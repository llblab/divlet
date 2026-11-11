import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startHub } from '../../core/lib/hub.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-launcher-errors-')), calls = [], errors = [], checks = [];
const files = [1, 2, 3, 4].map(n => path.join(root, `${n}.divlet`));
for (const [index, file] of files.entries()) await fs.writeFile(file, JSON.stringify({ version: '2.21', divlet: { schemaVersion: 1, name: `Project ${index + 1}` }, children: [] }));
let browser, release, enter, delayed;
const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { enter = resolve; });
const message = file => `Unsupported PEN node type: ellipse\n${file}/a-long-context-path-that-must-wrap-without-covering-project-buttons <details>literal text</details>`;
const hub = await startHub({ collection: root, open: async file => { calls.push(file); if (file === delayed) { enter(); await gate; } throw new Error(message(file)); } });
try {
  const options = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }; if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) options.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch(options); const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const json = Response.prototype.json, fetch = window.fetch; window.__launcherErrorReplies = []; window.__launcherOpenRequests = 0;
    window.fetch = function (...args) { if (args[0] === 'api/open') window.__launcherOpenRequests++; return fetch.apply(this, args); };
    Response.prototype.json = async function (...args) { const data = await json.apply(this, args); if (this.url.endsWith('/api/open')) window.__launcherErrorReplies.push(data.message); return data; };
  });
  await page.goto(hub.url); await page.locator('.card').first().waitFor();
  const card = n => page.locator('.card', { hasText: `Project ${n}` }), alert = page.getByRole('alert');
  assert.equal(await alert.count(), 0); const before = await page.locator('#grid').boundingBox();
  await card(1).click(); await alert.waitFor(); await page.mouse.move(0, 0);
  assert.equal(await page.locator('#open-error-message').textContent(), message(files[0])); assert.equal(await alert.locator('details').count(), 0);
  assert.deepEqual(await page.locator('#grid').boundingBox(), before); assert.equal(page.url(), hub.url); assert.equal(calls.length, 1);
  checks.push('a real failed open renders a persistent plain-text alert after the project list without moving the cards or navigating');
  await fs.mkdir('artifacts', { recursive: true });
  for (const width of [1100, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) for (const zoom of [1, 2]) {
      const bounds = await page.evaluate(({ theme, zoom }) => {
        document.documentElement.dataset.theme = theme; document.documentElement.style.zoom = String(zoom);
        const grid = document.querySelector('#grid'), panel = document.querySelector('#open-error'), g = grid.getBoundingClientRect(), p = panel.getBoundingClientRect();
        const cards = [...grid.children].map(node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
        const row = cards.filter(r => Math.abs(r.top - cards[0].top) < 1), next = cards.find(r => r.top >= Math.max(...row.map(r => r.bottom)));
        return { gap: p.top - g.bottom, rowGap: next ? next.top - Math.max(...row.map(r => r.bottom)) : null, after: !!(grid.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING), overflow: document.documentElement.scrollWidth > innerWidth, panelOverflow: panel.scrollWidth > panel.clientWidth };
      }, { theme, zoom });
      assert.equal(bounds.after, true); assert.ok(bounds.gap >= 20 * zoom - 1); assert.ok(bounds.rowGap === null || bounds.rowGap >= 16 * zoom - 1);
      assert.equal(bounds.overflow, false, JSON.stringify({ width, theme, zoom, bounds })); assert.equal(bounds.panelOverflow, false);
      if (width === 1100 && theme === 'dark' && zoom === 1) await page.screenshot({ path: 'artifacts/launcher-error-wide.png', fullPage: true });
      if (width === 390 && theme === 'dark' && zoom === 2) await page.screenshot({ path: 'artifacts/launcher-error-narrow.png', fullPage: true });
    }
  }
  checks.push('card rows keep a 16px gap and the bottom error a 20px gap at 1100/768/390px, light/dark and 100/200%, without horizontal overflow');
  await page.setViewportSize({ width: 1100, height: 900 }); await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
  delayed = files[1]; const cardsBefore = await page.locator('#grid').boundingBox(), idleBox = await card(2).boundingBox();
  await card(2).click(); await started; assert.equal(await alert.count(), 0);
  await page.getByRole('progressbar').waitFor();
  assert.equal(await page.getByRole('progressbar').count(), 1, 'only the pending card shows progress');
  assert.equal(await card(2).getByRole('progressbar').count(), 1, 'progress is drawn on the opening project card itself');
  assert.equal(await page.locator('.opening-status').count(), 0, 'no floating panel covers other projects');
  await page.waitForFunction(() => /Opening/.test(document.querySelector('.card[aria-busy="true"] .meta')?.textContent || ''));
  assert.deepEqual(await page.locator('#grid').boundingBox(), cardsBefore, 'opening does not move the grid'); const busyBox = await card(2).boundingBox(); assert.ok(Math.abs(busyBox.height - idleBox.height) < 0.5 && Math.abs(busyBox.width - idleBox.width) < 0.5 && Math.abs(busyBox.x - idleBox.x) < 0.5, 'opening does not resize or move the card sideways (hover lift excluded)');
  assert.equal(await card(2).getAttribute('aria-busy'), 'true'); assert.equal(await card(2).isDisabled(), true);
  await card(2).dispatchEvent('click'); await card(2).dispatchEvent('click');
  assert.equal(await page.evaluate(() => window.__launcherOpenRequests), 2, 'repeated clicks cannot issue another open while that project is pending');
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), null, 'preparation has no fabricated percentage');
  for (const width of [1100, 768, 390]) for (const zoom of [1, 2]) {
    await page.setViewportSize({ width, height: 900 });
    const fits = await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); const node = document.querySelector('.card[aria-busy="true"]'), bar = node.querySelector('.opening-track'), r = node.getBoundingClientRect(), t = bar.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && node.scrollWidth <= node.clientWidth && t.left >= r.left - 1 && t.right <= r.right + 1 && t.bottom <= r.bottom + 1; }, zoom);
    assert.equal(fits, true, JSON.stringify({ width, zoom }));
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.opening-track').evaluate(node => getComputedStyle(node, '::before').animationName), 'none');
  await page.screenshot({ path: 'artifacts/launcher-opening.png', fullPage: true });
  await page.setViewportSize({ width: 1100, height: 900 }); await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
  await card(3).click(); await alert.waitFor(); assert.equal(await page.locator('#open-error-message').textContent(), message(files[2]));
  const response = page.waitForResponse(r => r.url() === hub.url + 'api/open' && r.request().postDataJSON()?.file === files[1]); release(); await response;
  // Native body consumption plus a browser-frame checkpoint follows the handler's microtask chain, not just HTTP headers.
  await page.waitForFunction(() => window.__launcherErrorReplies.some(message => message.includes('/2.divlet/')));
  assert.equal(await page.locator('#open-error-message').textContent(), message(files[2]));
  assert.equal(await page.evaluate(() => document.activeElement.textContent.includes('Project 3')), true); assert.equal(calls.length, 3);
  assert.equal(await page.getByRole('progressbar').count(), 0);
  checks.push('indeterminate loading is drawn on the opening card (elapsed time, no floating panel, no reflow) before the open reply, guards duplicate clicks, survives narrow/200% layouts and respects reduced motion without fabricated progress');
  checks.push('a new open clears the previous error; an older held failure cannot replace the latest error or steal card focus');
  await page.locator('#q').fill('New canvas'); await page.locator('#make').click();
  await page.locator('#open-error-title', { hasText: 'Could not open the new project' }).waitFor();
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'new-canvas.divlet'), 'utf8')).schemaVersion, 1);
  assert.equal(page.url(), hub.url); assert.deepEqual(errors, []);
  checks.push('new-project open failure uses the same bottom alert without falsely claiming its already-published source was not created');
  console.log(JSON.stringify({ status: 'passed', checks, screenshots: ['artifacts/launcher-error-wide.png', 'artifacts/launcher-error-narrow.png'] }, null, 2));
} finally { release(); await browser?.close(); await hub.close(); await fs.rm(root, { recursive: true, force: true }); }
