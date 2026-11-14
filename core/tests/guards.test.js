// The board, the HTTP routes and the Pi tools all promise that a caller can name the state it read.
// Every advertised guard is checked here: a stale name is refused and changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openRuntime } from '@divlet/core/runtime';
import { legacyProject } from './fixtures/legacy-project.js';

const frame = (id, extra = {}) => ({ schemaVersion: 1, id, name: id, version: 1, artboard: { x: 0, y: 0, width: 100, height: 100 }, rootId: 'root', tokens: {}, css: '', metadata: {}, nodes: { root: { id: 'root', type: 'element', tag: 'main', children: [] } }, ...extra });

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-guards-'));
  await legacyProject(path.join(cwd, 'project.divlet'));
  const runtime = await openRuntime({ cwd, watch: false, createDemo: false });
  t.after(async () => { await runtime.close(); await rm(cwd, { recursive: true, force: true }); });
  await runtime.create({ document: frame('a'), undoable: false });
  return { runtime };
}

/** Refusal leaves the accepted project, the file and the history exactly as they were. */
async function refused(runtime, action, code) {
  const before = runtime.info();
  const disk = await readFile(runtime.projectPath, 'utf8');
  await assert.rejects(action, { code });
  assert.deepEqual(runtime.info(), before);
  assert.equal(await readFile(runtime.projectPath, 'utf8'), disk);
}

test('deleting a frame with a stale version is refused and deletes nothing', async t => {
  const { runtime } = await fixture(t);
  await runtime.patch({ documentId: 'a', expectedVersion: 1, patch: { name: 'A renamed' } });
  assert.equal(runtime.render('a').version, 2);
  await refused(runtime, () => runtime.removeDocument({ documentId: 'a', expectedVersion: 1 }), 'REVISION_CONFLICT');
  assert.equal(runtime.render('a').version, 2, 'the frame is still there');
});

test('deleting a frame without a named version still works for the undoable board path', async t => {
  const { runtime } = await fixture(t);
  await runtime.removeDocument({ documentId: 'a' });
  assert.throws(() => runtime.render('a'), { code: 'NOT_FOUND' });
});

test('a patch made against a stale render is refused, a current one applies', async t => {
  const { runtime } = await fixture(t);
  await runtime.patch({ documentId: 'a', expectedVersion: 1, patch: { name: 'A renamed' } });
  const { version, render } = runtime.render('a');
  assert.equal(render, 2);
  await refused(runtime, () => runtime.patch({ documentId: 'a', expectedVersion: version, expectedRender: 1, patch: { name: 'stale' } }), 'RENDER_CONFLICT');
  const applied = await runtime.patch({ documentId: 'a', expectedVersion: version, expectedRender: render, patch: { name: 'fresh' } });
  assert.equal(applied.version, version + 1);
  assert.equal(runtime.read({ view: 'frame', documentId: 'a' }).name, 'fresh');
});

test('an edit operation carries its expected render through to the patch', async t => {
  const { runtime } = await fixture(t);
  await runtime.patch({ documentId: 'a', expectedVersion: 1, patch: { name: 'A renamed' } });
  const { version, render } = runtime.render('a');
  await refused(runtime, () => runtime.edit({ documentId: 'a', expectedVersion: version, expectedRender: render - 1, op: { type: 'insert', spec: { tag: 'p', text: 'hi' }, parentId: 'root' } }), 'RENDER_CONFLICT');
  await runtime.edit({ documentId: 'a', expectedVersion: version, expectedRender: render, op: { type: 'insert', spec: { tag: 'p', text: 'hi' }, parentId: 'root' } });
  const applied = runtime.read({ view: 'frame', documentId: 'a' });
  assert.equal(applied.nodes.root.children.length, 1);
  assert.equal(applied.nodes[applied.nodes.root.children[0]].tag, 'p');
});

test('duplicating a frame from a stale version is refused', async t => {
  const { runtime } = await fixture(t);
  await runtime.patch({ documentId: 'a', expectedVersion: 1, patch: { name: 'A renamed' } });
  await refused(runtime, () => runtime.createArtboard({ from: 'a', expectedVersion: 1 }), 'REVISION_CONFLICT');
  const created = await runtime.createArtboard({ from: 'a', expectedVersion: runtime.render('a').version });
  assert.equal(runtime.read({ view: 'frame', documentId: created.documentId }).name, 'A renamed copy');
});

test('saving a copy from a stale project version is refused before the host is touched', async t => {
  const { runtime } = await fixture(t);
  await runtime.patchProject({ expectedVersion: runtime.info().project.version, patch: { name: 'Renamed project' } });
  const { version } = runtime.info().project;
  await refused(runtime, () => runtime.saveAs({ path: '/tmp/nowhere-divlet-guard', expectedVersion: version - 1, expectedFormat: 'divlet' }), 'REVISION_CONFLICT');
  // The version guard answers before the host check, so a stale dialog is never reported as NO_HOST.
  await assert.rejects(() => runtime.saveAs({ path: '/tmp/nowhere-divlet-guard', expectedVersion: version, expectedFormat: 'divlet' }), { code: 'NO_HOST' });
});
