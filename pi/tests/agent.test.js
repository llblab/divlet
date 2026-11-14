import test from 'node:test';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import divletExtension, { lastAssistantText } from '../lib/extension.js';
import { openRuntime } from '@divlet/core/runtime';
import { applyOperation } from '../../core/lib/ops.ts';
import { applyDocumentPatch, createDemoDocument } from '../../core/lib/model.ts';
import { exportHtml } from '../../core/lib/codec.ts';

function harness(cwd) {
  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  const messages = [];
  const sent = [];
  let aborted = 0;
  divletExtension({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => events.set(name, handler),
    sendMessage: (message) => messages.push(message),
    sendUserMessage: (content, options) => sent.push({ content, options }),
  });
  const ctx = { cwd, hasUI: false, abort: () => { aborted++; } };
  const call = async (name, params = {}) => (await tools.get(name).execute('test-call', params, new AbortController().signal, undefined, ctx)).details;
  const emit = (name, event = {}) => events.get(name)?.(event, ctx);
  return { tools, commands, events, messages, sent, ctx, call, emit, aborted: () => aborted };
}

const post = (url, route, body) => fetch(new URL(route, url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin }, body: JSON.stringify(body) });

test('a board request reaches Pi with its selection, and Pi state and replies come back', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-agent-'));
  await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
  const host = harness(cwd);
  try {
    const info = await host.call('divlet_open');
    assert.equal(info.agent.connected, true);
    assert.equal(info.agent.busy, false);
    const asked = await post(info.url, 'api/ask', { text: 'Make the title bigger', ids: ['welcome'], nodes: { documentId: 'welcome', nodeIds: ['title'] } });
    assert.equal(asked.status, 200);
    assert.equal((await asked.json()).queued, false);
    assert.equal(host.sent.length, 1);
    assert.equal(host.sent[0].options.deliverAs, 'followUp');
    // One compact prompt block first (`[divlet|…]`, its value on that line, lists below), then the request after a blank line.
    assert.match(host.sent[0].content, /^\[divlet\|project:[^|]+\|frames:1\|nodes:1\] about “A space for ideas” with 1 selected element\nframes:\n- welcome · v1 · “A space for ideas”\nelements in welcome:\n/);
    assert.match(host.sent[0].content, /\n- h1#title “Make room for something new\.”/);
    assert.ok(host.sent[0].content.endsWith('\n\nMake the title bigger'));
    const history = await host.call('divlet_read', { view: 'history' });
    const ask = history.changes.at(-1);
    assert.equal(ask.kind, 'ask');
    assert.equal(ask.actor, 'user');
    assert.equal(ask.message, 'Make the title bigger');
    assert.deepEqual(ask.context.nodes.ids, ['title']);

    await host.emit('agent_start');
    const runtime = await host.call('divlet_read', { view: 'project' });
    assert.equal(runtime.agent.busy, true);
    await host.emit('tool_execution_start', { toolName: 'divlet_patch', args: { documentId: 'welcome' } });
    assert.equal((await host.call('divlet_read')).agent.activity, 'editing “A space for ideas”');
    const queued = await (await post(info.url, 'api/ask', { text: 'And the button too' })).json();
    assert.equal(queued.queued, true);
    assert.equal((await host.call('divlet_read')).agent.queued, 1);
    const stop = await post(info.url, 'api/agent/stop', {});
    assert.equal(stop.status, 200);
    assert.equal(host.aborted(), 1);
    await host.emit('tool_execution_end', { toolName: 'divlet_patch' });
    await host.emit('agent_end', { messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'toolCall', name: 'divlet_patch' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Done — the title is now 6xl.' }] }] });
    const reply = (await host.call('divlet_read', { view: 'history' })).changes.at(-1);
    assert.equal(reply.kind, 'reply');
    assert.equal(reply.actor, 'agent');
    assert.equal(reply.message, 'Done — the title is now 6xl.');
    assert.equal(reply.context.replyTo, ask.seq);
    await host.emit('agent_settled', { aborted: false });
    assert.equal((await host.call('divlet_read')).agent.busy, false);
    assert.equal((await post(info.url, 'api/agent/stop', {})).status, 409);
    // Board requests and replies are not repeated back to Pi as “changes since your last turn”.
    const snapshot = await host.emit('before_agent_start', {});
    assert.doesNotMatch(snapshot?.message?.content ?? '', /Make the title bigger|Done — the title/);

    // A run that never touched divlet and was not asked from the board stays out of the board log.
    const seq = (await host.call('divlet_read', { view: 'history' })).changes.at(-1).seq;
    await host.emit('agent_start');
    await host.emit('tool_execution_start', { toolName: 'bash', args: {} });
    assert.equal((await host.call('divlet_read')).agent.activity, 'using bash');
    await host.emit('agent_end', { messages: [{ role: 'assistant', content: 'Unrelated answer' }] });
    await host.emit('agent_settled', {});
    assert.equal((await host.call('divlet_read', { view: 'history' })).changes.at(-1).seq, seq);

    const empty = await post(info.url, 'api/ask', { text: '   ' });
    assert.equal(empty.status, 400);
  } finally {
    await host.emit('session_shutdown');
    await rm(cwd, { recursive: true, force: true });
  }
});

test('without Pi the board cannot send requests', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-noagent-'));
  const runtime = await openRuntime({ cwd, watch: false });
  try {
    assert.equal(runtime.info().agent.connected, false);
    const response = await post(runtime.info().url, 'api/ask', { text: 'Hello' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'NO_AGENT');
  } finally {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('lastAssistantText reads string and block content', () => {
  assert.equal(lastAssistantText([{ role: 'assistant', content: 'a' }, { role: 'assistant', content: [{ type: 'text', text: ' b ' }, { type: 'text', text: 'c' }] }]), 'b \nc');
  assert.equal(lastAssistantText([{ role: 'assistant', content: [] }]), '');
  assert.equal(lastAssistantText(undefined), '');
});

test('insert takes nested specs, preset overrides and arrays of siblings', () => {
  const doc = createDemoDocument();
  const { patch } = applyOperation(doc, { type: 'insert', after: 'cta', spec: [
    { tag: 'article', id: 'card', className: 'p-4', children: [{ tag: 'h3', text: 'Title' }, { preset: 'button', text: 'Go' }, 'loose text'] },
    'link',
  ] });
  const { ids, removed, map, ...rest } = patch;
  const next = applyDocumentPatch(doc, rest);
  assert.deepEqual(ids, ['card', 'a']);
  assert.equal(next.nodes.hero.children.at(-2), 'card');
  assert.equal(next.nodes.hero.children.at(-1), 'a');
  const [h3, button, loose] = next.nodes.card.children;
  assert.equal(next.nodes[h3].tag, 'h3');
  assert.equal(next.nodes[next.nodes[h3].children[0]].content, 'Title');
  assert.equal(next.nodes[button].tag, 'button');
  assert.equal(next.nodes[button].attrs.type, 'button');
  assert.equal(next.nodes[next.nodes[button].children[0]].content, 'Go');
  assert.equal(next.nodes[loose].content, 'loose text');
  // Pasting the same IDs again yields fresh ones.
  const again = applyOperation(next, { type: 'insert', parentId: 'root', spec: { tag: 'article', id: 'card', children: [{ tag: 'h3', id: 'title', text: 'Copy' }] } }).patch;
  assert.deepEqual(again.ids, ['card-2']);
  assert.ok(Object.keys(again.nodes).includes('title-2'));
  assert.throws(() => applyOperation(doc, { type: 'insert', parentId: 'root', spec: { tag: 'img', children: ['x'] } }), /cannot contain/);
  assert.throws(() => applyOperation(doc, { type: 'insert', parentId: 'root', spec: { tag: 'div', children: 'x' } }), /children must be an array/);
  assert.throws(() => applyOperation(doc, { type: 'insert', parentId: 'root', spec: { preset: 'nope' } }), /Unknown element preset/);
  assert.throws(() => applyOperation(doc, { type: 'insert', parentId: 'root', spec: [] }), /Nothing to insert/);
});

test('export produces clean HTML for a node and a standalone page; assets list and upload', async () => {
  const doc = createDemoDocument();
  const fragment = exportHtml(doc, { nodeId: 'cards' });
  assert.doesNotMatch(fragment, /data-divlet|divlet:text/);
  assert.match(fragment, /^<section class="grid[^"]*">\n  <article/);
  assert.match(exportHtml(doc, { nodeId: 'brand-text' }), /^divlet \/ studio\n$/);
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-export-'));
  await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
  const runtime = await openRuntime({ cwd, watch: false });
  try {
    const page = await runtime.exportDocument('welcome');
    assert.match(page.html, /^<!doctype html>/);
    assert.match(page.html, /--accent: #d7b474;/);
    assert.match(page.html, /\.min-h-screen/);
    assert.doesNotMatch(page.html, /data-divlet|divlet-metadata|divlet:text/);
    const url = runtime.info().url;
    const download = await fetch(new URL('api/export/welcome?download=1', url));
    assert.match(download.headers.get('content-disposition'), /attachment; filename="welcome.html"/);
    const node = await (await fetch(new URL('api/export/welcome?node=cta', url))).json();
    assert.match(node.html, /^<button type="button"/);
    assert.equal((await fetch(new URL('api/export/welcome?node=missing', url))).status, 404);

    await writeFile(path.join(runtime.projectDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.deepEqual((await runtime.listAssets({ documentId: 'welcome' })).assets.map(item => item.path), ['logo.svg']);
    const upload = await fetch(new URL('api/assets?name=My%20Photo.PNG&documentId=welcome', url), { method: 'POST', headers: { 'Content-Type': 'image/png', Origin: new URL(url).origin }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    assert.equal(upload.status, 200);
    assert.equal((await upload.json()).path, 'asset:images/my-photo.png');
    const second = await (await fetch(new URL('api/assets?name=my-photo.png', url), { method: 'POST', headers: { 'Content-Type': 'image/png', Origin: new URL(url).origin }, body: Buffer.from([1]) })).json();
    assert.equal(second.path, 'asset:images/my-photo-2.png');
    const rejected = await fetch(new URL('api/assets?name=run.js', url), { method: 'POST', headers: { 'Content-Type': 'image/png', Origin: new URL(url).origin }, body: Buffer.from([1]) });
    assert.equal(rejected.status, 400);
    const listed = await (await fetch(new URL('api/assets?documentId=welcome', url))).json();
    assert.equal(listed.assets.length, 3);
  } finally {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('insert accepts a pasted HTML fragment and strips anything executable', () => {
  const doc = createDemoDocument();
  const html = '<!-- c --><div id="promo" class="p-4  rounded" style="color: red" onclick="x()"><h3>Hi <em>there</em></h3><a href="javascript:alert(1)">bad</a><a href="https://example.com">good</a><script>alert(1)</script><blink>old</blink><svg viewBox="0 0 10 10"><linearGradient id="g"/><rect width="4" height="4"/></svg></div>loose';
  const { patch } = applyOperation(doc, { type: 'insert', after: 'cta', html });
  const { ids, removed, map, ...rest } = patch;
  const next = applyDocumentPatch(doc, rest);
  assert.deepEqual(ids, ['promo', 'p']);
  const promo = next.nodes.promo;
  assert.equal(promo.className, 'p-4 rounded');
  assert.deepEqual(promo.style, { color: 'red' });
  assert.deepEqual(promo.attrs, {});
  const tags = promo.children.map(id => next.nodes[id].tag);
  assert.deepEqual(tags, ['h3', 'a', 'a', 'span', 'svg']);
  const [, bad, good] = promo.children;
  assert.deepEqual(next.nodes[bad].attrs, {});
  assert.equal(next.nodes[good].attrs.href, 'https://example.com');
  const svg = next.nodes[promo.children[4]];
  assert.equal(svg.attrs.viewBox, '0 0 10 10');
  assert.deepEqual(svg.children.map(id => next.nodes[id].tag), ['linearGradient', 'rect']);
  assert.equal(next.nodes[next.nodes.p.children[0]].content, 'loose');
  assert.throws(() => applyOperation(doc, { type: 'insert', parentId: 'root', html: '<script>x</script>  ' }), /no supported content/);
});

test('the agent marks where it works; marks end with its turn and follow deleted frames', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-work-'));
  const host = harness(cwd);
  try {
    const opened = await host.call('divlet_open');
    const id = opened.frames[0].id;
    host.emit('agent_start');
    await assert.rejects(host.call('divlet_mark', { frameId: id, nodeIds: ['nope'] }), /no node nope/);
    await assert.rejects(host.call('divlet_mark', {}), /needs frameId/);
    const frame = await host.call('divlet_read', { view: 'frame', frameId: id });
    const node = Object.keys(frame.nodes).find(key => frame.nodes[key].type === 'element' && key !== frame.rootId);
    const first = await host.call('divlet_mark', { frameId: id, nodeIds: [node], note: 'restyling the first block' });
    assert.deepEqual(first.marked.nodeIds, [node]);
    const state = await fetch(new URL('api/project', opened.url)).then(response => response.json());
    assert.equal(state.work.length, 1);
    assert.equal(state.work[0].note, 'restyling the first block');
    const second = await host.call('divlet_mark', { frameId: id, add: true });
    assert.equal(second.work, 2, 'add keeps earlier marks; no nodeIds marks the whole frame');
    const replaced = await host.call('divlet_mark', { frameId: id, note: 'whole frame' });
    assert.equal(replaced.work, 1, 'a new call replaces earlier marks');
    host.emit('tool_execution_end');
    assert.equal((await fetch(new URL('api/project', opened.url)).then(response => response.json())).agent.activity, 'whole frame', 'the note shows as the activity');
    assert.equal((await host.call('divlet_mark', { clear: true })).cleared, 1);
    await host.call('divlet_mark', { frameId: id });
    host.emit('agent_end', { messages: [] });
    host.emit('agent_settled');
    const after = await fetch(new URL('api/project', opened.url)).then(response => response.json());
    assert.deepEqual(after.work, [], 'marks end when the agent stops');
  } finally {
    await host.emit('session_shutdown');
    await rm(cwd, { recursive: true, force: true });
  }
});
