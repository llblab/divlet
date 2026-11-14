import test from 'node:test';
import { legacyProject } from './fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntime } from '@divlet/core/runtime';
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

test('frame lifecycle replay restores authored order, including grouped deletion and multi-step return', async t => {
  const { runtime, id } = await fixture(t);
  for (const name of ['Alpha', 'Beta', 'Gamma']) await runtime.createArtboard({ name });
  const order = () => [...runtime.documents.keys()];
  const original = order();
  await runtime.removeDocument({ documentId: 'alpha' });
  await runtime.undo();
  assert.deepEqual(order(), original, 'restoring a middle frame must not append it');
  await runtime.redo(); await runtime.undo();
  assert.deepEqual(order(), original);
  const group = runtime.newGroup();
  for (const documentId of [id, 'beta']) await runtime.removeDocument({ documentId, group });
  await runtime.undo();
  assert.deepEqual(order(), original, 'reverse group replay restores each original position');
  await runtime.redo();
  await runtime.createArtboard({ name: 'Later' });
  await runtime.undo({ steps: 2 });
  assert.deepEqual(order(), original, 'a lifecycle traversal accepts the exact original order');
  assert.deepEqual(JSON.parse(await fs.readFile(runtime.projectPath, 'utf8')).frames.map(frame => frame.id), original);
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

test('external frame-order-only edits are one undoable project change', async t => {
  const { runtime } = await fixture(t);
  for (const name of ['Alpha', 'Beta', 'Gamma']) await runtime.createArtboard({ name });
  const before = [...runtime.documents.keys()], depth = runtime.undoStack.length;
  const project = JSON.parse(await fs.readFile(runtime.projectPath, 'utf8'));
  project.frames.reverse();
  await fs.writeFile(runtime.projectPath, JSON.stringify(project)); await runtime.scan();
  assert.deepEqual([...runtime.documents.keys()], [...before].reverse());
  assert.equal(runtime.undoStack.length, depth + 1, 'frame order is not just an untracked source rewrite');
  assert.match(runtime.readHistory().changes.at(-1).summary, /frame order/);
  await runtime.undo(); assert.deepEqual([...runtime.documents.keys()], before);
  assert.equal(runtime.readHistory().changes.at(-1).kind, 'undo');
  await runtime.redo(); assert.deepEqual([...runtime.documents.keys()], [...before].reverse());
  assert.equal(runtime.readHistory().changes.at(-1).kind, 'redo');
  assert.deepEqual(JSON.parse(await fs.readFile(runtime.projectPath, 'utf8')).frames.map(frame => frame.id), [...before].reverse());
});

test('external lifecycle, reorder, content and settings replay together without disturbing an unrelated later frame', async t => {
  const { runtime, id } = await fixture(t);
  for (const name of ['Alpha', 'Beta', 'Gamma']) await runtime.createArtboard({ name });
  const before = [...runtime.documents.values()].map(entry => structuredClone(entry.document)), name = runtime.settings.name;
  const project = JSON.parse(await fs.readFile(runtime.projectPath, 'utf8'));
  const extra = { ...structuredClone(project.frames[1]), id: 'extra', name: 'Extra' };
  project.frames = [project.frames[3], extra, project.frames[0]];
  project.frames[2].nodes['title-text'].content = 'External title'; project.name = 'External settings';
  const after = project.frames.map(frame => frame.id);
  await fs.writeFile(runtime.projectPath, JSON.stringify(project)); await runtime.scan();
  assert.deepEqual([...runtime.documents.keys()], after);
  await runtime.undo();
  assert.deepEqual([...runtime.documents.keys()], before.map(frame => frame.id));
  assert.deepEqual([...runtime.documents.values()].map(entry => strip(entry.document)), before.map(strip));
  assert.equal(runtime.settings.name, name);
  await runtime.redo();
  assert.deepEqual([...runtime.documents.keys()], after);
  assert.equal(runtime.read({ view: 'document', documentId: id }).nodes['title-text'].content, 'External title');
  assert.equal(runtime.settings.name, 'External settings');
  await runtime.createArtboard({ name: 'Later' });
  await runtime.undo({ documentId: id });
  assert.deepEqual([...runtime.documents.keys()], [...before.map(frame => frame.id), 'later']);
  assert.equal(runtime.settings.name, name);
  assert.deepEqual(JSON.parse(await fs.readFile(runtime.projectPath, 'utf8')).frames.map(frame => frame.id), [...before.map(frame => frame.id), 'later']);
});

test('external membership/order replay covers head/tail deletion, replacement and empty projects', async t => {
  const { runtime } = await fixture(t);
  for (const name of ['Alpha', 'Beta', 'Gamma']) await runtime.createArtboard({ name });
  const before = [...runtime.documents.keys()], source = JSON.parse(await fs.readFile(runtime.projectPath, 'utf8'));
  const frames = new Map(source.frames.map(frame => [frame.id, frame]));
  for (const id of ['extra', 'second']) frames.set(id, { ...structuredClone(source.frames[1]), id, name: id });
  for (const target of [['gamma', 'extra', 'welcome'], ['gamma', 'extra'], ['extra', 'gamma'], ['extra', 'second'], []]) {
    const project = JSON.parse(await fs.readFile(runtime.projectPath, 'utf8'));
    project.frames = target.map(id => frames.get(id));
    await fs.writeFile(runtime.projectPath, JSON.stringify(project)); await runtime.scan();
    assert.deepEqual([...runtime.documents.keys()], target);
    await runtime.undo(); assert.deepEqual([...runtime.documents.keys()], before, `undo ${JSON.stringify(target)}`);
    await runtime.redo(); assert.deepEqual([...runtime.documents.keys()], target, `redo ${JSON.stringify(target)}`);
    await runtime.undo(); assert.deepEqual([...runtime.documents.keys()], before);
  }
});

test('overlapping later frame order refuses replay without changing accepted state or stacks', async t => {
  for (const direction of ['undo', 'redo']) {
    const { runtime, id } = await fixture(t);
    for (const name of ['Alpha', 'Beta']) await runtime.createArtboard({ name });
    const project = JSON.parse(await fs.readFile(runtime.projectPath, 'utf8'));
    project.frames.reverse();
    await fs.writeFile(runtime.projectPath, JSON.stringify(project)); await runtime.scan();
    if (direction === 'redo') await runtime.undo();
    const entries = [...runtime.documents.values()].map(entry => entry.document);
    await runtime.adopt(runtime.settings, [entries[1], entries[0], entries[2]]);
    const before = runtime.info(), history = runtime.readHistory(), stacks = structuredClone([runtime.undoStack, runtime.redoStack]);
    const source = await fs.readFile(runtime.projectPath), output = await fs.readFile(runtime.getEntry(id).htmlPath);
    await assert.rejects(() => runtime[direction](), { code: 'CANNOT_UNDO' }, `${direction} refuses conflicting frame order`);
    assert.deepEqual(runtime.info(), before); assert.deepEqual(runtime.readHistory(), history);
    assert.deepEqual([runtime.undoStack, runtime.redoStack], stacks);
    assert.deepEqual(await fs.readFile(runtime.projectPath), source);
    assert.deepEqual(await fs.readFile(runtime.getEntry(id).htmlPath), output);
  }
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

test('guarded state points navigate grouped edits as one atomic traversal and retain forward return', async t => {
  const { runtime, id } = await fixture(t);
  const initial = runtime.readHistory().timeline;
  assert.equal(initial.points.length, 1);
  const base = initial.current, name = runtime.settings.name, text = runtime.getEntry(id).document.nodes['title-text'].content;
  const group = runtime.newGroup();
  await runtime.patch({ documentId: id, expectedVersion: 1, group, label: 'Grouped move', patch: { artboard: { x: 400 } } });
  const partial = runtime.readHistory().timeline.current;
  await runtime.patch({ documentId: id, expectedVersion: 2, group, label: '', patch: { artboard: { x: 700 } } });
  assert.equal(runtime.readTimeline().points.at(-1).label, 'Grouped move', 'endpoint captions follow the actual merged stack label');
  await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { name: 'Point target' } });
  await runtime.patch({ documentId: id, expectedVersion: 3, patch: { nodes: { 'title-text': { content: 'After edits' } } } });
  const timeline = runtime.readHistory().timeline, ids = timeline.points.map(point => point.id);
  assert.equal(ids.length, 4, 'one drag/group is one endpoint, not each live partial');
  assert.ok(!ids.includes(partial));
  assert.equal(runtime.info().history.pointId, timeline.current);
  let writes = 0;
  const persist = runtime.persist.bind(runtime);
  runtime.persist = (...args) => { writes++; return persist(...args); };
  const revision = runtime.revision;
  const result = await runtime.navigateHistory({ pointId: base, expectedPoint: timeline.current });
  assert.equal(result.changed, true); assert.equal(result.pointId, base);
  assert.equal(runtime.revision, revision + 1); assert.equal(writes, 1);
  assert.equal(runtime.getEntry(id).document.artboard.x, 80);
  assert.equal(runtime.getEntry(id).document.nodes['title-text'].content, text); assert.equal(runtime.settings.name, name);
  assert.deepEqual(runtime.readHistory().timeline.points.map(point => point.id), ids);
  assert.equal(runtime.readHistory().timeline.index, 0);
  const unchanged = runtime.readHistory();
  assert.equal((await runtime.navigateHistory({ pointId: base, expectedPoint: base })).changed, false);
  assert.equal(writes, 1); assert.equal(runtime.revision, revision + 1); assert.deepEqual(runtime.readHistory(), unchanged);
  await runtime.navigateHistory({ pointId: timeline.current, expectedPoint: base });
  assert.equal(writes, 2); assert.equal(runtime.settings.name, 'Point target');
  assert.equal(runtime.getEntry(id).document.artboard.x, 700);
  assert.equal(runtime.getEntry(id).document.nodes['title-text'].content, 'After edits');
  assert.deepEqual(runtime.readHistory().timeline.points.map(point => point.id), ids);
  await runtime.undo({ documentId: id });
  assert.equal(runtime.readTimeline().current, ids.at(-2), 'a scoped replay of the newest whole group stays linear');
  await runtime.redo({ documentId: id });
  assert.equal(runtime.readTimeline().current, timeline.current);
});

test('point authority moves even when a net-equal group emits no replay audit diff', async t => {
  const { runtime, id } = await fixture(t);
  const base = runtime.readTimeline().current, group = runtime.newGroup();
  await runtime.patch({ documentId: id, expectedVersion: 1, group, patch: { artboard: { x: 400 } } });
  await runtime.patch({ documentId: id, expectedVersion: 2, group, patch: { artboard: { x: 80 } } });
  const target = runtime.readTimeline().current, seq = runtime.seq;
  await runtime.navigateHistory({ pointId: base, expectedPoint: target });
  assert.equal(runtime.seq, seq, 'no authored diff is invented merely to move a history cursor');
  assert.equal(runtime.historyHead().pointId, base);
  await runtime.navigateHistory({ pointId: target, expectedPoint: base });
  assert.equal(runtime.seq, seq); assert.equal(runtime.historyHead().pointId, target);
  assert.equal(runtime.getEntry(id).document.artboard.x, 80);
});

test('point navigation rejects stale frontiers, discarded branches and queued stale heads without writing', async t => {
  const { runtime, id } = await fixture(t);
  const base = runtime.readTimeline().current, group = runtime.newGroup();
  await runtime.patch({ documentId: id, expectedVersion: 1, group, patch: { artboard: { x: 400 } } });
  const partial = runtime.readTimeline().current;
  await runtime.patch({ documentId: id, expectedVersion: 2, group, patch: { artboard: { x: 700 } } });
  const head = runtime.readTimeline().current, source = await fs.readFile(runtime.projectPath), history = runtime.readHistory();
  await assert.rejects(() => runtime.navigateHistory({ pointId: base, expectedPoint: partial }), { code: 'HISTORY_CONFLICT' });
  await assert.rejects(() => runtime.navigateHistory({ pointId: partial, expectedPoint: head }), { code: 'HISTORY_POINT_UNAVAILABLE' });
  for (const query of [undefined, null, 1, {}, { pointId: 1, expectedPoint: head }, { pointId: head, expectedPoint: null }]) await assert.rejects(() => runtime.navigateHistory(query), { code: 'INVALID_QUERY' });
  assert.deepEqual(await fs.readFile(runtime.projectPath), source); assert.deepEqual(runtime.readHistory(), history);
  runtime.say({ text: 'An observation is not a new state point.' }); runtime.setAgent({ connected: true });
  assert.equal(runtime.readTimeline().current, head, 'audit and host activity do not move the content cursor');
  await runtime.undo();
  await runtime.patch({ documentId: id, expectedVersion: runtime.getEntry(id).document.version, patch: { name: 'New branch' } });
  const branch = runtime.readTimeline().current;
  await assert.rejects(() => runtime.navigateHistory({ pointId: head, expectedPoint: branch }), { code: 'HISTORY_POINT_UNAVAILABLE' });
  const revision = runtime.revision;
  const pending = runtime.patch({ documentId: id, expectedVersion: runtime.getEntry(id).document.version, patch: { artboard: { x: 999 } } });
  await assert.rejects(() => runtime.navigateHistory({ pointId: base, expectedPoint: branch }), { code: 'HISTORY_CONFLICT' });
  await pending;
  assert.equal(runtime.revision, revision + 1); assert.equal(runtime.getEntry(id).document.artboard.x, 999);
});

test('non-top selective replay and untracked acceptance preserve legacy stacks but cut advertised endpoints', async t => {
  const { runtime, id } = await fixture(t);
  const base = runtime.readTimeline().current;
  await runtime.patch({ documentId: id, expectedVersion: 1, patch: { artboard: { x: 400 } } });
  await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { name: 'Keep settings' } });
  const old = runtime.readTimeline().points.map(point => point.id);
  await runtime.undo({ documentId: id });
  let timeline = runtime.readTimeline();
  assert.equal(timeline.boundary, 'nonlinear'); assert.equal(timeline.points.length, 1);
  assert.equal(timeline.pastLimited, true); assert.equal(timeline.futureLimited, true);
  assert.equal(runtime.undoStack.length, 1); assert.equal(runtime.redoStack.length, 1);
  await assert.rejects(() => runtime.navigateHistory({ pointId: base, expectedPoint: timeline.current }), { code: 'HISTORY_POINT_UNAVAILABLE' });
  await runtime.redo({ documentId: id });
  assert.equal(runtime.getEntry(id).document.artboard.x, 400); assert.equal(runtime.settings.name, 'Keep settings');
  assert.ok(!old.includes(runtime.readTimeline().current), 'a nonlinear round trip does not guess identity from content or audit sequences');
  await runtime.patch({ documentId: id, expectedVersion: runtime.getEntry(id).document.version, patch: { name: 'Fresh step' } });
  assert.equal(runtime.readTimeline().points.length, 2);
  await runtime.patch({ documentId: id, expectedVersion: runtime.getEntry(id).document.version, patch: { artboard: { y: 900 } }, undoable: false });
  timeline = runtime.readTimeline();
  assert.equal(timeline.boundary, 'untracked'); assert.equal(timeline.points.length, 1);
  const depth = runtime.undoStack.length;
  await runtime.undo();
  assert.equal(runtime.undoStack.length, depth - 1);
  assert.equal(runtime.getEntry(id).document.artboard.y, 900, 'legacy selective field matching still preserves unrelated changes');
  assert.equal(runtime.readTimeline().boundary, 'nonlinear');
});

test('state-point traversal retains order/lifecycle and preserves endpoint authority on persistence refusal', async t => {
  const { runtime } = await fixture(t);
  for (const name of ['Alpha', 'Beta']) await runtime.createArtboard({ name });
  const base = runtime.readTimeline().current, original = [...runtime.documents.keys()];
  const project = JSON.parse(await fs.readFile(runtime.projectPath, 'utf8'));
  project.frames = [project.frames[2], { ...structuredClone(project.frames[1]), id: 'extra', name: 'Extra' }, project.frames[0]];
  await fs.writeFile(runtime.projectPath, JSON.stringify(project)); await runtime.scan();
  const target = runtime.readTimeline().current, order = [...runtime.documents.keys()];
  const history = runtime.readHistory(), stacks = structuredClone([runtime.undoStack, runtime.redoStack]), source = await fs.readFile(runtime.projectPath);
  const persist = runtime.persist;
  runtime.persist = async () => { throw new Error('Point publication refused'); };
  try { await assert.rejects(() => runtime.navigateHistory({ pointId: base, expectedPoint: target }), /Point publication refused/); }
  finally { runtime.persist = persist; }
  assert.deepEqual(runtime.readHistory(), history); assert.deepEqual([runtime.undoStack, runtime.redoStack], stacks);
  assert.deepEqual(await fs.readFile(runtime.projectPath), source); assert.deepEqual([...runtime.documents.keys()], order);
  await runtime.navigateHistory({ pointId: base, expectedPoint: target }); assert.deepEqual([...runtime.documents.keys()], original);
  await runtime.navigateHistory({ pointId: target, expectedPoint: base }); assert.deepEqual([...runtime.documents.keys()], order);
  await runtime.adopt(runtime.settings, [...runtime.documents.values()].map(entry => entry.document));
  assert.equal(runtime.readTimeline().boundary, 'untracked', 'whole-source replacement cannot leave old endpoints advertised');
  await assert.rejects(() => runtime.navigateHistory({ pointId: base, expectedPoint: runtime.readTimeline().current }), { code: 'HISTORY_POINT_UNAVAILABLE' });
});

test('retained point navigation is bounded by the existing 200 groups, independently of audit filtering', async t => {
  const { runtime, id } = await fixture(t);
  const base = runtime.readTimeline().current;
  for (let index = 0; index < 202; index++) await runtime.patch({ documentId: id, expectedVersion: runtime.getEntry(id).document.version, patch: { artboard: { x: 1000 + index } } });
  const timeline = runtime.readHistory({ limit: 1, actor: 'file' }).timeline;
  assert.equal(timeline.points.length, 201); assert.equal(timeline.index, 200); assert.equal(timeline.boundary, 'retained');
  assert.ok(!timeline.points.some(point => point.id === base));
  await assert.rejects(() => runtime.navigateHistory({ pointId: base, expectedPoint: timeline.current }), { code: 'HISTORY_POINT_UNAVAILABLE' });
  await runtime.navigateHistory({ pointId: timeline.points[0].id, expectedPoint: timeline.current });
  assert.equal(runtime.getEntry(id).document.artboard.x, 1001);
  assert.equal(runtime.readTimeline().index, 0);
});

test('point reads survive client reload but not a runtime restart or source serialization', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-points-'));
  let first, second;
  try {
    await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
    first = await openRuntime({ cwd, watch: false });
    const read = async () => (await (await fetch(first.url + 'api/history')).json()).timeline;
    const initial = await read(); assert.deepEqual(await read(), initial);
    await first.patch({ documentId: 'welcome', expectedVersion: 1, patch: { name: 'Before restart' } });
    const previous = first.readTimeline();
    assert.ok(!(await fs.readFile(first.projectPath, 'utf8')).includes(previous.current), 'state point IDs are not authored project fields');
    await first.close(); second = await openRuntime({ cwd, watch: false });
    const next = second.readTimeline();
    assert.equal(next.points.length, 1); assert.equal(next.boundary, 'opened'); assert.notEqual(next.current, previous.current);
    await assert.rejects(() => second.navigateHistory({ pointId: previous.current, expectedPoint: next.current }), { code: 'HISTORY_POINT_UNAVAILABLE' });
  } finally { await first?.close(); await second?.close(); await fs.rm(cwd, { recursive: true, force: true }); }
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
