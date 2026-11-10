// A host may offer more than answering prompts: the Pi extension lets the board change the model and thinking level of the
// session that answers it, which MCP cannot. The board only ever asks for a value the host advertised, and stores nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { legacyProject } from './fixtures/legacy-project.js';
import { openRuntime } from '../lib/runtime.js';

const fixture = async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-controls-'));
  await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
  const runtime = await openRuntime({ cwd, watch: false });
  t.after(async () => { await runtime.close(); await fs.rm(cwd, { recursive: true, force: true }); });
  runtime.setAgent({ connected: true });
  return runtime;
};
const hostControls = {
  model: { value: 'anthropic/claude-sonnet-4-5', options: [{ id: 'anthropic/claude-sonnet-4-5', label: 'claude-sonnet-4-5' }, { id: 'anthropic/claude-haiku-4-5', label: 'claude-haiku-4-5' }] },
  thinking: { value: 'medium', options: ['off', 'low', 'medium', 'high'] },
};

test('a host that offers controls can be asked for a value it offered', async t => {
  const runtime = await fixture(t);
  runtime.setAgent({ controls: hostControls });
  const asked = [];
  runtime.on('agent-setting', request => asked.push(request));

  assert.deepEqual(runtime.applyAgentSetting({ thinking: 'high' }), { ok: true });
  assert.deepEqual(runtime.applyAgentSetting({ model: 'anthropic/claude-haiku-4-5', thinking: 'off' }), { ok: true });
  assert.deepEqual(asked, [{ thinking: 'high' }, { model: 'anthropic/claude-haiku-4-5', thinking: 'off' }]);

  // The host reports what took effect, and the board shows that — not what was requested.
  const next = structuredClone(hostControls);
  next.thinking = { ...next.thinking, value: 'high' };
  runtime.setAgent({ controls: next });
  assert.equal(runtime.info().agent.controls.thinking.value, 'high');
  assert.equal(runtime.readHistory({ limit: 1 }).changes.some(change => change.kind === 'patch'), false, 'a session setting is not project content');
});

test('a host without controls is never asked, and a value it did not offer is refused', async t => {
  const runtime = await fixture(t);
  assert.throws(() => runtime.applyAgentSetting({ thinking: 'high' }), /cannot change the model or the thinking level/);
  assert.equal(runtime.info().agent.controls, undefined, 'an MCP-backed board advertises no controls');

  runtime.setAgent({ controls: hostControls });
  runtime.on('agent-setting', () => {});
  assert.throws(() => runtime.applyAgentSetting({ model: 'openai/gpt-5' }), /Unknown model/);
  assert.throws(() => runtime.applyAgentSetting({ thinking: 'maximum' }), /Unknown thinking level/);
  assert.throws(() => runtime.applyAgentSetting({}), /Send a model, a thinking level, or both/);
  assert.throws(() => runtime.applyAgentSetting({ thinking: 3 }), /Unknown thinking level/);
});

test('a board with no connected agent cannot ask anyone', async t => {
  const runtime = await fixture(t);
  runtime.setAgent({ connected: false, controls: hostControls });
  assert.throws(() => runtime.applyAgentSetting({ thinking: 'low' }), /No agent is connected/);
});
