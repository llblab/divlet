// Package boundaries are installation boundaries: core → web, adapters → core; no copied clients or wrappers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const exists = async file => { try { return (await stat(file)).isFile(); } catch { return false; } };

test('@divlet/core is the shared product library, not a host or command package', async () => {
  assert.equal(pkg.name, '@divlet/core');
  assert.equal(pkg.exports['.'].default, './dist/core/index.js');
  assert.equal(pkg.exports['./runtime'].default, './dist/core/runtime.js');
  assert.equal(pkg.bin, undefined);
  assert.equal(pkg.pi, undefined);
  assert.equal(pkg.exports['./pi'], undefined, 'the Pi adapter now belongs to @divlet/pi');
  assert.equal(pkg.peerDependencies?.typebox, undefined);
  for (const word of ['pi', 'pi-package']) assert.equal(pkg.keywords.includes(word), false);
  assert.equal(pkg.exports['./skill'], './skills/divlet/SKILL.md', 'the workflow remains product-owned');
  for (const legacy of ['adapters', 'packages']) await assert.rejects(stat(path.join(root, legacy)), { code: 'ENOENT' }, 'no legacy adapter wrapper tree');
  for (const name of ['cli', 'mcp', 'pi']) assert.equal(pkg.files.includes(name), false, 'adapter sources stay out of core');
  assert.deepEqual(pkg.workspaces, ['.', 'web', 'cli', 'mcp', 'pi', 'plugins/*']);
  assert.ok(pkg.workspaces.includes('.'), 'source adapters can resolve the product workspace without a registry release');
});

test('native host packaging separates optional provider dependencies from mandatory native parsers', async () => {
  assert.deepEqual(pkg.exports['./native'], { 'divlet-source': './core/native.ts', default: './dist/core/native.js' });
  const providers = ['@tailwindcss/node', 'tailwindcss', 'lucide-static', 'svg-pathdata'];
  assert.deepEqual(Object.keys(pkg.optionalDependencies).sort(), providers.sort());
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(lock.packages[''].optionalDependencies, pkg.optionalDependencies);
  for (const plugin of ['tailwind', 'pen']) {
    const descriptor = JSON.parse(await readFile(path.join(root, 'plugins', plugin, 'package.json'), 'utf8'));
    for (const name of Object.keys(descriptor.dependencies).filter(name => providers.includes(name))) {
      assert.equal(pkg.dependencies[name], undefined);
      assert.equal(pkg.optionalDependencies[name], descriptor.dependencies[name], 'bundled payload retains its plugin-owned dependency range');
    }
  }
  for (const name of ['@divlet/web', 'postcss', 'postcss-value-parser', 'parse5', '@xmldom/xmldom', 'marked', 'yaml']) assert.ok(pkg.dependencies[name], `${name} remains native-owned`);
});

test('the public model selects native semantics for browser exports and explicit composition for Node', async () => {
  assert.deepEqual(pkg.exports['./model'], {
    browser: { 'divlet-source': './core/lib/model.ts', default: './dist/core/lib/model.js' },
    'divlet-source': './core/model.ts', default: './dist/core/model.js',
  });
  const native = await import('../lib/model.ts');
  const composed = await import('@divlet/core/model');
  assert.deepEqual(Object.keys(composed), Object.keys(native));
  for (const name of Object.keys(native)) assert.equal(composed[name], native[name], 'one vocabulary/validator, not host-specific model implementations');
});

test('@divlet/web owns client files and portable ports with no reverse package dependency', async () => {
  const web = JSON.parse(await readFile(path.join(root, 'web/package.json'), 'utf8'));
  assert.equal(web.name, '@divlet/web'); assert.equal(web.version, pkg.version);
  assert.equal(pkg.dependencies['@divlet/web'], pkg.version);
  assert.ok(pkg.workspaces.includes('web'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(Object.keys(web[field] ?? {}).length, 0, `web has no ${field} back edge`);
  assert.deepEqual(web.exports['./session'], { 'divlet-source': './lib/board-session.ts', default: './dist/lib/board-session.js' });
  assert.deepEqual(web.exports['./host'], { 'divlet-source': './lib/board-host.ts', default: './dist/lib/board-host.js' });
  const { clientRoot } = await import('@divlet/web');
  assert.equal(clientRoot.href, new URL('../../web/', import.meta.url).href);
  const server = await readFile(path.join(root, 'core/lib/server.ts'), 'utf8');
  assert.match(server, /from '@divlet\/web'/);
  assert.doesNotMatch(server, /new URL\('\.\.\/\.\.\/web\//, 'the server uses a public locator, not a sibling path');
});

test('browser mapping replaces only the declared host ports and keeps their source bindings', async () => {
  assert.deepEqual(pkg.browser, {
    './core/lib/model-styles.ts': './core/lib/browser-styles.ts',
    './dist/core/lib/model-styles.js': './dist/core/lib/browser-styles.js',
    './core/lib/media-type.ts': './core/lib/browser-media-type.ts',
    './dist/core/lib/media-type.js': './dist/core/lib/browser-media-type.js',
  });
  for (const [source, replacement] of Object.entries(pkg.browser).filter(([file]) => file.endsWith('.ts'))) {
    for (const file of [source, replacement]) assert.ok(await exists(path.join(root, file)), file);
    const [original, browser] = await Promise.all([import(path.join(root, source)), import(path.join(root, replacement))]);
    assert.deepEqual(Object.keys(browser).sort(), Object.keys(original).sort(), `${replacement} names the same bindings as ${source}`);
  }
});

for (const name of ['cli', 'mcp', 'pi']) test(`@divlet/${name} owns its adapter, release version and installed entry`, async () => {
  const directory = path.join(root, name);
  const adapter = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  assert.equal(adapter.name, `@divlet/${name}`);
  assert.notEqual(adapter.private, true);
  assert.equal(adapter.version, pkg.version);
  assert.equal(adapter.dependencies['@divlet/core'], pkg.version);
  assert.equal(adapter.dependencies['@divlet/web'], undefined, 'the core HTTP composition owns the web dependency');
  assert.equal(adapter.repository.directory, name);
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[`node_modules/@divlet/${name}`].resolved, name);
  assert.equal(lock.packages[name].name, adapter.name);
  assert.equal(Object.keys(lock.packages).some(key => key.startsWith('packages/')), false, 'the lock retains no phantom nested workspaces');
  assert.deepEqual(adapter.exports['.'], { 'divlet-source': './index.js', default: './dist/index.js' });
  assert.equal(adapter.files.includes('dist'), true);
  assert.equal(adapter.files.includes('tests'), false);
  const source = await readFile(path.join(directory, 'index.js'), 'utf8');
  if (name === 'pi') {
    assert.deepEqual(adapter.pi.extensions, ['./dist/index.js']);
    assert.match(source, /from '\.\/lib\/extension\.js'/, 'the implementation lives in this package');
    assert.ok(adapter.keywords.includes('pi-package'));
    assert.equal(adapter.peerDependencies.typebox, '*');
  } else {
    assert.deepEqual(adapter.bin, { [name === 'cli' ? 'divlet' : 'divlet-mcp']: './dist/index.js' });
    assert.match(source, /import\.meta\.main/, 'imports do not start the executable');
  }
});

test('public adapter imports start no process service or stdio listeners', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const before = [process.stdin.listenerCount('data'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const cli = await import('@divlet/cli');
    const mcp = await import('@divlet/mcp');
    const pi = await import('@divlet/pi');
    assert.equal(typeof cli.runCli, 'function');
    assert.equal(typeof mcp.runMcp, 'function');
    assert.equal(typeof pi.default, 'function');
    assert.deepEqual([process.stdin.listenerCount('data'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
  `], { cwd: root, stdio: 'pipe', timeout: 10000 });
});

// Every probe is a fresh module graph; a warm root import must not mask missing standalone initialization.
function coldStandalone(script) {
  execFileSync(process.execPath, ['--conditions=divlet-source', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createRequire, registerHooks } from 'node:module';
    const require = createRequire(import.meta.url);
    const rootURL = import.meta.resolve('@divlet/core');
    const rootGuard = registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      assert.notEqual(result.url, rootURL, 'standalone entries must not initialize through the library root');
      return result;
    } });
    ${script}
  `], { cwd: root, stdio: 'pipe', timeout: 10000 });
}

test('the public native host loads no provider and makes untouched absence authoritative', () => coldStandalone(`
  const providers = registerHooks({ resolve(specifier, context, next) {
    const result = next(specifier, context);
    assert.doesNotMatch(result.url, /\\/plugins\\/(?:tailwind|pen)\\//, 'native composition never loads bundled providers');
    return result;
  } });
  const api = await import('@divlet/core/native');
  assert.deepEqual(Object.keys(api).sort(), ['launch', 'makeHost', 'openRuntime', 'registerExporter', 'registerImporter', 'registerStyleEngine', 'resolveOpenFile', 'setStyleEngines', 'startServer'].sort());
  const engines = await import('./core/lib/style-engines.ts');
  const importers = await import('./core/lib/plugin-registry.ts');
  assert.equal(engines.styleEngine(), undefined);
  assert.deepEqual(importers.importerList(), []);
  providers.deregister();
  await import('@divlet/core/runtime');
  await import('@divlet/core/contract');
  assert.equal(engines.styleEngine(), undefined, 'late public composition preserves the explicit native choice');
  assert.deepEqual(importers.importerList(), []);
`));

test('public native registration and preselected host providers survive either composition order', () => coldStandalone(`
  const engines = await import('./core/lib/style-engines.ts');
  const importers = await import('./core/lib/plugin-registry.ts');
  const engine = { id: 'host-owned', applyStyles() { return 'host'; } };
  const importer = { id: 'host-owned', extensions: ['.host'] };
  engines.setStyleEngines([engine]);
  importers.registerImporter(importer);
  const api = await import('@divlet/core/native');
  assert.equal(engines.styleEngine(), engine, 'native entry never clears an existing host choice');
  assert.deepEqual(importers.importerList(), [importer]);
  api.setStyleEngines([]);
  api.registerStyleEngine(engine);
  api.registerImporter(importer);
  const exporter = { id: 'host-output', label: 'Host', extension: '.txt', mime: 'text/plain', export() { return { name: 'host', bytes: 'host' }; } };
  api.registerExporter(exporter);
  await import('@divlet/core/runtime');
  await import('@divlet/core/contract');
  assert.equal(engines.styleEngine(), engine);
  assert.deepEqual(importers.importerList(), [importer]);
  assert.equal(importers.exporterList()[0].id, exporter.id);
`));

test('cold public runtime composes both bundled defaults without the library root', () => coldStandalone(`
  const api = await import('@divlet/core/runtime');
  const native = await import('./core/lib/runtime.js');
  assert.equal(api.openRuntime, native.openRuntime); assert.equal(api.DivletRuntime, native.DivletRuntime);
  const styles = await import('./core/lib/style-engines.ts');
  const plugins = await import('./core/lib/plugin-registry.ts');
  assert.equal(styles.styleEngine().id, 'tailwind');
  assert.equal(styles.applyStyles('', { 'padding-top': '12px' }), 'pt-3');
  assert.deepEqual(plugins.importerList().map(item => item.id), ['pen']);
  rootGuard.deregister();
  assert.equal((await import('@divlet/core')).openRuntime, api.openRuntime, 'root and named entry share the native writer');
`));

test('public runtime composition retains explicit native host absence', () => coldStandalone(`
  const styles = await import('./core/lib/style-engines.ts'); styles.setStyleEngines([]);
  const plugins = await import('./core/lib/plugin-registry.ts'); plugins.seedImporters([]);
  const api = await import('@divlet/core/runtime');
  assert.equal(typeof api.openRuntime, 'function');
  assert.equal(styles.styleEngine(), undefined); assert.deepEqual(plugins.importerList(), []);
  await import('@divlet/core/model');
  rootGuard.deregister(); await import('@divlet/core');
  assert.equal(styles.styleEngine(), undefined); assert.deepEqual(plugins.importerList(), []);
`));

for (const mode of ['resolve', 'lazy-session']) test(`cold public contract retains foreign admission before runtime loading (${mode})`, () => coldStandalone(`
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os'); const path = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-cold-contract-'));
  const file = path.join(directory, 'source.pen');
  const source = JSON.stringify({ version: '2.21', children: [{ id: 'page', name: 'Cold contract', type: 'frame', width: 100, height: 60 }] });
  let session;
  try {
    await fs.writeFile(file, source);
    const contract = await import('@divlet/core/contract');
    if (${mode === 'resolve'}) {
      const result = await contract.resolveOpenFile(file);
      assert.notEqual(result.file, file, 'contract-only admission must convert before any runtime import');
      assert.equal(result.created, true); assert.equal(JSON.parse(await fs.readFile(result.file, 'utf8')).schemaVersion, 1);
    } else {
      session = contract.createSession({ cwd: directory, attach: false, async openBoard({ file: admitted }) {
        assert.equal(admitted, path.join(directory, 'source.divlet'), 'source admission precedes the lazy runtime callback');
        const { openRuntime } = await import('@divlet/core/runtime');
        return openRuntime({ file: admitted, watch: false, createDemo: false });
      } });
      const opened = await session.open({ path: file });
      assert.equal(opened.kind, 'project'); assert.notEqual(opened.info.project.file, file);
    }
    assert.equal(await fs.readFile(file, 'utf8'), source);
  } finally { await session?.close(); await fs.rm(directory, { recursive: true, force: true }); }
`));

test('cold public contract preserves explicit native selection', () => coldStandalone(`
  const styles = await import('./core/lib/style-engines.ts'); styles.setStyleEngines([]);
  const plugins = await import('./core/lib/plugin-registry.ts'); plugins.seedImporters([]);
  const contract = await import('@divlet/core/contract');
  assert.equal(typeof contract.resolveOpenFile, 'function');
  assert.equal(styles.styleEngine(), undefined); assert.deepEqual(plugins.importerList(), []);
`));

for (const mode of ['import', 'require']) {
  const load = entry => mode === 'import' ? `await import('@divlet/core/${entry}')` : `require('@divlet/core/${entry}')`;
  test(`cold public model keeps default lowering through ${mode} without the library root`, () => coldStandalone(`
    const api = ${load('model')};
    const base = api.createDemoDocument();
    const next = api.applyDocumentPatch(base, { nodes: { [base.rootId]: { styles: { 'padding-top': '12px' } } } });
    assert.match(next.nodes[base.rootId].className, /(?:^|\\s)pt-3(?:$|\\s)/);
    assert.equal(base.nodes[base.rootId].className.includes('pt-3'), false);
  `));
  test(`cold public engine keeps bundled defaults through ${mode} without the library root`, () => coldStandalone(`
    const api = ${load('engine')};
    assert.equal(api.styleEngine().id, 'tailwind');
    assert.equal(api.applyStyles('', { 'padding-top': '12px' }), 'pt-3');
    assert.equal(api.clientPlugins().filter(plugin => plugin.id === 'tailwind').length, 1);
    assert.match(await api.compileClasses({}, ['pt-3'], process.cwd()), /padding-top/);
  `));
}

test('cold public plugins keep the bundled importer without the library root', () => coldStandalone(`
  const api = await import('@divlet/core/plugins');
  const pen = api.importerList().find(importer => importer.id === 'pen');
  assert.ok(pen);
  assert.equal(api.importerList().filter(importer => importer.id === 'pen').length, 1);
  assert.ok(api.importExtensions().has('.pen'));
  assert.equal(await api.importerFor('scene.PEN', () => assert.fail('extension dispatch must not read source')), pen);
`));

for (const selection of ['empty', 'set', 'register']) test(`provider-free ${selection} selection survives the first default facade import`, () => coldStandalone(`
  const kernel = await import('./core/lib/style-engines.ts');
  assert.equal(kernel.styleEngine(), undefined);
  const input = Object.freeze({ opacity: 0.5, width: null });
  const host = { id: 'early-host', applyStyles(className, edits) {
    assert.equal(this, host); assert.equal(edits, input); return 'host-authored';
  } };
  ${selection === 'empty' ? 'kernel.setStyleEngines([]);' : selection === 'set' ? 'kernel.setStyleEngines([host]);' : 'kernel.registerStyleEngine(host);'}
  const facade = await import('@divlet/core/engine');
  assert.equal(Object.hasOwn(facade, 'seedStyleEngines'), false, 'composition initializer is not a public capability');
  assert.deepEqual(Object.keys(facade), Object.keys(kernel).filter(name => name !== 'seedStyleEngines'), 'the facade retains every capability without exposing composition authority');
  for (const name of Object.keys(facade)) assert.equal(facade[name], kernel[name], 'the facade delegates to one registry/dispatcher, not a second state');
  assert.equal(facade.styleEngine(), ${selection === 'empty' ? 'undefined' : 'host'});
  if (${selection !== 'empty'}) assert.equal(facade.applyStyles('', input), 'host-authored');
  const model = await import('@divlet/core/model');
  const base = model.createDemoDocument();
  const patch = { nodes: { [base.rootId]: { styles: input } } };
  ${selection === 'empty' ? "assert.throws(() => model.applyDocumentPatch(base, patch), { code: 'NO_STYLE_ENGINE' });" : "assert.equal(model.applyDocumentPatch(base, patch).nodes[base.rootId].className, 'host-authored');"}
`));

test('explicit engine absence survives late model, importer and root imports', () => coldStandalone(`
  const engine = await import('@divlet/core/engine');
  engine.setStyleEngines([]);
  const model = await import('@divlet/core/model');
  await import('@divlet/core/plugins');
  rootGuard.deregister();
  await import('@divlet/core');
  assert.equal(engine.styleEngine(), undefined);
  assert.deepEqual(engine.clientPlugins(), []);
  assert.equal(await engine.compileClasses({}, ['pt-3']), '');
  const base = model.createDemoDocument();
  const patch = input => model.applyDocumentPatch(base, { nodes: { [base.rootId]: input } });
  assert.throws(() => patch({ styles: { color: 'red' } }), { code: 'NO_STYLE_ENGINE' });
  assert.equal(patch({ style: { color: 'red' } }).nodes[base.rootId].style.color, 'red');
`));

test('host engine selection, ID deduplication and exact identity survive late composition', () => coldStandalone(`
  const engine = await import('@divlet/core/engine');
  const host = { id: 'host', version: 'host-renderer', applyStyles() {
    assert.equal(this, host);
    return 'host-authored';
  }, async compileClasses() { assert.equal(this, host); return 'host CSS'; } };
  engine.setStyleEngines([host]);
  engine.registerStyleEngine({ id: 'host', version: 'wrong', applyStyles() { assert.fail('duplicate ID'); } });
  engine.registerStyleEngine({ id: 'other', version: 'other-renderer' });
  const model = await import('@divlet/core/model');
  await import('@divlet/core/plugins');
  rootGuard.deregister();
  await import('@divlet/core');
  assert.equal(engine.styleEngine(), host);
  const requirement = Object.freeze({ id: 'host', version: 'host-renderer' });
  assert.equal(engine.resolveStyleEngine(requirement), host);
  assert.equal(await engine.compileClasses({}, ['anything'], undefined, requirement), 'host CSS');
  assert.throws(() => engine.resolveStyleEngine({ ...requirement, version: 'wrong' }), { code: 'STYLE_ENGINE_VERSION_MISMATCH' });
  const base = model.createDemoDocument();
  const next = model.applyDocumentPatch(base, { nodes: { [base.rootId]: { styles: { color: 'red' } } } });
  assert.equal(next.nodes[base.rootId].className, 'host-authored');
`));

for (const selection of ['empty', 'register', 'seed', 'exporter-only']) test(`early importer ${selection} choice survives the first public plugin facade import`, () => coldStandalone(`
  const registry = await import('./core/lib/plugin-registry.ts');
  assert.deepEqual(registry.importerList(), []);
  const host = { id: 'early-host', label: 'Host', extensions: ['.host'], async claims() { return false; }, convert() { assert.fail('not converting'); } };
  ${selection === 'empty' ? 'registry.seedImporters([]);' : selection === 'register' ? 'registry.registerImporter(host);' : selection === 'seed' ? 'const defaults = [host]; registry.seedImporters(defaults); defaults.length = 0;' : "registry.registerExporter({ id: 'host-export', label: 'Host', extension: '.host', mime: 'text/plain', export() { return { name: 'host', bytes: 'kept' }; } });"}
  const api = await import('@divlet/core/plugins');
  assert.deepEqual(Object.keys(api), Object.keys(registry).filter(name => name !== 'seedImporters'));
  for (const name of Object.keys(api)) assert.equal(api[name], registry[name], 'one registry, not a facade-owned copy');
  assert.deepEqual(api.importerList().map(item => item.id), ${selection === 'empty' ? '[]' : selection === 'exporter-only' ? "['pen']" : "['early-host']"});
  if (${selection === 'register' || selection === 'seed'}) assert.equal(await api.importerFor('scene.HOST', () => assert.fail('extension shortcut must not read')), host);
  if (${selection === 'exporter-only'}) assert.equal((await api.exportAs('host-export', { project: {}, frames: [] })).bytes.toString(), 'kept');
  const selected = api.importerList();
  await import('@divlet/core/model'); await import('@divlet/core/engine');
  rootGuard.deregister(); await import('@divlet/core');
  assert.deepEqual(api.importerList(), selected, 'late composition preserves the early choice');
`));

test('importer registration preserves first claim, ID deduplication and order across late composition', () => coldStandalone(`
  const api = await import('@divlet/core/plugins');
  const original = api.importerList();
  const read = () => assert.fail('dispatch must not read this probe');
  const first = { id: 'first', label: 'First', extensions: [], async claims(file, actualRead) {
    assert.equal(this, first); assert.equal(actualRead, read); return file.endsWith('.probe');
  }, convert() { assert.fail('dispatch must not convert'); } };
  const second = { id: 'second', label: 'Second', extensions: ['.probe'], async claims() { return false; }, convert() { assert.fail('dispatch must not convert'); } };
  api.registerImporter(first);
  api.registerImporter({ ...first, label: 'Duplicate', async claims() { assert.fail('duplicate ID'); } });
  api.registerImporter(second);
  const expected = [...original, first, second];
  assert.deepEqual(api.importerList(), expected);
  await import('@divlet/core/model');
  await import('@divlet/core/engine');
  rootGuard.deregister();
  await import('@divlet/core');
  assert.deepEqual(api.importerList(), expected);
  assert.equal(await api.importerFor('scene.probe', read), first);
  const copy = api.importerList(); copy.length = 0;
  assert.deepEqual(api.importerList(), expected, 'listing does not expose registry storage');
`));

test('published library targets are compiled; development targets name real source files', async () => {
  for (const [name, target] of Object.entries(pkg.exports)) {
    if (name === './skill') { assert.equal(await exists(path.join(root, target)), true); continue; }
    assert.match(target.default, /^\.\/dist\//);
    assert.equal(await exists(path.join(root, target['divlet-source'])), true, name);
  }
});
