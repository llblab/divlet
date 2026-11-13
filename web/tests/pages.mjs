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
  // A first visit reads the page at its real size; the board is one step back and is remembered afterwards.
  await page.waitForSelector('#expanded-preview:not([hidden])');
  assert.equal((await page.locator('#expanded-title').textContent()).trim(), 'Edit on the board');
  const readable = async () => page.evaluate(() => {
    const frame = document.querySelector('iframe[data-document-id="index"]').getBoundingClientRect();
    return { width: frame.width, viewport: innerWidth };
  });
  const wide = await readable();
  assert.ok(wide.width > wide.viewport * 0.9, `the page uses the window width (${wide.width}/${wide.viewport})`);
  const heading = await page.frameLocator('iframe[data-document-id="index"]').locator('h1').first().evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize) * node.getBoundingClientRect().width / node.offsetWidth);
  assert.ok(heading >= 28, `the heading reads at real size (${heading}px)`);
  await page.screenshot({ path: 'artifacts/pages-first-visit.png' }).catch(() => {});
  await page.click('#expanded-back');
  await page.waitForSelector('#expanded-preview', { state: 'hidden' });
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

test('a first visit on a phone reads the landing as a phone page', async () => {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.goto(base);
  await phone.waitForSelector('#expanded-preview:not([hidden])');
  const frame = phone.frameLocator('iframe[data-document-id="index"]');
  await frame.locator('h1').first().waitFor();
  const layout = await frame.locator('h1').first().evaluate(node => ({ font: Number.parseFloat(getComputedStyle(node).fontSize), right: node.getBoundingClientRect().right, width: document.documentElement.clientWidth }));
  assert.ok(layout.width <= 400 && layout.right <= layout.width + 1, `the page lays out at phone width (${JSON.stringify(layout)})`);
  assert.ok(layout.font >= 24, 'and its heading stays readable');
  await phone.screenshot({ path: 'artifacts/pages-first-visit-phone.png' }).catch(() => {});
  await phone.close();
});

test('an agent connects by URL, edits the project and the visitor sees it; the copy persists across reloads', async () => {
  const connection = await connectBrowserMcp(base, { browser, readyTimeoutMs: 15_000 });
  try {
    assert.deepEqual(connection.tools.filter(tool => !tool.name.endsWith('_divlet')).map(tool => tool.name), ['divlet_read', 'divlet_patch', 'divlet_edit', 'divlet_frame_manage', 'divlet_undo', 'divlet_mark']);
    assert.equal(connection.tools.length, 12, 'browser allowlisting retains six explicitly described compatibility aliases');
    assert.match(connection.tools.find(tool => tool.name === 'read_divlet').description, /Compatibility alias for divlet_read/);
    assert.match(String(connection.discovery.instructions), /browser-local copy/);
    const page = connection.page;
    await page.waitForSelector('.artboard[data-artboard-id="index"] iframe');
    const project = parse(await connection.callTool('read_divlet', {}));
    assert.deepEqual(project.frames.map(frame => frame.id), ['index']);
    const frame = parse(await connection.callTool('divlet_read', { view: 'frame', frameId: 'index', full: true }));
    const heading = Object.values(frame.nodes).find(node => node.type === 'element' && node.tag === 'h1');
    const text = Object.values(frame.nodes).find(node => node.type === 'text' && heading.children.includes(node.id));
    parse(await connection.callTool('divlet_mark', { frameId: 'index', nodeIds: [heading.id], note: 'retitling the hero' }));
    const patched = parse(await connection.callTool('patch_divlet', { frameId: 'index', expectedVersion: frame.version, label: 'agent retitle', patch: { nodes: { [text.id]: { content: 'Edited by an agent in your browser' } } } }));
    assert.equal(patched.version, frame.version + 1);
    await page.frameLocator('iframe[data-document-id="index"]').locator('h1', { hasText: 'Edited by an agent in your browser' }).waitFor();
    const stale = await connection.callTool('divlet_patch', { frameId: 'index', expectedVersion: frame.version, patch: { name: 'stale' } });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /^REVISION_CONFLICT/);
    const invalid = await connection.callTool('divlet_edit', { frameId: 'index', expectedVersion: patched.version, op: { type: 'explode' } });
    assert.equal(invalid.isError, true, 'schema refusal');
    // The visitor's own edit goes through the same writer; the agent reads it.
    await page.evaluate(async () => { const { commit, descriptor } = await import('./lib/store.js'); await commit('index', { name: 'Visitor renamed' }, { expectedVersion: descriptor('index').version }); });
    const after = parse(await connection.callTool('divlet_read', { view: 'frame', frameId: 'index', full: true }));
    assert.equal(after.name, 'Visitor renamed');
    const history = parse(await connection.callTool('divlet_read', { view: 'history' }));
    assert.deepEqual(history.changes.map(change => change.actor), ['agent', 'user']);
    await page.reload();
    await connection.reconnect();
    const restored = parse(await connection.callTool('divlet_read', { view: 'frame', frameId: 'index', full: true }));
    assert.equal(restored.name, 'Visitor renamed', 'IndexedDB kept the browser copy');
    assert.equal(restored.nodes[text.id].content, 'Edited by an agent in your browser');
    // Undo history belongs to the page instance, not to storage: a reload starts a new history line.
    const undo = await connection.callTool('divlet_undo', {});
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
    assert.equal(tools.find(tool => tool.name === 'divlet_read').annotations.readOnlyHint, true);
    const created = await client.callTool({ name: 'divlet_frame_manage', arguments: { action: 'create', name: 'Phone', width: 390, height: 844 } });
    assert.equal(created.isError, false);
    await connection.page.waitForSelector('.artboard[data-artboard-id="phone"]');
    const undone = await client.callTool({ name: 'divlet_undo', arguments: {} });
    assert.equal(undone.isError, false);
    await connection.page.waitForSelector('.artboard[data-artboard-id="phone"]', { state: 'detached' });
    await client.close();
  } finally { await connection.close(); }
});
