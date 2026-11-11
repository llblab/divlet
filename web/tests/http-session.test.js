import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonTransport } from '../lib/http.js';
import { createHttpReadSession } from '../lib/http-session.js';

class Stream {
  handlers = new Map();
  closed = 0;
  addEventListener(name, listener) { this.handlers.set(name, listener); }
  emit(name, data) { this.handlers.get(name)?.({ data }); }
  close() { this.closed++; }
}

test('native JSON transport retains token-relative URLs, headers, POST and dynamic fetch instrumentation', async () => {
  const saved = globalThis.fetch, calls = [];
  const transport = createJsonTransport(new URL('http://127.0.0.1:1234/token/'));
  try {
    globalThis.fetch = async (...args) => { calls.push(['first', ...args]); return new Response('{"ok":1}'); };
    assert.deepEqual(await transport.request('api/project', { headers: { 'X-Test': 'yes' } }), { ok: 1 });
    globalThis.fetch = async (...args) => { calls.push(['second', ...args]); return new Response('{"ok":2}'); };
    assert.deepEqual(await transport.post('api/patch', { documentId: 'index' }), { ok: 2 });
    assert.deepEqual(calls, [
      ['first', 'http://127.0.0.1:1234/token/api/project', { headers: { 'Content-Type': 'application/json', 'X-Test': 'yes' } }],
      ['second', 'http://127.0.0.1:1234/token/api/patch', { method: 'POST', body: '{"documentId":"index"}', headers: { 'Content-Type': 'application/json' } }],
    ]);
  } finally { globalThis.fetch = saved; }
});

test('native JSON refusal preserves message, code, details and status projection', async () => {
  const body = { message: 'Changed', error: 'REVISION_CONFLICT', details: { actualVersion: 2 } };
  const transport = createJsonTransport(new URL('http://127.0.0.1/token/'), async () => new Response(JSON.stringify(body), { status: 409 }));
  await assert.rejects(transport.request('api/project'), { message: body.message, code: body.error, details: body.details, status: 409 });
  const invalid = createJsonTransport(new URL('http://127.0.0.1/token/'), async () => new Response('not JSON', { status: 500 }));
  await assert.rejects(invalid.request('api/project'), { message: 'Request failed (500)', status: 500 });
});

test('HTTP read session is lazy, encodes frame identities and grants no raw route or write capability', async () => {
  const calls = [], stream = new Stream(); let opened = 0;
  const reader = createHttpReadSession({ request: async path => { calls.push(path); return path; }, events: () => { opened++; return stream; } });
  assert.equal(Object.isFrozen(reader), true);
  assert.deepEqual(Object.keys(reader).sort(), ['readFrame', 'readState', 'subscribe']);
  assert.equal(opened, 0);
  assert.equal(await reader.readState(), 'api/project');
  assert.equal(await reader.readFrame('a/b #'), 'api/documents/a%2Fb%20%23');
  assert.deepEqual(calls, ['api/project', 'api/documents/a%2Fb%20%23']);
  assert.equal(opened, 0);
  const stop = reader.subscribe(() => {});
  assert.equal(opened, 1); stop();
});

test('SSE decoding retains state/change ordering, malformed payload policy and availability events', () => {
  const stream = new Stream(), seen = [];
  const reader = createHttpReadSession({ request: async () => ({}), events: () => stream });
  const stop = reader.subscribe(event => seen.push(event));
  stream.emit('open'); stream.emit('state', '{"stateVersion":1}'); stream.emit('change', '{"revision":2}');
  stream.emit('change', 'broken'); stream.emit('state', 'broken'); stream.emit('state', 'null'); stream.emit('error');
  assert.deepEqual(seen, [
    { type: 'connection', status: 'connected' }, { type: 'state', value: { stateVersion: 1 } }, { type: 'change', value: { revision: 2 } },
    { type: 'invalid-state' }, { type: 'state', value: null }, { type: 'connection', status: 'offline' },
  ]);
  stop(); stop();
  for (const name of ['open', 'error', 'state', 'change']) stream.emit(name, '{"late":true}');
  assert.equal(seen.length, 6, 'late queued events have no authority after unsubscribe');
  assert.equal(stream.closed, 1);
});

test('consumer errors are not mislabeled as malformed transport payloads', () => {
  const stream = new Stream();
  const reader = createHttpReadSession({ request: async () => ({}), events: () => stream });
  const stop = reader.subscribe(() => { throw new Error('consumer failure'); });
  assert.throws(() => stream.emit('state', '{}'), /consumer failure/);
  stop();
});
