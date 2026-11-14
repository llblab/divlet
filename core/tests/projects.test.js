import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { resolveProject, listProjects, createProject, initProject, inspectPath } from '../lib/projects.ts';
import { launch } from '../lib/launch.ts';
import divletExtension from '@divlet/pi';
import { openRuntime } from '@divlet/core/runtime';
import { writeProject, validateSettings, readProject } from '../lib/project.ts';
import { decodeHtml } from '../lib/codec.ts';

const temp = () => mkdtemp(path.join(os.tmpdir(), 'divlet-projects-'));

test('filesystem browsing binds the normalized requested target separately from the existing listing directory', async () => {
  const root = await temp();
  try {
    await writeFile(path.join(root, 'notes.txt'), 'foreign file');
    for (const input of ['missing/deep-copy', 'notes.txt/impossible-copy', './missing/../other-copy', root]) {
      const info = await inspectPath(input, root);
      assert.equal(info.requested, path.resolve(root, input));
      assert.equal(info.path, root, 'listing location is not a missing copy destination');
    }
    assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'foreign file');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file discovery defaults directly to project.divlet and distinguishes shared-directory projects', async () => {
  const root = await temp();
  try {
    assert.deepEqual(await resolveProject(root), { kind: 'new', file: path.join(root, 'project.divlet'), dir: root });
    const a = await initProject(path.join(root, 'a.divlet'), 'A');
    assert.deepEqual(await resolveProject(root), { kind: 'project', file: a, dir: root });
    const b = await initProject(path.join(root, 'b.divlet'), 'B');
    assert.deepEqual(await resolveProject(b), { kind: 'project', file: b, dir: root });
    const found = await resolveProject(root);
    assert.equal(found.kind, 'collection');
    assert.deepEqual(found.projects.map(item => item.path).sort(), ['a.divlet', 'b.divlet']);
    assert.ok(found.projects.every(item => item.dir === root && path.isAbsolute(item.file)));
    const info = await inspectPath(root);
    assert.equal(info.kind, 'collection');
    assert.deepEqual(info.files.map(item => item.name), ['a.divlet', 'b.divlet']);
    assert.equal((await inspectPath(b)).kind, 'project');
    assert.equal((await inspectPath(b)).path, b);
    assert.equal((await inspectPath(b)).directory, root);
    assert.deepEqual(await resolveProject(path.join(root, 'new.divlet')), { kind: 'new', file: path.join(root, 'new.divlet'), dir: root });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('existing .pen files appear beside .divlet projects without changing new-project defaults', async () => {
  const root = await temp();
  try {
    const pen = path.join(root, 'layout.pen');
    await writeFile(pen, JSON.stringify({ schemaVersion: 1, frames: [] }));
    assert.deepEqual(await resolveProject(pen), { kind: 'project', file: pen, dir: root });
    assert.equal((await resolveProject(root)).file, pen);
    assert.equal((await listProjects(root))[0].name, 'layout');
    await initProject(path.join(root, 'current.divlet'));
    await writeFile(path.join(root, 'upper.PEN'), JSON.stringify({ schemaVersion: 1, frames: [] }));
    const info = await inspectPath(root);
    assert.equal(info.kind, 'collection');
    assert.deepEqual(info.files.map(file => file.name), ['current.divlet', 'layout.pen', 'upper.PEN']);
    assert.equal((await inspectPath(pen)).path, pen);
    await assert.rejects(resolveProject(path.join(root, 'absent.pen')), { code: 'NOT_FOUND' });
    await assert.rejects(initProject(path.join(root, 'new.pen')), /New project paths/);
    assert.match(await createProject(root, 'New project'), /new-project\.divlet$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});




test('configured and Designs collections include child-directory files and malformed projects', async () => {
  const root = await temp();
  try {
    await writeFile(path.join(root, 'divlet.config.json'), JSON.stringify({ projects: 'work/ui' }));
    assert.equal((await resolveProject(root)).kind, 'new');
    await initProject(path.join(root, 'work/ui/one/a.divlet'), 'One');
    await mkdir(path.join(root, 'work/ui/two'));
    await writeFile(path.join(root, 'work/ui/two/b.divlet'), '{ nope');
    const found = await resolveProject(root);
    assert.equal(found.dir, path.join(root, 'work/ui'));
    assert.match(found.projects.find(item => item.path === 'work/ui/two/b.divlet').error, /not valid JSON/);
    await writeFile(path.join(root, 'divlet.config.json'), JSON.stringify({ projects: '../outside' }));
    assert.equal((await resolveProject(root)).kind, 'new');
    await initProject(path.join(root, 'Designs/example/project.divlet'), 'Example');
    assert.equal((await resolveProject(root)).dir, path.join(root, 'Designs'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('creation initializes unique files directly in the collection without overwriting', async () => {
  const root = await temp();
  try {
    const a = await createProject(root, 'My Landing Page');
    const b = await createProject(root, 'My Landing Page');
    assert.equal(a, path.join(root, 'my-landing-page.divlet'));
    assert.equal(b, path.join(root, 'my-landing-page-2.divlet'));
    assert.equal(JSON.parse(await readFile(a, 'utf8')).name, 'My Landing Page');
    await assert.rejects(initProject(a, 'Overwrite'), { code: 'EEXIST' });
    await assert.rejects(createProject(root, '  '), /name/);
    assert.equal((await listProjects(root)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('launcher opens exact listed files, rejects unlisted paths, creates files and reuses hubs', async () => {
  const root = await temp();
  const boards = new Map();
  const hubs = new Map();
  const openBoard = async ({ file }) => {
    assert.ok(path.isAbsolute(file));
    if (!boards.has(file)) boards.set(file, { info: () => ({ url: `http://board/${path.basename(file)}` }) });
    return boards.get(file);
  };
  try {
    const a = await initProject(path.join(root, 'a.divlet'), 'A');
    assert.equal((await launch(root, { openBoard, hubs })).runtime, boards.get(a));
    const b = await initProject(path.join(root, 'b.divlet'), 'B');
    const many = await launch(root, { openBoard, hubs });
    assert.equal(many.kind, 'collection');
    const api = async (route, body) => {
      const response = await fetch(new URL(route, many.hub.url), body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(many.hub.url).origin }, body: JSON.stringify(body) } : undefined);
      return { status: response.status, body: await response.json() };
    };
    assert.deepEqual((await api('api/projects')).body.projects.map(item => item.path).sort(), ['a.divlet', 'b.divlet']);
    assert.equal((await api('api/open', { file: b })).body.url, boards.get(b).info().url);
    for (const body of [{ file: '/etc/passwd' }, { dir: root }, { file: path.join(root, 'absent.divlet') }, { file: `${root}/../${path.basename(root)}/a.divlet` }]) assert.equal((await api('api/open', body)).status, 404);
    assert.equal((await api('api/new', { name: 'Pricing' })).status, 200);
    assert.ok(boards.has(path.join(root, 'pricing.divlet')));
    assert.equal((await api('api/new', { name: '' })).status, 400);
    assert.match(await (await fetch(many.hub.url)).text(), /divlet · projects/);
    const blocked = await new Promise((resolve, reject) => { const target = new URL(many.hub.url); http.get({ host: target.hostname, port: target.port, path: target.pathname, headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); });
    assert.equal(blocked, 403);
    assert.equal((await launch(root, { openBoard, hubs })).hub, many.hub);
  } finally {
    for (const hub of hubs.values()) await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('extension keeps same-directory project runtimes and session selection distinct', async () => {
  const root = await temp();
  const tools = new Map();
  const events = new Map();
  divletExtension({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on: (name, handler) => events.set(name, handler), sendMessage() {} });
  const ctx = { cwd: root, hasUI: false };
  const call = async (name, params = {}) => (await tools.get(name).execute('c', params, new AbortController().signal, undefined, ctx)).details;
  try {
    const a = await initProject(path.join(root, 'a.divlet'), 'A');
    await initProject(path.join(root, 'b.divlet'), 'B');
    const listed = await call('divlet_open', { createDemo: false });
    assert.deepEqual(listed.projects.map(item => item.path).sort(), ['a.divlet', 'b.divlet']);
    const openedA = await call('divlet_open', { path: 'a.divlet', createDemo: false });
    const openedB = await call('divlet_open', { path: 'b.divlet', createDemo: false });
    assert.notEqual(openedA.projectId, openedB.projectId);
    assert.equal((await call('divlet_read')).project.name, 'B');
    assert.equal((await call('divlet_read', { projectId: openedA.projectId })).project.name, 'A');
    const hub = await fetch(new URL('api/open', listed.launcher), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(listed.launcher).origin }, body: JSON.stringify({ file: a }) });
    assert.equal(hub.status, 200);
    assert.equal((await call('divlet_read')).project.name, 'A');
  } finally {
    await events.get('session_shutdown')?.();
    await rm(root, { recursive: true, force: true });
  }
});
