// The GitHub Pages build as a real static site: the board opens the landing project with no backend, and an agent connects to
// the page by URL alone, discovers the divlet tools and edits the project the visitor is looking at.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readProject } from '../../core/lib/project.ts';
import { previewCandidateSource } from '../../core/tests/fixtures/preview-candidates.js';
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

const publishedText = files.get('project.divlet').toString('utf8');
const publishedBase = createHash('sha256').update(publishedText).digest('hex');

// One origin-owned record, through the real IndexedDB rather than a storage substitute.
async function browserRecord({ write = false, value } = {}) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('divlet-browser', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('projects', write ? 'readwrite' : 'readonly');
      const store = tx.objectStore('projects'), key = location.pathname + '#landing';
      const action = write ? store.put(value, key) : store.get(key);
      let result;
      action.onsuccess = () => { result = action.result; };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

const startupSettled = page => page.waitForFunction(() => document.querySelector('#loading .host-error') || !!globalThis[Symbol.for('divlet.board-host/1')]);
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

test('the prepared landing is the first paint and stays until the visitor leaves it', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Hold the board back: whatever the visitor sees meanwhile is what a slow connection shows first.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(base + 'divlet-host.js', async route => { await held; await route.continue(); });
  await page.goto(base, { waitUntil: 'commit' });
  const cover = page.frameLocator('#boot-cover');
  await cover.locator('h1').first().waitFor();
  const first = await page.evaluate(() => {
    const node = document.querySelector('#boot-cover'), box = node.getBoundingClientRect(), hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return { covers: box.left <= 0 && box.top <= 0 && box.right >= innerWidth && box.bottom >= innerHeight, top: hit === node, spinner: getComputedStyle(document.querySelector('#loading')).display, chrome: ['#brand', '#dock', '#sidebar-foot'].map(selector => getComputedStyle(document.querySelector(selector)).display), host: !!globalThis[Symbol.for('divlet.board-host/1')] };
  });
  assert.deepEqual(first, { covers: true, top: true, spinner: 'none', chrome: ['none', 'none', 'none'], host: false }, 'before any board script runs the visitor reads the landing, with no preloader or editor chrome');
  release();
  // The board starts behind the landing and only adds the way to it.
  await page.waitForSelector('#expanded-preview:not([hidden])');
  await page.frameLocator('iframe[data-document-id="index"]').locator('h1').first().waitFor();
  await page.waitForTimeout(200);
  const ready = await page.evaluate(() => {
    const control = document.querySelector('#expanded-back').getBoundingClientRect();
    return { cover: !!document.querySelector('#boot-cover'), control: document.elementFromPoint(control.left + control.width / 2, control.top + control.height / 2)?.closest('#expanded-back') !== null, tip: document.querySelector('.tip')?.classList.contains('show') ?? false };
  });
  assert.deepEqual(ready, { cover: true, control: true, tip: false }, 'the unchanged landing never swaps under the reader; Edit on the board sits above it with no tip over the page');
  await page.click('#expanded-back');
  await page.waitForSelector('#expanded-preview', { state: 'hidden' });
  assert.equal(await page.locator('#boot-cover').count(), 0, 'collapsing reveals the board itself');
  assert.equal(await page.locator('#brand').isVisible(), true);
  assert.deepEqual(errors, []);
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
    assert.match(String(connection.discovery.instructions), /Utility classes compile in this page/, 'agents are told what the composed engine does, not the provider-free fallback');
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
    // The published landing would contradict the restored copy: the live page replaces it once painted.
    await page.waitForSelector('#boot-cover', { state: 'detached' });
    await page.frameLocator('iframe[data-document-id="index"]').locator('h1', { hasText: 'Edited by an agent in your browser' }).waitFor();
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

const preparationRefusalSource = structuredClone(previewCandidateSource);
const largeFrame = preparationRefusalSource.frames[0];
largeFrame.nodes.text.content = '&'.repeat(8 * 1024);
largeFrame.nodes.part = { id: 'part', type: 'element', tag: 'section', reusable: true, children: ['text'] };
largeFrame.nodes.root.children = ['part', ...Array.from({ length: 160 }, (_, index) => {
  const id = `instance-${index}`;
  largeFrame.nodes[id] = { id, type: 'ref', ref: 'part' };
  return id;
})];
const bytesRefusalSource = JSON.parse(publishedText);
bytesRefusalSource.assets = { unopened: 'data:application/octet-stream;base64,AQID' };
assert.doesNotThrow(() => readProject(preparationRefusalSource), 'the oversized derived preview starts from admitted canonical source');
assert.doesNotThrow(() => readProject(bytesRefusalSource), 'the unavailable-byte copy is valid native source, not corrupt JSON');

for (const row of [
  { name: 'malformed JSON', text: '{"schemaVersion":1,', cause: 'INVALID_PROJECT' },
  { name: 'unavailable bytes', text: '\n  ' + JSON.stringify(bytesRefusalSource) + '\n\n', cause: 'ASSETS_UNAVAILABLE' },
  { name: 'derived preparation refusal', text: JSON.stringify(preparationRefusalSource), cause: 'FILE_TOO_LARGE' },
  { name: 'non-text record', text: { retained: true }, cause: 'INVALID_PROJECT' },
]) test(`a stored browser copy is retained on ${row.name}`, async () => {
  const page = await browser.newPage();
  const pageErrors = [], restoreRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => restoreRequests.push(request.url()));
  await page.addInitScript(() => {
    window.startupErrors = [];
    addEventListener('error', event => startupErrors.push({ code: event.error?.code, details: event.error?.details }));
  });
  try {
    await page.goto(base); await page.waitForSelector('#loading', { state: 'hidden' });
    const record = { base: publishedBase, text: row.text, savedAt: 'unchanged-sentinel', opaque: { retained: [1, null, 'raw'] } };
    await page.evaluate(browserRecord, { write: true, value: record });
    restoreRequests.length = 0;
    await page.reload(); await startupSettled(page);
    assert.deepEqual(await page.evaluate(browserRecord), record, 'failed restoration does not delete, normalize, migrate or replace the record');
    const error = await page.locator('#loading .host-error').innerText();
    assert.match(error, /saved browser copy could not be opened and was kept unchanged/i);
    assert.deepEqual(await page.evaluate(() => ({ host: !!globalThis[Symbol.for('divlet.board-host/1')], provider: !!globalThis[Symbol.for('browser-mcp/1')], frames: document.querySelectorAll('.artboard').length })), { host: false, provider: false, frames: 0 }, 'no fallback writer, page agent or native board starts');
    assert.deepEqual(await page.evaluate(() => startupErrors), [{ code: 'BROWSER_RESTORE_FAILED', details: { causeCode: row.cause } }]);
    assert.equal(pageErrors.length, 1, 'one expected startup refusal');
    await page.reload(); await startupSettled(page);
    assert.deepEqual(await page.evaluate(browserRecord), record, 'repeated refusal is not an automatic reset');
    assert.equal(pageErrors.length, 2);
    assert.ok(restoreRequests.every(url => !/\/(?:board\.js|api\/|events(?:\?|$))/.test(url)), 'blocked startup never imports the native-fallback board or requests its routes');
  } finally { await page.close(); }
});

for (const row of [
  { name: 'invalid JSON', text: '{"schemaVersion":1,', cause: 'SyntaxError' },
  { name: 'derived preview refusal', text: JSON.stringify(preparationRefusalSource), cause: 'FILE_TOO_LARGE' },
]) test(`a new publication with ${row.name} cannot delete the older browser copy`, async () => {
  const page = await browser.newPage(), restoreRequests = [];
  page.on('request', request => restoreRequests.push(request.url()));
  await page.addInitScript(() => {
    window.startupCauses = [];
    addEventListener('error', event => startupCauses.push(event.error?.code ?? event.error?.name));
  });
  try {
    await page.goto(base); await page.waitForSelector('#loading', { state: 'hidden' });
    const record = { base: publishedBase, text: '\n' + publishedText + '\n', savedAt: 'older-copy', opaque: true };
    await page.evaluate(browserRecord, { write: true, value: record });
    await page.route(base + 'project.divlet', route => route.fulfill({ contentType: 'application/octet-stream', body: row.text }));
    restoreRequests.length = 0;
    await page.reload(); await startupSettled(page);
    assert.deepEqual(await page.evaluate(browserRecord), record, 'replacement source must prepare before any old-copy cleanup');
    assert.equal(await page.locator('#loading .host-error').count(), 1);
    assert.deepEqual(await page.evaluate(() => ({ host: !!globalThis[Symbol.for('divlet.board-host/1')], provider: !!globalThis[Symbol.for('browser-mcp/1')], frames: document.querySelectorAll('.artboard').length })), { host: false, provider: false, frames: 0 });
    assert.deepEqual(await page.evaluate(() => startupCauses), [row.cause]);
    assert.ok(restoreRequests.every(url => !/\/(?:board\.js|api\/|events(?:\?|$))/.test(url)));
  } finally { await page.close(); }
});

test('a valid new publication still replaces the old baseline and persists its own edits', async () => {
  const page = await browser.newPage();
  const next = JSON.parse(publishedText); next.name = 'Next publication';
  const text = JSON.stringify(next), fingerprint = createHash('sha256').update(text).digest('hex');
  try {
    await page.goto(base); await page.waitForSelector('#loading', { state: 'hidden' });
    await page.evaluate(browserRecord, { write: true, value: { base: publishedBase, text: publishedText, savedAt: 'old' } });
    await page.route(base + 'project.divlet', route => route.fulfill({ contentType: 'application/octet-stream', body: text }));
    await page.reload(); await page.waitForSelector('#loading', { state: 'hidden' });
    assert.equal(await page.evaluate(browserRecord), undefined, 'admitted changed publication retires the old baseline');
    const state = await page.evaluate(() => globalThis[Symbol.for('divlet.board-host/1')].readSession.readState());
    assert.equal(state.project.name, 'Next publication');
    await page.evaluate(async () => {
      const host = globalThis[Symbol.for('divlet.board-host/1')], frame = await host.readSession.readFrame('index');
      await host.writer.patch({ documentId: 'index', expectedVersion: frame.version, patch: { name: 'Edited next publication' } });
    });
    const record = await page.evaluate(browserRecord);
    assert.equal(record.base, fingerprint);
    assert.equal(JSON.parse(record.text).frames[0].name, 'Edited next publication');
    await page.reload(); await page.waitForSelector('#loading', { state: 'hidden' });
    assert.equal(await page.evaluate(async () => (await globalThis[Symbol.for('divlet.board-host/1')].readSession.readFrame('index')).name), 'Edited next publication');
    assert.deepEqual(await page.evaluate(browserRecord), record, 'successful restoration does not rewrite the source record');
  } finally { await page.close(); }
});
