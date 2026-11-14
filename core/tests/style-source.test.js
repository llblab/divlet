// The draft map profile cannot express every ordered style transition as reversible merge patches.
// Refuse those live source edits before accepting their hash, rather than overwriting them on a later unrelated write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntime } from '@divlet/core/runtime';
import { componentTextProject } from './fixtures/component-text.js';

const initial = { 'padding-left': '20px', padding: '10px' };
const reordered = { padding: '10px', 'padding-left': '20px' };
const location = (project, kind) => kind === 'literal' ? project.frames[0].nodes.button : project.frames[1].nodes.instance.descendants.button;
async function fixture(t, kind = 'literal', style = initial, setup = () => {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-style-source-'));
  const file = path.join(directory, 'project.divlet');
  const source = componentTextProject('button', kind === 'override' ? { button: { style: initial } } : {});
  location(source, kind).style = structuredClone(style);
  setup(source);
  await fs.writeFile(file, JSON.stringify(source));
  const runtime = await openRuntime({ file, watch: false, createDemo: false });
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  // Retain real stack/point authority and a captured selection through the refusal.
  await runtime.patch({ documentId: 'definitions', expectedVersion: runtime.getEntry('definitions').document.version, patch: { nodes: { label: { content: 'Accepted' } } } });
  await runtime.patch({ documentId: 'consumer', expectedVersion: runtime.getEntry('consumer').document.version, patch: { name: 'Temporary' } });
  await runtime.undo(); // Leave both a real Undo group and a real Redo group available.
  runtime.setSelection({ documentId: 'consumer', ids: ['instance'] });
  return { runtime, file, kind };
}
async function state(runtime) {
  return {
    documents: [...runtime.documents].map(([id, item]) => [id, structuredClone(item.document), item.render, item.html, item.fileHtml]),
    outputs: await Promise.all([...runtime.documents.values()].flatMap(item => [item.htmlPath, item.metaPath]).map(async file => [file, await fs.readFile(file, 'utf8')])),
    selection: structuredClone(runtime.selection), revision: runtime.revision, settings: structuredClone(runtime.settings),
    history: structuredClone(runtime.history), undo: structuredClone(runtime.undoStack), redo: structuredClone(runtime.redoStack),
    point: runtime.historyHead().pointId, hash: runtime.knownHashes.get(runtime.projectPath),
  };
}

const refusals = ['literal', 'override'].flatMap(kind => [
  ['order only', reordered],
  ['order and value', { padding: '11px', 'padding-left': '20px' }],
  ['inverse cannot restore removed first property', { padding: '10px' }],
  ...(kind === 'override' ? [['stored null operation cannot become a sparse patch deletion', { 'padding-left': '20px', padding: null }]] : []),
].map(([name, style]) => ({ kind, name, edit: source => { location(source, kind).style = style; } })));
const storedNull = { 'padding-left': null, padding: '10px' };
refusals.push(
  { kind: 'override', name: 'stored-null node removal', initialStyle: storedNull, edit: source => { delete source.frames[1].nodes.instance; source.frames[1].nodes.root.children = []; } },
  { kind: 'override', name: 'stored-null address removal', initialStyle: storedNull, edit: source => { delete source.frames[1].nodes.instance.descendants.button; } },
  { kind: 'override', name: 'stored-null node creation', edit: source => {
    source.frames[1].nodes.second = { ...structuredClone(source.frames[1].nodes.instance), id: 'second', descendants: { button: { style: storedNull } } };
    source.frames[1].nodes.root.children.push('second');
  } },
  { kind: 'override', name: 'stored-null address creation', setup: source => { delete source.frames[1].nodes.instance.descendants.button; }, edit: source => { source.frames[1].nodes.instance.descendants.button = { style: storedNull }; } },
);
for (const { kind, name, edit, initialStyle, setup } of refusals) test(`live ${kind} source refuses ${name} without accepting its hash or losing bytes`, async t => {
  const { runtime, file } = await fixture(t, kind, initialStyle, setup);
  const before = await state(runtime);
  const accepted = await fs.readFile(file, 'utf8');
  const source = JSON.parse(accepted);
  edit(source);
  source.name = 'Collateral change must not commit';
  const authored = JSON.stringify(source, null, '\t') + '\r\n';
  await fs.writeFile(file, authored);
  await runtime.scan();
  assert.equal(runtime.diagnostics.get(file)?.code, 'UNSUPPORTED_STYLE_REPLAY');
  assert.deepEqual(await state(runtime), before, 'accepted model, output, selection, hashes and complete stacks stay unchanged');
  assert.equal(await fs.readFile(file, 'utf8'), authored);
  await runtime.scan();
  assert.deepEqual(await state(runtime), before, 'repeat reads do not accept the rejected source hash');
  for (const write of [
    () => runtime.patch({ documentId: 'definitions', expectedVersion: runtime.getEntry('definitions').document.version, patch: { nodes: { label: { content: 'Unrelated' } } } }),
    () => runtime.undo(),
    () => runtime.redo(),
  ]) await assert.rejects(write, { code: 'EXTERNAL_PENDING' });
  assert.deepEqual(await state(runtime), before);
  assert.equal(await fs.readFile(file, 'utf8'), authored, 'an unrelated edit cannot overwrite the authored declaration order');
  await fs.writeFile(file, accepted);
  await runtime.scan();
  assert.equal(runtime.diagnostics.has(file), false, 'restoring the accepted source clears the guard');
  await runtime.patch({ documentId: 'definitions', expectedVersion: runtime.getEntry('definitions').document.version, patch: { nodes: { label: { content: 'Recovered' } } } });
  assert.equal(runtime.getEntry('definitions').document.nodes.label.content, 'Recovered');
});

for (const kind of ['literal', 'override']) test(`replayable ${kind} style source edits still accept, save and replay exact declaration sequences`, async t => {
  const { runtime, file } = await fixture(t, kind);
  const read = () => location({ frames: [runtime.getEntry('definitions').document, runtime.getEntry('consumer').document] }, kind).style;
  const before = Object.entries(read());
  const source = JSON.parse(await fs.readFile(file, 'utf8'));
  location(source, kind).style = { 'padding-left': '24px', padding: '12px', color: 'red' };
  const expected = Object.entries(location(source, kind).style);
  await fs.writeFile(file, JSON.stringify(source));
  await runtime.scan();
  assert.equal(runtime.diagnostics.has(file), false);
  assert.deepEqual(Object.entries(read()), expected);
  assert.deepEqual(Object.entries(location(JSON.parse(await fs.readFile(file, 'utf8')), kind).style), expected);
  await runtime.undo(); assert.deepEqual(Object.entries(read()), before);
  await runtime.redo(); assert.deepEqual(Object.entries(read()), expected);
});

for (const kind of ['literal', 'override']) test(`freshly opened ${kind} source retains its authored map order`, async t => {
  const { runtime, file } = await fixture(t, kind, reordered);
  const source = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.entries(location(source, kind).style), Object.entries(reordered));
  assert.deepEqual(Object.entries(location({ frames: [runtime.getEntry('definitions').document, runtime.getEntry('consumer').document] }, kind).style), Object.entries(reordered));
  assert.equal(runtime.diagnostics.size, 0, 'this is a live replay boundary, not a new reader refusal');
});

for (const style of [{}, initial]) test(`override style-container absence and ${Object.keys(style).length ? 'nonempty map' : 'empty map'} replay in both directions`, async t => {
  const { runtime, file } = await fixture(t, 'override', {}, source => { delete location(source, 'override').style; });
  const read = () => {
    const node = runtime.getEntry('consumer').document.nodes.instance.descendants.button;
    return Object.hasOwn(node, 'style') ? { present: true, entries: Object.entries(node.style) } : { present: false };
  };
  const before = read();
  assert.deepEqual(before, { present: false });
  const source = JSON.parse(await fs.readFile(file, 'utf8'));
  location(source, 'override').style = style;
  await fs.writeFile(file, JSON.stringify(source)); await runtime.scan();
  assert.equal(runtime.diagnostics.has(file), false);
  const expected = { present: true, entries: Object.entries(style) };
  assert.deepEqual(read(), expected);
  await runtime.undo(); assert.deepEqual(read(), before);
  assert.equal(Object.hasOwn(location(JSON.parse(await fs.readFile(file, 'utf8')), 'override'), 'style'), false);
  await runtime.redo(); assert.deepEqual(read(), expected);
  assert.deepEqual(Object.entries(location(JSON.parse(await fs.readFile(file, 'utf8')), 'override').style), expected.entries);
});

test('existing stored-null style operations survive an unrelated source edit and history via the unchanged-style fast path', async t => {
  const { runtime, file } = await fixture(t, 'override', storedNull);
  const read = () => Object.entries(runtime.getEntry('consumer').document.nodes.instance.descendants.button.style);
  const expected = Object.entries(storedNull);
  assert.deepEqual(read(), expected);
  const source = JSON.parse(await fs.readFile(file, 'utf8'));
  source.frames[1].metadata = { note: 'Unrelated to the style operation' };
  await fs.writeFile(file, JSON.stringify(source)); await runtime.scan();
  assert.equal(runtime.diagnostics.has(file), false);
  assert.deepEqual(read(), expected);
  await runtime.undo(); assert.deepEqual(read(), expected);
  await runtime.redo(); assert.deepEqual(read(), expected);
  assert.deepEqual(Object.entries(location(JSON.parse(await fs.readFile(file, 'utf8')), 'override').style), expected);
});

test('styled literal-node lifecycle keeps exact sequences through external acceptance and Undo/Redo', async t => {
  const { runtime, file } = await fixture(t);
  const source = JSON.parse(await fs.readFile(file, 'utf8'));
  const style = { padding: '3px', color: 'red' };
  source.frames[0].nodes.extra = { id: 'extra', type: 'element', tag: 'aside', style, children: [] };
  source.frames[0].nodes.root.children.push('extra');
  await fs.writeFile(file, JSON.stringify(source)); await runtime.scan();
  const read = () => runtime.getEntry('definitions').document.nodes.extra;
  assert.equal(runtime.diagnostics.has(file), false);
  assert.deepEqual(Object.entries(read().style), Object.entries(style));
  await runtime.undo(); assert.equal(read(), undefined);
  await runtime.redo(); assert.deepEqual(Object.entries(read().style), Object.entries(style));
  const removed = JSON.parse(await fs.readFile(file, 'utf8'));
  delete removed.frames[0].nodes.extra;
  removed.frames[0].nodes.root.children = removed.frames[0].nodes.root.children.filter(id => id !== 'extra');
  await fs.writeFile(file, JSON.stringify(removed)); await runtime.scan();
  assert.equal(runtime.diagnostics.has(file), false);
  assert.equal(read(), undefined);
  await runtime.undo(); assert.deepEqual(Object.entries(read().style), Object.entries(style));
  await runtime.redo(); assert.equal(read(), undefined);
});

test('opaque metadata records named style retain unordered-record draft equality', async t => {
  const { runtime, file } = await fixture(t);
  let source = JSON.parse(await fs.readFile(file, 'utf8'));
  source.frames[0].nodes.label.metadata = { style: { one: 1, two: 2 } };
  await fs.writeFile(file, JSON.stringify(source)); await runtime.scan();
  const before = await state(runtime);
  source = JSON.parse(await fs.readFile(file, 'utf8'));
  source.frames[0].nodes.label.metadata.style = { two: 2, one: 1 };
  await fs.writeFile(file, JSON.stringify(source)); await runtime.scan();
  assert.equal(runtime.diagnostics.has(file), false);
  const after = await state(runtime);
  assert.notEqual(after.hash, before.hash, 'nonsemantic metadata order still adopts the new source hash');
  assert.deepEqual({ ...after, hash: before.hash }, before);
});
