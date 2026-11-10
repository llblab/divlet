import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { startServer } from '../lib/server.ts';

async function fixture(t) {
  const runtime = new EventEmitter();
  const pages = new Map([
    ['/', '<!doctype html><html><head><title>Home</title></head><body><main>Home page</main></body></html>'],
    ['/guide/start/', '<!doctype html><html><head><title>Start</title></head><body><main>Nested guide</main></body></html>'],
    ['/space%20name/', '<!doctype html><html><head><title>Space</title></head><body><main>Encoded page</main></body></html>'],
  ]);
  runtime.clients = 0;
  runtime.info = () => ({ site: { version: 7, title: 'Documentation' } });
  runtime.renderSite = route => {
    const html = pages.get(route);
    if (!html) throw Object.assign(new Error('Unknown site route.'), { code: 'NOT_FOUND' });
    return { documentId: 'site-fixture', version: 7, html };
  };
  const server = await startServer(runtime);
  t.after(() => server.close());
  return { runtime, url: server.url };
}

test('site routes serve nested pages and canonical redirects beneath the token prefix', async t => {
  const { url } = await fixture(t);
  const root = await fetch(url + 'site?mode=preview', { redirect: 'manual' });
  assert.equal(root.status, 308);
  assert.equal(root.headers.get('location'), new URL(url).pathname + 'site/?mode=preview');
  assert.match(await (await fetch(url + 'site/')).text(), /Home page/);
  const nested = await fetch(url + 'site/guide/start/');
  assert.equal(nested.status, 200);
  assert.match(await nested.text(), /Nested guide/);
  const slashless = await fetch(url + 'site/guide/start?q=one', { redirect: 'manual' });
  assert.equal(slashless.status, 308);
  assert.equal(slashless.headers.get('location'), new URL(url).pathname + 'site/guide/start/?q=one');
  assert.equal((await fetch(url + 'site/space%20name/')).status, 200);
  assert.equal((await fetch(url + 'site/missing/')).status, 404);
  assert.equal((await fetch(url + 'site/missing', { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(new URL('/site/guide/start/', url))).status, 404);
  assert.notEqual((await fetch(url + 'site/guide%2fstart/')).status, 200);
});

test('site HTML adds a nonce-only live script and same-origin SSE connection policy', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url + 'site/guide/start/');
  const html = await response.text();
  const script = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.ok(script);
  const policy = response.headers.get('content-security-policy');
  assert.ok(policy.includes(`script-src 'nonce-${script[1]}'`));
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /base-uri 'none'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.match(script[2], /EventSource/);
  assert.match(script[2], new RegExp(new URL(url).pathname + 'events'));
});

test('site live script reloads only a new accepted site and returns to the board when disabled', async t => {
  const { url } = await fixture(t);
  const html = await (await fetch(url + 'site/')).text();
  const source = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  let stream;
  const actions = [];
  const context = {
    EventSource: class {
      constructor(endpoint) { this.endpoint = endpoint; stream = this; }
      addEventListener(name, callback) { this[name] = callback; }
      close() { actions.push('close'); }
    },
    location: { reload() { actions.push('reload'); }, replace(target) { actions.push(['replace', target]); } },
    addEventListener() {},
  };
  vm.runInNewContext(source, context);
  stream.state({ data: JSON.stringify({ site: { version: 7 } }) });
  stream.state({ data: 'invalid json' });
  assert.deepEqual(actions, []);
  stream.state({ data: JSON.stringify({ site: { version: 8 } }) });
  assert.deepEqual(actions, ['close', 'reload']);
  actions.length = 0;
  stream.state({ data: JSON.stringify({ site: null }) });
  assert.deepEqual(actions, ['close', ['replace', new URL(url).pathname]]);
});

test('embedded site receives live state only from its parent without cross-origin SSE', async t => {
  const { url } = await fixture(t);
  const html = await (await fetch(url + 'site/')).text();
  const source = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const messages = [];
  const actions = [];
  const listeners = new Map();
  const parent = { postMessage: message => messages.push(message) };
  vm.runInNewContext(source, {
    parent,
    EventSource: class { constructor() { throw new Error('An opaque iframe must use its parent connection.'); } },
    location: { reload: () => actions.push('reload'), replace: target => actions.push(target) },
    addEventListener: (type, listener) => listeners.set(type, listener),
  });
  assert.equal(messages[0].type, 'divlet:site-ready');
  listeners.get('message')({ source: {}, data: { type: 'divlet:site-state', site: { version: 8 } } });
  listeners.get('message')({ source: parent, data: { type: 'divlet:site-state', site: { version: 7 } } });
  assert.deepEqual(actions, []);
  listeners.get('message')({ source: parent, data: { type: 'divlet:site-state', site: { version: 8 } } });
  assert.deepEqual(actions, ['reload']);
  listeners.get('keydown')({ key: 'Escape' });
  assert.equal(messages.at(-1).type, 'divlet:escape');
});
