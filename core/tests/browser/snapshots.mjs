// Far zoom shows pictures that the frames take of themselves in the browser (no server round trip); zooming back in shows the
// same still-loaded pages again, and a click on a thumbnail zooms to that frame.
import assert from 'node:assert/strict';
import { legacyProject } from '../fixtures/legacy-project.js';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../lib/runtime.js';

const playwright = await import('playwright');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-snapshots-'));
await cp(path.join(root, 'examples', 'studio'), cwd, { recursive: true });
await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
const runtime = await openRuntime({ cwd, watch: false });
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const errors = [], checks = [], requests = [];
let browser;
try {
  browser = await playwright.chromium.launch(launch);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })).newPage();
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request.url()));
  await page.goto(runtime.info().url); await page.waitForFunction(() => document.querySelector('#loading')?.hidden);
  await page.evaluate(async () => { window.frameCanvas = await import('./lib/canvas.js'); window.frameStore = await import('./lib/store.js'); window.frameCanvas.setCamera({ x: 40, y: 80, k: 0.5 }); });
  const ids = runtime.info().documents.map(doc => doc.id), first = ids[0];
  await page.waitForFunction(() => [...window.frameCanvas.entries.values()].every(e => e.iframe && e.loaded));
  // Pictures are taken in the background as soon as pages have rendered, before anyone zooms out.
  await page.waitForFunction(() => [...window.frameCanvas.entries.values()].every(e => e.shot?.url), null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => [...window.frameCanvas.entries.values()].every(e => e.shot.url.startsWith('blob:'))), true, 'the pictures are made in the browser');
  assert.equal(requests.some(url => /snapshot/.test(url)), false, 'nothing is requested from the server');
  checks.push('every frame photographs itself in the browser after rendering; no server request is involved');

  const picture = await page.evaluate(async id => { const e = window.frameCanvas.entries.get(id); const image = new Image(); image.src = e.shot.url; await image.decode(); const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; const g = c.getContext('2d'); g.drawImage(image, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let colored = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) colored++; return { w: image.width, h: image.height, colored: colored / (d.length / 4) }; }, first);
  assert.ok(picture.w > 100 && picture.h > 100 && picture.colored > 0.05, `the picture shows the page: ${JSON.stringify(picture)}`);
  checks.push('the picture has the page content, not a blank rectangle');

  const identity = await page.evaluate(() => { window.__iframes = new Map([...window.frameCanvas.entries].map(([id, e]) => [id, e.iframe])); window.__loads = 0; for (const e of window.frameCanvas.entries.values()) e.iframe.addEventListener('load', () => window.__loads++); return window.__iframes.size; });
  assert.ok(identity >= 4);
  await page.evaluate(() => window.frameCanvas.setCamera({ x: 400, y: 300, k: 0.1 }));
  await page.waitForFunction(() => document.querySelectorAll('.artboard.lod img.frame-snapshot').length >= 4, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => getComputedStyle(window.frameCanvas.entries.values().next().value.iframe).visibility), 'hidden', 'the live page is not painted at far zoom');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.artboard.lod img.frame-snapshot')].every(img => img.complete && img.naturalWidth > 0)), true);
  checks.push('at far zoom the pictures replace the live pages immediately (nothing loads), which stay loaded but hidden');

  // Watch what the clicked artboard shows on every animation frame: the picture hands over to the live page with no blank frame.
  await page.evaluate(id => {
    window.__shown = [];
    const tick = () => {
      const art = document.querySelector(`.artboard[data-artboard-id="${id}"]`), img = art.querySelector('img.frame-snapshot'), frame = art.querySelector('iframe');
      const visible = node => !!node && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden';
      window.__shown.push({ picture: visible(img), page: visible(frame) });
      if (!window.__stopShown) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, first);
  const box = await page.locator(`.artboard[data-artboard-id="${first}"] .ab-body`).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => window.frameCanvas.camera.k > 0.5, null, { timeout: 10000 });
  await page.waitForFunction(id => !document.querySelector(`.artboard[data-artboard-id="${id}"]`).classList.contains('lod'), first);
  await page.evaluate(() => window.frameStore.selectArtboards([])); await page.evaluate(() => window.frameCanvas.setCamera({ x: 40, y: 80, k: 1 }));
  await page.waitForFunction(() => document.querySelectorAll('.artboard.lod').length === 0);
  assert.equal(await page.evaluate(() => [...window.frameCanvas.entries].every(([id, e]) => e.iframe === window.__iframes.get(id))), true, 'the very same iframes: nothing was torn down');
  assert.equal(await page.evaluate(() => window.__loads), 0, 'no frame reloaded while zooming out and in');
  // Stop recording once the live page has been showing for two more frames (the loop above never gives up on a slow machine).
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { window.__stopShown = true; resolve(); }))));
  const shown = await page.evaluate(() => window.__shown);
  assert.ok(shown.length > 0, 'the zoom was observed');
  assert.equal(shown.filter(entry => !entry.picture && !entry.page).length, 0, 'no frame is blank while the picture hands over to the live page');
  assert.equal(shown.at(-1).page, true, 'the live page is showing at the end');
  checks.push('clicking a thumbnail hands the picture over to the live page without a blank frame (no flicker)');
  checks.push('clicking a thumbnail zooms to that frame; zooming back in shows the same loaded pages: no reload, no remount');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser?.close(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
