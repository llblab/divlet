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

async function assertCollapseControl(page) {
  const control = page.getByRole('button', { name: 'Collapse to the board', exact: true });
  assert.equal(await control.count(), 1, 'expanded viewing has one collapse action, not browser-history navigation');
  const layout = await control.evaluate(async node => {
    const { icon } = await import('./lib/util.js');
    const label = node.querySelector('#expanded-title'), glyph = node.querySelector('svg');
    return {
      order: [...node.children].map(child => child.tagName.toLowerCase()),
      glyph: glyph.innerHTML, expectedGlyph: icon('collapse').innerHTML, hiddenGlyph: glyph.getAttribute('aria-hidden'),
      label: label.getBoundingClientRect().toJSON(), icon: glyph.getBoundingClientRect().toJSON(),
      button: node.getBoundingClientRect().toJSON(), viewport: innerWidth,
    };
  });
  assert.deepEqual(layout.order, ['span', 'svg'], 'the label precedes the collapse icon');
  assert.equal(layout.glyph, layout.expectedGlyph, 'the glyph is collapse, not the back arrow');
  assert.equal(layout.hiddenGlyph, 'true', 'the decorative icon does not duplicate the accessible action name');
  assert.ok(layout.label.right <= layout.icon.left + 1, 'the complete label stays to the left of the icon');
  assert.ok(layout.icon.width > 0 && layout.icon.right <= layout.button.right && layout.icon.top >= layout.button.top && layout.icon.bottom <= layout.button.bottom, 'the icon stays visible inside the control');
  assert.ok(layout.button.left >= 0 && layout.button.right <= layout.viewport, 'the whole control stays within the viewport');
}

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
  await assertCollapseControl(page);
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
  const columnEdges = await page.evaluate(() => {
    const row = document.querySelector('#brand').getBoundingClientRect(), panel = document.querySelector('#sidebar').getBoundingClientRect();
    return { left: Math.abs(row.left - panel.left), right: Math.abs(row.right - panel.right) };
  });
  assert.ok(columnEdges.left < 1 && columnEdges.right <= 1, 'the static board retains header-aligned defaults after its initially expanded view');
  assert.equal(await page.locator('#agent .chat-list .quiet').count(), 0, 'disconnected visitors are not told to start an unavailable conversation');
  const command = page.getByRole('textbox', { name: 'Agent connection command', exact: true });
  assert.equal(await command.count(), 1, 'the command is visible before it is copied');
  assert.equal(await command.inputValue(), `npx -y @divlet/mcp --connect ${base}`);
  assert.equal(await command.evaluate(node => node.readOnly && !node.disabled), true, 'read-only but selectable, not disabled');
  await command.focus();
  await page.keyboard.type('not editable');
  assert.equal(await command.inputValue(), `npx -y @divlet/mcp --connect ${base}`);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#agent .ask-copy').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await command.inputValue(), 'Copy uses exactly the displayed command');
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied'); }; });
  await page.locator('#agent .ask-copy').click();
  await page.waitForFunction(() => { const node = document.querySelector('.agent-connect-value'); return node === document.activeElement && node.selectionStart === 0 && node.selectionEnd === node.value.length; });
  assert.match(await page.locator('#toast').innerText(), /clipboard is unavailable/);
  await page.evaluate(() => { delete navigator.clipboard.writeText; });
  await command.press('Tab');
  assert.equal(await page.locator('#agent .ask-copy').evaluate(node => node === document.activeElement), true, 'Tab reaches the corner Copy button without editing the command');
  assert.equal(await page.locator('.agent-composer').isVisible(), false, 'the static host does not offer a conversation relay it lacks');
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
  await assertCollapseControl(phone);
  await phone.screenshot({ path: 'artifacts/pages-first-visit-phone.png' }).catch(() => {});
  await phone.locator('#expanded-preview').screenshot({ path: 'artifacts/pages-collapse-control.png' });
  await phone.evaluate(async () => (await import('./lib/help.js')).setUiSize(200));
  await assertCollapseControl(phone);
  await phone.getByRole('button', { name: 'Collapse to the board', exact: true }).focus();
  await phone.keyboard.press('Enter');
  await phone.waitForSelector('#expanded-preview', { state: 'hidden' });
  await phone.click('#open-agent');
  const command = phone.getByRole('textbox', { name: 'Agent connection command', exact: true });
  assert.equal(await command.count(), 1);
  for (const size of [100, 200]) {
    await phone.evaluate(async size => (await import('./lib/help.js')).setUiSize(size), size);
    const geometry = await phone.locator('.agent-connect-command').evaluate(box => {
      const field = box.querySelector('textarea'), copy = box.querySelector('button');
      const outer = box.getBoundingClientRect(), control = copy.getBoundingClientRect(), input = field.getBoundingClientRect();
      const glyph = copy.querySelector('svg').getBoundingClientRect(), label = copy.querySelector('span').getBoundingClientRect();
      return { readonly: field.readOnly, visible: input.width > 60 && input.height > 0, copyInside: control.left >= outer.left && control.right <= outer.right && control.top >= outer.top && control.bottom <= outer.bottom, copyInline: glyph.right <= label.left + 1 && Math.abs((glyph.top + glyph.bottom) - (label.top + label.bottom)) <= 2, clipped: box.scrollWidth > box.clientWidth + 1 };
    });
    assert.deepEqual(geometry, { readonly: true, visible: true, copyInside: true, copyInline: true, clipped: false }, `the command and corner Copy button fit at phone/${size}%`);
    assert.equal(await phone.locator('.chat-list .quiet').count(), 0);
    await phone.screenshot({ path: `artifacts/pages-agent-connect-${size}.png` });
    if (size === 100) await phone.locator('.agent-connect').screenshot({ path: 'artifacts/pages-agent-connect-card.png' });
  }
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
    assert.equal(await page.locator('.agent-connect').count(), 0, 'an MCP agent reported by the host replaces connection instructions');
    assert.match(await page.locator('.chat-list').textContent(), /Continue the conversation in your agent/);
    assert.doesNotMatch(await page.locator('.chat-list').textContent(), /Ask the agent to change the layout below/, 'tool access does not invent a conversation relay');
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
