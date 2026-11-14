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

async function capsule(t, { writer = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'divlet-provider-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copy = (from, to) => cp(from, to, { recursive: true, dereference: true, filter: source => path.basename(source) !== 'node_modules' });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'divlet-provider-isolation', type: 'module' }));
  await mkdir(path.join(root, 'core'), { recursive: true });
  await copy(path.join(checkout, 'core/lib'), path.join(root, 'core/lib'));
  await mkdir(path.join(root, 'core/tests/fixtures'), { recursive: true });
  await copy(new URL('./fixtures/frame-portability.js', import.meta.url), path.join(root, 'core/tests/fixtures/frame-portability.js'));
  const packages = writer ? [...parsers, 'postcss-value-parser', '@xmldom/xmldom', 'marked', 'yaml', '@divlet/web'] : parsers;
  const versions = {};
  for (const name of packages) {
    const directory = await packageRoot(name, name === '@divlet/web' ? { resolve: name => fileURLToPath(import.meta.resolve(name)) } : require);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.optionalDependencies ?? {}), [], 'parser closure must not acquire optional providers');
    const fromPackage = createRequire(path.join(directory, 'package.json'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      assert.ok(packages.includes(dependency), `Undeclared native dependency: ${dependency}`);
      assert.equal(await packageRoot(dependency, fromPackage), await packageRoot(dependency), 'flattening must not change the selected parser graph');
    }
    versions[name] = manifest.version;
    if (name === '@divlet/web') {
      const target = path.join(root, 'node_modules', name), dist = path.join(target, 'dist');
      await cp(directory, target, { recursive: true, dereference: true, filter: source => !['node_modules', 'dist', 'tests'].includes(path.basename(source)) });
      // Node does not strip TS inside node_modules. Build only this peer into the isolate, never race shared dist output.
      execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(directory, 'tsconfig.build.json'), '--outDir', dist], { encoding: 'utf8', timeout: 20000 });
      for (const asset of ['board.js', 'board.css', 'index.html', 'lib']) await cp(path.join(directory, asset), path.join(dist, asset), { recursive: true, filter: source => !source.endsWith('.ts') });
    } else await copy(directory, path.join(root, 'node_modules', name));
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

test('the Node plugin registry dispatches from one copied source without provider/model/parser packages', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'divlet-plugin-registry-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await cp(new URL('../lib/plugin-registry.ts', import.meta.url), path.join(directory, 'plugin-registry.ts'));
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const onlySource = new URL('./plugin-registry.ts', import.meta.url).href;
    const loaded = new Set();
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      assert.ok(result.url === onlySource || result.url.startsWith('node:'), 'no provider, parser or checkout rescue');
      loaded.add(result.url); return result;
    } });
    const api = await import('./plugin-registry.ts');
    const read = () => assert.fail('dispatch need not read source for these mocks');
    assert.deepEqual(api.importerList(), []);
    assert.deepEqual([...api.importExtensions()], []);
    assert.deepEqual([...api.pageExtensions()], []);
    assert.equal(await api.importerFor('unknown.foo', read), null);
    api.seedImporters([]); api.seedImporters([{ id: 'ignored' }]);
    assert.deepEqual(api.importerList(), [], 'an explicit empty choice survives default seeding');
    const calls = [];
    const first = { id: 'first', label: 'First', listed: false, extensions: ['.foo'],
      async claims(file, actualRead) { assert.equal(this, first); assert.equal(actualRead, read); calls.push('first'); if (file.endsWith('.alias')) return true; throw new Error('not mine'); },
      page() { assert.fail('not projecting'); }, convert() { assert.fail('not converting'); } };
    const second = { id: 'second', label: 'Second', extensions: ['.bar'], async claims() { calls.push('second'); return true; }, convert() {} };
    api.registerImporter(first); api.registerImporter({ ...first, async claims() { assert.fail('duplicate ID'); } }); api.registerImporter(second);
    api.seedImporters([{ id: 'ignored' }]);
    assert.deepEqual(api.importerList(), [first, second]);
    const listing = api.importerList(); listing.length = 0; assert.equal(api.importerList().length, 2);
    assert.deepEqual([...api.importExtensions()], ['.bar']);
    assert.deepEqual([...api.importExtensions({ all: true })], ['.foo', '.bar']);
    assert.deepEqual([...api.pageExtensions()], ['.foo']);
    assert.equal(await api.importerFor('scene.FOO', read), first); assert.deepEqual(calls, [], 'extension shortcuts do not sniff');
    assert.equal(await api.importerFor('scene.alias', read), first); assert.deepEqual(calls, ['first'], 'first claim wins');
    calls.length = 0;
    assert.equal(await api.importerFor('scene.other', read), second); assert.deepEqual(calls, ['first', 'second'], 'rejected claims continue in order');
    assert.deepEqual(api.exporterList(), []);
    await assert.rejects(api.exportAs('missing', {}), { code: 'UNKNOWN_EXPORTER' });
    assert.throws(() => api.registerExporter({ id: 'invalid' }), TypeError);
    const bytes = new Uint8Array([1, 2, 3]);
    const exporter = { id: 'host', label: 'Host', extension: '.bin', mime: 'application/octet-stream', export() { assert.equal(this, exporter); return { name: 'a/b', bytes }; } };
    api.registerExporter(exporter); api.registerExporter(exporter);
    assert.throws(() => api.registerExporter({ ...exporter }), /already registered/);
    assert.equal(api.exporterList().length, 1);
    const result = await api.exportAs('host', { project: {}, frames: [] });
    assert.equal(result.name, 'a_b.bin'); assert.equal(result.mime, exporter.mime);
    assert.deepEqual([...result.bytes], [1, 2, 3]); assert.notEqual(result.bytes, bytes);
    api.registerExporter({ id: 'text', label: 'Text', extension: '.txt', mime: 'text/plain', export() { return { name: 'note.txt', bytes: 'é' }; } });
    assert.equal((await api.exportAs('text', {})).bytes.toString('utf8'), 'é');
    api.registerExporter({ id: 'broken', label: 'Broken', extension: '.txt', mime: 'text/plain', export() { return { name: 'no bytes' }; } });
    await assert.rejects(api.exportAs('broken', {}), { code: 'EXPORT_FAILED' });
    assert.deepEqual([...loaded].filter(url => url.startsWith('file:')), [onlySource], 'type-only contracts never load their model/project owners');
  `], { cwd: directory, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, encoding: 'utf8', timeout: 10000 });
});

test('the native Node writer/server runs without plugin source or provider packages', async t => {
  const isolate = await capsule(t, { writer: true });
  const script = `
    import assert from 'node:assert/strict';
    import { promises as fs, realpathSync } from 'node:fs';
    import { registerHooks } from 'node:module';
    import { fileURLToPath } from 'node:url';
    import path from 'node:path';
    const root = realpathSync(process.cwd()), loaded = new Set();
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (result.url.startsWith('file:')) {
        const relative = path.relative(root, realpathSync(fileURLToPath(result.url))).split(path.sep).join('/');
        assert.ok(relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative), 'no checkout rescue');
        assert.ok(!relative.startsWith('plugins/') && !/^core\\/lib\\/(engine|plugins)\\.ts$/.test(relative), 'no default composition in native writer/server');
        loaded.add(relative);
      } else assert.ok(result.url.startsWith('node:'));
      return result;
    } });
    const { openRuntime } = await import('./core/lib/runtime.js');
    const { decodeHtml } = await import('./core/lib/codec.ts');
    const file = path.join(root, 'workspace/project.divlet');
    let runtime;
    try {
      runtime = await openRuntime({ file, watch: false, createDemo: false });
      await runtime.create({ document: decodeHtml('<main id="root" style="color:red"><p id="label">One</p></main>', { fallbackId: 'plain' }) });
      const read = () => runtime.read({ view: 'frame', documentId: 'plain' });
      const version = read().version, textId = Object.values(read().nodes).find(node => node.type === 'text').id;
      assert.deepEqual(runtime.info().clientPlugins, []);
      await runtime.patch({ documentId: 'plain', expectedVersion: version, patch: { nodes: { root: { style: { color: 'blue' } }, [textId]: { content: 'Two' } } } });
      const accepted = read(), source = await fs.readFile(file, 'utf8');
      await assert.rejects(runtime.patch({ documentId: 'plain', expectedVersion: version, patch: { name: 'stale' } }), { code: 'REVISION_CONFLICT' });
      await assert.rejects(runtime.patch({ documentId: 'plain', expectedVersion: accepted.version, patch: { nodes: { root: { style: { color: 'red;display:none' } } } } }), { code: 'INVALID_DOCUMENT' });
      await assert.rejects(runtime.patch({ documentId: 'plain', expectedVersion: accepted.version, patch: { nodes: { root: { styles: { color: 'green' } } } } }), { code: 'NO_STYLE_ENGINE' });
      assert.deepEqual(read(), accepted); assert.equal(await fs.readFile(file, 'utf8'), source);
      await runtime.undo(); assert.equal(read().nodes.root.style.color, 'red');
      await runtime.redo(); assert.equal(read().nodes.root.style.color, 'blue');
      const rendered = await fetch(runtime.info().documents[0].viewUrl);
      assert.equal(rendered.status, 200); const html = await rendered.text();
      assert.match(html, /color:blue/); assert.match(html, /Two/);
      assert.equal((await fetch(runtime.url)).status, 200, 'the loopback board serves the actual portable web peer');
      assert.match((await runtime.exportDocument('plain')).html, /Two/);
      const saved = read(); await runtime.close(); runtime = null;
      await fs.rm(path.join(root, 'workspace/.divlet'), { recursive: true, force: true });
      runtime = await openRuntime({ file, watch: false, createDemo: false });
      assert.deepEqual(runtime.read({ view: 'frame', documentId: 'plain' }), saved, 'cache-free reopen retains the accepted native source');
      assert.ok(loaded.has('core/lib/server.ts') && loaded.has('core/lib/import.ts') && loaded.has('core/lib/plugin-registry.ts'));
    } finally { await runtime?.close(); }
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: isolate.root, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', PI_DIVLET_STATE_DIR: path.join(isolate.root, 'board-state') }, encoding: 'utf8', timeout: 20000 });
  t.diagnostic(`native writer closure: ${JSON.stringify(isolate.versions)}`);
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
