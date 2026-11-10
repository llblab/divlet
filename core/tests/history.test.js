import test from 'node:test';
import { legacyProject } from './fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntime } from '../lib/runtime.js';
import { applyDocumentPatch, createDemoDocument, validateDocument } from '../lib/model.ts';
import { diffDocuments, summarizeChange } from '../lib/diff.ts';
import { operationPatch } from '../lib/ops.ts';

const strip = doc => ({ ...doc, version: 0 });

async function fixture(t, options = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-history-'));
  await legacyProject(path.join(cwd, 'project.divlet'));
  const runtime = await openRuntime({ cwd, watch: false, createDemo: false, ...options });
  t.after(async () => { await runtime.close(); await fs.rm(cwd, { recursive: true, force: true }); });
  await runtime.create({ document: createDemoDocument(), actor: 'system', undoable: false });
  return { cwd, runtime, id: 'welcome' };
}

test('diffDocuments yields the minimal patch that reproduces the target document', () => {
  const a = createDemoDocument();
  const edits = [
    { name: 'Renamed', artboard: { x: 5, width: 400 } },
    { tokens: { '--accent': null, '--extra': '#fff' }, metadata: { intent: null, note: { deep: [1, 2] } } },
    { nodes: { title: { className: 'text-2xl', style: { color: 'red' } }, 'title-text': { content: 'Changed' } } },
    { nodes: { cards: { children: ['card-three', 'card-two', 'card-one', 'extra'] }, extra: { id: 'extra', type: 'element', tag: 'div', children: [] } } },
  ];
  for (const edit of edits) {
    const target = applyDocumentPatch(a, edit);
    const patch = diffDocuments(a, target);
    assert.deepEqual(strip(applyDocumentPatch(a, patch)), strip(target));
    assert.deepEqual(diffDocuments(target, target), {});
    assert.deepEqual(strip(applyDocumentPatch(target, diffDocuments(target, a))), strip(a));
  }
  const removed = applyDocumentPatch(a, operationPatch(a, { type: 'remove', ids: ['cards'] }).patch);
  assert.deepEqual(strip(applyDocumentPatch(a, diffDocuments(a, removed))), strip(removed));
  assert.deepEqual(strip(applyDocumentPatch(removed, diffDocuments(removed, a))), strip(a));
  const summary = summarizeChange(a, applyDocumentPatch(a, { artboard: { x: 9 }, nodes: { 'title-text': { content: 'x' } } }));
  assert.match(summary.text, /moved to 9, 100/);
  assert.deepEqual(summary.nodes.changed, { 'title-text': ['content'] });
});

test('node operations produce valid patches', () => {
  const doc = createDemoDocument();
  const apply = op => { const result = operationPatch(doc, op); return { ...result, doc: applyDocumentPatch(doc, result.patch) }; };
  assert.ok(apply({ type: 'duplicate', id: 'card-one' }).doc.nodes['card-one-copy']);
  assert.equal(apply({ type: 'duplicate', id: 'card-one' }).doc.nodes.cards.children[1], 'card-one-copy');
  const removed = apply({ type: 'remove', ids: ['cards'] });
  assert.ok(!removed.doc.nodes['card-one'] && removed.removed.includes('card-one-title-text'));
  assert.deepEqual(apply({ type: 'move', id: 'cta', parentId: 'nav', index: 1 }).doc.nodes.nav.children, ['brand', 'cta', 'status']);
  assert.throws(() => operationPatch(doc, { type: 'move', id: 'cards', parentId: 'card-one', index: 0 }), /into itself/);
  assert.throws(() => operationPatch(doc, { type: 'remove', ids: ['root'] }), /root/);
  const inserted = apply({ type: 'insert', parentId: 'hero', spec: 'button' });
  assert.equal(inserted.doc.nodes[inserted.ids[0]].tag, 'button');
  assert.equal(apply({ type: 'text', id: 'title', content: 'Hi' }).doc.nodes['title-text'].content, 'Hi');
  assert.throws(() => operationPatch(doc, { type: 'text', id: 'card-one', content: 'x' }), /mixes|text/);
});

test('wrap, unwrap, relative insert/move and multi-duplicate produce valid patches', () => {
  const doc = createDemoDocument();
  const apply = (op, base = doc) => { const result = operationPatch(base, op); return { ...result, doc: applyDocumentPatch(base, result.patch) }; };
  const wrapped = apply({ type: 'wrap', ids: ['description', 'title'] });
  const group = wrapped.ids[0];
  assert.equal(group, 'group');
  assert.deepEqual(wrapped.doc.nodes[group].children, ['title', 'description'], 'wrapped siblings keep document order');
  assert.equal(wrapped.doc.nodes.hero.children.indexOf(group), doc.nodes.hero.children.indexOf('title'));
  assert.throws(() => operationPatch(doc, { type: 'wrap', ids: ['title', 'card-one'] }), /siblings/);
  const unwrapped = apply({ type: 'unwrap', id: group }, wrapped.doc);
  assert.deepEqual(unwrapped.doc.nodes.hero.children, doc.nodes.hero.children);
  assert.deepEqual(unwrapped.removed, [group]);
  assert.throws(() => operationPatch(doc, { type: 'unwrap', id: 'root' }), /root/);
  const after = apply({ type: 'insert', after: 'title', spec: { tag: 'p', id: 'kicker', text: 'Hello', className: 'text-sm' } });
  assert.deepEqual(after.ids, ['kicker']);
  assert.equal(after.doc.nodes.hero.children.indexOf('kicker'), doc.nodes.hero.children.indexOf('title') + 1);
  const list = apply({ type: 'insert', parentId: 'hero', spec: 'list' });
  assert.equal(list.doc.nodes[list.ids[0]].children.length, 2);
  assert.equal(list.doc.nodes[list.doc.nodes[list.ids[0]].children[0]].tag, 'li');
  assert.throws(() => operationPatch(doc, { type: 'insert', parentId: 'hero', spec: { tag: 'div', onclick: 'x' } }), /Unsupported insert spec/);
  const moved = apply({ type: 'move', id: 'card-three', before: 'card-one' });
  assert.deepEqual(moved.doc.nodes.cards.children, ['card-three', 'card-one', 'card-two']);
  assert.deepEqual(apply({ type: 'move', id: 'card-one', after: 'card-three' }).doc.nodes.cards.children, ['card-two', 'card-three', 'card-one']);
  assert.equal(apply({ type: 'move', id: 'cta', parentId: 'nav' }).doc.nodes.nav.children.at(-1), 'cta', 'move without index appends');
  const copies = apply({ type: 'duplicate', ids: ['card-one', 'card-three'] });
  assert.deepEqual(copies.ids, ['card-one-copy', 'card-three-copy']);
  assert.deepEqual(copies.doc.nodes.cards.children, ['card-one', 'card-one-copy', 'card-two', 'card-three', 'card-three-copy']);
});

test('new and duplicated artboards are placed without overlapping existing ones', async t => {
  const { runtime, id } = await fixture(t);
  const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const first = await runtime.createArtboard({ from: id });
  const second = await runtime.createArtboard({ from: id });
  const third = await runtime.createArtboard({ name: 'Phone', width: 390, height: 844 });
  const boards = runtime.info().documents.map(doc => doc.artboard);
  for (let i = 0; i < boards.length; i++) for (let j = i + 1; j < boards.length; j++) assert.equal(overlaps(boards[i], boards[j]), false, `artboards ${i} and ${j} overlap`);
  assert.ok([first, second, third].every(result => result.documentId));
  const pinned = await runtime.createArtboard({ name: 'Pinned', x: 80, y: 100, width: 100, height: 100 });
  assert.deepEqual(runtime.read({ view: 'document', documentId: pinned.documentId }).artboard, { x: 80, y: 100, width: 100, height: 100 }, 'explicit coordinates are respected');
  const log = runtime.readHistory().changes;
  assert.match(log.at(-1).summary, /^created “Pinned” · 1 node$/);
  await runtime.removeDocument({ documentId: pinned.documentId });
  assert.match(runtime.readHistory().changes.at(-1).summary, /removed “Pinned”/);
});

test('documents found when a project opens are not reported as changes', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-quiet-'));
  try {
    const first = await openRuntime({ cwd, watch: false });
    await first.close();
    const second = await openRuntime({ cwd, watch: false });
    assert.equal(second.info().documents.length, 1);
    assert.deepEqual(second.readHistory().changes, []);
    await second.close();
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('every accepted change is logged with actor, summary and touched nodes', async t => {
  const { runtime, id } = await fixture(t);
  assert.equal(runtime.readHistory().changes.at(-1).actor, 'system');
  const base = runtime.read({ view: 'document', documentId: id });
  await runtime.patch({ documentId: id, expectedVersion: base.version, patch: { nodes: { 'title-text': { content: 'By agent' } } }, actor: 'agent', label: 'rewrite title' });
  await runtime.patch({ documentId: id, expectedVersion: base.version + 1, patch: { artboard: { x: 300 } }, actor: 'user' });
  const log = runtime.read({ view: 'history', since: 1 });
  assert.deepEqual(log.changes.map(change => [change.actor, change.fromVersion, change.toVersion]), [['agent', 1, 2], ['user', 2, 3]]);
  assert.deepEqual(log.changes[0].touched, ['title-text']);
  assert.match(log.changes[1].summary, /moved/);
  assert.equal(log.canUndo, true);
  assert.equal(runtime.readHistory({ actor: 'user' }).changes.length, 1);
  assert.equal(runtime.info().history.seq, runtime.seq);
});

test('undo applies inverse patches selectively and redo restores them', async t => {
  const { runtime, id } = await fixture(t);
  const patch = (version, change, actor = 'agent') => runtime.patch({ documentId: id, expectedVersion: version, patch: change, actor });
  await patch(1, { nodes: { 'title-text': { content: 'A' } } });
  await patch(2, { artboard: { x: 500 } }, 'user');
  await runtime.undo({ documentId: id });
  let doc = runtime.read({ view: 'document', documentId: id });
  assert.equal(doc.artboard.x, 80);
  assert.equal(doc.nodes['title-text'].content, 'A');
  await runtime.undo();
  doc = runtime.read({ view: 'document', documentId: id });
  assert.notEqual(doc.nodes['title-text'].content, 'A');
  await runtime.redo();
  await runtime.redo();
  doc = runtime.read({ view: 'document', documentId: id });
  assert.equal(doc.artboard.x, 500);
  assert.equal(doc.nodes['title-text'].content, 'A');
  assert.equal(runtime.historyHead().canRedo, false);
  assert.deepEqual(runtime.readHistory().changes.slice(-2).map(change => change.kind), ['redo', 'redo']);
  await runtime.undo();
  await patch(doc.version + 1, { name: 'Branch' });
  assert.equal(runtime.historyHead().canRedo, false, 'a new change clears redo');
  await assert.rejects(() => runtime.undo({ documentId: 'nothing' }), /Nothing to undo/);
});

test('undo of an overridden edit is rejected without corrupting state, and a group undoes as one', async t => {
  const { runtime, id } = await fixture(t);
  await runtime.patch({ documentId: id, expectedVersion: 1, patch: { nodes: { 'title-text': { content: 'one' } } } });
  const removal = operationPatch(runtime.read({ view: 'document', documentId: id }), { type: 'remove', ids: ['title'] }).patch;
  await runtime.patch({ documentId: id, expectedVersion: 2, patch: removal, undoable: false });
  await assert.rejects(() => runtime.undo({ documentId: id }), { code: 'CANNOT_UNDO' });
  assert.equal(runtime.historyHead().canUndo, true, 'the failed step stays on the stack');
  assert.equal(runtime.read({ view: 'document', documentId: id }).version, 3);
  runtime.undoStack.length = 0;
  const group = runtime.newGroup();
  const version = runtime.read({ view: 'document', documentId: id }).version;
  await runtime.patch({ documentId: id, expectedVersion: version, patch: { artboard: { y: 1 } }, actor: 'user', group });
  await runtime.patch({ documentId: id, expectedVersion: version + 1, patch: { artboard: { y: 2 } }, actor: 'user', group });
  assert.equal(runtime.undoStack.at(-1).items.length, 2);
  await runtime.undo();
  assert.equal(runtime.read({ view: 'document', documentId: id }).artboard.y, 100);
});

test('artboards can be created, duplicated and deleted with undo', async t => {
  const { runtime, cwd, id } = await fixture(t);
  const created = await runtime.createArtboard({ name: 'Phone', width: 390, height: 844 });
  assert.equal(created.documentId, 'phone');
  assert.equal(runtime.read({ view: 'document', documentId: 'phone' }).artboard.width, 390);
  const copy = await runtime.createArtboard({ from: id });
  assert.notEqual(copy.documentId, id);
  assert.ok(runtime.read({ view: 'document', documentId: copy.documentId }).nodes.title);
  await runtime.removeDocument({ documentId: 'phone' });
  assert.equal(runtime.info().documents.some(doc => doc.id === 'phone'), false);
  assert.ok((await fs.readdir(path.join(runtime.outputDir, '.trash'))).length >= 2);
  await runtime.undo();
  assert.equal(runtime.info().documents.some(doc => doc.id === 'phone'), true);
  await runtime.undo();
  await runtime.undo();
  assert.equal(runtime.info().documents.some(doc => doc.id === 'phone'), false);
  await runtime.redo();
  assert.equal(runtime.info().documents.some(doc => doc.id === 'phone'), true);
});

test('structured edit operations log the acting user', async t => {
  const { runtime, id } = await fixture(t);
  const result = await runtime.edit({ documentId: id, expectedVersion: 1, op: { type: 'duplicate', id: 'card-one' }, actor: 'user' });
  assert.deepEqual(result.ids, ['card-one-copy']);
  await runtime.edit({ documentId: id, expectedVersion: 2, op: { type: 'text', id: 'title', content: 'Typed in the browser' } });
  const last = runtime.readHistory().changes.at(-1);
  assert.equal(last.actor, 'user');
  assert.deepEqual(last.touched, ['title-text']);
  await assert.rejects(() => runtime.edit({ documentId: id, expectedVersion: 1, op: { type: 'remove', ids: ['cards'] } }), { code: 'REVISION_CONFLICT' });
});

test('external file edits appear in the log as file changes and can be undone', async t => {
  const { runtime, id } = await fixture(t);
  const file = runtime.projectPath;
  const project = JSON.parse(await fs.readFile(file, 'utf8'));
  project.frames.find(frame => frame.id === id).nodes['title-text'].content = 'Edited by hand';
  await fs.writeFile(file, JSON.stringify(project));
  await runtime.scan();
  const last = runtime.readHistory().changes.at(-1);
  assert.equal(last.actor, 'file');
  assert.equal(last.kind, 'external');
  assert.deepEqual(last.touched, ['title-text']);
  await runtime.undo();
  assert.notEqual(runtime.read({ view: 'document', documentId: id }).nodes['title-text'].content, 'Edited by hand');
  validateDocument(runtime.read({ view: 'document', documentId: id }));
});

test('multi-step history replays dependent edits in order with one accepted commit', async t => {
  const { runtime, id } = await fixture(t);
  const base = runtime.read({ view: 'document', documentId: id });
  await runtime.patch({ documentId: id, expectedVersion: 1, patch: { artboard: { x: 400 } } });
  await runtime.patch({ documentId: id, expectedVersion: 2, patch: { artboard: { x: 700 } } });
  const revision = runtime.revision;
  let writes = 0;
  const persist = runtime.persist.bind(runtime);
  runtime.persist = (...args) => { writes++; return persist(...args); };
  await runtime.undo({ steps: 2 });
  assert.equal(runtime.read({ view: 'document', documentId: id }).artboard.x, base.artboard.x);
  assert.equal(runtime.read({ view: 'document', documentId: id }).version, 4, 'one new frame revision, not two intermediate commits');
  assert.equal(runtime.revision, revision + 1);
  assert.equal(writes, 1);
  assert.equal(runtime.undoStack.length, 0);
  assert.equal(runtime.redoStack.length, 2);
  await runtime.redo({ steps: 2 });
  assert.equal(runtime.read({ view: 'document', documentId: id }).artboard.x, 700);
  assert.equal(runtime.read({ view: 'document', documentId: id }).version, 5);
  assert.equal(runtime.revision, revision + 2);
  assert.equal(writes, 2);
  assert.equal(runtime.undoStack.length, 2);
  assert.equal(runtime.redoStack.length, 0);
});

test('multi-step history includes grouped frame movement, project settings and content', async t => {
  const { runtime, id } = await fixture(t);
  const other = { ...runtime.read({ view: 'document', documentId: id }), id: 'other', name: 'Other' };
  await runtime.create({ document: other, undoable: false });
  const baseName = runtime.settings.name, baseText = other.nodes['title-text'].content;
  const group = runtime.newGroup();
  for (const documentId of [id, 'other']) await runtime.patch({ documentId, expectedVersion: 1, group, patch: { artboard: { x: 900, y: 400 } } });
  await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { name: 'History target' } });
  await runtime.patch({ documentId: id, expectedVersion: 2, patch: { nodes: { 'title-text': { content: 'New title' } } } });
  assert.equal(runtime.undoStack.length, 3, 'a two-frame gesture is still one step');
  await runtime.undo({ steps: 3 });
  for (const documentId of [id, 'other']) assert.deepEqual(runtime.read({ view: 'document', documentId }).artboard, other.artboard);
  assert.equal(runtime.settings.name, baseName);
  assert.equal(runtime.read({ view: 'document', documentId: id }).nodes['title-text'].content, baseText);
  await runtime.redo({ steps: 3 });
  for (const documentId of [id, 'other']) assert.equal(runtime.read({ view: 'document', documentId }).artboard.x, 900);
  assert.equal(runtime.settings.name, 'History target');
  assert.equal(runtime.read({ view: 'document', documentId: id }).nodes['title-text'].content, 'New title');
});

test('multi-step history preserves frame lifecycle ordering and frame-scoped selectivity', async t => {
  const { runtime, id } = await fixture(t);
  const created = await runtime.createArtboard({ name: 'Transient' });
  await runtime.patch({ documentId: created.documentId, expectedVersion: created.version, patch: { artboard: { x: 1700 } } });
  await runtime.removeDocument({ documentId: created.documentId });
  await runtime.undo({ steps: 3 });
  assert.equal(runtime.info().documents.some(doc => doc.id === created.documentId), false);
  await runtime.redo({ steps: 2 });
  assert.equal(runtime.read({ view: 'document', documentId: created.documentId }).artboard.x, 1700);
  await runtime.redo();
  assert.equal(runtime.info().documents.some(doc => doc.id === created.documentId), false);
  const first = runtime.read({ view: 'document', documentId: id });
  await runtime.patch({ documentId: id, expectedVersion: first.version, patch: { artboard: { x: 400 } } });
  await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { name: 'Keep unrelated settings' } });
  await runtime.patch({ documentId: id, expectedVersion: first.version + 1, patch: { artboard: { y: 500 } } });
  await runtime.undo({ documentId: id, steps: 2 });
  assert.deepEqual(runtime.read({ view: 'document', documentId: id }).artboard, first.artboard);
  assert.equal(runtime.settings.name, 'Keep unrelated settings');
  await runtime.redo({ documentId: id, steps: 2 });
  assert.equal(runtime.read({ view: 'document', documentId: id }).artboard.x, 400);
  assert.equal(runtime.read({ view: 'document', documentId: id }).artboard.y, 500);
});

test('a later conflict in multi-step replay preserves accepted state, disk, outputs and stacks', async t => {
  for (const direction of ['undo', 'redo']) await t.test(direction, async t => {
    const { runtime, id } = await fixture(t);
    await runtime.patch({ documentId: id, expectedVersion: 1, patch: { nodes: { 'title-text': { content: 'one' } } } });
    await runtime.patch({ documentId: id, expectedVersion: 2, patch: { artboard: { x: 700 } } });
    if (direction === 'redo') await runtime.undo({ steps: 2 });
    const version = runtime.read({ view: 'document', documentId: id }).version;
    const patch = direction === 'undo' ? { nodes: { 'title-text': { content: 'external override' } } } : { artboard: { x: 999 } };
    await runtime.patch({ documentId: id, expectedVersion: version, patch, undoable: false });
    const before = runtime.read({ view: 'document', documentId: id });
    const stacks = structuredClone([runtime.undoStack, runtime.redoStack]);
    const history = runtime.readHistory(), revision = runtime.revision;
    const source = await fs.readFile(runtime.projectPath);
    const output = await fs.readFile(runtime.getEntry(id).htmlPath);
    await assert.rejects(() => runtime[direction]({ steps: 2 }), { code: 'CANNOT_UNDO' });
    assert.deepEqual(runtime.read({ view: 'document', documentId: id }), before);
    assert.deepEqual([runtime.undoStack, runtime.redoStack], stacks);
    assert.deepEqual(runtime.readHistory(), history);
    assert.equal(runtime.revision, revision);
    assert.deepEqual(await fs.readFile(runtime.projectPath), source);
    assert.deepEqual(await fs.readFile(runtime.getEntry(id).htmlPath), output);
  });
});

test('multi-step pre-publication refusal leaves state and stack authority intact', async t => {
  const { runtime, id } = await fixture(t);
  await runtime.patch({ documentId: id, expectedVersion: 1, patch: { artboard: { x: 400 } } });
  await runtime.patch({ documentId: id, expectedVersion: 2, patch: { artboard: { y: 400 } } });
  const before = runtime.read({ view: 'document', documentId: id }), stacks = structuredClone([runtime.undoStack, runtime.redoStack]);
  const history = runtime.readHistory(), revision = runtime.revision;
  const source = await fs.readFile(runtime.projectPath);
  const persist = runtime.persist;
  runtime.persist = async () => { throw new Error('Injected publication refusal'); };
  try { await assert.rejects(() => runtime.undo({ steps: 2 }), /Injected publication refusal/); }
  finally { runtime.persist = persist; }
  assert.deepEqual(runtime.read({ view: 'document', documentId: id }), before);
  assert.deepEqual([runtime.undoStack, runtime.redoStack], stacks);
  assert.deepEqual(runtime.readHistory(), history);
  assert.equal(runtime.revision, revision);
  assert.deepEqual(await fs.readFile(runtime.projectPath), source);
});

test('multi-step output preflight refusal cannot accept a valid movement prefix', async t => {
  const { runtime, cwd, id } = await fixture(t);
  const oldOutput = runtime.outputDir;
  await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { outputDir: 'build/current' } });
  await runtime.patch({ documentId: id, expectedVersion: 1, patch: { artboard: { x: 777 } } });
  const oldPage = path.join(oldOutput, `${id}.html`), target = path.join(cwd, 'protected.txt');
  await fs.writeFile(target, 'keep these bytes');
  await fs.rm(oldPage); await fs.symlink(target, oldPage);
  const before = runtime.read({ view: 'document', documentId: id }), settings = structuredClone(runtime.settings);
  const stacks = structuredClone([runtime.undoStack, runtime.redoStack]), history = runtime.readHistory(), revision = runtime.revision;
  const source = await fs.readFile(runtime.projectPath), output = await fs.readFile(runtime.getEntry(id).htmlPath);
  await assert.rejects(() => runtime.undo({ steps: 2 }), { code: 'UNSAFE_PATH' });
  assert.deepEqual(runtime.read({ view: 'document', documentId: id }), before);
  assert.deepEqual(runtime.settings, settings);
  assert.deepEqual([runtime.undoStack, runtime.redoStack], stacks);
  assert.deepEqual(runtime.readHistory(), history);
  assert.equal(runtime.revision, revision);
  assert.deepEqual(await fs.readFile(runtime.projectPath), source);
  assert.deepEqual(await fs.readFile(runtime.getEntry(id).htmlPath), output);
  assert.equal(await fs.readFile(target, 'utf8'), 'keep these bytes');
});

test('invalid or unavailable history step counts refuse without consuming any step', async t => {
  const { runtime, id } = await fixture(t);
  await runtime.patch({ documentId: id, expectedVersion: 1, patch: { artboard: { x: 400 } } });
  const before = runtime.read({ view: 'document', documentId: id }), stacks = structuredClone([runtime.undoStack, runtime.redoStack]);
  for (const steps of [0, -1, 1.5, '2', NaN, Infinity, 201]) await assert.rejects(() => runtime.undo({ steps }), { code: 'INVALID_QUERY' });
  await assert.rejects(() => runtime.undo({ steps: 2 }), { code: 'NOTHING_TO_UNDO' });
  await assert.rejects(() => runtime.redo({ steps: 1 }), { code: 'NOTHING_TO_UNDO' });
  assert.deepEqual(runtime.read({ view: 'document', documentId: id }), before);
  assert.deepEqual([runtime.undoStack, runtime.redoStack], stacks);
});

test('HTTP mutation endpoints act as the user and stream change events', async t => {
  const { runtime, id } = await fixture(t);
  const url = runtime.url;
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(url).origin }, body: JSON.stringify(body) });
  const events = [];
  runtime.on('change', change => events.push(change));
  const ok = await post('api/patch', { documentId: id, expectedVersion: 1, patch: { artboard: { x: 42 } }, label: 'move' });
  assert.equal(ok.status, 200);
  assert.equal(events.at(-1).actor, 'user');
  assert.equal((await post('api/patch', { documentId: id, expectedVersion: 1, patch: {} })).status, 409);
  assert.equal((await post('api/edit', { documentId: id, expectedVersion: 2, op: { type: 'insert', parentId: 'hero', spec: 'text' } })).status, 200);
  assert.equal((await post('api/undo', {})).status, 200);
  assert.equal((await post('api/undo', {})).status, 200);
  assert.equal((await post('api/undo', {})).status, 400);
  assert.equal((await post('api/redo', {})).status, 200);
  assert.equal((await post('api/artboards', { name: 'Tablet', width: 768, height: 1024 })).status, 200);
  const history = await (await fetch(url + 'api/history?since=1')).json();
  assert.ok(history.changes.length >= 5);
  assert.equal((await fetch(url + 'api/history?limit=0')).status, 400);
  assert.equal((await fetch(url + 'api/patch', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })).status, 403);
});
