// Real Pi (RPC mode) + divlet + a scripted OpenAI-compatible model: a request typed on the board
// must reach Pi, run a divlet tool, change the project and come back as a reply in History.
// Run with `npm run test:pi`; skipped when the pi CLI is not installed.
import http from 'node:http';
import { legacyProject } from '../../../../core/tests/fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

if (spawnSync('pi', ['--version'], { encoding: 'utf8' }).error) {
  console.log(JSON.stringify({ status: 'skipped', reason: 'the pi CLI is not installed' }));
  process.exit(0);
}
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SP = await mkdtemp(path.join(os.tmpdir(), 'divlet-e2e-'));
await mkdir(path.join(SP, 'agent'));
await mkdir(path.join(SP, 'work'));
await legacyProject(path.join(SP, 'work/project.divlet'), { demo: true });
const requests = [];
let scriptedCall = null;
const chunk = (delta, finish = null, usage) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  const json = JSON.parse(body);
  requests.push(json);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const last = json.messages.at(-1);
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (last.role === 'tool') {
    res.write(chunk({ role: 'assistant', content: scriptedCall?.reply || 'Added a **note** under the button.' }));
    res.write(chunk({}, 'stop', usage));
  } else {
    const args = scriptedCall?.args || { frameId: 'welcome', expectedVersion: 1, label: 'add a note under the CTA', op: { type: 'insert', after: 'cta', spec: { tag: 'p', id: 'e2e-note', className: 'text-sm text-[#b4a9c7]', text: 'Added by Pi' } } };
    res.write(chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: scriptedCall?.name || 'edit_divlet', arguments: JSON.stringify(args) } }] }));
    res.write(chunk({}, 'tool_calls', usage));
  }
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const pi = spawn('pi', ['--mode', 'rpc', '--no-extensions', '-e', path.join(ROOT, 'packages', 'pi', 'index.js'), '-e', path.join(ROOT, 'packages', 'pi', 'tests', 'e2e', 'mock-provider.js'), '--provider', 'mock', '--model', 'mock-model', '--no-session'], { cwd: `${SP}/work`, env: { ...process.env, PI_CODING_AGENT_DIR: `${SP}/agent`, MOCK_PORT: String(port), MOCK_API_KEY: 'x' }, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
pi.stderr.on('data', data => { stderr += data; });
const events = [];
const waiters = [];
readline.createInterface({ input: pi.stdout }).on('line', line => {
  let event; try { event = JSON.parse(line); } catch { return; }
  events.push(event);
  for (const waiter of [...waiters]) if (waiter.test(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
});
const waitFor = (test, label, timeout = 20000) => new Promise((resolve, reject) => {
  const found = events.find(test);
  if (found) return resolve(found);
  const timer = setTimeout(() => reject(new Error(`Timed out: ${label}\n${stderr.slice(-2000)}`)), timeout);
  waiters.push({ test, resolve: value => { clearTimeout(timer); resolve(value); } });
});
const send = command => pi.stdin.write(JSON.stringify(command) + '\n');
const result = {};
try {
  send({ id: 'cmds', type: 'get_commands' });
  const commands = await waitFor(event => event.id === 'cmds', 'get_commands');
  result.skillCommand = commands.data.commands.filter(command => command.source === 'skill' && /divlet/.test(command.name)).map(command => `${command.name} (${command.source})`);
  send({ id: 'divlet', type: 'prompt', message: '/divlet' });
  const notify = await waitFor(event => event.type === 'extension_ui_request' && /divlet: http/.test(event.message || ''), 'board URL');
  const url = notify.message.replace('divlet: ', '').trim();
  const api = (route, body) => fetch(new URL(route, url), body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin }, body: JSON.stringify(body) } : undefined).then(response => response.json());
  result.connected = (await api('api/project')).agent.connected;
  const asked = await api('api/ask', { text: 'Add a short note under the button', ids: ['welcome'], nodes: { documentId: 'welcome', nodeIds: ['cta'] } });
  result.asked = asked;
  await waitFor(event => event.type === 'agent_start', 'agent_start');
  const busy = await api('api/project');
  result.busyWhileWorking = busy.agent.busy;
  await waitFor(event => event.type === 'tool_execution_end' && event.toolName === 'edit_divlet', 'edit_divlet executed');
  await waitFor(event => event.type === 'agent_end', 'agent_end');
  await new Promise(resolve => setTimeout(resolve, 600));
  const after = await api('api/project');
  result.idleAfter = !after.agent.busy;
  const frame = await api('api/documents/welcome');
  result.noteAdded = frame.nodes['e2e-note']?.type === 'element' && frame.version === 2;
  const history = await api('api/history?limit=10');
  result.history = history.changes.map(change => `${change.actor}/${change.kind}: ${change.label ?? ''} ${change.summary}`);
  const firstPrompt = requests[0];
  const userText = firstPrompt.messages.filter(message => message.role === 'user')
    .map(message => typeof message.content === 'string' ? message.content : (message.content || []).map(block => block.text ?? '').join('\n'))
    .join('\n');
  // The board's context reaches the harness as one compact prompt block: `[divlet|project:…|frames:…|nodes:…]`, its value on the
  // same line, lists from the next line, and the request itself after a blank line.
  result.userMessageHasContext = /\[divlet\|project:[^|]+\|frames:\d+\|nodes:\d+\] [^\n]+\nframes:\n- welcome · v1 · “/m.test(userText)
    && /^elements in welcome:\n- button#cta/m.test(userText)
    && /\n\nAdd a short note under the button$/.test(userText)
    && !/sent from the divlet board/.test(userText);
  const system = JSON.stringify(firstPrompt.messages.filter(message => message.role === 'system'));
  result.skillAdvertised = /<name>divlet<\/name>/.test(system) && /SKILL\.md/.test(system);
  result.toolsAdvertised = (firstPrompt.tools || []).map(tool => tool.function?.name).filter(name => /_divlet$/.test(name));
  result.modelRequests = requests.length;
  assert.deepEqual(result.skillCommand, ['skill:divlet (skill)']);
  assert.equal(result.connected, true);
  assert.equal(result.asked.queued, false);
  assert.equal(result.busyWhileWorking, true);
  assert.equal(result.idleAfter, true);
  assert.equal(result.noteAdded, true);
  assert.deepEqual(result.history.map(line => line.split(':')[0]), ['user/ask', 'agent/patch', 'agent/reply']);
  assert.equal(result.userMessageHasContext, true);
  assert.equal(result.skillAdvertised, true);
  assert.deepEqual(result.toolsAdvertised, ['open_divlet', 'read_divlet', 'patch_divlet', 'edit_divlet', 'frame_divlet', 'undo_divlet', 'mark_divlet']);
  // Keep the legacy RPC fixture explicit, then earn the real command's native missing-source default independently.
  send({ id: 'native-divlet', type: 'prompt', message: '/divlet native-default' });
  const nativeNotice = await waitFor(event => event.type === 'extension_ui_request' && /divlet: http/.test(event.message || '') && event.message !== notify.message, 'native default board URL');
  const nativeURL = nativeNotice.message.replace('divlet: ', '').trim();
  const nativeApi = (route, body) => fetch(new URL(route, nativeURL), body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(nativeURL).origin }, body: JSON.stringify(body) } : undefined).then(response => response.json());
  const nativeState = await nativeApi('api/project'), descriptor = nativeState.documents[0];
  assert.equal(nativeState.project.format, 'divlet'); assert.equal(nativeState.project.version, 1); assert.equal(nativeState.documents.length, 1); assert.equal(descriptor.id, 'welcome');
  const nativeModel = await nativeApi(`api/documents/${encodeURIComponent(descriptor.id)}`);
  scriptedCall = { name: 'edit_divlet', reply: 'Added a default note.', args: { frameId: descriptor.id, expectedVersion: descriptor.version, label: 'default first edit', op: { type: 'insert', parentId: nativeModel.rootId, spec: { tag: 'p', id: 'rpc-default-note', text: 'Default RPC proof' } } } };
  const nativeEvents = events.length;
  const nativeAsked = await nativeApi('api/ask', { text: 'Add a native note', ids: [descriptor.id], nodes: { documentId: descriptor.id, nodeIds: [nativeModel.rootId] } }); assert.equal(nativeAsked.queued, false);
  await waitFor(event => events.indexOf(event) >= nativeEvents && event.type === 'tool_execution_end' && event.toolName === 'edit_divlet', 'native edit_divlet executed');
  await waitFor(event => events.indexOf(event) >= nativeEvents && event.type === 'agent_end', 'native agent_end');
  const nativeSource = JSON.parse(await readFile(path.join(SP, 'work/native-default/project.divlet'), 'utf8'));
  assert.equal(nativeSource.schemaVersion, 1); assert.match(JSON.stringify(nativeSource.frames[0]), /Default RPC proof/);
  assert.equal(JSON.parse(await readFile(path.join(SP, 'work/project.divlet'), 'utf8')).schemaVersion, 1);
  result.nativeDefault = { format: nativeState.project.format, starter: descriptor.id, firstDefaultEdit: true, legacyFixturePreserved: true };
  // Exercise the current HTML owner through actual advertised RPC tools, not HTTP patches.
  result.modelRequests = requests.length;
  console.log(JSON.stringify({ status: 'passed', ...result }, null, 2));
} catch (error) {
  console.error(error.message);
  console.error(JSON.stringify(events.slice(-8), null, 1).slice(0, 3000));
  process.exitCode = 1;
} finally {
  pi.kill();
  server.close();
  await rm(SP, { recursive: true, force: true });
}
