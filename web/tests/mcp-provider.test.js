// The browser MCP provider, exercised in Node: protocol revision 2026-07-28 semantics, the official SDK client through an
// in-memory transport, bounded validation/execution, cancellation and the optional WebMCP registration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { createBrowserMcpProvider, exposeBrowserMcp, defineTools, registerWebMcpTools, ENDPOINT_KEY, PROTOCOL_VERSION, ERRORS } from '@divlet/web/mcp';

const META = { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function counterTools(state = { count: 0 }) {
  return [
    { name: 'counter.get', title: 'Read the counter', description: 'Return the counter.', inputSchema: { type: 'object', additionalProperties: false }, annotations: { readOnlyHint: true }, execute: () => ({ count: state.count }) },
    {
      name: 'counter.add', description: 'Add to the counter after an optional delay.',
      inputSchema: { type: 'object', properties: { by: { type: 'integer', minimum: -100, maximum: 100 }, delayMs: { type: 'integer', minimum: 0, maximum: 5000 } }, required: ['by'], additionalProperties: false },
      async execute({ by, delayMs = 0 }, { signal }) {
        if (delayMs) await new Promise((resolve, reject) => { const timer = setTimeout(resolve, delayMs); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
        state.count += by;
        return { count: state.count, by };
      },
    },
    { name: 'fail', description: 'Always refuses.', inputSchema: { type: 'object' }, execute() { throw Object.assign(new Error('Nope.'), { code: 'NOT_ALLOWED', details: { why: 'test' } }); } },
    { name: 'huge', description: 'Returns too much.', inputSchema: { type: 'object' }, execute: () => ({ blob: 'x'.repeat(4096) }) },
    { name: 'hang', description: 'Never finishes.', inputSchema: { type: 'object' }, execute: () => new Promise(() => {}) },
  ];
}

/** The SDK `Transport` shape over a provider in the same process: messages still go through JSON text. */
function memoryTransport(provider) {
  return {
    async start() {}, async close() { this.onclose?.(); },
    async send(message) {
      const reply = await provider.handleText(JSON.stringify(message));
      if (reply) queueMicrotask(() => this.onmessage?.(JSON.parse(reply)));
    },
  };
}

test('the official SDK client (pinned to 2026-07-28) discovers and calls tools over revision 2026-07-28', async () => {
  const state = { count: 0 };
  const provider = createBrowserMcpProvider({ name: 'counter', version: '1.0.0', instructions: 'Counts.', tools: counterTools(state), limits: { resultBytes: 1024 } });
  const client = new Client({ name: 'test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(memoryTransport(provider));
  assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['counter.get', 'counter.add', 'fail', 'huge', 'hang']);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  const added = await client.callTool({ name: 'counter.add', arguments: { by: 3 } });
  assert.deepEqual(added.structuredContent, { count: 3, by: 3 });
  assert.equal(added.isError, false);
  assert.deepEqual(JSON.parse(added.content[0].text), { count: 3, by: 3 });
  const refused = await client.callTool({ name: 'counter.add', arguments: { by: 'many' } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /^INVALID_ARGUMENT: .*by must be integer/);
  assert.equal(state.count, 3, 'an invalid call never reaches the operation');
  const domain = await client.callTool({ name: 'fail', arguments: {} });
  assert.equal(domain.isError, true);
  assert.deepEqual(domain.structuredContent.error, { code: 'NOT_ALLOWED', message: 'Nope.', details: { why: 'test' } });
  const large = await client.callTool({ name: 'huge', arguments: {} });
  assert.equal(large.structuredContent.error.code, 'RESULT_TOO_LARGE');
  await assert.rejects(client.callTool({ name: 'missing', arguments: {} }), error => error.code === -32602);
  await client.close();
});

test('every request must carry the per-request protocol metadata; versions are checked per request', async () => {
  const provider = createBrowserMcpProvider({ name: 'p', version: '1', tools: counterTools() });
  const missing = await provider.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.equal(missing.error.code, ERRORS.INVALID_PARAMS);
  const noCapabilities = await provider.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION } } });
  assert.equal(noCapabilities.error.code, ERRORS.INVALID_PARAMS);
  const old = await provider.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } } });
  assert.deepEqual(old.error, { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: '2025-11-25' } });
  const legacy = await provider.handle({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } });
  assert.deepEqual(legacy.error.data, { supported: ['2026-07-28'] });
  const discover = await provider.handle({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: META } });
  assert.deepEqual(discover.result.supportedVersions, ['2026-07-28']);
  assert.equal(discover.result.resultType, 'complete');
  assert.equal(discover.result.ttlMs, 0);
  assert.deepEqual(discover.result._meta['io.modelcontextprotocol/serverInfo'], { name: 'p', version: '1' });
  assert.equal((await provider.handle({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: META, cursor: 'x' } })).error.code, ERRORS.INVALID_PARAMS);
  assert.equal((await provider.handle({ jsonrpc: '2.0', id: 6, method: 'resources/list', params: { _meta: META } })).error.code, ERRORS.METHOD_NOT_FOUND);
  assert.equal(JSON.parse(await provider.handleText('{')).error.code, ERRORS.PARSE);
  assert.equal(JSON.parse(await provider.handleText('[]')).error.code, ERRORS.INVALID_REQUEST);
  assert.equal(await provider.handle({ jsonrpc: '2.0', method: 'notifications/whatever' }), null, 'notifications get no response');
});

test('concurrent calls stay correlated and are bounded', async () => {
  const provider = createBrowserMcpProvider({ name: 'p', version: '1', tools: counterTools(), limits: { concurrent: 3 } });
  const call = (id, by, delayMs) => provider.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { _meta: META, name: 'counter.add', arguments: { by, delayMs } } });
  const replies = await Promise.all([call('slow', 1, 60), call('fast', 10, 0), call(7, 100, 20), call('over', 1, 0)]);
  assert.deepEqual(replies.map(reply => reply.id), ['slow', 'fast', 7, 'over']);
  assert.deepEqual(replies.slice(0, 3).map(reply => reply.result.structuredContent.by), [1, 10, 100]);
  assert.equal(replies[3].error.code, ERRORS.TOO_MANY_REQUESTS);
  const again = await call('after', 1, 0);
  assert.equal(again.result.isError, false, 'finished calls release their slots');
});

test('notifications/cancelled aborts the running call; it gets no response', async () => {
  const provider = createBrowserMcpProvider({ name: 'p', version: '1', tools: counterTools() });
  const running = provider.handle({ jsonrpc: '2.0', id: 'c1', method: 'tools/call', params: { _meta: META, name: 'counter.add', arguments: { by: 1, delayMs: 5000 } } });
  await delay(10);
  assert.equal(await provider.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'c1', reason: 'test' } }), null);
  assert.equal(await running, null);
});

test('a call that outlives its deadline is aborted and reported', async () => {
  const provider = createBrowserMcpProvider({ name: 'p', version: '1', tools: counterTools(), limits: { timeoutMs: 30 } });
  const reply = await provider.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: META, name: 'hang', arguments: {} } });
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.structuredContent.error.code, 'TIMEOUT');
});

test('messages and results are byte-bounded in both directions', async () => {
  const provider = createBrowserMcpProvider({ name: 'p', version: '1', tools: counterTools(), limits: { messageBytes: 512 } });
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: META, name: 'counter.get', arguments: { pad: 'é'.repeat(400) } } });
  assert.match(JSON.parse(await provider.handleText(big)).error.message, /exceeds 512 bytes/);
});

test('schemas outside the implemented subset are refused at definition time', () => {
  const tool = schema => ({ name: 't', description: 'd', inputSchema: schema, execute() {} });
  assert.throws(() => defineTools([tool({ type: 'object', properties: { a: { type: 'string', pattern: '^x' } } })]), /unsupported keyword "pattern"/);
  assert.throws(() => defineTools([tool({ type: 'object', $schema: 'http://json-schema.org/draft-07/schema#' })]), /dialect/);
  assert.throws(() => defineTools([tool({ type: 'string' })]), /object schema/);
  assert.throws(() => defineTools([tool({ type: 'object' }), tool({ type: 'object' })]), /Duplicate/);
  assert.throws(() => defineTools([{ ...tool({ type: 'object' }), name: 'has space' }]), /tool name/);
});

test('the page endpoint is a non-enumerable registered symbol and refuses a second provider', async () => {
  const page = {};
  const provider = createBrowserMcpProvider({ name: 'p', version: '1', tools: counterTools() });
  const withdraw = exposeBrowserMcp(provider, page);
  const endpoint = page[ENDPOINT_KEY];
  assert.equal(endpoint.protocol, 'browser-mcp/1');
  assert.match(endpoint.instance, /^[0-9a-f]{24}$/);
  assert.deepEqual(Object.keys(page), []);
  assert.throws(() => exposeBrowserMcp(provider, page), /already published/);
  const reply = JSON.parse(await endpoint.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } })));
  assert.equal(reply.result.tools.length, 5);
  withdraw();
  assert.equal(page[ENDPOINT_KEY], undefined);
  const closed = JSON.parse(await endpoint.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: META } })));
  assert.match(closed.error.message, /closed/);
});

test('WebMCP registration uses the same registry and is absent without the browser API', async () => {
  const state = { count: 0 };
  const registry = defineTools(counterTools(state));
  assert.deepEqual((await registerWebMcpTools(registry, undefined)).registered, []);
  const registrations = [];
  const modelContext = {
    async registerTool(tool, { signal }) {
      if (tool.name === 'hang') throw new DOMException('refused', 'InvalidStateError');
      registrations.push(tool);
      signal.addEventListener('abort', () => registrations.splice(registrations.indexOf(tool), 1));
    },
  };
  const result = await registerWebMcpTools(registry, modelContext);
  assert.deepEqual(result.registered, ['counter.get', 'counter.add', 'fail', 'huge']);
  assert.deepEqual(result.failed.map(item => item.name), ['hang']);
  assert.deepEqual(registrations[0].annotations, { readOnlyHint: true, consequentialHint: false });
  assert.deepEqual(await registrations[1].execute({ by: 2 }, { signal: new AbortController().signal }), { count: 2, by: 2 });
  await assert.rejects(registrations[1].execute({ by: 'x' }, { signal: new AbortController().signal }), /INVALID_ARGUMENT/);
  assert.equal(state.count, 2);
  result.unregister();
  assert.equal(registrations.length, 0);
});
