import test from 'node:test';
import { legacyProject } from './fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openRuntime } from '../lib/runtime.js';
import { readProject } from '../lib/project.ts';

const frame = (id, extra = {}) => ({ schemaVersion: 1, id, name: id, version: 1, artboard: { x: 0, y: 0, width: 100, height: 100 }, rootId: 'root', tokens: {}, css: '', metadata: {}, nodes: { root: { id: 'root', type: 'element', tag: 'main', children: [] } }, ...extra });
const doc = (runtime, id) => runtime.read({ view: 'frame', documentId: id });
async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-safety-'));
  await legacyProject(path.join(cwd, 'project.divlet'));
  const runtime = await openRuntime({ cwd, watch: false, createDemo: false });
  t.after(async () => { await runtime.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, runtime };
}
async function unchangedAfterRejection(runtime, action) {
  const before = runtime.info();
  const disk = await readFile(runtime.projectPath, 'utf8');
  const undo = structuredClone(runtime.undoStack);
  const redo = structuredClone(runtime.redoStack);
  await assert.rejects(action, { code: 'CANNOT_UNDO' });
  assert.deepEqual(runtime.info(), before);
  assert.equal(await readFile(runtime.projectPath, 'utf8'), disk);
  assert.deepEqual(runtime.undoStack, undo);
  assert.deepEqual(runtime.redoStack, redo);
}

test('selective grouped undo refuses later overlapping edits but preserves unrelated edits', async t => {
  for (const conflict of [false, true]) await t.test(conflict ? 'overlapping field' : 'unrelated field', async t => {
    const { runtime } = await fixture(t);
    await runtime.create({ document: frame('a'), undoable: false });
    await runtime.create({ document: frame('b'), undoable: false });
    await runtime.patch({ documentId: 'a', expectedVersion: 1, patch: { name: 'Grouped A' }, group: 'batch' });
    await runtime.patch({ documentId: 'b', expectedVersion: 1, patch: { name: 'Grouped B' }, group: 'batch' });
    await runtime.patch({ documentId: 'b', expectedVersion: 2, patch: conflict ? { name: 'Later B' } : { metadata: { later: true } } });
    if (conflict) await unchangedAfterRejection(runtime, () => runtime.undo({ documentId: 'a' }));
    else {
      await runtime.undo({ documentId: 'a' });
      assert.equal(doc(runtime, 'a').name, 'a');
      assert.equal(doc(runtime, 'b').name, 'b');
      assert.equal(doc(runtime, 'b').metadata.later, true);
      await runtime.redo({ documentId: 'a' });
      assert.equal(doc(runtime, 'b').name, 'Grouped B');
      assert.equal(doc(runtime, 'b').metadata.later, true);
    }
  });
});

test('a failed group undo leaves the complete project and history unchanged', async t => {
  const { runtime } = await fixture(t);
  await runtime.create({ document: frame('b'), undoable: false });
  const component = frame('component');
  component.nodes.root.reusable = true;
  await runtime.create({ document: component, group: 'batch' });
  await runtime.patch({ documentId: 'b', expectedVersion: 1, patch: { name: 'Grouped B' }, group: 'batch' });
  const consumer = frame('consumer');
  consumer.nodes.root.children = ['instance'];
  consumer.nodes.instance = { id: 'instance', type: 'ref', ref: 'component/root' };
  await runtime.create({ document: consumer });
  await unchangedAfterRejection(runtime, () => runtime.undo({ documentId: 'b' }));
});

test('a created frame and its grouped edits undo and redo as one transaction', async t => {
  const { runtime } = await fixture(t);
  await runtime.create({ document: frame('a'), group: 'batch' });
  await runtime.patch({ documentId: 'a', expectedVersion: 1, patch: { name: 'Edited A' }, group: 'batch' });
  await runtime.undo();
  assert.equal(runtime.documents.size, 0);
  await runtime.redo();
  assert.equal(doc(runtime, 'a').name, 'Edited A');
  readProject(JSON.parse(await readFile(runtime.projectPath, 'utf8')));
});

test('external edits introducing component dependencies undo and redo regardless of frame order', async t => {
  const { runtime } = await fixture(t);
  await runtime.create({ document: frame('page'), undoable: false });
  const project = JSON.parse(await readFile(runtime.projectPath, 'utf8'));
  const component = frame('component');
  component.nodes.root.reusable = true;
  const { schemaVersion, ...stored } = component;
  project.frames.push(stored);
  project.frames[0].nodes.root.children = ['instance'];
  project.frames[0].nodes.instance = { id: 'instance', type: 'ref', ref: 'component/root' };
  await writeFile(runtime.projectPath, JSON.stringify(project));
  await runtime.scan();
  assert.equal(runtime.documents.size, 2);
  await runtime.undo();
  assert.equal(runtime.documents.size, 1);
  assert.deepEqual(doc(runtime, 'page').nodes.root.children, []);
  await runtime.redo();
  assert.equal(doc(runtime, 'page').nodes.instance.ref, 'component/root');
  assert.equal(runtime.documents.size, 2);
  readProject(JSON.parse(await readFile(runtime.projectPath, 'utf8')));
});

test('undo refuses to delete a created subtree containing later additions', async t => {
  const { runtime } = await fixture(t);
  await runtime.create({ document: frame('a'), undoable: false });
  await runtime.create({ document: frame('b'), undoable: false });
  await runtime.patch({ documentId: 'a', expectedVersion: 1, patch: { name: 'Grouped A' }, group: 'batch' });
  await runtime.patch({ documentId: 'b', expectedVersion: 1, patch: { metadata: { added: {} } }, group: 'batch' });
  await runtime.patch({ documentId: 'b', expectedVersion: 2, patch: { metadata: { added: { later: true } } } });
  await unchangedAfterRejection(runtime, () => runtime.undo({ documentId: 'a' }));
});

test('undo does not regenerate unrelated hand-edited output or change its selection', async t => {
  const { runtime } = await fixture(t);
  await runtime.create({ document: frame('a'), undoable: false });
  await runtime.create({ document: frame('b'), undoable: false });
  const file = runtime.getEntry('b').htmlPath;
  const edited = (await readFile(file, 'utf8')).replace('<main', '<main data-hand-edit="kept"');
  await writeFile(file, edited);
  await runtime.scan();
  runtime.setSelection({ ids: ['b'] });
  const selection = runtime.read({ view: 'selection' }).selection;
  await runtime.patch({ documentId: 'a', expectedVersion: 1, patch: { name: 'Changed' } });
  await runtime.undo();
  assert.equal(await readFile(file, 'utf8'), edited);
  assert.deepEqual(runtime.read({ view: 'selection' }).selection, selection);
  assert.ok(runtime.info().diagnostics.some(item => item.path === file && item.code === 'GENERATED_FILE_EDITED'));
});

test('the frame limit is enforced before writing a project that cannot reopen', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-frame-limit-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const frames = Array.from({ length: 200 }, (_, i) => { const { schemaVersion, ...stored } = frame(`frame${i}`); return stored; });
  await writeFile(path.join(cwd, 'project.divlet'), JSON.stringify({ schemaVersion: 2, name: 'Limit', version: 1, tokens: {}, css: '', metadata: {}, frames }));
  const runtime = await openRuntime({ cwd, watch: false, createDemo: false });
  t.after(() => runtime.close());
  const disk = await readFile(runtime.projectPath, 'utf8');
  for (const action of [() => runtime.createArtboard({ name: 'Overflow' }), () => runtime.createArtboard({ from: 'frame0' })]) {
    await assert.rejects(action, { code: 'INVALID_PROJECT' });
    assert.equal(await readFile(runtime.projectPath, 'utf8'), disk);
    assert.equal(runtime.documents.size, 200);
  }
  await runtime.close();
  const reopened = await openRuntime({ cwd, watch: false, createDemo: false });
  t.after(() => reopened.close());
  assert.equal(reopened.documents.size, 200);
  assert.deepEqual(reopened.info().diagnostics, []);
});
