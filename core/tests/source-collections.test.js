import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listProjects, resolveProject, inspectPath } from '../lib/projects.ts';
import { SOURCE_LIMITS } from '../lib/model.ts';
import { launch, makeHost } from '../lib/launch.ts';
import { openRuntime } from '../lib/runtime.js';
import extension from '@divlet/pi';

const secret = 'S3cr3t!';
const native = () => ({ version: '2.21', fileToken: secret, name: secret, frames: [{ id: 'foreign', name: 'Not a PEN root' }], children: [
  { id: 'shared', type: 'frame', name: 'Shared card', reusable: true, width: 200, height: 80, children: [{ id: 'text', type: 'text', content: 'Shared' }] },
  { id: 'screen', type: 'frame', name: 'Desktop', width: 390, height: 500, children: [{ id: 'instance', type: 'ref', ref: 'shared' }] },
] });
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-source-collections-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Summaries are bounded serialized-root metadata, never projections, readiness or authority.
test('native summaries count canonical roots, respect active names and keep foreign/future fields inert', async t => {
  const root = await setup(t), snapshots = new Map();
  const inputs = {
    'alpha.pen': native(),
    'empty.PEN': { version: '2.21', children: [] },
    'named.divlet': { ...native(), divlet: { schemaVersion: 1, name: 'Explicit native name', metadata: { credential: secret } } },
    'future.pen': { ...native(), divlet: { schemaVersion: { credential: secret }, name: 'Marker is inert', metadata: { credential: secret } } },
  };
  for (const [name, input] of Object.entries(inputs)) {
    const file = path.join(root, name), text = JSON.stringify(input); await fs.writeFile(file, text); snapshots.set(file, text);
  }
  const projects = await listProjects(root), byFile = new Map(projects.map(project => [path.basename(project.file), project]));
  assert.equal(byFile.get('alpha.pen').name, 'alpha');
  assert.equal(byFile.get('alpha.pen').frames, 2);
  assert.deepEqual(byFile.get('alpha.pen').frameNames, ['Shared card', 'Desktop']);
  assert.equal(byFile.get('empty.PEN').frames, 0); assert.deepEqual(byFile.get('empty.PEN').frameNames, []);
  assert.equal(byFile.get('named.divlet').name, 'Explicit native name');
  assert.equal(byFile.get('future.pen').name, 'Marker is inert'); assert.equal(byFile.get('future.pen').frames, 2);
  assert.equal(JSON.stringify(projects).includes(secret), false);
  for (const project of projects) {
    assert.deepEqual(Object.keys(project).sort(), ['dir', 'file', 'frameNames', 'frames', 'modified', 'name', 'path'].sort());
    assert.equal(path.isAbsolute(project.file), true); assert.equal(project.dir, root);
    assert.equal(await fs.readFile(project.file, 'utf8'), snapshots.get(project.file));
  }
  const resolved = await resolveProject(root);
  assert.equal(resolved.kind, 'collection'); assert.equal(resolved.projects.length, 4);
  assert.equal((await inspectPath(root)).projects, 4);
  assert.deepEqual((await fs.readdir(root)).sort(), Object.keys(inputs).sort(), 'no outputs, caches or converted sources');
});

test('large shared-instance graphs stay unexpanded and metadata labels stay bounded', async t => {
  const root = await setup(t), children = [];
  for (let i = 0; i < 20; i++) children.push({ id: `def-${i}`, type: 'frame', reusable: true, name: i === 0 ? 'x'.repeat(2000) : `Definition ${i}`, children: i ? [0, 1].map(n => ({ id: `use-${i}-${n}`, type: 'ref', ref: `def-${i - 1}` })) : [] });
  await fs.writeFile(path.join(root, 'large.pen'), JSON.stringify({ version: '2.21', children }));
  const [summary] = await listProjects(root);
  assert.equal(summary.error, undefined); assert.equal(summary.frames, 20);
  assert.equal(summary.frameNames.length, 4); assert.equal(summary.frameNames[0], 'x'.repeat(512));
  assert.equal(summary.capabilities, undefined, 'an expansion exceeding renderer budgets is still only wire metadata');
});

test('malformed JSON, native graph errors and invalid roots expose no source/parser excerpts', async t => {
  const root = await setup(t);
  const invalid = { ...native(), children: [{ id: 'instance', type: 'ref', ref: secret }] };
  const cases = { 'syntax.pen': `{"fileToken":${secret},"version":"2.21","children":[]}`, 'graph.pen': JSON.stringify(invalid), 'shape.pen': JSON.stringify({ version: 2.21, children: [], fileToken: secret }), 'null.pen': 'null' };
  for (const [file, text] of Object.entries(cases)) await fs.writeFile(path.join(root, file), text);
  const projects = await listProjects(root);
  assert.equal(projects.length, 4);
  assert.match(projects.find(project => project.path === 'syntax.pen').error, /not valid JSON/);
  for (const project of projects) { assert.ok(project.error); assert.equal(project.frames, 0); assert.equal(project.frameNames, undefined); }
  assert.equal(JSON.stringify(projects).includes(secret), false);
  for (const [file, text] of Object.entries(cases)) assert.equal(await fs.readFile(path.join(root, file), 'utf8'), text);
});


test('summary descriptor reads reject oversized/replaced entries and remain serial across large collections', async t => {
  const root = await setup(t), huge = path.join(root, 'huge.pen');
  await fs.writeFile(huge, '{}'); await fs.truncate(huge, SOURCE_LIMITS.bytes + 1);
  const [large] = await listProjects(root); assert.match(large.error, /too large/);
  await fs.rm(huge);
  for (let n = 0; n < 6; n++) await fs.writeFile(path.join(root, `${n}.pen`), JSON.stringify(native()));
  const realOpen = fs.open.bind(fs); let active = 0, maximum = 0;
  t.mock.method(fs, 'open', async (file, flags) => {
    assert.ok(flags & constants.O_NOFOLLOW); assert.ok(flags & constants.O_NONBLOCK);
    const handle = await realOpen(file, flags); active++; maximum = Math.max(maximum, active);
    const close = handle.close.bind(handle);
    handle.close = async () => { try { await close(); } finally { active--; } };
    return handle;
  });
  assert.equal((await listProjects(root)).length, 6); assert.equal(maximum, 1); assert.equal(active, 0);
  fs.open.mock.restore();
  const target = path.join(root, '0.pen');
  t.mock.method(fs, 'open', async (file, flags) => {
    if (file === target) throw Object.assign(new Error(secret), { code: 'ELOOP' });
    return realOpen(file, flags);
  });
  const unreadable = (await listProjects(root)).find(project => project.file === target);
  assert.match(unreadable.error, /could not be read safely/); assert.equal(JSON.stringify(unreadable).includes(secret), false);
});

for (const mutation of ['grow', 'shrink', 'same-size']) test(`summary refuses a ${mutation} source change during bounded descriptor reading`, async t => {
  const root = await setup(t), file = path.join(root, 'changing.pen');
  const text = JSON.stringify(native()); await fs.writeFile(file, text);
  const realOpen = fs.open.bind(fs); let capacity = 0, closed = false;
  t.mock.method(fs, 'open', async (target, flags) => {
    const handle = await realOpen(target, flags), read = handle.read.bind(handle), close = handle.close.bind(handle);
    let mutated = false;
    handle.read = async (buffer, offset, length, position) => {
      capacity = Math.max(capacity, buffer.length);
      if (!mutated) {
        mutated = true;
        if (mutation === 'grow') await fs.appendFile(file, ' ');
        else if (mutation === 'shrink') await fs.truncate(file, text.length - 1);
        else { await fs.writeFile(file, text.replace('Desktop', 'Changed')); await fs.utimes(file, new Date(), new Date(Date.now() + 5000)); }
      }
      return read(buffer, offset, length, position);
    };
    handle.close = async () => { closed = true; return close(); };
    return handle;
  });
  const [summary] = await listProjects(root);
  assert.match(summary.error, /changed while being read/); assert.equal(summary.frames, 0);
  assert.equal(capacity, Buffer.byteLength(text) + 1); assert.equal(closed, true);
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

async function resources(t) {
  const root = await setup(t), dir = path.join(root, 'design'); await fs.mkdir(dir);
  const image = path.join(root, 'photo.svg'); await fs.writeFile(image, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const source = native(); source.divlet = { schemaVersion: 1, externalFiles: [image] };
  source.children[1].children.push({ id: 'photo', type: 'rectangle', width: 16, height: 16, fill: [{ type: 'image', url: '../photo.svg' }] });
  const a = path.join(dir, 'a.pen'), b = path.join(dir, 'b.PEN'), text = JSON.stringify(source);
  for (const file of [a, b]) await fs.writeFile(file, text);
  return { root, dir, image, a, b, text };
}

test('CLI collection summaries do not prepare resources or lend host authority to exact-file opens', async t => {
  const f = await resources(t), boards = new Map(), hubs = new Map(), calls = [];
  const openBoard = async location => { calls.push(location); if (!boards.has(location.file)) { const runtime = await openRuntime({ ...location, watch: false, createDemo: false }); runtime.host = host; boards.set(location.file, runtime); } return boards.get(location.file); };
  const host = makeHost({ openBoard, hubs });
  t.after(async () => { for (const hub of hubs.values()) await hub.close(); for (const runtime of boards.values()) await runtime.close(); });
  const listed = await launch(f.dir, { openBoard, hubs });
  assert.deepEqual(listed.projects.map(project => project.frames), [2, 2]); assert.equal(calls.length, 0);
  const reply = await fetch(listed.hub.url + 'api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: f.a, externalFiles: [f.image] }) });
  const openedReply = await reply.json(); assert.equal(reply.status, 200); assert.ok(openedReply.url); assert.equal(calls[0].externalFiles, undefined);
  const opened = await launch(f.a, { openBoard, hubs, externalFiles: [f.image] });
  assert.equal(opened.runtime.documents.size, 2); assert.equal(opened.runtime.projectPath, f.a.replace(/\.pen$/, '.divlet'), 'a .pen opens through the Divlet project created beside it');
  assert.ok((await host.open(f.b)).url);
  for (const file of [f.a, f.b]) assert.equal(await fs.readFile(file, 'utf8'), f.text);
});

test('Pi collection metadata preserves sibling identity without granting outside files or advertising readiness', async t => {
  const f = await resources(t), tools = new Map(), events = new Map();
  extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on: (name, handler) => events.set(name, handler), sendMessage() {} });
  t.after(() => events.get('session_shutdown')());
  const call = async (name, params = {}) => (await tools.get(name).execute('test', params, new AbortController().signal, undefined, { cwd: f.root, hasUI: false })).details;
  const listed = await call('divlet_open', { path: f.dir });
  assert.deepEqual(listed.projects.map(project => project.frames), [2, 2]);
  assert.ok(listed.projects.every(project => path.isAbsolute(project.file) && !project.capabilities));
  assert.equal(JSON.stringify(listed).includes(secret), false);
  assert.ok((await call('divlet_open', { path: f.dir })).launcher);
  const a = await call('divlet_open', { path: f.a, externalFiles: [f.image] });
  assert.equal(a.frames.length, 2);
  assert.ok((await call('divlet_open', { path: f.b })).url);
  const b = await call('divlet_open', { path: f.b, externalFiles: [f.image] });
  assert.notEqual(a.projectId, b.projectId);
  for (const file of [f.a, f.b]) assert.equal(await fs.readFile(file, 'utf8'), f.text);
});
