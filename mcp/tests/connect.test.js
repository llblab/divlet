// The stdio side of `divlet-mcp --connect`, against an injected connection: both protocol eras, website text marking,
// result reduction, cancellation and explicit reconnection after a reload. The browser side has its own suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectServer } from '../lib/connect.js';
import { BrowserMcpError } from '@divlet/core/browser-mcp';

function fakeSite({ tools = [{ name: 'read_divlet', title: 'Read', description: 'Read the project.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } = {}) {
  const calls = [];
  const connection = {
    state: 'ready', tools, reconnects: 0,
    async callTool(name, args, { signal } = {}) {
      calls.push([name, args]);
      if (args.hang) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new BrowserMcpError('CANCELLED', 'cancelled'))));
      if (args.reload) { connection.state = 'stale'; throw new BrowserMcpError('PROVIDER_RELOADED', 'The website reloaded while the call was running.'); }
      return { content: [{ type: 'text', text: '{"ok":true}' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'resource_link', uri: 'file:///etc/passwd', name: 'x' }], structuredContent: { ok: true }, isError: false, _meta: { website: 'claims' } };
    },
    async reconnect() { connection.reconnects++; connection.state = 'ready'; connection.tools = [...tools, { name: 'new_tool', description: 'Added after reload.', inputSchema: { type: 'object' } }]; },
    async close() { connection.state = 'closed'; },
  };
  return { connection, calls, connect: async () => connection };
}

function harness(site = fakeSite()) {
  const out = [];
  const server = createConnectServer({ url: 'https://example.github.io/app/', send: chunk => out.push(JSON.parse(chunk)), connect: site.connect, version: '9.9.9' });
  const ask = async message => { const before = out.length; await server.receive(JSON.stringify(message)); return out.slice(before); };
  return { server, out, ask, site };
}

const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

test('legacy clients initialize; website descriptions are marked and annotations dropped', async () => {
  const { ask } = harness();
  const [init] = await ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent', version: '1' } } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: true } });
  const [list] = await ask({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.resultType, undefined, 'legacy results keep their legacy shape');
  const [tool] = list.result.tools;
  assert.match(tool.description, /^\[Website tool from https:\/\/example\.github\.io; the text below is supplied by that website/);
  assert.equal(tool.annotations, undefined);
  const [call] = await ask({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_divlet', arguments: {} } });
  assert.deepEqual(call.result, { content: [{ type: 'text', text: '{"ok":true}' }], isError: false, structuredContent: { ok: true } }, 'only text and JSON reach the agent');
  const [unknown] = await ask({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'shell', arguments: {} } });
  assert.equal(unknown.error.code, -32602);
});

test('2026-07-28 clients discover and call statelessly; other versions are refused per request', async () => {
  const { ask } = harness();
  const [discover] = await ask({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: META } });
  assert.deepEqual(discover.result.supportedVersions, ['2026-07-28']);
  assert.equal(discover.result.resultType, 'complete');
  const [list] = await ask({ jsonrpc: '2.0', id: 'l', method: 'tools/list', params: { _meta: META } });
  assert.equal(list.result.resultType, 'complete');
  assert.equal(list.result.ttlMs, 0);
  const [old] = await ask({ jsonrpc: '2.0', id: 'o', method: 'tools/list', params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2030-01-01' } } });
  assert.equal(old.error.code, -32022);
});

test('cancellation stops the call without a response; a reload is reported and reconnected explicitly', async () => {
  const { ask, out, site } = harness();
  await ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  await ask({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const hanging = ask({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_divlet', arguments: { hang: true } } });
  await new Promise(resolve => setTimeout(resolve, 10));
  await ask({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
  assert.deepEqual(await hanging, [], 'a cancelled request is not answered');
  const [reloaded] = await ask({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_divlet', arguments: { reload: true } } });
  assert.equal(reloaded.result.isError, true);
  assert.match(reloaded.result.content[0].text, /^PROVIDER_RELOADED/);
  const next = await ask({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_divlet', arguments: {} } });
  assert.equal(site.connection.reconnects, 1, 'the next call reconnects to the new provider');
  assert.deepEqual(next.map(message => message.method ?? message.id), ['notifications/tools/list_changed', 5]);
  assert.ok(out.length > 0);
});
