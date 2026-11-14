// Typing into the next item right after a Tab must still be saved when the previous commit's re-render reaches the page late.
// The page holds an update back while a text edit is open, so the render it shows is older than the server's; the edit names the
// held render when it is the same page as far as that element goes, and the server accepts it instead of refusing it as stale.
import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openRuntime } from '@divlet/core/runtime';

const playwright = await import('playwright');
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-text-render-'));
await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
const runtime = await openRuntime({ cwd, watch: true });
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitUntil = async (fn, label, timeout = 8000) => {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (error) { last = error; } await sleep(40); }
  throw new Error(`Timed out: ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
};
const errors = [];
let browser, release = () => {}, gate = null;
try {
  const base = runtime.read({ view: 'document', documentId: 'welcome' });
  await runtime.edit({ documentId: 'welcome', expectedVersion: base.version, actor: 'user', label: 'Add a list', op: { type: 'insert', parentId: base.rootId, spec: { id: 'steps', tag: 'ul', children: [{ id: 'one', tag: 'li', text: 'First' }, { id: 'two', tag: 'li', text: 'Second' }] } } });
  const textOf = id => { const model = runtime.read({ view: 'document', documentId: 'welcome' }); return model.nodes[model.nodes[id].children[0]].content; };
  browser = await playwright.chromium.launch(launch);
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 960 } })).newPage();
  page.on('pageerror', error => errors.push(error.message));
  const refused = [];
  page.on('response', async response => { if (/\/api\/edit$/.test(response.url()) && response.status() >= 400) refused.push((await response.json().catch(() => ({}))).error || response.status()); });
  // The render that follows the first commit is held back until the test lets it through, so it reaches the page only after the
  // second edit is open and committed, whatever the machine's speed.
  await page.route('**/api/render/**', async route => { if (gate) await gate; await route.continue(); });
  await page.goto(runtime.info().url);
  await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
  await page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="two"]').waitFor();
  await page.waitForFunction(() => document.querySelector('.artboard[data-artboard-id="welcome"]')?.dataset.status === 'live');
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['one']); });
  await waitUntil(() => runtime.info().selection.selectedNodes?.nodeIds?.[0] === 'one', 'the first item is selected');
  await page.locator('#viewport').focus();
  await page.keyboard.press('Enter');
  await page.locator('.artboard[data-artboard-id="welcome"].editing').waitFor();
  await page.keyboard.type('Alpha');
  gate = new Promise(resolve => { release = resolve; });
  await page.keyboard.press('Tab');
  await waitUntil(() => runtime.info().selection.selectedNodes?.nodeIds?.[0] === 'two', 'Tab moves to the next item');
  await waitUntil(() => textOf('one') === 'Alpha', 'Tab saved the first item');
  // Enter starts an edit against the render the board last heard about (a server-sent event), which can lag the server by a
  // moment; start it the same way, before the page has the newer render.
  await page.evaluate(async () => (await import('./lib/canvas.js')).editText('welcome', 'two', 0));
  await page.locator('.artboard[data-artboard-id="welcome"].editing').waitFor();
  await page.keyboard.type('Beta');
  gate = null; release(); // the held render now reaches the page while the edit is open, and is held back there until it ends
  await sleep(500);
  await page.keyboard.press('Control+Enter');
  await waitUntil(() => textOf('two') === 'Beta', 'the second item is saved although the page still showed the older render');
  assert.deepEqual(refused, [], 'no edit was refused as stale');
  await waitUntil(async () => (await page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="two"]').textContent()) === 'Beta', 'the page catches up once the held render is applied');
  assert.deepEqual(errors, []);
  console.log('text edit render handoff passed');
} finally {
  release?.();
  await browser?.close();
  await runtime.close?.();
  await rm(cwd, { recursive: true, force: true });
}
process.exit(0);
