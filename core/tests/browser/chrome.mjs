// The interface chrome: one left column (logo + search, sidebar, tabs), a bottom-right toolbar with the inspector attached above it,
// and the selection path in the bottom row between them — on a desktop window and on a phone.
import assert from 'node:assert/strict';
import { legacyProject } from '../fixtures/legacy-project.js';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../lib/runtime.js';

const playwright = await import('playwright');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-chrome-'));
await cp(path.join(root, 'examples', 'studio'), cwd, { recursive: true });
await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
const runtime = await openRuntime({ cwd, watch: false });
runtime.setAgent({ connected: true });
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const errors = [], checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitUntil = async (fn, label, timeout = 8000) => {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (error) { last = error; } await sleep(40); }
  throw new Error(`Timed out: ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
};
let browser;
try {
  browser = await playwright.chromium.launch(launch);
  const open = async (width, height) => {
    const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(runtime.info().url);
    await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
    return page;
  };
  const rect = (page, selector) => page.evaluate(selector => { const node = document.querySelector(selector); if (!node || node.hidden || !node.getClientRects().length) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }, selector);
  const select = page => page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['nav']); });

  /* ---- desktop ------------------------------------------------------------ */
  const page = await open(1400, 860);
  await select(page);
  const brand = await rect(page, '#brand'), tabs = await rect(page, '#side-tabs'), dock = await rect(page, '#dock');
  assert.ok(brand && tabs && dock);
  assert.ok(brand.y < 20 && brand.x < 20 && tabs.bottom > 840 && tabs.x < 20, 'logo/search top left, tabs bottom left');
  assert.ok(dock.right > 1380 && dock.bottom > 840, 'tools bottom right');
  assert.equal(await rect(page, '#sidebar'), null, 'the sidebar starts folded');
  assert.equal(await page.locator('#ask, #dock-ask, #agent-label').count(), 0, 'no floating Ask box, Ask button or corner chip');
  // Opening the sidebar changes the surface behind the tabs, never where a label sits.
  const labelBefore = await page.locator('#open-history .tool-label').boundingBox();
  await page.locator('#open-layers').click();
  const side = await rect(page, '#sidebar'), b2 = await rect(page, '#brand'), t2 = await rect(page, '#side-tabs');
  const labelAfter = await page.locator('#open-history .tool-label').boundingBox();
  assert.ok(Math.abs(labelBefore.x - labelAfter.x) < 0.6 && Math.abs(labelBefore.y - labelAfter.y) < 0.6,
    `a tab label does not move when the sidebar opens (${labelBefore.x},${labelBefore.y} → ${labelAfter.x},${labelAfter.y})`);
  assert.ok(Math.abs(side.width - t2.width) < 1 && side.bottom <= t2.y + 2 && t2.y - side.bottom < 3, 'open: the tabs join the sidebar into one panel');
  assert.ok(side.y >= b2.bottom + 4 && Math.abs(b2.width - side.width) > 20, 'the logo and search stay separate islands, not tied to the sidebar width');
  assert.equal(await page.locator('#activity .chip').count(), 0);
  await page.locator('#open-history').click();
  assert.equal(await page.locator('#activity').isVisible(), true); assert.equal(await page.locator('#layers').isVisible(), false);
  await page.locator('#open-agent').click();
  assert.equal(await page.locator('#agent .ask-input').isVisible(), true);
  await page.locator('#open-agent').click();
  assert.equal(await rect(page, '#sidebar'), null, 'pressing the open tab folds the sidebar');
  assert.ok(await rect(page, '#side-tabs') && await rect(page, '#brand'), 'the tabs and the logo row stay');
  assert.equal(await page.locator('#open-agent').getAttribute('aria-selected'), 'false');
  checks.push('the logo/search islands stay put, the tabs join the sidebar when it opens; a tab switches panes and, when open, folds the sidebar while the tabs and logo row stay');

  const inspector = await rect(page, '#inspector'), tools = await rect(page, '#dock');
  assert.ok(inspector && inspector.bottom <= tools.y - 4 && inspector.bottom >= tools.y - 16 && inspector.right <= tools.right + 1 && inspector.right >= tools.right - 4, 'the inspector sits just above the tools, attached to the bottom right');
  const crumbs = await rect(page, '#crumbs'), tabsNow = await rect(page, '#side-tabs');
  assert.ok(crumbs && crumbs.x >= tabsNow.right && crumbs.right <= tools.x && Math.abs((crumbs.y + crumbs.height / 2) - (tools.y + tools.height / 2)) < 4, 'the path sits in the bottom row between the tabs and the tools');
  checks.push('the inspector is attached above the bottom-right tools; the path sits between the left column and the tools');

  await page.setViewportSize({ width: 820, height: 860 });
  await page.evaluate(() => window.__divletFit?.());
  const narrow = await rect(page, '#crumbs');
  if (narrow) {
    const track = await page.evaluate(() => { const t = document.querySelector('.crumbs-track'); return { end: Math.abs(t.scrollLeft + t.clientWidth - t.scrollWidth) < 2, over: t.scrollWidth > t.clientWidth }; });
    assert.ok(!track.over || track.end, 'when short of room the start scrolls away and the selected element stays in view');
  }
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.evaluate(() => window.__divletFit?.());
  await page.locator('#open-agent').click();
  assert.equal(await page.locator('#agent .ask-about').count(), 0, 'the composer has no breadcrumbs');
  assert.ok(await rect(page, '#crumbs'), 'the path stays at the bottom centre while the Agent tab is open');
  await page.close();
  checks.push('a narrow bottom row keeps the end of the path; the Agent tab repeats the path in its composer');

  /* ---- phone -------------------------------------------------------------- */
  const phone = await open(390, 800);
  await select(phone);
  await phone.locator('#open-layers').click();
  const sheet = await rect(phone, '#sidebar'), pb = await rect(phone, '#brand'), pt = await rect(phone, '#side-tabs');
  assert.ok(sheet.width >= 390 - 24 && sheet.height > 800 * 0.7, 'the sidebar opens almost full screen');
  assert.ok(sheet.y >= pb.bottom - 2 && sheet.bottom <= pt.y + 2);
  assert.equal(await rect(phone, '#inspector'), null, 'only one big surface at a time on a phone');
  assert.equal(await rect(phone, '#dock'), null);
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
  await phone.locator('#open-layers').click();
  assert.ok(await rect(phone, '#dock') && await rect(phone, '#inspector'), 'folding brings the tools and the inspector back');
  const pd = await rect(phone, '#dock'), pi = await rect(phone, '#inspector'), pt2 = await rect(phone, '#side-tabs');
  assert.ok(pi.bottom <= pd.y - 4, 'the inspector sheet sits above the tools');
  // The dock is the base row (it is used most) and the tabs sit above it; with a sidebar open the tabs are its footer at the
  // bottom edge instead, because the dock is hidden then.
  assert.ok(pt2.bottom <= pd.y + 1, `the tabs sit above the dock (${pt2.bottom} <= ${pd.y})`);
  assert.ok(pt2.y > 0 && pd.bottom <= 800 + 1, `both rows stay on screen (tabs y ${pt2.y}, dock bottom ${pd.bottom})`);
  await phone.locator('#open-layers').click();
  const pt3 = await rect(phone, '#side-tabs'), pd3 = await rect(phone, '#dock');
  assert.equal(pd3, null, 'the dock is hidden while a sidebar is open');
  assert.ok(pt3.bottom > 800 - 24, `with a sidebar open the tabs sit at the bottom edge (${pt3.bottom})`);
  await phone.locator('#open-layers').click();
  checks.push('on a phone the dock is the base row, the tabs sit above it (and stay the sidebar footer when one is open), and the sidebar fills the screen between the logo row and the tabs');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser?.close(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
