// The shared contract is the one place tool semantics, parameters and result shaping live; these tests pin the parts a second
// host depends on: one tool list, both schema renderings agreeing, the agent vocabulary, and the board registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { Type } from 'typebox';
import {
  LARGE_FRAME_BYTES, S, compactComponents, compactProject, forAgent, inputSchema, nullable, openView, optional,
  createSession, outlineOf, propertySchema, runOnRuntime, toTypeBox, toolByName, toolList, toolNames,
} from '../lib/contract.ts';
import { findBoard, listBoards, registerBoard, unregisterBoard } from '../lib/boards.ts';

test('one tool list, and every tool is described once', () => {
  assert.deepEqual(toolList().map(tool => tool.name), ['divlet_open', 'divlet_read', 'divlet_patch', 'divlet_edit', 'divlet_frame_manage', 'divlet_undo', 'divlet_mark']);
  assert.equal(toolList({ hidden: true }).length, toolList().length + 1, 'the internal create_frame tool stays out of host listings');
  for (const tool of toolList()) {
    assert.ok(tool.description.length > 40, `${tool.name} has a real description`);
    assert.equal(tool.title.length > 0, true);
    assert.equal(typeof tool.parameters, 'object');
  }
  assert.equal(toolNames.has('create_frame'), true);
});

test('legacy names resolve to the canonical operations without doubling the default tool list', async () => {
  const aliases = { open_divlet: 'divlet_open', read_divlet: 'divlet_read', patch_divlet: 'divlet_patch', edit_divlet: 'divlet_edit', frame_divlet: 'divlet_frame_manage', undo_divlet: 'divlet_undo', mark_divlet: 'divlet_mark' };
  assert.equal(toolList({ aliases: true }).length, 14);
  for (const [legacy, canonical] of Object.entries(aliases)) {
    assert.equal(toolByName.get(legacy), toolByName.get(canonical), legacy);
    assert.equal(toolNames.has(legacy), true);
    const advertised = toolList({ aliases: true }).find(tool => tool.name === legacy);
    assert.match(advertised.description, new RegExp('Compatibility alias for ' + canonical));
    assert.equal(advertised.parameters, toolByName.get(canonical).parameters);
  }
  const runtime = { patch: async args => args };
  const args = { frameId: 'one', expectedVersion: 1, patch: { name: 'x' } };
  assert.deepEqual(await runOnRuntime('patch_divlet', args, runtime), await runOnRuntime('divlet_patch', args, runtime));
  await assert.rejects(() => runOnRuntime('open_divlet', {}, runtime), { code: 'UNKNOWN_TOOL' });
});

test('new sessions attach to legacy-only live boards using their original wire names', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'divlet-legacy-board-'));
  const previous = process.env.PI_DIVLET_STATE_DIR;
  process.env.PI_DIVLET_STATE_DIR = path.join(root, 'state');
  const file = path.join(root, 'project.divlet');
  await writeFile(file, '{}');
  const info = { projectId: 'legacy-owner', project: { file }, documents: [] };
  const calls = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify(info));
    let text = '';
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    calls.push(request);
    if (request.name !== 'read_divlet') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'UNKNOWN_TOOL' })); }
    res.end(JSON.stringify({ result: { legacyOwner: true } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const board = await registerBoard({ file, url: `http://127.0.0.1:${server.address().port}/token/`, projectId: info.projectId });
  const session = createSession({ cwd: root, openBoard: () => { throw new Error('must attach, not start a second writer'); } });
  t.after(async () => {
    await session.close();
    await unregisterBoard({ file, url: board.url });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.PI_DIVLET_STATE_DIR; else process.env.PI_DIVLET_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  await session.call('divlet_open');
  assert.deepEqual(await session.call('divlet_read'), { legacyOwner: true });
  assert.deepEqual(await session.call('read_divlet'), { legacyOwner: true });
  assert.deepEqual(calls.map(call => call.name), ['read_divlet', 'read_divlet']);
});

test('the JSON Schema and the TypeBox rendering come from the same parameters', () => {
  const patch = toolList().find(tool => tool.name === 'divlet_patch');
  const json = inputSchema(patch);
  assert.deepEqual([...json.required].sort(), ['expectedVersion', 'patch']);
  assert.equal(json.properties.patch.type, 'object');
  assert.equal(json.properties.patch.additionalProperties, false);
  assert.deepEqual(json.properties.patch.properties.name, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  assert.equal(json.properties.patch.properties.tokens.type, 'object');
  assert.equal(json.properties.patch.properties.tokens.additionalProperties, true, 'a token map is free-form');

  const types = toTypeBox({ expectedVersion: S.integer({ minimum: 1 }), view: optional(S.oneOf(['frame', 'nodes'])), ids: optional(S.array(S.string(), { maxItems: 3 })) }, Type);
  assert.equal(types.type, 'object');
  assert.deepEqual([...types.required], ['expectedVersion']);
  assert.equal(types.properties.view.anyOf[1].const, 'nodes');

  // The same schema, both ways: required names agree for every tool.
  for (const tool of toolList()) {
    const jsonRequired = new Set(inputSchema(tool).required ?? []);
    const typeRequired = new Set(toTypeBox(tool.parameters, Type).required ?? []);
    assert.deepEqual([...typeRequired].sort(), [...jsonRequired].sort(), `${tool.name}: required parameters agree`);
  }
  assert.equal(propertySchema(nullable(S.string())).anyOf.length, 2);
});

test('results are in the agent vocabulary, and nothing but data crosses the contract', () => {
  const state = {
    url: 'http://127.0.0.1:1/x/',
    project: { file: '/p/project.divlet', version: 3 },
    documents: [{ id: 'one', name: 'One', version: 2, artboard: { x: 0, y: 0, width: 100, height: 100 }, modelPath: '/p/project.divlet', htmlPath: '/p/.divlet/p/one.html', uses: [], usedBy: [] }],
    clientPlugins: [{ id: 'tailwind' }], stateVersion: 7, selection: { ids: [] },
  };
  const compact = compactProject(state);
  assert.equal(compact.documents[0].htmlPath, undefined, 'generated-file paths are dropped');
  assert.equal(compact.clientPlugins, undefined);
  assert.equal(compact.project.file, '/p/project.divlet', 'the project file stays: a client opens it');
  assert.deepEqual(forAgent({ documents: [{ id: 'a' }], documentId: 'a' }), { frames: [{ id: 'a' }], frameId: 'a' });
  assert.deepEqual(forAgent({ nodes: { a: { documentId: 'keep' } } }).nodes, { a: { documentId: 'keep' } }, 'user data is never renamed');
  const many = compactComponents({ components: [{ id: 'c', instances: Array.from({ length: 8 }, (_, n) => `f/n${n}`) }] });
  assert.equal(many.components[0].instances.length, 5);
  assert.equal(many.components[0].instanceCount, 8);
  const outline = outlineOf({ id: 'f', name: 'F', version: 1, artboard: {}, rootId: 'r', nodes: { r: { id: 'r', type: 'element', tag: 'main', children: ['t'] }, t: { id: 't', type: 'text', content: 'hello' } } }, LARGE_FRAME_BYTES + 1);
  assert.equal(outline.large, true);
  assert.equal(outline.outline.children[0].text, 'hello');
  assert.equal(openView({ kind: 'project', info: state }).documents.length, 1);
  assert.equal(openView({ kind: 'collection', launcher: 'http://x/', collection: '/c', projects: [{ name: 'A', file: '/c/a.divlet', frames: 2 }] }).projects[0].file, '/c/a.divlet');
});

test('a board only runs the runtime tools it publishes', async () => {
  const calls = [];
  const runtime = { patch: async args => { calls.push(args); return { version: 4 }; } };
  assert.deepEqual(await runOnRuntime('divlet_patch', { frameId: 'one', expectedVersion: 3, patch: { name: 'x' } }, runtime), { version: 4 });
  assert.equal(calls[0].documentId, 'one');
  assert.equal(calls[0].actor, 'agent');
  for (const name of ['divlet_open', 'create_frame', 'nope']) {
    await assert.rejects(() => runOnRuntime(name, {}, runtime), { code: 'UNKNOWN_TOOL' });
  }
});

test('the registry names one live owner per project and forgets dead ones', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'divlet-boards-'));
  const previous = process.env.PI_DIVLET_STATE_DIR;
  process.env.PI_DIVLET_STATE_DIR = path.join(root, 'state');
  t.after(async () => { if (previous === undefined) delete process.env.PI_DIVLET_STATE_DIR; else process.env.PI_DIVLET_STATE_DIR = previous; await rm(root, { recursive: true, force: true }); });

  const project = path.join(root, 'a.divlet');
  await writeFile(project, '{}');
  assert.equal(await findBoard(project), null, 'nothing registered yet');

  const entry = await registerBoard({ file: project, url: 'http://127.0.0.1:1/token/', projectId: 'p1' });
  assert.equal(entry.pid, process.pid);
  const found = await findBoard(project);
  assert.equal(found.url, 'http://127.0.0.1:1/token/');
  assert.equal((await listBoards()).length, 1);

  // A board is only withdrawn by its own url: a later owner's entry survives.
  assert.equal(await unregisterBoard({ file: project, url: 'http://127.0.0.1:2/other/' }), false);
  assert.ok(await findBoard(project));
  assert.equal(await unregisterBoard({ file: project, url: entry.url }), true);
  assert.equal(await findBoard(project), null);

  // An entry whose process is gone is stale and is removed on read.
  const file = path.join(root, 'b.divlet');
  await writeFile(file, '{}');
  await registerBoard({ file, url: 'http://127.0.0.1:3/token/', projectId: 'p2' });
  let stateFile;
  for (const name of await readdir(process.env.PI_DIVLET_STATE_DIR)) {
    if (!name.endsWith('.json')) continue;
    const candidate = path.join(process.env.PI_DIVLET_STATE_DIR, name);
    if (JSON.parse(await readFile(candidate, 'utf8')).projectId === 'p2') stateFile = candidate;
  }
  await writeFile(stateFile, JSON.stringify({ ...JSON.parse(await readFile(stateFile, 'utf8')), pid: 999999 }));
  assert.equal(await findBoard(file), null, 'a dead owner is not attachable');
});
