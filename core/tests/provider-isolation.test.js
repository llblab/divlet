// Physical dependency isolation for production native semantics, separate from public bundled-default composition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
// Deliberately closed parser closure: no provider packages, package-manager install, links or blanket polyfills.
const parsers = ['postcss', 'nanoid', 'picocolors', 'source-map-js', 'parse5', 'entities'];

async function packageRoot(name, resolver = require) {
  let directory = path.dirname(resolver.resolve(name));
  while (true) {
    try { if (JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).name === name) return directory; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, `Cannot locate selected parser package ${name}`);
    directory = parent;
  }
}

async function capsule(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'divlet-provider-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copy = (from, to) => cp(from, to, { recursive: true, dereference: true, filter: source => path.basename(source) !== 'node_modules' });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'divlet-provider-isolation', type: 'module' }));
  await mkdir(path.join(root, 'core'), { recursive: true });
  await copy(path.join(checkout, 'core/lib'), path.join(root, 'core/lib'));
  await mkdir(path.join(root, 'core/tests/fixtures'), { recursive: true });
  await copy(new URL('./fixtures/frame-portability.js', import.meta.url), path.join(root, 'core/tests/fixtures/frame-portability.js'));
  const versions = {};
  for (const name of parsers) {
    const directory = await packageRoot(name);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.optionalDependencies ?? {}), [], 'parser closure must not acquire optional providers');
    const fromPackage = createRequire(path.join(directory, 'package.json'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      assert.ok(parsers.includes(dependency), `Undeclared parser dependency: ${dependency}`);
      assert.equal(await packageRoot(dependency, fromPackage), await packageRoot(dependency), 'flattening must not change the selected parser graph');
    }
    versions[name] = manifest.version;
    await copy(directory, path.join(root, 'node_modules', name));
  }
  return { root, versions };
}

function probe(isolate, { escape = false } = {}) {
  const script = `
    import assert from 'node:assert/strict';
    import { realpathSync, readdirSync } from 'node:fs';
    import { registerHooks } from 'node:module';
    import { fileURLToPath } from 'node:url';
    import path from 'node:path';
    const root = realpathSync(process.cwd());
    const loaded = new Set();
    registerHooks({ resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (resolved.url.startsWith('file:')) {
        const file = realpathSync(fileURLToPath(resolved.url));
        const relative = path.relative(root, file);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
          throw Object.assign(new Error('Module resolved outside the isolated copy'), { code: 'ISOLATION_ESCAPE' });
        }
        loaded.add(relative.split(path.sep).join('/'));
      } else assert.ok(resolved.url.startsWith('node:'), 'only copied files and Node builtins may load');
      return resolved;
    } });
    try {
      assert.deepEqual(readdirSync('node_modules').sort(), ${JSON.stringify([...parsers].sort())});
      ${escape ? `await import(${JSON.stringify(new URL('../lib/validation.ts', import.meta.url).href)});` : ''}
      const api = await import('./core/lib/model.ts');
      const { frameCases, captureFrame, sampleFrame } = await import('./core/tests/fixtures/frame-portability.js');
      for (const witness of frameCases) {
        const result = captureFrame(api, witness.run);
        assert.equal(result.ok, !witness.error, witness.name);
        if (witness.error) { assert.equal(result.code, witness.error, witness.name); assert.equal(result.domainError, true); }
      }
      const { encodeHtml, decodeHtml } = await import('./core/lib/codec.ts');
      const { readProject, writeProject, validateSettings } = await import('./core/lib/project.ts');
      const base = api.validateDocument(sampleFrame());
      const before = structuredClone(base);
      const next = api.applyDocumentPatch(base, { nodes: { root: { style: { color: 'var(--brand)', padding: '12px' } }, label: { content: 'Native CSS' } } });
      assert.deepEqual(base, before);
      assert.deepEqual(decodeHtml(encodeHtml(next)), next);
      const settings = validateSettings({ tokens: { '--brand': '#123456' }, css: '@media(min-width:1px){main{border:1px solid var(--brand)}}' });
      const reopened = readProject(JSON.parse(writeProject(settings, [next])));
      assert.deepEqual(reopened.settings, settings);
      assert.deepEqual(reopened.frames, [next]);
      const accepted = structuredClone(next);
      assert.throws(() => api.applyDocumentPatch(next, { nodes: { label: null } }), { code: 'INVALID_DOCUMENT' });
      assert.deepEqual(next, accepted);
      assert.throws(() => api.applyDocumentPatch(next, { nodes: { root: { styles: { color: 'red' } } } }), { code: 'NO_STYLE_ENGINE' });
      assert.ok(loaded.has('core/lib/model-styles.ts') && loaded.has('core/lib/style-engines.ts'));
      assert.ok(![...loaded].some(file => file.startsWith('plugins/') || /^core\\/lib\\/(engine|browser-styles)\\.ts$/.test(file)));
      console.log(JSON.stringify({ ok: true, witnesses: frameCases.length, modules: [...loaded].sort() }));
    } catch (error) { console.log(JSON.stringify({ ok: false, code: error.code, missingPackage: /Cannot find package '([^']+)'/.exec(error.message)?.[1], message: error.message, modules: [...loaded].sort() })); }
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: isolate.root, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, encoding: 'utf8', timeout: 15000,
  }));
}

test('the production style registry dispatches from a single copied source file with no provider or parser packages', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'divlet-registry-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await cp(new URL('../lib/style-engines.ts', import.meta.url), path.join(directory, 'style-engines.ts'));
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const onlySource = new URL('./style-engines.ts', import.meta.url).href;
    const loaded = new Set();
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      assert.ok(result.url === onlySource || result.url.startsWith('node:'), 'no checkout, parser, provider or model runtime rescue');
      loaded.add(result.url); return result;
    } });
    const api = await import('./style-engines.ts');
    assert.equal(api.styleEngine(), undefined);
    assert.deepEqual(api.clientPlugins(), []);
    assert.equal(api.clientPluginFile('missing', 'panel.js'), null);
    assert.equal(api.resolveStyleEngine(null), null);
    assert.equal(await api.compileClasses({}, ['opaque']), '');
    assert.deepEqual(await api.unknownClasses({ tokens: {}, byNode: {} }), {});
    assert.deepEqual(await api.explainClasses({ tokens: {}, names: [] }), {});
    assert.deepEqual(await api.suggestClasses({ tokens: {}, query: '' }), []);
    assert.deepEqual(api.customClasses(''), new Map());
    assert.equal(api.warmSuggestions({}), undefined);
    for (const name of ['applyStyles', 'declarationClass', 'propertyOfClass', 'createClassResourceMapper']) assert.throws(() => api[name]('', {}), { code: 'NO_STYLE_ENGINE' });
    const defaults = [{ id: 'default' }];
    api.seedStyleEngines(defaults); defaults.length = 0;
    assert.equal(api.styleEngine().id, 'default', 'read fallbacks do not select the registry; default lists are copied');
    api.setStyleEngines([]);
    const requirement = { id: 'host', version: 'exact' };
    assert.throws(() => api.resolveStyleEngine(requirement), { code: 'STYLE_ENGINE_UNAVAILABLE' });
    const host = { ...requirement, async compileClasses() { assert.equal(this, host); return 'host CSS'; } };
    api.registerStyleEngine(host);
    api.registerStyleEngine({ ...host, version: 'wrong' });
    api.seedStyleEngines([{ id: 'default' }]);
    assert.equal(api.styleEngine(), host);
    assert.equal(api.resolveStyleEngine(requirement), host);
    assert.equal(await api.compileClasses({}, [], undefined, requirement), 'host CSS');
    assert.throws(() => api.resolveStyleEngine({ ...requirement, version: 'other' }), { code: 'STYLE_ENGINE_VERSION_MISMATCH' });
    api.setStyleEngines([]); api.seedStyleEngines([host]);
    assert.equal(api.styleEngine(), undefined, 'explicit absence is not an uninitialized registry');
    assert.deepEqual([...loaded], [onlySource], 'type-only vocabulary dependencies do not load the model');
  `], { cwd: directory, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, encoding: 'utf8', timeout: 10000 });
});

test('a physically parser-only copy runs the production model binding without a port remap or plugin source', async t => {
  const isolate = await capsule(t);
  t.diagnostic(`production binding; parser versions: ${JSON.stringify(isolate.versions)}`);
  await t.test('shared admission, native inline patches, refusal integrity and HTML/project round trips', () => {
    const result = probe(isolate);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.witnesses > 0);
    t.diagnostic(`${result.witnesses} shared frame witnesses; ${result.modules.length} isolated source/parser files loaded`);
  });
  await t.test('checkout fallback is refused before any external module can execute', () => {
    const result = probe(isolate, { escape: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ISOLATION_ESCAPE');
  });
  await t.test('a missing mandatory parser cannot be rescued from checkout dependencies', async () => {
    // Keep the declared directory list unchanged while removing the owned parser bytes.
    await rm(path.join(isolate.root, 'node_modules/postcss'), { recursive: true });
    await mkdir(path.join(isolate.root, 'node_modules/postcss'));
    const result = probe(isolate);
    assert.equal(result.ok, false);
    assert.ok(['ERR_MODULE_NOT_FOUND', 'ISOLATION_ESCAPE'].includes(result.code), JSON.stringify(result));
  });
});
