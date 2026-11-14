// Physical dependency isolation for a prototype host port, not a replacement for public Node defaults.
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
  for (const directory of ['core/lib', 'plugins/pen/lib', 'plugins/tailwind/lib']) {
    await mkdir(path.dirname(path.join(root, directory)), { recursive: true });
    await copy(path.join(checkout, directory), path.join(root, directory));
  }
  for (const plugin of ['pen', 'tailwind']) for (const file of ['index.js', 'package.json']) {
    await copy(path.join(checkout, 'plugins', plugin, file), path.join(root, 'plugins', plugin, file));
  }
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
  const pkg = JSON.parse(await readFile(path.join(checkout, 'package.json'), 'utf8'));
  const source = './core/lib/model-styles.ts', replacement = pkg.browser[source];
  assert.equal(replacement, './core/lib/browser-styles.ts', 'use the declared style port, not a test validator');
  return { root, source, replacement, versions };
}

function probe(isolate, { mapped = false, escape = false } = {}) {
  const script = `
    import assert from 'node:assert/strict';
    import { realpathSync, readdirSync } from 'node:fs';
    import { registerHooks } from 'node:module';
    import { fileURLToPath } from 'node:url';
    import path from 'node:path';
    const root = realpathSync(process.cwd());
    const loaded = new Set();
    const port = new URL(${JSON.stringify(isolate.source)}, import.meta.url).href;
    const replacement = new URL(${JSON.stringify(isolate.replacement)}, import.meta.url).href;
    registerHooks({ resolve(specifier, context, next) {
      let resolved = next(specifier, context);
      if (${mapped} && resolved.url === port) resolved = next(replacement, context);
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
      ${mapped ? `assert.throws(() => api.applyDocumentPatch(next, { nodes: { root: { styles: { color: 'red' } } } }), { code: 'NO_STYLE_ENGINE' });
      assert.ok(loaded.has('core/lib/browser-styles.ts'));
      assert.ok(![...loaded].some(file => file.startsWith('plugins/') || /^core\\/lib\\/(engine|model-styles)\\.ts$/.test(file)));` : ''}
      console.log(JSON.stringify({ ok: true, witnesses: frameCases.length, modules: [...loaded].sort() }));
    } catch (error) { console.log(JSON.stringify({ ok: false, code: error.code, missingPackage: /Cannot find package '([^']+)'/.exec(error.message)?.[1], message: error.message, modules: [...loaded].sort() })); }
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: isolate.root, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, encoding: 'utf8', timeout: 15000,
  }));
}

test('a physically parser-only copy exercises the declared provider-free port without changing Node defaults', async t => {
  const isolate = await capsule(t);
  // Characterize default loading, but do not fossilize today's provider coupling as a required failure.
  const baseline = probe(isolate);
  t.diagnostic(`unmapped Node control: ${baseline.ok ? 'loaded' : baseline.code}${baseline.missingPackage ? ' (' + baseline.missingPackage + ')' : ''}; parser versions: ${JSON.stringify(isolate.versions)}`);
  await t.test('shared admission, native inline patches, refusal integrity and HTML/project round trips', () => {
    const result = probe(isolate, { mapped: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.witnesses > 0);
    t.diagnostic(`${result.witnesses} shared frame witnesses; ${result.modules.length} isolated source/parser files loaded`);
  });
  await t.test('checkout fallback is refused before any external module can execute', () => {
    const result = probe(isolate, { mapped: true, escape: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ISOLATION_ESCAPE');
  });
  await t.test('a missing mandatory parser cannot be rescued from checkout dependencies', async () => {
    // Keep the declared directory list unchanged while removing the owned parser bytes.
    await rm(path.join(isolate.root, 'node_modules/postcss'), { recursive: true });
    await mkdir(path.join(isolate.root, 'node_modules/postcss'));
    const result = probe(isolate, { mapped: true });
    assert.equal(result.ok, false);
    assert.ok(['ERR_MODULE_NOT_FOUND', 'ISOLATION_ESCAPE'].includes(result.code), JSON.stringify(result));
  });
});
