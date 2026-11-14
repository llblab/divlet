// Copied into the empty installed consumer; imports only public compiled product entries.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = await realpath(process.cwd()), loaded = new Set();
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url.startsWith('file:')) {
    const relative = path.relative(root, realpathSync(fileURLToPath(result.url))).split(path.sep).join('/');
    assert.ok(relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative), 'no checkout or ancestor module rescue');
    assert.doesNotMatch(relative, /\/plugins\/(?:pen|tailwind)\//, 'no bundled provider execution');
    assert.doesNotMatch(relative, /\/core\/(?:runtime|contract|model)\.js$|\/lib\/(?:engine|plugins)\.js$/, 'no bundled-default facade');
    loaded.add(relative);
  } else assert.ok(result.url.startsWith('node:'), 'only installed files and Node builtins');
  return result;
} });
const api = await import('@divlet/core/native');
const { decodeHtml } = await import('@divlet/core/codec');
assert.match(import.meta.resolve('@divlet/core/native'), /\/dist\/core\/native\.js$/);
const file = path.resolve(process.argv[2], 'project.divlet');
let runtime;
try {
  runtime = await api.openRuntime({ file, watch: false, createDemo: false });
  await runtime.create({ document: decodeHtml('<main id="root" style="color:red"><p>One</p></main>', { fallbackId: 'plain' }) });
  const read = () => runtime.read({ view: 'frame', documentId: 'plain' });
  const version = read().version, textId = Object.values(read().nodes).find(node => node.type === 'text').id;
  assert.deepEqual(runtime.info().clientPlugins, []);
  await runtime.patch({ documentId: 'plain', expectedVersion: version, patch: { nodes: { root: { style: { color: 'blue' } }, [textId]: { content: 'Two' } } } });
  const accepted = read(), source = await readFile(file, 'utf8');
  for (const [expectedVersion, patch, code] of [
    [version, { name: 'stale' }, 'REVISION_CONFLICT'],
    [accepted.version, { nodes: { root: { style: { color: 'red;display:none' } } } }, 'INVALID_DOCUMENT'],
    [accepted.version, { nodes: { root: { styles: { color: 'green' } } } }, 'NO_STYLE_ENGINE'],
  ]) {
    await assert.rejects(runtime.patch({ documentId: 'plain', expectedVersion, patch }), { code });
    assert.deepEqual(read(), accepted); assert.equal(await readFile(file, 'utf8'), source);
  }
  await runtime.undo(); assert.equal(read().nodes.root.style.color, 'red');
  await runtime.redo(); assert.equal(read().nodes.root.style.color, 'blue');
  const rendered = await fetch(runtime.info().documents[0].viewUrl);
  assert.equal(rendered.status, 200); assert.match(await rendered.text(), /color:blue/);
  assert.equal((await fetch(runtime.url)).status, 200);
  assert.match((await runtime.exportDocument('plain')).html, /Two/);
  const saved = read(); await runtime.close(); runtime = null;
  await rm(path.join(path.dirname(file), '.divlet'), { recursive: true, force: true });
  runtime = await api.openRuntime({ file, watch: false, createDemo: false });
  assert.deepEqual(read(), saved, 'cache-free reopen uses the accepted source');
  const importer = { id: 'host-input', label: 'Host input', extensions: ['.host'], async claims() { return false; }, convert(bytes) {
    assert.equal(new TextDecoder().decode(bytes), 'host input'); return { text: source };
  } };
  api.registerImporter(importer);
  const foreign = path.join(path.dirname(file), 'input.host');
  await writeFile(foreign, 'host input');
  const imported = await api.resolveOpenFile(foreign);
  assert.equal(imported.created, true); assert.equal(await readFile(foreign, 'utf8'), 'host input');
  assert.equal(JSON.parse(await readFile(imported.file, 'utf8')).frames.length, 1);
  let lowered = 0;
  const engine = { id: 'host-style', async compileClasses() { return ''; }, async createClassResourceMapper() { return async () => null; }, applyStyles(classes, styles) {
    assert.equal(this, engine); assert.equal(styles.padding, '2px'); lowered++; return `${classes} host-custom`.trim();
  } };
  api.registerStyleEngine(engine);
  await runtime.patch({ documentId: 'plain', expectedVersion: read().version, patch: { nodes: { root: { styles: { padding: '2px' } } } } });
  assert.equal(lowered, 1); assert.match(read().nodes.root.className, /host-custom/);
  console.log(JSON.stringify({ status: 'passed', mode: 'installed-native', modules: loaded.size, registeredHostProviders: true }));
} finally { await runtime?.close(); }
