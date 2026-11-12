// The interface chrome: one left column (logo + search, sidebar, tabs), a bottom-right toolbar with the inspector attached above it,
// and the selection path in the bottom row between them — on a desktop window and on a phone.
import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { cp, mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../core/lib/runtime.js';

const playwright = await import('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
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

  const readTabs = page => page.evaluate(() => [...document.querySelectorAll('#side-tabs .tab')].map(tab => {
    const box = tab.getBoundingClientRect(), label = tab.querySelector('.tool-label'), r = label.getBoundingClientRect();
    const icon = tab.querySelector('.icon').getBoundingClientRect();
    const parts = [...tab.querySelectorAll('.icon, .tool-label, .badge:not([hidden])')].map(node => node.getBoundingClientRect());
    return { text: label.textContent, iconLeft: icon.right <= r.left + .5 && icon.top < r.bottom && icon.bottom > r.top, x: r.x, y: r.y, clipped: label.scrollWidth > label.clientWidth + 1 || parts.some(p => p.left < box.left - 1 || p.right > box.right + 1 || p.top < box.top - 1 || p.bottom > box.bottom + 1),
      overlap: parts.some((a, i) => parts.slice(i + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)) };
  }));

  /* ---- desktop ------------------------------------------------------------ */
  const page = await open(1400, 860);
  await mkdir('artifacts', { recursive: true });
  for (const selector of ['#status-dot svg', '#empty svg']) {
    const paint = await page.locator(selector).evaluate(svg => {
      const [bracket, wedge] = svg.querySelectorAll('path'), a = getComputedStyle(bracket), b = getComputedStyle(wedge);
      return { count: svg.querySelectorAll('path').length, outline: a.fill === 'none' && a.stroke !== 'none', filled: b.fill !== 'none' && b.stroke === 'none', sameColour: a.stroke === b.fill };
    });
    assert.deepEqual(paint, { count: 2, outline: true, filled: true, sameColour: true }, `${selector}: one outlined bracket and a solid D, in the same inherited colour`);
  }
  assert.equal(await page.locator('#status-dot svg path').nth(1).evaluate(path => path.isPointInFill(new DOMPoint(13, 10))), true, 'the D interior is really painted, not just outlined');
  checks.push('the divlet mark pairs an outlined bracket and filled D/play wedge with one inherited colour, including the empty-state mark');
  const rootId = runtime.read({ view: 'document', documentId: 'welcome' }).rootId;
  const versionBeforeNavigation = runtime.read({ view: 'document', documentId: 'welcome' }).version;
  await page.evaluate(async () => (await import('./lib/store.js')).selectArtboards(['welcome']));
  const rootEntry = page.locator('#crumbs button[aria-label="Select root element"]');
  await rootEntry.waitFor();
  assert.equal(await page.locator('#crumbs .crumb').count(), 1, 'a selected artboard folds to a single root icon');
  assert.equal(await rootEntry.innerText(), '', 'the collapsed path is really icon-only');
  assert.equal(await rootEntry.locator('svg').count(), 1, 'the root action has a visible icon');
  await page.locator('#crumbs .crumbs-track').screenshot({ path: 'artifacts/root-crumb-folded.png' });
  await rootEntry.focus(); await page.keyboard.press('Enter');
  await waitUntil(() => page.evaluate(async root => (await import('./lib/store.js')).store.node?.nodeIds[0] === root, rootId), 'keyboard activation selects the actual model root');
  await waitUntil(async () => await page.locator('#crumbs .crumb').count() === 2, 'root selection opens artboard and root breadcrumbs');
  assert.equal(await page.locator('#crumbs .crumb.current').evaluate(node => document.activeElement === node), true, 'expanding the path preserves keyboard focus on its current crumb');
  await page.locator('#crumbs .crumbs-track').screenshot({ path: 'artifacts/root-crumb-expanded.png' });
  await page.locator('#crumbs .home').click();
  await rootEntry.waitFor();
  assert.equal(await rootEntry.evaluate(node => document.activeElement === node), true, 'the artboard crumb folds back to the focused root icon');
  await rootEntry.click();
  await waitUntil(() => page.evaluate(async root => (await import('./lib/store.js')).store.node?.nodeIds[0] === root, rootId), 'pointer activation also enters the root');
  assert.equal(runtime.read({ view: 'document', documentId: 'welcome' }).version, versionBeforeNavigation, 'breadcrumb navigation changes no content');

  // A cold root read cannot reclaim selection after the user leaves and comes back to the same artboard.
  let releaseRoot, rootRequested;
  const coldRequest = new Promise(resolve => { rootRequested = resolve; });
  const rootGate = new Promise(resolve => { releaseRoot = resolve; });
  await page.route('**/api/documents/welcome', async route => { rootRequested(); await rootGate; await route.continue(); });
  try {
    await page.evaluate(async () => { const m = await import('./lib/store.js'); m.store.models.delete('welcome'); m.selectArtboards(['welcome']); });
    await coldRequest;
    await page.evaluate(async () => { window.__rootAttempt = (await import('./lib/actions.js')).selectRoot('welcome'); });
    await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['pricing']); m.selectArtboards(['welcome']); });
    releaseRoot();
    await page.evaluate(() => window.__rootAttempt);
    assert.deepEqual(await page.evaluate(async () => { const m = await import('./lib/store.js'); return { ids: [...m.store.selected], node: m.store.node }; }), { ids: ['welcome'], node: null }, 'a late root read does not undo a later navigation, even back to the same frame');
  } finally { releaseRoot(); await page.unroute('**/api/documents/welcome'); }
  await page.evaluate(async () => (await import('./lib/store.js')).selectArtboards(['welcome', 'pricing']));
  await waitUntil(async () => await page.locator('#crumbs').innerText() === '2 artboards', 'multiple artboards keep their aggregate path');
  assert.equal(await rootEntry.count(), 0, 'multiple artboards do not offer an ambiguous root action');
  checks.push('the bottom root icon unfolds the real path by mouse/keyboard, folds back without losing focus and refuses stale cold-read navigation');
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

  // The actual 240px edge resize must keep complete labels, even with counters, open or folded.
  await page.locator('#open-agent').click();
  const edge = await page.locator('.resize-handle[data-panel="sidebar"]').boundingBox();
  await page.mouse.move(edge.x + 4, edge.y + edge.height / 2); await page.mouse.down();
  await page.mouse.move(edge.x - 160, edge.y + edge.height / 2, { steps: 6 }); await page.mouse.up();
  await waitUntil(async () => Math.abs((await rect(page, '#sidebar')).width - 240) < 1, 'sidebar reaches its 240px minimum');
  await page.evaluate(() => { for (const [id, count] of [['diag-count', '1234'], ['agent-count', '99+']]) { const n = document.getElementById(id); n.hidden = false; n.textContent = count; } });
  for (const mode of ['board', 'frame', 'node']) {
    const scope = await page.evaluate(async mode => {
      const m = await import('./lib/store.js'); m.selectArtboards(mode === 'board' ? [] : ['welcome']); if (mode === 'node') m.selectNodes('welcome', ['nav']);
      const header = document.querySelector('.ask-scope'), input = document.querySelector('.ask-input'), box = header.getBoundingClientRect();
      const bottom = Math.max(...[...header.querySelectorAll('span')].map(n => n.getBoundingClientRect().bottom));
      return { contained: bottom <= box.bottom + 1, described: !!header.id && input.getAttribute('aria-describedby') === header.id, gap: input.getBoundingClientRect().top - bottom, text: header.textContent };
    }, mode);
    assert.ok(scope.contained && scope.described && scope.gap >= 4, `the ${mode} context has intrinsic height and stays clear of the input: ${JSON.stringify(scope)}`);
  }
  const narrowOpen = await readTabs(page);
  assert.deepEqual(narrowOpen.map(({ text, iconLeft, clipped, overlap }) => ({ text, iconLeft, clipped, overlap })), ['Layers', 'History', 'Agent'].map(text => ({ text, iconLeft: true, clipped: false, overlap: false })), 'full labels, icons and counters fit the narrow open tabs');
  await page.locator('#open-agent').click();
  const narrowFolded = await readTabs(page);
  for (let i = 0; i < 3; i++) {
    assert.equal(narrowFolded[i].iconLeft, true, 'folded tabs keep icons to the left, never above the text');
    assert.equal(narrowFolded[i].clipped || narrowFolded[i].overlap, false);
    assert.ok(Math.abs(narrowOpen[i].x - narrowFolded[i].x) < .6 && Math.abs(narrowOpen[i].y - narrowFolded[i].y) < .6, 'folding does not reset the tab layout or move its label');
  }
  await page.locator('#open-agent').click(); await page.locator('.resize-handle[data-panel="sidebar"]').dblclick(); await page.locator('#open-agent').click();
  await page.evaluate(() => { document.getElementById('diag-count').hidden = true; document.getElementById('agent-count').hidden = true; });
  checks.push('all tab labels and counters fit at the actual 240px minimum; folding preserves their layout');

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
  await phone.evaluate(async () => { (await import('./lib/help.js')).setUiSize(200); (await import('./lib/store.js')).selectArtboards(['welcome']); });
  await phone.locator('#inspector [data-key="name"]').waitFor();
  const actionRow = await phone.evaluate(() => {
    const bar = document.querySelector('#inspector .smart-bar');
    return { height: bar?.offsetHeight ?? 0, scrollHeight: bar?.scrollHeight ?? 0, flexShrink: bar ? getComputedStyle(bar).flexShrink : '', connected: bar?.isConnected ?? false };
  });
  assert.ok(actionRow.height >= 24, `the scrollable inspector must not shrink its action row out of reach: ${JSON.stringify(actionRow)}`);
  await phone.locator('#inspector button[aria-label="More"]:not([hidden])').click();
  const compactActions = await phone.locator('.menu .menu-label').allTextContents();
  assert.ok(compactActions.includes('Delete artboard'), 'the real narrow inspector overflow is open');
  assert.ok(!compactActions.includes('Rename') && !compactActions.includes('Select root element'), 'phone/200% overflow has neither removed action');
  await phone.locator('.menu').screenshot({ path: 'artifacts/root-crumb-phone-menu.png' });
  await phone.keyboard.press('Escape');
  checks.push('the real phone/200% frame-inspector overflow omits Rename and Select root element');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser?.close(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
