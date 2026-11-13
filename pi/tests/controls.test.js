// The board's model and thinking chips come from the Pi adapter: it must advertise them from the moment the session exists, not
// only after the first turn, and applying a choice must go through Pi rather than the board's own state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import divletExtension from '../lib/extension.js';

/** A fake Pi whose model APIs behave like the real ones: a catalogue, a current model and a thinking level. */
function fakePi(cwd) {
  const tools = new Map(), commands = new Map(), events = new Map();
  const models = [
    { provider: 'anthropic', id: 'claude-sonnet-4-5' },
    { provider: 'anthropic', id: 'claude-haiku-4-5' },
  ];
  const state = { model: models[0], level: 'medium', setModelCalls: [], setLevelCalls: [], authorised: new Set(['anthropic/claude-sonnet-4-5', 'anthropic/claude-haiku-4-5']) };
  const pi = {
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => events.set(name, handler),
    sendMessage: () => {},
    sendUserMessage: () => {},
    getThinkingLevel: () => state.level,
    setThinkingLevel: level => { state.setLevelCalls.push(level); state.level = level; },
    async setModel(model) {
      state.setModelCalls.push(`${model.provider}/${model.id}`);
      if (!state.authorised.has(`${model.provider}/${model.id}`)) return false;
      state.model = model;
      return true;
    },
  };
  const ctx = {
    cwd,
    hasUI: false,
    abort: () => {},
    get model() { return state.model; },
    scopedModels: models.map(model => ({ model })),
    modelRegistry: { find: (provider, id) => models.find(model => model.provider === provider && model.id === id) ?? null, getAvailable: () => models },
  };
  divletExtension(pi);
  const call = async (name, params = {}) => (await tools.get(name).execute('call', params, new AbortController().signal, undefined, ctx)).details;
  const emit = async (name, event = {}) => events.get(name)?.(event, ctx);
  return { tools, commands, events, state, ctx, call, emit };
}

test('a fresh Pi session advertises the model list and thinking level to every board', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-pi-controls-'));
  await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
  const pi = fakePi(cwd);
  t.after(async () => { await pi.emit('session_shutdown'); await rm(cwd, { recursive: true, force: true }); });

  // The session exists before any turn; that is when the board must learn what it can change.
  await pi.emit('session_start', { reason: 'startup' });
  const opened = await pi.call('divlet_open', {});
  const controls = (await fetch(new URL('api/project', opened.url), { headers: { Origin: new URL(opened.url).origin } }).then(response => response.json())).agent.controls;
  assert.deepEqual(controls.model, { value: 'anthropic/claude-sonnet-4-5', options: [{ id: 'anthropic/claude-sonnet-4-5', label: 'claude-sonnet-4-5' }, { id: 'anthropic/claude-haiku-4-5', label: 'claude-haiku-4-5' }] }, 'the model picker lists what the session can use, current first');
  assert.deepEqual(controls.thinking, { value: 'medium', options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] });

  // The board asks; Pi applies; the board then shows what took effect rather than what was requested.
  const post = (route, body) => fetch(new URL(route, opened.url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(opened.url).origin }, body: JSON.stringify(body) });
  assert.equal((await post('api/agent/settings', { model: 'anthropic/claude-haiku-4-5' })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(pi.state.setModelCalls, ['anthropic/claude-haiku-4-5']);
  const after = (await fetch(new URL('api/project', opened.url), { headers: { Origin: new URL(opened.url).origin } }).then(response => response.json())).agent;
  assert.equal(after.controls.model.value, 'anthropic/claude-haiku-4-5', 'the chip follows the session');

  assert.equal((await post('api/agent/settings', { thinking: 'high' })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(pi.state.setLevelCalls, ['high']);
});

test('a model Pi cannot authenticate is refused, and the board is told instead of silently keeping it', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-pi-controls-'));
  await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
  const pi = fakePi(cwd);
  t.after(async () => { await pi.emit('session_shutdown'); await rm(cwd, { recursive: true, force: true }); });
  await pi.emit('session_start', { reason: 'startup' });
  const opened = await pi.call('divlet_open', {});
  const origin = new URL(opened.url).origin;
  const state = () => fetch(new URL('api/project', opened.url), { headers: { Origin: origin } }).then(response => response.json());
  const history = () => fetch(new URL('api/history?limit=5', opened.url), { headers: { Origin: origin } }).then(response => response.json());
  // The conversation gains a reply saying why, and the chip keeps the model that is actually in use.
  pi.state.authorised.delete('anthropic/claude-haiku-4-5');
  await fetch(new URL('api/agent/settings', opened.url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ model: 'anthropic/claude-haiku-4-5' }) });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await state()).agent.controls.model.value, 'anthropic/claude-sonnet-4-5', 'the chip never claims a model Pi refused');
  const replies = (await history()).changes.filter(change => change.kind === 'reply');
  assert.ok(replies.some(change => /No credentials for anthropic\/claude-haiku-4-5/.test(change.message || '')), 'and the conversation says why, in Pi\'s own words');
});
