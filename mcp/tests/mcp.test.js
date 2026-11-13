// The MCP integration is exercised through its real boundary: a child process speaking newline-delimited JSON-RPC over stdio,
// from initialization to tool calls to shutdown. Nothing in this test imports the adapter; it only spawns the packaged entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { findBoard } from '../../core/lib/boards.ts';

const ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));

/** One spawned MCP server plus the request/response plumbing of its stdio transport. */
function client(cwd, stateDir) {
  const child = spawn(process.execPath, [ENTRY, '--cwd', cwd], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(stateDir ? { PI_DIVLET_STATE_DIR: stateDir } : {}) } });
  const pending = new Map();
  const notifications = [];
  const requests = [];
  let onRequest = null;
  let buffer = '';
  let closed = false;
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (typeof message.method === 'string') { requests.push(message); onRequest?.(message); continue; }
      if (message.id === undefined || message.id === null) { notifications.push(message); continue; }
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      waiter?.(message);
    }
    while (waiters.length) waiters.shift()();
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`No answer to ${method} in 20s. stderr: ${stderr}`)), 20000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n');
  const stop = () => new Promise(resolve => {
    if (closed || child.exitCode !== null) { closed = true; return resolve({ code: child.exitCode ?? 0, stderr }); }
    child.once('exit', code => { closed = true; resolve({ code, stderr }); });
    child.stdin.end();
  });
  // A child that dies takes every pending request with it instead of leaving the test waiting.
  child.on('exit', code => { closed = true; for (const [id, waiter] of pending) { pending.delete(id); waiter({ jsonrpc: '2.0', id, error: { code: -32000, message: `server exited (${code}): ${stderr}` } }); } });
  const respond = (id, result) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  return { child, request, notify, respond, stop, notifications, requests, set onRequest(fn) { onRequest = fn; }, stderr: () => stderr, results: () => waiters };
}

/** Call a tool and return the parsed text of a successful answer, or the refusal. */
async function tool(rpc, name, args = {}) {
  const message = await rpc.request('tools/call', { name, arguments: args });
  assert.equal(message.jsonrpc, '2.0');
  if (message.error) throw Object.assign(new Error(message.error.message), { rpcCode: message.error.code });
  const text = message.result.content?.[0]?.text ?? '';
  return { isError: !!message.result.isError, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

/** Poll until `check` returns truthy (or fail with the label). */
async function waitFor(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await check(); if (last) return last; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
}

async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'divlet-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  const cwd = path.join(root, 'work');
  await mkdir(cwd, { recursive: true });
  return { cwd, state };
}

/** A small project written by hand: two frames, no imports, no demo. */
async function writeProject(cwd) {
  const frame = (id, name) => ({ id, name, version: 1, artboard: { x: 0, y: 0, width: 320, height: 240 }, rootId: 'root', tokens: {}, css: '', metadata: {}, nodes: {
    root: { id: 'root', type: 'element', tag: 'main', className: 'p-4', attrs: {}, style: {}, metadata: {}, children: ['title'] },
    title: { id: 'title', type: 'text', content: name, metadata: {} },
  } });
  await writeFile(path.join(cwd, 'project.divlet'), JSON.stringify({ schemaVersion: 1, name: 'MCP', version: 1, tokens: {}, css: '', metadata: {}, frames: [frame('one', 'One'), frame('two', 'Two')] }));
}

test('an MCP client initializes, lists the shared tools and edits a project end to end', async t => {
  const { cwd, state } = await project(t);
  await writeProject(cwd);
  const rpc = client(cwd, state);
  t.after(() => rpc.stop());

  const init = await rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'divlet');
  rpc.notify('notifications/initialized');

  const list = await rpc.request('tools/list');
  const names = list.result.tools.map(tool => tool.name);
  assert.deepEqual(names, ['divlet_open', 'divlet_read', 'divlet_patch', 'divlet_edit', 'divlet_frame_manage', 'divlet_undo', 'divlet_mark'], 'the MCP surface is the shared contract');
  const patch = list.result.tools.find(tool => tool.name === 'divlet_patch');
  assert.equal(patch.inputSchema.type, 'object');
  assert.deepEqual([...patch.inputSchema.required].sort(), ['expectedVersion', 'patch'], 'required parameters come from the same schema Pi uses');
  assert.ok(patch.description.includes('expectedVersion'));

  const opened = await tool(rpc, 'open_divlet', {});
  assert.equal(opened.isError, false);
  assert.match(opened.json.url, /^http:\/\/127\.0\.0\.1:\d+\//);
  const projectId = opened.json.projectId;
  assert.deepEqual(opened.json.frames.map(frame => frame.id), ['one', 'two']);

  const read = await tool(rpc, 'read_divlet', { projectId, view: 'project' });
  assert.equal(read.json.frames.length, 2);
  assert.deepEqual(Object.keys(read.json.frames[0]).filter(key => /Path$/.test(key)), [], 'the frame list carries no generated-file paths');

  const patched = await tool(rpc, 'patch_divlet', { projectId, frameId: 'one', expectedVersion: 1, label: 'rename', patch: { name: 'First' } });
  assert.equal(patched.isError, false);
  assert.equal(patched.json.version, 2);
  const after = await tool(rpc, 'divlet_read', { projectId, frameId: 'one', view: 'frame' });
  assert.equal(after.json.name, 'First');

  const stale = await tool(rpc, 'divlet_patch', { projectId, frameId: 'one', expectedVersion: 1, patch: { name: 'Again' } });
  assert.equal(stale.isError, true, 'a stale revision is a tool error');
  assert.match(stale.text, /REVISION_CONFLICT/);
  const unchanged = await tool(rpc, 'divlet_read', { projectId, frameId: 'one', view: 'frame' });
  assert.equal(unchanged.json.name, 'First', 'a refused change changed nothing');

  const undone = await tool(rpc, 'divlet_undo', { projectId, frameId: 'one' });
  assert.equal(undone.isError, false);
  const restored = await tool(rpc, 'divlet_read', { projectId, frameId: 'one', view: 'frame' });
  assert.equal(restored.json.name, 'One');

  const created = await tool(rpc, 'divlet_frame_manage', { projectId, action: 'create', name: 'Third', width: 390, height: 600 });
  assert.equal(created.json.frame.name, 'Third');
  const marked = await tool(rpc, 'divlet_mark', { projectId, frameId: created.json.frame.id, note: 'laying it out' });
  assert.equal(marked.isError, false);

  const unknown = await rpc.request('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.error.code, -32602, 'an unknown tool is an invalid-params error, not a tool failure');

  const exited = await rpc.stop();
  assert.equal(exited.code, 0, 'stdin closing stops the server cleanly');
  process.env.PI_DIVLET_STATE_DIR = state;
  assert.equal(await findBoard(path.join(cwd, 'project.divlet')), null, 'the board it owned is unregistered');
});

test('protocol errors keep the JSON-RPC shape and do not disturb the session', async t => {
  const { cwd, state } = await project(t);
  await writeProject(cwd);
  const rpc = client(cwd, state);
  t.after(() => rpc.stop());
  await rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const unknownMethod = await rpc.request('resources/read', { uri: 'x' });
  assert.equal(unknownMethod.error.code, -32601);
  const unknownTool = await rpc.request('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  const ping = await rpc.request('ping');
  assert.deepEqual(ping.result, {});
  const opened = await tool(rpc, 'divlet_open', {});
  assert.equal(opened.json.frames.length, 2, 'the session still works after a protocol error');
});

test('two MCP clients share one board: the second attaches instead of opening a writer', async t => {
  const { cwd, state } = await project(t);
  await writeProject(cwd);
  const first = client(cwd, state), second = client(cwd, state);
  t.after(() => Promise.all([first.stop(), second.stop()]));
  for (const rpc of [first, second]) { await rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} }); }

  const a = await tool(first, 'divlet_open', {});
  const b = await tool(second, 'divlet_open', {});
  assert.equal(b.json.url, a.json.url, 'the second client reaches the same board');
  assert.equal(b.json.projectId, a.json.projectId);

  // One accepted state: what one client writes, the other reads, and revisions are the board's.
  const written = await tool(first, 'divlet_patch', { projectId: a.json.projectId, frameId: 'one', expectedVersion: 1, patch: { name: 'From A' } });
  assert.equal(written.json.version, 2);
  const seen = await tool(second, 'divlet_read', { projectId: b.json.projectId, frameId: 'one', view: 'frame' });
  assert.equal(seen.json.name, 'From A');
  assert.equal(seen.json.version, 2);

  // Both read version 2; the first write wins and the second is refused without changing anything.
  const winner = await tool(first, 'divlet_patch', { projectId: a.json.projectId, frameId: 'one', expectedVersion: 2, patch: { name: 'Winner' } });
  assert.equal(winner.json.version, 3);
  const loser = await tool(second, 'divlet_patch', { projectId: b.json.projectId, frameId: 'one', expectedVersion: 2, patch: { name: 'Loser' } });
  assert.equal(loser.isError, true);
  assert.match(loser.text, /REVISION_CONFLICT/);
  const final = await tool(second, 'divlet_read', { projectId: b.json.projectId, frameId: 'one', view: 'frame' });
  assert.equal(final.json.name, 'Winner');

  // A browser session is just another client of the same board: the page's own API reports the accepted revision.
  const page = await (await fetch(new URL('api/project', a.json.url))).json();
  assert.equal(page.documents.find(frame => frame.id === 'one').version, 3, 'the board a browser loads sees the same accepted state');
  assert.equal(page.projectId, a.json.projectId);

  // The user's selection on the board is one thing, seen by both clients.
  const selected = await tool(first, 'divlet_read', { projectId: a.json.projectId, view: 'selection' });
  const selectedFromB = await tool(second, 'divlet_read', { projectId: b.json.projectId, view: 'selection' });
  assert.deepEqual(selectedFromB.json.selection, selected.json.selection);

  // Closing the client that attached leaves the owner's board alone.
  const secondExit = await second.stop();
  assert.equal(secondExit.code, 0);
  const stillThere = await tool(first, 'divlet_read', { projectId: a.json.projectId, view: 'project' });
  assert.equal(stillThere.json.frames.length, 2, 'the board outlives the client that attached to it');
});

test('a board owned by another process is used, not duplicated, even for a client that starts later', async t => {
  const { cwd, state } = await project(t);
  await writeProject(cwd);
  const owner = client(cwd, state);
  t.after(() => owner.stop());
  await owner.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const opened = await tool(owner, 'divlet_open', {});
  process.env.PI_DIVLET_STATE_DIR = state;
  const board = await findBoard(path.join(cwd, 'project.divlet'));
  assert.ok(board, 'the owner registered its board');
  assert.equal(board.url, opened.json.url);

  const later = client(cwd, state);
  t.after(() => later.stop());
  await later.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const attached = await tool(later, 'divlet_open', {});
  assert.equal(attached.json.url, board.url);
  assert.equal((await readFile(path.join(cwd, 'project.divlet'), 'utf8')).length > 0, true);
});


test('a request typed on the board becomes a sampling request the client answers', async t => {
  const { cwd, state } = await project(t);
  await writeProject(cwd);
  const rpc = client(cwd, state);
  t.after(() => rpc.stop());
  await rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: { sampling: {} }, clientInfo: { name: 'sampler', version: '1' } });
  rpc.notify('notifications/initialized');
  const opened = await tool(rpc, 'divlet_open', {});
  assert.equal(opened.isError, false);
  const projectId = opened.json.projectId;
  const frameId = opened.json.frames[0].id;

  // The client is the agent: it answers the board's prompt through sampling.
  const asked = new Promise(resolve => { rpc.onRequest = message => { if (message.method === 'sampling/createMessage') resolve(message); }; });
  const answer = async askedMessage => rpc.respond(askedMessage.id, {
    role: 'assistant',
    content: { type: 'text', text: 'Tightened the title spacing on the first frame.' },
    model: 'test-model',
    stopReason: 'endTurn',
  });
  const ask = await fetch(new URL('api/ask', opened.json.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'tighten the title', ids: [frameId] }) });
  assert.equal(ask.status, 200, await ask.text());
  const request = await asked;
  assert.equal(request.params.messages[0].content.text.includes('tighten the title'), true, 'the board request travels as the sampling prompt');
  assert.equal(request.params.messages[0].role, 'user');
  assert.equal(typeof request.params.maxTokens, 'number');
  await answer(request);

  // The answer lands in the board's own history and conversation, visible to every client.
  await waitFor(async () => {
    const history = await tool(rpc, 'divlet_read', { projectId, view: 'history' });
    return history.json.changes.some(change => change.kind === 'reply' && /Tightened the title spacing/.test(change.message || change.text || ''));
  }, 'the sampling answer reaches the board');
  const board = await (await fetch(new URL('api/project', opened.json.url))).json();
  assert.equal(board.agent.connected, true, 'the board sees an agent because an MCP client is connected');
  assert.equal(board.agent.busy, false);
});

test('without sampling the board is told, not left waiting', async t => {
  const { cwd, state } = await project(t);
  await writeProject(cwd);
  const rpc = client(cwd, state);
  t.after(() => rpc.stop());
  await rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const opened = await tool(rpc, 'divlet_open', {});
  assert.ok(opened.json.url);
  const ask = await fetch(new URL('api/ask', opened.json.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'bigger title' }) });
  assert.equal(ask.status, 200, 'the request is accepted: an agent is connected');
  await waitFor(async () => {
    const history = await tool(rpc, 'divlet_read', { projectId: opened.json.projectId, view: 'history' });
    return history.json.changes.some(change => change.kind === 'reply' && /does not support sampling/.test(change.message || ''));
  }, 'the board is told the client cannot answer');
  assert.equal(rpc.requests.length, 0, 'no sampling request is sent to a client that cannot answer');
});
