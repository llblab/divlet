// The GitHub Pages build as a real static site: the board opens the landing project with no backend, and an agent connects to
// the page by URL alone, discovers the divlet tools and edits the project the visitor is looking at.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { pagesEntries } from '../../scripts/pages-build.mjs';
import { connectBrowserMcp, browserMcpTransport } from '../../core/lib/browser-mcp.ts';

const files = new Map(await pagesEntries());
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.divlet': 'application/octet-stream' };
const prefix = '/divlet/';
const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  requests.push(`${req.method} ${url.pathname}`);
  const name = url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html' : null;
  if (req.method !== 'GET' || !name || !files.has(name)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(name)] ?? 'application/octet-stream' });
  res.end(files.get(name));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}${prefix}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.PI_DIVLET_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE } : {}) });
test.after(async () => { await browser.close(); server.close(); });

const frameText = (page, selector) => page.frameLocator('iframe[data-document-id="index"]').locator(selector).first().textContent();
const parse = result => { assert.equal(result.isError, false, result.content?.[0]?.text); return result.structuredContent; };

test('the static board opens the landing project with no backend', async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(base);
  await page.waitForSelector('#loading', { state: 'hidden' });
  await page.waitForSelector('.artboard[data-artboard-id="index"] iframe');
  assert.match(await frameText(page, 'h1'), /\S/);
  assert.equal(await page.evaluate(() => typeof globalThis[Symbol.for('browser-mcp/1')]?.handle), 'function');
  // Host capabilities: filesystem actions are absent, agents are offered the MCP connection to this very page.
  await page.click('#status');
  const menu = await page.locator('[role="menu"]').innerText();
  assert.doesNotMatch(menu, /Open project|Save a copy|folder path/);
  assert.match(menu, /Download project file/);
  await page.keyboard.press('Escape');
  await page.click('#open-agent');
  await page.waitForSelector('#agent .ask-copy');
  assert.match(await page.locator('#agent').innerText(), /Connect an agent to this page/);
  const exported = await page.evaluate(async () => (await (await import('./lib/host.js')).exports.page('index')).html);
  assert.match(exported, /^<!DOCTYPE html>/i);
  assert.doesNotMatch(exported, /data-divlet-id/, 'a clean export, not the editing page');
  await page.keyboard.press('Control+,');
  await page.waitForSelector('.settings-row');
  assert.equal(await page.locator('#settings-output').count(), 0, 'no build-output setting without a filesystem');
  assert.deepEqual(errors, []);
  assert.ok(requests.every(line => line.startsWith('GET ') && !line.includes('/api/') && !line.includes('/events')), `only static files were requested: ${requests.filter(line => line.includes('/api/')).join(', ')}`);
  await page.screenshot({ path: 'artifacts/pages-board.png' }).catch(() => {});
  await page.close();
});

test('an agent connects by URL, edits the project and the visitor sees it; the copy persists across reloads', async () => {
  const connection = await connectBrowserMcp(base, { browser, readyTimeoutMs: 15_000 });
  try {
    assert.deepEqual(connection.tools.map(tool => tool.name), ['read_divlet', 'patch_divlet', 'edit_divlet', 'frame_divlet', 'undo_divlet', 'mark_divlet']);
    assert.match(String(connection.discovery.instructions), /browser-local copy/);
    const page = connection.page;
    await page.waitForSelector('.artboard[data-artboard-id="index"] iframe');
    const project = parse(await connection.callTool('read_divlet', {}));
    assert.deepEqual(project.frames.map(frame => frame.id), ['index']);
    const frame = parse(await connection.callTool('read_divlet', { view: 'frame', frameId: 'index', full: true }));
    const heading = Object.values(frame.nodes).find(node => node.type === 'element' && node.tag === 'h1');
    const text = Object.values(frame.nodes).find(node => node.type === 'text' && heading.children.includes(node.id));
    parse(await connection.callTool('mark_divlet', { frameId: 'index', nodeIds: [heading.id], note: 'retitling the hero' }));
    const patched = parse(await connection.callTool('patch_divlet', { frameId: 'index', expectedVersion: frame.version, label: 'agent retitle', patch: { nodes: { [text.id]: { content: 'Edited by an agent in your browser' } } } }));
    assert.equal(patched.version, frame.version + 1);
    await page.frameLocator('iframe[data-document-id="index"]').locator('h1', { hasText: 'Edited by an agent in your browser' }).waitFor();
    const stale = await connection.callTool('patch_divlet', { frameId: 'index', expectedVersion: frame.version, patch: { name: 'stale' } });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /^REVISION_CONFLICT/);
    const invalid = await connection.callTool('edit_divlet', { frameId: 'index', expectedVersion: patched.version, op: { type: 'explode' } });
    assert.equal(invalid.isError, true, 'schema refusal');
    // The visitor's own edit goes through the same writer; the agent reads it.
    await page.evaluate(async () => { const { commit, descriptor } = await import('./lib/store.js'); await commit('index', { name: 'Visitor renamed' }, { expectedVersion: descriptor('index').version }); });
    const after = parse(await connection.callTool('read_divlet', { view: 'frame', frameId: 'index', full: true }));
    assert.equal(after.name, 'Visitor renamed');
    const history = parse(await connection.callTool('read_divlet', { view: 'history' }));
    assert.deepEqual(history.changes.map(change => change.actor), ['agent', 'user']);
    await page.reload();
    await connection.reconnect();
    const restored = parse(await connection.callTool('read_divlet', { view: 'frame', frameId: 'index', full: true }));
    assert.equal(restored.name, 'Visitor renamed', 'IndexedDB kept the browser copy');
    assert.equal(restored.nodes[text.id].content, 'Edited by an agent in your browser');
    // Undo history belongs to the page instance, not to storage: a reload starts a new history line.
    const undo = await connection.callTool('undo_divlet', {});
    assert.equal(undo.isError, true);
    assert.match(undo.content[0].text, /^NOTHING_TO_UNDO/);
  } finally { await connection.close(); }
});

test('the official SDK client drives the real application through the browser transport', async () => {
  const connection = await connectBrowserMcp(base, { browser, readyTimeoutMs: 15_000 });
  try {
    const client = new Client({ name: 'sdk', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(browserMcpTransport(connection));
    const { tools } = await client.listTools();
    assert.equal(tools.find(tool => tool.name === 'read_divlet').annotations.readOnlyHint, true);
    const created = await client.callTool({ name: 'frame_divlet', arguments: { action: 'create', name: 'Phone', width: 390, height: 844 } });
    assert.equal(created.isError, false);
    await connection.page.waitForSelector('.artboard[data-artboard-id="phone"]');
    const undone = await client.callTool({ name: 'undo_divlet', arguments: {} });
    assert.equal(undone.isError, false);
    await connection.page.waitForSelector('.artboard[data-artboard-id="phone"]', { state: 'detached' });
    await client.close();
  } finally { await connection.close(); }
});
