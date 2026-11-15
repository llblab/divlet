// Live source styles use the same exact session blocks as tool history; invalid/racing candidates stay unaccepted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openRuntime } from '@divlet/core/runtime';
import { readProject } from '@divlet/core/project';
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
  // Keep real Undo/Redo groups and a captured selection across source acceptance or refusal.
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

for (const kind of ['literal', 'override']) test(`live ${kind} order-only source edits use exact history blocks`, async t => {
  const { runtime, file } = await fixture(t, kind);
  const read = () => location({ frames: [runtime.getEntry('definitions').document, runtime.getEntry('consumer').document] }, kind).style;
  const original = Object.entries(read()), selected = structuredClone(runtime.selection), point = runtime.historyHead().pointId;
  const source = JSON.parse(await fs.readFile(file, 'utf8'));
  location(source, kind).style = reordered;
  await fs.writeFile(file, JSON.stringify(source)); await runtime.scan();
  assert.equal(runtime.diagnostics.has(file), false, 'whole-block history makes the old merge-only source refusal obsolete');
  assert.deepEqual(Object.entries(read()), Object.entries(reordered));
  assert.deepEqual(runtime.selection, selected, 'content/history do not manufacture a new captured selection');
  assert.notEqual(runtime.historyHead().pointId, point);
  await runtime.undo(); assert.deepEqual(Object.entries(read()), original);
  await runtime.redo(); assert.deepEqual(Object.entries(read()), Object.entries(reordered));
});

const transitions = ['literal', 'override'].flatMap(kind => [
  ['order only', reordered],
  ['order and value', { padding: '11px', 'padding-left': '20px' }],
  ['inverse cannot restore removed first property', { padding: '10px' }],
  ...(kind === 'override' ? [['stored null operation cannot become a sparse patch deletion', { 'padding-left': '20px', padding: null }]] : []),
].map(([name, style]) => ({ kind, name, edit: source => { location(source, kind).style = style; } })));
const storedNull = { 'padding-left': null, padding: '10px' };
transitions.push(
  { kind: 'literal', name: 'collateral project metadata null', edit: source => { source.frames[0].nodes.button.style = reordered; source.metadata = { literal: null }; } },
  { kind: 'literal', name: 'project-only null insertion', edit: source => { source.metadata = { literal: null, nested: { value: null }, toString: null }; } },
  { kind: 'literal', name: 'project null restoration', setup: source => { source.metadata = { literal: null, nested: { value: null } }; }, edit: source => { source.metadata = {}; } },
  { kind: 'override', name: 'stored-null node removal', initialStyle: storedNull, edit: source => { delete source.frames[1].nodes.instance; source.frames[1].nodes.root.children = []; } },
  { kind: 'override', name: 'stored-null address removal', initialStyle: storedNull, edit: source => { delete source.frames[1].nodes.instance.descendants.button; } },
  { kind: 'override', name: 'stored-null node creation', edit: source => {
    source.frames[1].nodes.second = { ...structuredClone(source.frames[1].nodes.instance), id: 'second', descendants: { button: { style: storedNull } } };
    source.frames[1].nodes.root.children.push('second');
  } },
  { kind: 'override', name: 'stored-null address creation', setup: source => { delete source.frames[1].nodes.instance.descendants.button; }, edit: source => { source.frames[1].nodes.instance.descendants.button = { style: storedNull }; } },
  { kind: 'override', name: 'opaque null insertion within a retained node', edit: source => { source.frames[1].nodes.instance.metadata.later = null; } },
  { kind: 'override', name: 'opaque null restoration within a retained node', edit: source => { source.frames[1].nodes.instance.metadata = { literal: 'Changed' }; } },
  { kind: 'override', name: 'stored-null attribute operation within a retained node', edit: source => { source.frames[1].nodes.instance.descendants.button.attrs = { title: null }; } },
  { kind: 'literal', name: 'frame metadata null insertion', edit: source => { source.frames[0].metadata = { literal: null, nested: { value: null }, toString: null }; } },
  { kind: 'override', name: 'nullable override address creation', setup: source => { delete source.frames[1].nodes.instance.descendants.button; }, edit: source => { source.frames[1].nodes.instance.descendants.button = { attrs: { title: null }, metadata: { literal: null }, style: storedNull }; } },
  { kind: 'override', name: 'nullable override address removal', setup: source => { source.frames[1].nodes.instance.descendants.button = { attrs: { title: null }, metadata: { literal: null }, style: storedNull }; }, edit: source => { delete source.frames[1].nodes.instance.descendants.button; } },
);
const digest = text => createHash('sha256').update(text).digest('hex');
const stylesOf = frames => frames.flatMap(frame => Object.keys(frame.nodes).sort().flatMap(id => {
  const node = frame.nodes[id];
  if (node.type === 'element') return [[frame.id, id, null, Object.entries(node.style ?? {})]];
  return node.type !== 'ref' ? [] : Object.keys(node.descendants ?? {}).sort().flatMap(address => {
    const style = node.descendants[address].style;
    return style === undefined ? [] : [[frame.id, id, address, Object.entries(style)]];
  });
}));
const acceptedStyles = runtime => stylesOf([...runtime.documents.values()].map(entry => entry.document));
const acceptedContent = runtime => [...runtime.documents.values()].map(entry => structuredClone({ ...entry.document, version: 0 }));
const acceptedSettings = runtime => structuredClone({ ...runtime.settings, version: 0 });

for (const { kind, name, edit, initialStyle, setup } of transitions) test(`live ${kind} source accepts and replays ${name} exactly`, async t => {
  const { runtime, file } = await fixture(t, kind, initialStyle, setup);
  runtime.setSelection({ documentId: 'consumer', ids: [runtime.getEntry('consumer').document.rootId] });
  const before = await state(runtime), original = acceptedStyles(runtime), originalContent = acceptedContent(runtime), originalSettings = acceptedSettings(runtime);
  const source = JSON.parse(await fs.readFile(file, 'utf8'));
  edit(source); source.name = 'Accepted external style edit';
  const prepared = readProject(source), expected = stylesOf(source.frames), expectedContent = prepared.frames.map(frame => ({ ...frame, version: 0 })), expectedSettings = { ...prepared.settings, version: 0 };
  await fs.writeFile(file, JSON.stringify(source, null, '\t') + '\r\n');
  await runtime.scan();
  assert.equal(runtime.diagnostics.has(file), false);
  assert.deepEqual(acceptedStyles(runtime), expected);
  assert.deepEqual(acceptedContent(runtime), expectedContent);
  assert.deepEqual(acceptedSettings(runtime), expectedSettings);
  const canonical = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(stylesOf(canonical.frames), expected); assert.deepEqual(canonical.metadata, expectedSettings.metadata);
  assert.equal(runtime.knownHashes.get(file), digest(await fs.readFile(file, 'utf8')));
  assert.deepEqual(runtime.selection, before.selection, 'captured selection is not refreshed by content/history');
  assert.equal(runtime.settings.name, source.name);
  assert.equal(runtime.revision, before.revision + 1);
  assert.equal(runtime.redoStack.length, 0, 'source acceptance discards the prior future');
  assert.ok(runtime.undoStack.at(-1).items.some(item => item.styleBlocks?.length || item.nodeBlocks?.length || item.nullBlocks?.length));
  const point = runtime.historyHead().pointId, accepted = await state(runtime);
  await runtime.scan(); assert.deepEqual(await state(runtime), accepted, 'own canonical write produces no echo');
  for (let iteration = 0; iteration < 2; iteration++) {
    await runtime.undo();
    assert.deepEqual(acceptedStyles(runtime), original);
    assert.deepEqual(acceptedContent(runtime), originalContent);
    assert.deepEqual(acceptedSettings(runtime), originalSettings);
    const undone = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(stylesOf(undone.frames), original); assert.deepEqual(undone.metadata, originalSettings.metadata);
    assert.equal(runtime.historyHead().pointId, before.point);
    await runtime.redo();
    assert.deepEqual(acceptedStyles(runtime), expected);
    assert.deepEqual(acceptedContent(runtime), expectedContent);
    assert.deepEqual(acceptedSettings(runtime), expectedSettings);
    const redone = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(stylesOf(redone.frames), expected); assert.deepEqual(redone.metadata, expectedSettings.metadata);
    assert.equal(runtime.historyHead().pointId, point);
    assert.deepEqual(runtime.selection, before.selection);
  }
  await runtime.patch({ documentId: 'definitions', expectedVersion: runtime.getEntry('definitions').document.version, patch: { nodes: { label: { content: 'Unrelated' } } } });
  assert.deepEqual(acceptedStyles(runtime), expected, 'an unrelated accepted write retains exact style state');
});

async function refusedSource(t, { kind = 'literal', initialStyle, edit, code }) {
  const { runtime, file } = await fixture(t, kind, initialStyle);
  const before = await state(runtime), accepted = await fs.readFile(file, 'utf8');
  const source = JSON.parse(accepted); edit(source);
  const authored = JSON.stringify(source, null, '\t') + '\r\n';
  await fs.writeFile(file, authored); await runtime.scan();
  assert.equal(runtime.diagnostics.get(file)?.code, code);
  assert.deepEqual(await state(runtime), before, 'models/output/selection/revision/settings/history/stacks/point/known hash stay unchanged');
  assert.equal(await fs.readFile(file, 'utf8'), authored);
  assert.equal(runtime.badHashes.get(file), digest(authored));
  await runtime.scan(); assert.deepEqual(await state(runtime), before);
  for (const write of [
    () => runtime.patch({ documentId: 'definitions', expectedVersion: runtime.getEntry('definitions').document.version, patch: { nodes: { label: { content: 'Unrelated' } } } }),
    () => runtime.undo(), () => runtime.redo(),
  ]) await assert.rejects(write, { code: 'EXTERNAL_PENDING' });
  assert.deepEqual(await state(runtime), before);
  assert.equal(await fs.readFile(file, 'utf8'), authored);
  await fs.writeFile(file, accepted); await runtime.scan();
  assert.equal(runtime.diagnostics.has(file), false);
  await runtime.patch({ documentId: 'definitions', expectedVersion: runtime.getEntry('definitions').document.version, patch: { nodes: { label: { content: 'Recovered' } } } });
  assert.equal(runtime.getEntry('definitions').document.nodes.label.content, 'Recovered');
}

for (const row of [
  { name: 'unsafe CSS', edit: source => { source.frames[0].nodes.button.style = { color: 'red;display:none' }; } },
  { name: 'unactivated declaration arrays', edit: source => { source.frames[0].nodes.button.style = [['color', 'red']]; } },
  { name: 'invalid override value', kind: 'override', edit: source => { source.frames[1].nodes.instance.descendants.button.style = { padding: { value: '4px' } }; } },
  { name: 'missing root', edit: source => { source.frames[0].rootId = 'missing'; } },
]) test(`invalid source retains state and authored bytes for ${row.name}`, t => refusedSource(t, { ...row, code: 'INVALID_DOCUMENT' }));

for (const phase of ['prepared candidate', 'output preflight']) test(`source replacement after ${phase} is not overwritten or accepted prematurely`, async t => {
  const { runtime, file } = await fixture(t), before = await state(runtime);
  const base = JSON.parse(await fs.readFile(file, 'utf8'));
  const first = structuredClone(base); first.frames[0].nodes.button.style = reordered; first.name = 'First candidate';
  const winner = structuredClone(base); winner.frames[0].nodes.button.style = { padding: '5px', 'padding-left': '30px' }; winner.name = 'Later source';
  const winnerBytes = JSON.stringify(winner, null, '\t') + '\r\n';
  let injected = false;
  if (phase === 'prepared candidate') {
    const prepare = runtime.prepareAll.bind(runtime);
    runtime.prepareAll = async (...args) => { const value = await prepare(...args); if (!injected) { injected = true; await fs.writeFile(file, winnerBytes); } return value; };
  } else {
    const contents = runtime.fileContents.bind(runtime); let reads = 0;
    runtime.fileContents = async (...args) => {
      const value = await contents(...args);
      if (args[0] === file && ++reads === 2) { injected = true; await fs.writeFile(file, winnerBytes); }
      return value;
    };
  }
  await fs.writeFile(file, JSON.stringify(first)); await runtime.scan();
  assert.equal(injected, true);
  assert.equal(runtime.diagnostics.get(file)?.code, 'FILE_CONFLICT');
  assert.deepEqual(await state(runtime), before);
  assert.equal(await fs.readFile(file, 'utf8'), winnerBytes);
  await runtime.scan();
  assert.equal(runtime.diagnostics.has(file), false);
  assert.deepEqual(acceptedStyles(runtime), stylesOf(winner.frames));
  assert.equal(runtime.settings.name, winner.name);
  assert.equal(runtime.knownHashes.get(file), digest(await fs.readFile(file, 'utf8')));
  await runtime.undo(); assert.deepEqual(acceptedStyles(runtime), stylesOf(base.frames));
  await runtime.redo(); assert.deepEqual(acceptedStyles(runtime), stylesOf(winner.frames));
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
