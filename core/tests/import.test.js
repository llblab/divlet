import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importSource as importPen, importedName } from '../lib/import.ts';
import { launch } from '../lib/launch.ts';
import { listProjects, resolveProject } from '../lib/projects.ts';
import { openRuntime } from '../lib/runtime.js';

const simple = () => ({ version: '2.21', fileToken: 'private-token', variables: { 'ink/primary': { type: 'color', value: '#123456' } }, children: [
  { id: 'page', type: 'frame', name: 'Landing Page', x: 0, y: 0, width: 320, height: 200, layout: 'vertical', padding: 16, gap: 8, fill: '#e8d5a8', children: [
    { id: 'title', type: 'text', content: 'Imported title', width: 180, height: 24, fontSize: 14, fontWeight: 500, lineHeight: 1.5, fill: '$ink/primary' },
  ] },
  { id: 'shared', type: 'frame', reusable: true, x: 400, y: 0, width: 150, height: 40, children: [{ id: 'label', type: 'text', content: 'Shared' }] },
  { id: 'screen', type: 'frame', name: 'Screen', x: 0, y: 300, width: 390, height: 480, children: [{ id: 'instance', type: 'ref', ref: 'shared' }] },
] });

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-import-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('opening a .pen converts it into a sibling Divlet project and leaves the .pen byte-identical', async t => {
  const dir = await workspace(t), pen = path.join(dir, 'landing.pen'), text = JSON.stringify(simple(), null, 1);
  await fs.writeFile(pen, text);
  const result = await importPen(pen);
  assert.equal(result.file, path.join(dir, 'landing.divlet')); assert.equal(importedName(pen), result.file);
  assert.equal(result.created, true); assert.equal(result.frames, 3);
  assert.ok(result.utilities > 0);
  assert.equal(await fs.readFile(pen, 'utf8'), text, 'the PEN file is never rewritten');
  const project = JSON.parse(await fs.readFile(result.file, 'utf8'));
  assert.equal(project.schemaVersion, 2, 'a Divlet project, not a PEN document');
  assert.deepEqual(project.metadata.import, { source: 'landing.pen', format: 'pen', sha256: sha(Buffer.from(text)), bytes: Buffer.byteLength(text) });
  assert.deepEqual(project.frames.map(frame => frame.name), ['Landing Page', 'shared', 'Screen']);
  assert.equal(project.tokens['--color-ink-primary'], '#123456', 'color variables become shared tokens');
  const page = project.frames[0], serialized = JSON.stringify(page);
  assert.ok(!serialized.includes('data-pen-style') && !serialized.includes('"pen"'), 'no PEN style bundles or provenance remain');
  const root = page.nodes[page.rootId];
  for (const expected of ['flex', 'flex-col', 'gap-[8px]', 'p-[16px]', 'w-[320px]', 'bg-[#e8d5a8]']) assert.ok(root.className.split(' ').includes(expected), `${expected} in ${root.className}`);
  const title = Object.values(page.nodes).find(node => node.type === 'element' && node.className.includes('text-[length:14px]'));
  assert.ok(title.className.includes('text-[color:var(--color-ink-primary)]'), 'a literal that is one variable\'s value refers to its token');
  const screen = project.frames[2], instance = Object.values(screen.nodes).find(node => node.type === 'ref');
  assert.ok(instance, 'a component instance stays an instance of its component');
  const definition = Object.values(project.frames[1].nodes).find(node => node.reusable === true);
  assert.equal(instance.ref, `${project.frames[1].id}/${definition.id}`);
});

test('importing is idempotent and never overwrites an existing or hand-edited Divlet project', async t => {
  const dir = await workspace(t), pen = path.join(dir, 'a.pen'), divlet = path.join(dir, 'a.divlet');
  await fs.writeFile(pen, JSON.stringify(simple()));
  assert.equal((await importPen(pen)).created, true);
  const edited = JSON.stringify({ ...JSON.parse(await fs.readFile(divlet, 'utf8')), name: 'Edited by hand' });
  await fs.writeFile(divlet, edited);
  assert.deepEqual(await importPen(pen), { file: divlet, created: false, frames: 0, utilities: 0, arbitrary: 0 });
  assert.equal(await fs.readFile(divlet, 'utf8'), edited);
  await fs.writeFile(pen, 'not json at all');
  assert.equal((await importPen(pen)).created, false);
});

test('the converted project opens as an ordinary Divlet project, edits like one, and renders what the PEN rendered', async t => {
  const dir = await workspace(t), pen = path.join(dir, 'mixed.pen');
  await fs.writeFile(pen, JSON.stringify(simple()));
  const result = await importPen(pen);
  const runtime = await openRuntime({ file: result.file, watch: false, createDemo: false });
  t.after(() => runtime.close());
  const documents = runtime.info().documents;
  assert.equal(documents.length, 3);
  const landing = runtime.read({ view: 'document', documentId: documents[0].id });
  const title = Object.values(landing.nodes).find(node => node.type === 'text' && node.content === 'Imported title');
  await runtime.patch({ documentId: landing.id, expectedVersion: landing.version, patch: { nodes: { [title.id]: { content: 'Edited title' } } } });
  assert.match(await fs.readFile(result.file, 'utf8'), /Edited title/, 'edits land in the Divlet project');
  assert.equal(await fs.readFile(pen, 'utf8'), JSON.stringify(simple()));
  const html = await fs.readFile(path.join(dir, '.divlet', 'mixed', (await fs.readdir(path.join(dir, '.divlet', 'mixed'))).find(name => name.endsWith('.html'))), 'utf8');
  assert.match(html, /<style/);
});

test('invalid or unsupported PEN sources are not converted: nothing is created and the file opens as itself', async t => {
  const dir = await workspace(t), pen = path.join(dir, 'broken.pen');
  await fs.writeFile(pen, '{"version":"2.21","children":');
  await assert.rejects(importPen(pen), { code: 'INVALID_PROJECT' });
  await assert.rejects(fs.lstat(path.join(dir, 'broken.divlet')), { code: 'ENOENT' });
  const opened = [];
  const result = await launch(pen, { openBoard: async location => { opened.push(location.file); return { info: () => ({ url: 'x' }) }; } });
  assert.equal(result.kind, 'project'); assert.deepEqual(opened, [pen]); assert.equal(result.imported, undefined);
});

test('launch opens the converted project, reports the import once and reuses it afterwards', async t => {
  const dir = await workspace(t), pen = path.join(dir, 'design.pen');
  await fs.writeFile(pen, JSON.stringify(simple()));
  const runtimes = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); });
  const openBoard = async location => { const runtime = await openRuntime({ ...location, watch: false, createDemo: false }); runtimes.push(runtime); return runtime; };
  const first = await launch(pen, { openBoard });
  assert.equal(first.runtime.projectPath, path.join(dir, 'design.divlet'));
  assert.equal(first.imported.from, pen); assert.equal(first.imported.to, path.join(dir, 'design.divlet')); assert.equal(first.imported.frames, 3);
  await fs.access(path.join(dir, '.divlet', 'design')); // The generated HTML cache sits beside the project.
  const second = await launch(pen, { openBoard });
  assert.equal(second.runtime.projectPath, first.runtime.projectPath); assert.equal(second.imported, undefined);
});

test('a PEN and its Divlet project appear once in collections and resolve to the project', async t => {
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'a.pen'), JSON.stringify(simple()));
  await fs.writeFile(path.join(dir, 'b.pen'), JSON.stringify(simple()));
  assert.deepEqual((await listProjects(dir)).map(project => path.basename(project.file)).sort(), ['a.pen', 'b.pen']);
  await importPen(path.join(dir, 'a.pen'));
  assert.deepEqual((await listProjects(dir)).map(project => path.basename(project.file)).sort(), ['a.divlet', 'b.pen']);
  await importPen(path.join(dir, 'b.pen'));
  assert.deepEqual((await listProjects(dir)).map(project => path.basename(project.file)).sort(), ['a.divlet', 'b.divlet']);
  const single = await workspace(t);
  await fs.writeFile(path.join(single, 'only.pen'), JSON.stringify(simple()));
  await importPen(path.join(single, 'only.pen'));
  assert.equal((await resolveProject(single)).file, path.join(single, 'only.divlet'));
});

test('a project notices when its imported source changed, and importing again makes a new sibling project', async t => {
  const { importStatus, importAgain, importSource } = await import('../lib/import.ts');
  const dir = await workspace(t);
  const source = path.join(dir, 'design.pen');
  await fs.writeFile(source, JSON.stringify(simple()));
  const { file } = await importSource(source);
  const metadata = JSON.parse(await fs.readFile(file, 'utf8')).metadata;
  assert.deepEqual(await importStatus(file, metadata), { source: 'design.pen', changed: false });
  const changed = simple(); changed.children[0].name = 'Renamed';
  await fs.writeFile(source, JSON.stringify(changed));
  assert.deepEqual(await importStatus(file, metadata), { source: 'design.pen', changed: true });
  const before = await fs.readFile(file);
  const again = await importAgain(file, metadata);
  assert.equal(path.basename(again.file), 'design-2.divlet');
  assert.equal((await importAgain(file, metadata)).file.endsWith('design-3.divlet'), true, 'never overwrites an earlier re-import');
  assert.deepEqual(await fs.readFile(file), before, 'the current project is untouched');
  assert.equal(await importStatus(file, {}), null, 'a project that was not imported has no source');
  assert.equal(await importStatus(file, { import: { source: '../etc/passwd', sha256: 'x' } }), null, 'a source outside the folder is ignored');
});

test('an HTML page opens by path (converted beside it) but is not offered as a project in folder listings', async t => {
  const { resolveProject } = await import('../lib/projects.ts');
  const { resolveOpenFile } = await import('../lib/import.ts');
  const dir = await workspace(t);
  const page = path.join(dir, 'landing.html');
  await fs.writeFile(page, '<!doctype html><title>Landing</title><body><h1>Hi</h1><script>x()</script></body>');
  const folder = await resolveProject(dir);
  assert.notEqual(folder.kind, 'project', 'a folder holding only .html files does not treat them as projects');
  assert.ok(!JSON.stringify(folder).includes('landing.html'));
  const direct = await resolveProject(page);
  assert.equal(direct.kind, 'project');
  const opened = await resolveOpenFile(direct.file);
  assert.equal(path.basename(opened.file), 'landing.divlet');
  assert.equal(opened.created, true);
  assert.equal(await fs.readFile(page, 'utf8'), '<!doctype html><title>Landing</title><body><h1>Hi</h1><script>x()</script></body>', 'the page is untouched');
  const project = JSON.parse(await fs.readFile(opened.file, 'utf8'));
  assert.equal(project.metadata.import.format, 'html');
  const runtime = await openRuntime({ file: opened.file, watch: false, createDemo: false });
  t.after(() => runtime.close());
  assert.equal(runtime.info().documents.length, 1);
});

test('a page dropped into a folder of its own uses native external-HTML admission, not strict cache decoding', async t => {
  const dir = await workspace(t);
  const text = '<!doctype html><title>Folder page</title><link rel="stylesheet" href="x.css"><style>.x{color:red}</style><body class="p-4"><main class="x" onclick="go()"><h1>Hello</h1><p>World</p><script>alert(1)</script></main></body>';
  await fs.writeFile(path.join(dir, 'dropped.html'), text);
  const runtime = await openRuntime({ cwd: dir, watch: false, createDemo: false });
  t.after(() => runtime.close());
  const frames = runtime.info().documents;
  assert.equal(frames.length, 1, 'the page becomes a frame instead of failing as INVALID_HTML');
  const frame = runtime.read({ view: 'frame', documentId: frames[0].id });
  assert.equal(frame.name, 'Folder page');
  assert.equal(frame.css, '.x{color:red}', 'head styles are kept');
  assert.deepEqual(frame.metadata.import, { source: 'dropped.html', format: 'html', dropped: { scripts: 1, comments: 0, links: 1, handlers: 1, frames: 0 } });
  const serialized = JSON.stringify(frame);
  assert.ok(!serialized.includes('alert(1)') && !serialized.includes('onclick'), 'scripts and handlers are dropped');
  assert.ok(!(await fs.readdir(dir)).includes('dropped.html'), 'the source moves to divlet/.trash once it is a frame');
  assert.ok(runtime.info().diagnostics.length === 0 || !runtime.info().diagnostics.some(item => item.code === 'INVALID_HTML'));
});

test('a page dropped into a project folder becomes a frame through the same native HTML admission', async t => {
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'project.divlet'), JSON.stringify({ schemaVersion: 2, name: 'Dropped', version: 1, tokens: {}, css: '', metadata: {}, frames: [
    { id: 'kept', name: 'Kept', version: 1, artboard: { x: 0, y: 0, width: 320, height: 200 }, rootId: 'root', tokens: {}, css: '', metadata: {}, nodes: { root: { id: 'root', type: 'element', tag: 'main', className: 'p-4', attrs: {}, style: {}, metadata: {}, children: [] } } },
  ] }));
  const runtime = await openRuntime({ cwd: dir, watch: false, createDemo: false });
  t.after(() => runtime.close());
  const page = '<!doctype html><title>Dropped in</title><link rel="stylesheet" href="y.css"><body><section onclick="go()"><h2>Hi</h2><script>alert(1)</script></section></body>';
  await fs.writeFile(path.join(dir, 'dropped-in.html'), page);
  await runtime.scan();
  const documents = runtime.info().documents;
  assert.deepEqual(documents.map(doc => doc.id), ['kept', 'dropped-in']);
  const frame = runtime.read({ view: 'frame', documentId: 'dropped-in' });
  assert.equal(frame.name, 'Dropped in');
  assert.deepEqual(frame.metadata.import, { source: 'dropped-in.html', format: 'html', dropped: { scripts: 1, comments: 0, links: 1, handlers: 1, frames: 0 } });
  assert.ok(!JSON.stringify(frame).includes('alert(1)'));
  assert.ok(!(await fs.readdir(dir)).includes('dropped-in.html'), 'the source is kept in divlet/.trash, not beside the project');
  assert.equal(runtime.info().diagnostics.filter(item => item.code === 'INVALID_HTML').length, 0);
});
