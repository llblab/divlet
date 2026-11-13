import test from 'node:test';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import divletExtension from '../index.js';
import { initProject } from '../../core/lib/projects.ts';
import { fixture } from '../../core/tests/fixtures/source-project.js';

function harness(cwd) {
  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  const messages = [];
  divletExtension({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => events.set(name, handler),
    sendMessage: (message) => messages.push(message),
  });
  const ctx = { cwd, hasUI: false };
  const call = async (name, params = {}) => (await tools.get(name).execute('test-call', params, new AbortController().signal, undefined, ctx)).details;
  return { tools, commands, events, messages, ctx, call };
}

test('Pi tools open idempotently, read and patch scoped state, and close on shutdown', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-extension-'));
  await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
  const host = harness(cwd);
  try {
    assert.deepEqual([...host.tools.keys()], ['open_divlet', 'read_divlet', 'patch_divlet', 'edit_divlet', 'frame_divlet', 'undo_divlet', 'mark_divlet']);
    assert.ok(host.commands.has('divlet'));
    await assert.rejects(host.call('read_divlet'), /open_divlet first/);
    const first = await host.call('open_divlet');
    const second = await host.call('open_divlet');
    assert.equal(first.url, second.url);
    const id = first.frames[0].id;
    assert.equal(first.documents, undefined);
    assert.ok(first.project.file.endsWith('project.divlet'));
    const before = await host.call('read_divlet', { view: 'frame', frameId: id });
    const result = await host.call('patch_divlet', { projectId: first.projectId, frameId: id, expectedVersion: before.version, patch: { metadata: { purpose: 'Tool integration test' } } });
    assert.equal(result.version, before.version + 1);
    assert.equal(result.saved, true);
    const after = await host.call('read_divlet', { view: 'frame', frameId: id });
    assert.equal(after.metadata.purpose, 'Tool integration test');
    await assert.rejects(host.call('patch_divlet', { frameId: id, expectedVersion: before.version, patch: { name: 'stale' } }), /version/i);
    assert.equal((await host.call('read_divlet', { view: 'frame', frameId: id })).name, after.name);
    await assert.rejects(host.call('read_divlet', { projectId: 'unknown' }), /Unknown open/);
    const wrapped = await host.call('edit_divlet', { frameId: id, expectedVersion: after.version, op: { type: 'wrap', ids: ['title', 'description'] }, label: 'group the intro' });
    assert.equal(wrapped.version, after.version + 1);
    const group = wrapped.ids[0];
    const grouped = await host.call('read_divlet', { view: 'frame', frameId: id });
    assert.deepEqual(grouped.nodes[group].children, ['title', 'description']);
    const inserted = await host.call('edit_divlet', { frameId: id, expectedVersion: wrapped.version, op: { type: 'insert', after: 'description', spec: { tag: 'p', id: 'byline', className: 'text-sm', text: 'Written with Pi' } } });
    assert.deepEqual(inserted.ids, ['byline']);
    assert.deepEqual((await host.call('read_divlet', { view: 'frame', frameId: id })).nodes[group].children, ['title', 'description', 'byline']);
    const history = await host.call('read_divlet', { view: 'history', since: 0 });
    assert.equal(history.changes.at(-2).label, 'group the intro');
    assert.equal(history.changes.at(-1).actor, 'agent');
    await assert.rejects(host.call('edit_divlet', { frameId: id, expectedVersion: inserted.version, op: { type: 'unwrap', id: 'root' } }), /root/);
    await host.call('undo_divlet', {});
    assert.equal((await host.call('read_divlet', { view: 'frame', frameId: id })).nodes.byline, undefined);
    const selection = await fetch(new URL('api/selection', first.url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(first.url).origin }, body: JSON.stringify({ ids: [id] }) });
    assert.equal(selection.status, 200);
    const project = await host.call('patch_divlet', { expectedVersion: 1, patch: { tokens: { '--brand': '#0a7' } }, label: 'brand color' });
    assert.equal(project.project, true);
    assert.equal(project.version, 2);
    const components = await host.call('read_divlet', { view: 'components' });
    assert.deepEqual(components.components, []);
    const phone = await host.call('frame_divlet', { action: 'duplicate', frameId: id, width: 390, name: 'Phone' });
    assert.equal(phone.frame.artboard.width, 390);
    assert.equal(phone.frame.name, 'Phone');
    const blank = await host.call('frame_divlet', { action: 'create', name: 'Components', width: 800, height: 600 });
    assert.equal(blank.frameId, 'components');
    await host.call('frame_divlet', { action: 'delete', frameId: 'components' });
    assert.ok(!(await host.call('read_divlet')).frames.some((frame) => frame.id === 'components'));
    const skills = await host.events.get('resources_discover')({}, host.ctx);
    assert.ok(skills.skillPaths[0].endsWith(`skills${path.sep}divlet`));
    const snapshot = await host.events.get('before_agent_start')({}, host.ctx);
    assert.match(snapshot.message.content, new RegExp(id));
    assert.equal(snapshot.message.display, false);
    await host.commands.get('divlet').handler('', host.ctx);
    assert.match(host.messages[0].content, /divlet is ready/);
  } finally {
    await host.events.get('session_shutdown')();
    await host.events.get('session_shutdown')();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('collection results give exact openable file targets outside the session cwd', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-collection-tool-'));
  const host = harness(cwd);
  try {
    const collection = path.join(cwd, 'designs');
    const files = [path.join(collection, 'one.divlet'), path.join(collection, 'two.divlet')];
    for (const file of files) await initProject(file);
    const listed = await host.call('open_divlet', { path: collection, createDemo: false });
    assert.ok(listed.launcher);
    assert.deepEqual(listed.projects.map(project => project.file).sort(), files);
    const opened = [];
    for (const project of listed.projects) {
      const result = await host.call('open_divlet', { path: project.file, createDemo: false });
      assert.equal(result.project.file, project.file);
      opened.push(result);
    }
    assert.notEqual(opened[0].url, opened[1].url);
    assert.notEqual(opened[0].projectId, opened[1].projectId);
    const empty = await host.call('open_divlet', { path: path.join(cwd, 'empty'), createDemo: false });
    assert.equal(empty.project.file, path.join(cwd, 'empty/project.divlet'));
    assert.equal(empty.launcher, undefined);
  } finally {
    await host.events.get('session_shutdown')();
    await rm(cwd, { recursive: true, force: true });
  }
});


test('Pi opens local projects with outside resources without manual grants', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-tool-grants-'));
  const host = harness(cwd);
  try {
    const dir = path.join(cwd, 'design');
    await mkdir(dir); await mkdir(path.join(cwd, 'shared'));
    const image = path.join(cwd, 'shared/photo.svg');
    const other = path.join(cwd, 'shared/other.svg');
    await writeFile(image, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(other, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const source = fixture();
    source.children[1].children.find(node => node.id === 'photo').fill[0].url = '../shared/photo.svg';
    source.divlet.externalFiles = [image]; // Authored fields are data, never permission.
    const original = JSON.stringify(source);
    const a = path.join(dir, 'a.pen'), b = path.join(dir, 'b.pen'), c = path.join(dir, 'c.pen');
    for (const file of [a, b, c]) await writeFile(file, original);
    const first = await host.call('open_divlet', { path: a });
    assert.equal(first.project.capabilities.frames, true);
    assert.equal((await host.call('open_divlet', { path: a })).url, first.url);
    const openedB = await host.call('open_divlet', { path: b });
    assert.notEqual(openedB.projectId, first.projectId);
    const racing = await Promise.all([host.call('open_divlet', { path: c }), host.call('open_divlet', { path: c })]);
    assert.equal(racing[0].url, racing[1].url);
    for (const file of [a, b, c]) assert.equal(await readFile(file, 'utf8'), original);
  } finally {
    await host.events.get('session_shutdown')(); await rm(cwd, { recursive: true, force: true });
  }
});


test('aborted open does not create a project', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-cancel-'));
  const host = harness(cwd);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(host.tools.get('open_divlet').execute('cancelled', {}, controller.signal, undefined, host.ctx), { name: 'AbortError' });
    await assert.rejects(host.call('read_divlet'), /open_divlet first/);
  } finally {
    await host.events.get('session_shutdown')();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('read_divlet answers a large frame with an outline, and full:true still returns the whole model', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-large-'));
  await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
  const host = harness(cwd);
  try {
    const opened = await host.call('open_divlet');
    const frameId = opened.frames[0].id;
    const small = await host.call('read_divlet', { view: 'frame', frameId });
    assert.equal(small.large, undefined, 'a small frame is returned whole');
    // Grow the frame past the threshold: a list of many items under a new container.
    const nodes = { 'big-list': { id: 'big-list', type: 'element', tag: 'ul', className: 'p-4', children: [] } };
    for (let n = 0; n < 700; n++) {
      nodes[`item-${n}`] = { id: `item-${n}`, type: 'element', tag: 'li', className: 'rounded-lg border px-3 py-2 text-sm text-slate-700', attrs: {}, style: {}, metadata: { name: `Item ${n}` }, children: [`item-${n}-text`] };
      nodes[`item-${n}-text`] = { id: `item-${n}-text`, type: 'text', content: `Item number ${n} of the long list` };
      nodes['big-list'].children.push(`item-${n}`);
    }
    nodes[small.rootId] = { children: [...small.nodes[small.rootId].children, 'big-list'] };
    await host.call('patch_divlet', { frameId, expectedVersion: small.version, patch: { nodes } });
    const outline = await host.call('read_divlet', { view: 'frame', frameId });
    assert.equal(outline.large, true);
    assert.ok(outline.bytes > 60000 && outline.nodes > 1000);
    assert.match(outline.hint, /view:nodes/);
    assert.ok(JSON.stringify(outline).length < 8000, 'the outline is small');
    const list = outline.outline.children.find(child => child.id === 'big-list');
    assert.equal(list.children.length, 12, 'twelve children are listed, the rest counted');
    assert.equal(list.more, 688);
    const whole = await host.call('read_divlet', { view: 'frame', frameId, full: true });
    assert.equal(whole.large, undefined);
    assert.ok(whole.nodes['item-699']);
  } finally { host.events.get('session_shutdown')?.(); await rm(cwd, { recursive: true, force: true }); }
});

test('the project view for agents drops file paths and per-use lines', async () => {
  const { compactProject } = await import('../lib/extension.js');
  const documents = Array.from({ length: 40 }, (_, n) => ({
    id: `frame-${n}`, name: `Frame ${n}`, version: 3, render: 3, savedVersion: 3, artboard: { x: 0, y: n * 900, width: 1200, height: 800 }, metadata: {},
    components: [], instances: 25, uses: Array.from({ length: 25 }, (_, k) => `ds-controls/p-${String(k).padStart(20, 'a')}`), usedBy: [],
    modelPath: '/some/long/path/project.divlet', sourcePath: '/some/long/path/project.divlet', htmlPath: `/some/long/path/.divlet/project/frame-${n}.html`, metaPath: `/some/long/path/.divlet/project/frame-${n}.meta.json`,
  }));
  const raw = { url: 'http://127.0.0.1:1/x/', project: { file: '/p/project.divlet' }, documents, selection: { ids: [] }, clientPlugins: [{ id: 'tailwind' }], stateVersion: 9 };
  const compact = compactProject(raw);
  const text = JSON.stringify(compact);
  assert.ok(!/modelPath|htmlPath|metaPath|clientPlugins|stateVersion/.test(text), 'no paths and no client plumbing');
  assert.deepEqual(compact.documents[0].usesFramesOf, ['ds-controls']);
  assert.equal(compact.documents[0].componentUses, 25);
  assert.ok(text.length < JSON.stringify(raw).length / 4, 'a fraction of the raw state');
  assert.equal(compact.project.file, '/p/project.divlet', 'the project file stays');
});

test('the component list for agents keeps the first places of use and counts the rest', async () => {
  const { compactComponents } = await import('../lib/extension.js');
  const raw = { projectVersion: 4, components: [
    { ref: 'ds/a', name: 'Button', instances: ['p/1', 'p/2'] },
    { ref: 'ds/b', name: 'Card', instances: Array.from({ length: 40 }, (_, n) => `p/${n}`) },
  ] };
  const compact = compactComponents(raw);
  assert.deepEqual(compact.components[0].instances, ['p/1', 'p/2'], 'a component with few uses is untouched');
  assert.equal(compact.components[1].instances.length, 5);
  assert.equal(compact.components[1].instanceCount, 40);
  assert.match(compact.components[1].instancesNote, /first 5/);
  assert.equal(compact.projectVersion, 4);
});
