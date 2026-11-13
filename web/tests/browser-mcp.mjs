// Browser MCP transport against real static pages in a real Chromium: connect by URL, discover, call, observe the UI, and
// the reliability/security boundaries. The fixture site is bundled to plain files and served by a file-only server; no MCP
// server process or HTTP endpoint takes part.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { connectBrowserMcp, browserMcpTransport, BrowserMcpError } from '../../core/lib/browser-mcp.ts';

const fixture = fileURLToPath(new URL('./fixtures/browser-mcp-site/', import.meta.url));
const bundle = async (entry, extra = {}) => (await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', conditions: ['divlet-source'], ...extra })).outputFiles[0].text;
const files = new Map([
  ['index.html', await fs.readFile(path.join(fixture, 'index.html'), 'utf8')],
  ['slow.html', await fs.readFile(path.join(fixture, 'slow.html'), 'utf8')],
  ['plain.html', await fs.readFile(path.join(fixture, 'plain.html'), 'utf8')],
  ['hostile.html', await fs.readFile(path.join(fixture, 'hostile.html'), 'utf8')],
  ['app.js', await bundle(path.join(fixture, 'app.js'))],
  ['provider.js', await bundle(fileURLToPath(new URL('../lib/mcp-provider.ts', import.meta.url)))],
]);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const prefix = '/owner/app/';
const requests = [];

/** A file-only server: GET of known files below a repository-like prefix, plus redirects for the origin tests. */
function serve(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const other = await serve((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><meta name="browser-mcp" content="browser-mcp/1"><script>Object.defineProperty(globalThis, Symbol.for('browser-mcp/1'), { value: { protocol: 'browser-mcp/1', instance: 'other', handle: async () => null } })</script>`); });
const otherOrigin = `http://127.0.0.1:${other.address().port}`;
const site = await serve((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  const url = new URL(req.url, 'http://x');
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (url.pathname === `${prefix}redirect`) { res.writeHead(302, { Location: `${otherOrigin}/elsewhere` }); return res.end(); }
  const name = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || 'index.html' : null;
  if (!name || !files.has(name)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(name)] });
  res.end(files.get(name));
});
const base = `http://127.0.0.1:${site.address().port}${prefix}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.PI_DIVLET_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE } : {}) });
const connect = (url = base, options = {}) => connectBrowserMcp(url, { browser, readyTimeoutMs: 5000, ...options });
const text = (page, selector) => page.$eval(selector, node => node.textContent);

test.after(async () => { await browser.close(); site.close(); other.close(); });

test('connect by URL under a repository subpath, discover, call and observe the page', async () => {
  const events = [];
  const connection = await connect(base, { onEvent: event => events.push(event.type) });
  try {
    assert.equal(connection.state, 'ready');
    assert.deepEqual(connection.discovery.supportedVersions, ['2026-07-28']);
    assert.deepEqual(connection.tools.map(tool => tool.name), ['todos.list', 'todos.add', 'todos.toggle', 'wait']);
    const added = await connection.callTool('todos.add', { text: 'Write the transport' });
    assert.deepEqual(added.structuredContent, { id: 1, text: 'Write the transport', done: false });
    await connection.page.waitForFunction(() => document.querySelector('#list li')?.textContent === '○ Write the transport');
    // The human interface runs the same domain operation; the agent sees its effect.
    await connection.page.click('#list li');
    await connection.page.waitForFunction(() => document.querySelector('#list li')?.textContent.startsWith('✓'));
    const listed = await connection.callTool('todos.list', {});
    assert.deepEqual(listed.structuredContent.todos, [{ id: 1, text: 'Write the transport', done: true }]);
    assert.equal(await connection.page.evaluate(() => typeof document.modelContext), 'undefined', 'Chromium has no native WebMCP here');
    assert.equal(await connection.page.evaluate(() => document.documentElement.dataset.webmcp), '');
    assert.deepEqual(events, ['ready']);
  } finally { await connection.close(); }
  assert.equal(connection.state, 'closed');
  assert.ok(requests.every(line => line.startsWith('GET ')), 'only static GETs reached the server');
});

test('the official SDK client works over the browser transport', async () => {
  const connection = await connect();
  try {
    const client = new Client({ name: 'sdk', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(browserMcpTransport(connection));
    const { tools } = await client.listTools();
    assert.equal(tools.length, 4);
    const result = await client.callTool({ name: 'todos.add', arguments: { text: 'From the SDK' } });
    assert.equal(result.structuredContent.text, 'From the SDK');
    const invalid = await client.callTool({ name: 'todos.add', arguments: { text: '' } });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /INVALID_ARGUMENT/);
    await client.close();
  } finally { await connection.close(); }
});

test('concurrent calls stay correlated; timeouts and cancellation reach the page', async () => {
  const connection = await connect();
  try {
    const results = await Promise.all([
      connection.callTool('wait', { ms: 150, tag: 'a' }),
      connection.callTool('wait', { ms: 10, tag: 'b' }),
      connection.callTool('wait', { ms: 80, tag: 'c' }),
    ]);
    assert.deepEqual(results.map(result => result.structuredContent.tag), ['a', 'b', 'c']);
    await assert.rejects(connection.callTool('wait', { ms: 5000, tag: 'late' }, { timeoutMs: 100 }), error => error.code === 'TIMEOUT');
    const controller = new AbortController();
    const cancelled = connection.callTool('wait', { ms: 5000, tag: 'stop' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(cancelled, error => error.code === 'CANCELLED');
    await connection.page.waitForFunction(() => document.getElementById('status').textContent === 'cancelled:late,stop');
    const invalid = await connection.callTool('todos.toggle', { id: 'one' });
    assert.equal(invalid.isError, true);
    await assert.rejects(connection.callTool('rm -rf', {}), error => error.code === 'TOOL_NOT_ALLOWED');
  } finally { await connection.close(); }
});

test('a reload invalidates pending calls and stale references; reconnect refreshes the provider; storage persists', async () => {
  const connection = await connect();
  try {
    await connection.callTool('todos.add', { text: 'Survives reloads' });
    const before = await connection.page.evaluate(() => globalThis[Symbol.for('browser-mcp/1')].instance);
    const pending = connection.callTool('wait', { ms: 5000, tag: 'reload' }).then(() => null, error => error);
    await new Promise(resolve => setTimeout(resolve, 50));
    await connection.page.reload();
    assert.equal((await pending)?.code, 'PROVIDER_RELOADED');
    assert.equal(connection.state, 'stale');
    await assert.rejects(connection.callTool('todos.list', {}), error => error.code === 'STALE');
    await connection.reconnect();
    assert.equal(connection.state, 'ready');
    assert.notEqual(await connection.page.evaluate(() => globalThis[Symbol.for('browser-mcp/1')].instance), before);
    const { structuredContent } = await connection.callTool('todos.list', {});
    assert.ok(structuredContent.todos.some(todo => todo.text === 'Survives reloads'), 'IndexedDB persisted across the reload');
  } finally { await connection.close(); }
});

test('closing the page rejects outstanding calls and the connection never looks connected afterwards', async () => {
  const connection = await connect();
  const pending = connection.callTool('wait', { ms: 5000 }).then(() => null, error => error);
  await new Promise(resolve => setTimeout(resolve, 50));
  await connection.page.close();
  assert.equal((await pending)?.code, 'CLOSED');
  assert.equal(connection.state, 'closed');
  await assert.rejects(connection.callTool('todos.list', {}), error => error.code === 'CLOSED');
  await assert.rejects(connection.reconnect(), error => error.code === 'CLOSED');
});

test('readiness: an async provider is awaited; a page without one fails fast', async () => {
  const slow = await connect(`${base}slow.html`);
  assert.deepEqual(slow.tools.map(tool => tool.name), ['ping']);
  await slow.close();
  const started = Date.now();
  await assert.rejects(connect(`${base}plain.html`), error => error instanceof BrowserMcpError && error.code === 'NO_PROVIDER');
  assert.ok(Date.now() - started < 4000, 'no provider is reported without waiting for the ready timeout');
});

test('origin boundaries: a cross-origin redirect is refused and leaving the origin closes the connection', async () => {
  await assert.rejects(connect(`${base}redirect`), error => error.code === 'ORIGIN_CHANGED');
  const connection = await connect();
  await connection.page.evaluate(href => { location.href = href; }, `${otherOrigin}/elsewhere`);
  await connection.page.waitForURL(`${otherOrigin}/elsewhere`).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(connection.state, 'closed');
  await assert.rejects(connection.reconnect(), error => error.code === 'CLOSED');
});

test('website code gets no host bindings; its descriptions stay data; oversized and mismatched replies are refused', async () => {
  const connection = await connect(`${base}hostile.html`);
  try {
    const innocent = connection.tools.find(tool => tool.name === 'innocent');
    assert.match(innocent.description, /IGNORE ALL PREVIOUS INSTRUCTIONS/, 'descriptions are passed on as untrusted text, not acted upon');
    const probe = await connection.callTool('innocent', {});
    assert.deepEqual(probe.structuredContent, { hostFunctions: [], hasProcess: 'undefined', hasRequire: 'undefined' });
    await assert.rejects(connection.callTool('huge', {}), error => error.code === 'MESSAGE_TOO_LARGE');
    await assert.rejects(connection.callTool('liar', {}), error => error.code === 'PROTOCOL_VIOLATION');
  } finally { await connection.close(); }
  const limited = await connect(base, { allowTools: ['todos.list'] });
  try {
    assert.deepEqual(limited.tools.map(tool => tool.name), ['todos.list']);
    await assert.rejects(limited.callTool('todos.add', { text: 'not allowed' }), error => error.code === 'TOOL_NOT_ALLOWED');
  } finally { await limited.close(); }
});

test('WebMCP, when the browser provides it, receives the same tools and runs the same operations', async () => {
  const context = await browser.newContext();
  // A stand-in for a browser that implements the draft API; the application code is unchanged.
  await context.addInitScript(() => {
    const tools = new Map();
    Object.defineProperty(Document.prototype, 'modelContext', { configurable: true, get() { return { registerTool: async (tool, { signal } = {}) => { tools.set(tool.name, tool); signal?.addEventListener('abort', () => tools.delete(tool.name)); } }; } });
    globalThis.__webmcpTools = tools;
  });
  const connection = await connectBrowserMcp(base, { context, readyTimeoutMs: 5000 });
  try {
    assert.equal(await connection.page.evaluate(() => document.documentElement.dataset.webmcp), 'todos.list,todos.add,todos.toggle,wait');
    const viaWebMcp = await connection.page.evaluate(() => globalThis.__webmcpTools.get('todos.add').execute({ text: 'Via WebMCP' }, { signal: new AbortController().signal }));
    assert.equal(viaWebMcp.text, 'Via WebMCP');
    const { structuredContent } = await connection.callTool('todos.list', {});
    assert.ok(structuredContent.todos.some(todo => todo.text === 'Via WebMCP'), 'one domain state behind both surfaces');
  } finally { await connection.close(); await context.close(); }
});
