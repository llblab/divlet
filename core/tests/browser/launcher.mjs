// The launcher page: lists projects of a collection, filters, opens one on its board, creates a new one.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../lib/runtime.js';
import { launch } from '../../lib/launch.ts';

const playwright = await import('playwright');
const root = await mkdtemp(path.join(os.tmpdir(), 'divlet-launcher-'));
await cp(fileURLToPath(new URL('../../../examples/studio/', import.meta.url)), path.join(root, 'Designs', 'app'), { recursive: true });
await mkdir(path.join(root, 'Designs', 'landing'));
await writeFile(path.join(root, 'Designs', 'landing', 'project.divlet'), JSON.stringify({ schemaVersion: 1, name: 'Landing page', version: 1, tokens: {}, css: '', metadata: {}, frames: [] }));
await mkdir(path.join(root, 'Designs', 'broken'));
await writeFile(path.join(root, 'Designs', 'broken', 'project.divlet'), '{ nope');
const boards = new Map();
const hubs = new Map();
const openBoard = async location => { const key = location.file || location.cwd; if (!boards.has(key)) boards.set(key, await openRuntime({ ...location, createDemo: false, watch: false })); return boards.get(key); };
const opened = await launch(root, { openBoard, hubs });
const launchOptions = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launchOptions.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const errors = [];
const checks = [];
let browser;
try {
  browser = await playwright.chromium.launch(launchOptions);
  for (const scheme of ['light', 'dark']) {
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: scheme })).newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(opened.hub.url);
    await page.locator('.card').first().waitFor();
    assert.equal(await page.locator('.card').count(), 3);
    assert.equal(await page.locator('.card:disabled').count(), 1, 'a broken project is listed but cannot be opened');
    assert.match(await page.locator('.card .error').textContent(), /not valid JSON/);
    assert.match(await page.locator('.where').textContent(), /divlet-launcher-/);
    const surface = await page.evaluate(() => getComputedStyle(document.querySelector('.card')).backgroundColor);
    const [r] = surface.match(/\d+/g).map(Number);
    assert.ok(scheme === 'dark' ? r < 80 : r > 180, `cards follow the ${scheme} theme (${surface})`);
    if (scheme === 'light') continue; // read-only pass first, then the one that changes things
    // Filter, then open a project.
    await page.locator('#q').fill('land');
    assert.equal(await page.locator('.card').count(), 1);
    assert.equal(await page.locator('#make').textContent(), 'Create “land”');
    await page.locator('#q').fill('');
    await page.locator('.card', { hasText: 'divlet examples' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.artboard').length === 5);
    assert.equal((await page.locator('#project-name').textContent()).trim(), 'DIVLET', 'the corner says DIVLET');
    assert.match(await page.title(), /^app · divlet/);
    checks.push('lists projects, marks a broken one, follows the theme, filters, opens a board');
    // Create a project from the typed name.
    await page.goto(opened.hub.url);
    await page.locator('#q').fill('Pricing Page');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#viewport');
    await page.waitForFunction(() => document.title.startsWith('pricing-page'));
    const created = await readdir(path.join(root, 'Designs'));
    assert.ok(created.includes('pricing-page.divlet'));
    assert.ok(!created.includes('pricing-page'), 'creation does not add a wrapper folder');
    await page.waitForFunction(() => document.querySelector('#loading')?.hidden); await page.locator('#source-mode').waitFor({ state: 'hidden' });
    const createdFile = path.join(root, 'Designs/pricing-page.divlet');
    assert.deepEqual(JSON.parse(await readFile(createdFile, 'utf8')), { schemaVersion: 1, name: 'Pricing Page', version: 1, tokens: {}, css: '', metadata: {}, frames: [] });
    await page.locator('#empty-new').click(); await page.locator('.artboard').waitFor();
    const firstRoot = JSON.parse(await readFile(createdFile, 'utf8')); assert.equal(firstRoot.frames.length, 1); assert.equal(firstRoot.name, 'Pricing Page');
    const firstUrl = page.url();
    await page.goto(opened.hub.url);
    await page.locator('.card', { hasText: 'pricing-page.divlet' }).waitFor();
    await page.locator('#q').fill('Pricing Page');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.title === 'pricing-page-2 · divlet');
    assert.notEqual(page.url(), firstUrl, 'a second source in the same folder has its own board');
    assert.ok((await readdir(path.join(root, 'Designs'))).includes('pricing-page-2.divlet'));
    await page.goto(opened.hub.url);
    await page.locator('.card', { hasText: 'pricing-page.divlet' }).click();
    await page.waitForURL(firstUrl);
    await page.waitForFunction(() => document.title === 'pricing-page · divlet');
    checks.push('typed names create native sources without wrappers; first-root creation preserves only the explicit name namespace and exact-board reopening');
  }
  assert.deepEqual(errors, []);
  // Narrow and large-text screens: nothing on the launcher is clipped, and the page never scrolls sideways.
  for (const zoom of [1, 2]) {
    const narrow = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
    await narrow.goto(opened.hub.url);
    await narrow.locator('.card').first().waitFor();
    if (zoom !== 1) await narrow.evaluate(z => { document.documentElement.style.zoom = String(z); }, zoom);
    await narrow.waitForTimeout(250);
    const clipped = await narrow.evaluate(() => [...document.querySelectorAll('body *')].filter(node => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && node.clientWidth > 0 && node.textContent.trim() && node.scrollWidth > node.clientWidth + 1 && (style.textOverflow === 'ellipsis' || style.overflowX === 'hidden');
    }).map(node => `${node.tagName.toLowerCase()}.${node.className} "${node.textContent.trim().slice(0, 30)}"`));
    assert.deepEqual(clipped, [], `no clipped launcher text at 390px, zoom ${zoom}`);
    assert.equal(await narrow.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `the launcher does not scroll sideways at zoom ${zoom}`);
    await narrow.close();
  }
  checks.push('the launcher shows whole text and does not scroll sideways at 390px, also at 2x text');
  // Launcher text meets WCAG AA contrast (4.5:1) in both colour schemes.
  for (const scheme of ['light', 'dark']) {
    const themed = await (await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: scheme })).newPage();
    await themed.goto(opened.hub.url);
    await themed.locator('.card').first().waitFor();
    await themed.waitForTimeout(300);
    const low = await themed.evaluate(scheme => {
      const parse = c => { const m = c.match(/[\d.]+/g)?.map(Number); return m ? { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 } : null; };
      const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
      const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
      const backdrop = node => { const layers = []; for (let n = node; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let base = scheme === 'dark' ? { r: 19, g: 19, b: 18, a: 1 } : { r: 243, g: 242, b: 239, a: 1 }; for (const layer of layers.reverse()) base = blend(layer, base); return base; };
      const out = [];
      for (const node of document.querySelectorAll('body *')) {
        const text = [...node.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        if (!text) continue;
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none' || node.closest('[hidden], :disabled')) continue;
        const fg = parse(style.color); if (!fg) continue;
        const bg = backdrop(node), shown = blend({ ...fg, a: fg.a * (parseFloat(style.opacity) || 1) }, bg);
        const l1 = lum(shown), l2 = lum(bg), ratio = (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
        if (ratio < 4.5) out.push(`${ratio.toFixed(2)} "${text.slice(0, 24)}" ${node.tagName.toLowerCase()}.${String(node.className).slice(0, 24)}`);
      }
      return [...new Set(out)];
    }, scheme);
    assert.deepEqual(low, [], `launcher text meets 4.5:1 contrast in the ${scheme} scheme`);
    await themed.close();
  }
  checks.push('launcher text meets WCAG AA contrast in the light and dark schemes');
  console.log(JSON.stringify({ status: 'passed', count: checks.length, checks }, null, 2));
} catch (error) {
  console.error(error);
  if (errors.length) console.error('browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const hub of hubs.values()) await hub.close();
  for (const runtime of boards.values()) await runtime.close();
  await rm(root, { recursive: true, force: true });
}
