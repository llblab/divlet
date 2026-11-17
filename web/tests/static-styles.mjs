// Style editing on the static board, in both compositions the Pages build can make. With the Tailwind provider bundled, the core
// property controls and the class editor are two views of one authored meaning (a control edit becomes a utility; a typed utility,
// even one absent from the build-time snapshot, compiles in the page and reads back into the controls). With the provider omitted
// the same controls write native inline CSS. Both run with only static GETs: no Node backend, no route, no remote compiler.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { pagesEntries } from '../../scripts/pages-build.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.divlet': 'application/octet-stream' };
const prefix = '/divlet/';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.PI_DIVLET_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE } : {}) });
test.after(() => browser.close());

async function serve(options) {
  const files = new Map(await pagesEntries(options));
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
  return { base: `http://127.0.0.1:${server.address().port}${prefix}`, requests, files, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

async function until(read, label, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await read(); if (last) return last; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out: ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
}

async function open(site) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(site.base);
  await page.getByRole('button', { name: 'Collapse to the board', exact: true }).click();
  return { context, page, errors };
}

const heading = page => page.frameLocator('iframe[data-document-id="index"]').locator('h1').first();
async function selectHeading(page) {
  await until(async () => { await heading(page).click(); return await page.locator('#inspector [data-section="layout"]').count(); }, 'selecting the page heading shows its property controls');
}
const sections = page => page.locator('#inspector [data-section]').evaluateAll(nodes => nodes.map(node => node.dataset.section));
const computed = (page, property) => heading(page).evaluate((node, property) => getComputedStyle(node)[property], property);
const attr = (page, name) => heading(page).getAttribute(name);
const setField = async (page, key, value) => { const field = page.locator(`#inspector [data-key="${key}"]`); await field.fill(value); await field.press('Enter'); };
const undo = async page => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Control+z'); };
const redo = async page => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Control+Shift+z'); };

test('with the Tailwind provider, controls and the class editor are linked views and new utilities compile in the page', async () => {
  const site = await serve();
  const { context, page, errors } = await open(site);
  try {
    await selectHeading(page);
    assert.deepEqual((await sections(page)).filter(name => !['head', 'node-meta', 'measured'].includes(name)), ['classes', 'layout', 'spacing', 'border', 'effects', 'appearance', 'attrs', 'style'], 'the class editor leads the core controls');
    // Control → utility: one edit, no inline declaration.
    assert.equal(await computed(page, 'paddingRight'), '0px');
    await setField(page, 'p-r', '4');
    await until(async () => (await computed(page, 'paddingRight')) === '4px', 'a padding edit renders');
    assert.match(await attr(page, 'class') ?? '', /(?:^|\s)pr-1(?:\s|$)/, 'the control edit is the matching utility');
    assert.ok(!/padding/.test(await attr(page, 'style') ?? ''), 'no inline declaration competes with the utility');
    await until(async () => (await page.locator('#inspector .classes').innerText()).includes('pr-1'), 'the class editor shows the new utility');
    // Undo and Redo move that one edit as a unit.
    await undo(page);
    await until(async () => (await computed(page, 'paddingRight')) === '0px' && !/pr-1/.test(await attr(page, 'class') ?? ''), 'Undo removes the utility');
    await redo(page);
    await until(async () => (await computed(page, 'paddingRight')) === '4px', 'Redo restores it');
    // Utility → control: a class the build-time snapshot never saw compiles in the page and reads back into the control.
    const input = page.locator('#inspector .cls-input');
    await input.fill('pr-[37px]'); await input.press('Enter');
    await until(async () => (await computed(page, 'paddingRight')) === '37px', 'a new arbitrary utility compiles and renders');
    await until(async () => (await page.locator('#inspector [data-key="p-r"]').inputValue()) === '37', 'the padding control reads the utility back');
    await input.fill('bg-fuchsia-600'); await input.press('Enter');
    await until(async () => /^oklch\(0\.59/.test(await computed(page, 'backgroundColor')), 'a theme colour utility compiles and renders');
    await until(async () => (await page.locator('#inspector [data-key="fill"]').inputValue()) === 'var(--color-fuchsia-600)', 'the Fill control reads the colour back');
    // The class editor explains utilities with the in-page design system (no route).
    await page.locator('#inspector .classes [data-kind="utility"]').first().hover();
    // What a utility cannot express stays plain CSS: a single border edge is a deliberate inline declaration.
    await setField(page, 'border-width-t', '3');
    await until(async () => /border-top-width:\s*3px/.test(await attr(page, 'style') ?? ''), 'an unconvertible edit stays an inline declaration');
    // The copy persists across a reload.
    await until(async () => (await computed(page, 'paddingRight')) === '37px', 'edits are rendered before reload');
    await page.reload();
    await page.getByRole('button', { name: 'Collapse to the board', exact: true }).click({ timeout: 1500 }).catch(() => {});
    await until(async () => (await computed(page, 'paddingRight')) === '37px', 'the browser-local copy keeps the edits');
    assert.deepEqual(errors, []);
    const outside = site.requests.filter(line => !line.startsWith('GET '));
    assert.deepEqual(outside, [], 'only static GETs');
    assert.deepEqual(site.requests.filter(line => /\/(?:api|events)\b/.test(line)), [], 'no native route is used');
  } finally { await context.close(); await site.close(); }
});

test('without the provider the same controls write native inline CSS and there is no class editor', async () => {
  const site = await serve({ tailwind: false });
  const { context, page, errors } = await open(site);
  try {
    await selectHeading(page);
    assert.deepEqual((await sections(page)).filter(name => !['head', 'node-meta', 'measured'].includes(name)), ['layout', 'spacing', 'border', 'effects', 'appearance', 'attrs', 'style'], 'every property control is still there');
    const classBefore = await attr(page, 'class');
    await setField(page, 'p-r', '4');
    await until(async () => (await computed(page, 'paddingRight')) === '4px', 'a padding edit renders');
    assert.equal(await attr(page, 'style'), 'padding-right:4px', 'the edit is a native inline declaration');
    assert.equal(await attr(page, 'class'), classBefore, 'no utility class is invented');
    // A declaration a control owns is not listed again in the raw CSS list.
    await page.locator('#inspector [data-section="style"] summary').click();
    assert.equal(await page.locator('#inspector [data-section="style"] .kv > .k').count(), 0, 'More CSS lists only what no control shows');
    // Fill and Family are controls too.
    await setField(page, 'fill', '#112233');
    await until(async () => (await computed(page, 'backgroundColor')) === 'rgb(17, 34, 51)', 'Fill writes background-color');
    assert.match(await attr(page, 'style') ?? '', /background-color:#112233/);
    await undo(page);
    await until(async () => (await computed(page, 'backgroundColor')) !== 'rgb(17, 34, 51)', 'Undo removes the fill');
    await undo(page);
    await until(async () => (await computed(page, 'paddingRight')) === '0px' && (await attr(page, 'style')) === null, 'Undo removes the padding declaration');
    await redo(page);
    await until(async () => (await computed(page, 'paddingRight')) === '4px', 'Redo restores it');
    await page.reload();
    await page.getByRole('button', { name: 'Collapse to the board', exact: true }).click({ timeout: 1500 }).catch(() => {});
    await until(async () => (await computed(page, 'paddingRight')) === '4px', 'the browser-local copy keeps the declaration');
    assert.deepEqual(errors, []);
    assert.deepEqual(site.requests.filter(line => /plugins\/tailwind/.test(line)), [], 'no Tailwind module is requested');
    assert.deepEqual(site.requests.filter(line => !line.startsWith('GET ')), [], 'only static GETs');
  } finally { await context.close(); await site.close(); }
});
