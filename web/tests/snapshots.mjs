// Far zoom pictures are rasterized in the browser; an optional host supplies only accepted frame font bytes. Zooming in shows the
// same still-loaded pages again, and a click on a thumbnail zooms to that frame.
import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { decodeHtml } from '../../core/lib/codec.ts';
import { validateSettings, writeProject } from '../../core/lib/project.ts';
import { setStyleEngines } from '../../core/lib/engine.ts';
import { fontBytes, fontDataUrl } from '../../core/tests/fixtures/font.js';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../core/lib/runtime.js';

const playwright = await import('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-snapshots-'));
await cp(path.join(root, 'examples', 'studio'), cwd, { recursive: true });
await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
const runtime = await openRuntime({ cwd, watch: false });
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const errors = [], checks = [], requests = [];
let browser, native;
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
  assert.equal(requests.some(url => /api\/snapshot/.test(url)), false, 'the server never renders or stores screenshots');
  checks.push('every frame photographs itself in the browser; only bounded accepted font CSS comes from the host');

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
  await runtime.close(); setStyleEngines([]);
  const frame = decodeHtml('<main><span id="proof" style="display:inline-block">AA</span></main>', { fallbackId: 'font-proof' });
  frame.artboard.width = 400; frame.artboard.height = 180;
  const file = path.join(cwd, 'fonts.divlet');
  await writeFile(file, writeProject(validateSettings({ css: 'body{margin:0}main{padding:20px;color:rgb(220,0,220);font:100px/100px "Capture Proof"}' }), [frame]));
  native = await openRuntime({ file, watch: false, createDemo: false });
  const uploaded = await native.saveFont({ name: 'proof.ttf', data: fontBytes(600, { family: 'Capture Proof' }), expectedVersion: native.settings.version });
  await page.goto(native.url);
  await page.waitForFunction(() => document.querySelector('#loading')?.hidden);
  await page.evaluate(async () => { window.frameCanvas = await import('./lib/canvas.js'); window.frameStore = await import('./lib/store.js'); window.frameStore.selectArtboards(['font-proof']); window.frameCanvas.setCamera({ x: 40, y: 80, k: 1 }); });
  const live = page.locator('iframe[data-document-id="font-proof"]').contentFrame().locator('#proof');
  await live.waitFor(); await live.evaluate(async node => { await node.ownerDocument.fonts.ready; });
  assert.equal(await live.evaluate(node => Math.round(node.getBoundingClientRect().width)), 120, 'live page uses actual uploaded bytes');
  const shot = async () => {
    await page.waitForFunction(() => { const e = window.frameCanvas.entries.get('font-proof'); return e.shot?.render === e.doc.render; }, null, { timeout: 20000 });
    return page.evaluate(async () => {
      const e = window.frameCanvas.entries.get('font-proof'), image = new Image(); image.src = e.shot.url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data; let min = Infinity, max = -Infinity, count = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) { const at = (y * canvas.width + x) * 4; if (data[at] > 150 && data[at + 1] < 100 && data[at + 2] > 150) { min = Math.min(min, x); max = Math.max(max, x); count++; } }
      return { width: max - min + 1, count, render: e.shot.render, url: e.shot.url };
    });
  };
  const firstFont = await shot();
  assert.ok(Math.abs(firstFont.width - 120) <= 2 && firstFont.count > 3500, `snapshot has solid synthetic triangles, not fallback letters: ${JSON.stringify(firstFont)}`);
  assert.ok(requests.some(url => url.includes('/api/capture-fonts/')), 'font closure is an explicit optional read, not normal model payload');
  const fontReads = requests.filter(url => url.includes('/api/capture-fonts/')).length;
  const withoutProof = await page.evaluate(() => new Promise(resolve => {
    const port = window.frameCanvas.entries.get('font-proof').port, captureId = 'without-font-proof';
    const listener = event => { if (event.data.captureId === captureId) { port.removeEventListener('message', listener); resolve(event.data.type); } };
    port.addEventListener('message', listener); port.postMessage({ type: 'divlet:capture', captureId });
  }));
  assert.equal(withoutProof, 'divlet:snapshot-failed', 'a host without font preparation must retain live rendering, not claim a fallback photo');
  assert.equal(requests.filter(url => url.includes('/api/capture-fonts/')).length, fontReads, 'missing font proof never grants the iframe fetch authority');
  const lifetime = await page.locator('iframe[data-document-id="font-proof"]').elementHandle();
  await page.evaluate(() => { window.frameStore.selectArtboards([]); window.frameCanvas.setCamera({ x: 40, y: 80, k: 0.1 }); });
  let resolveHeld, release;
  const held = new Promise(resolve => { resolveHeld = resolve; }); let holdNext = true;
  await page.route('**/api/capture-fonts/font-proof?render=*', async route => {
    if (!holdNext) return route.continue(); holdNext = false;
    const response = await route.fetch(); resolveHeld(await response.json());
    await new Promise(resolve => { release = resolve; }); await route.fulfill({ response });
  });
  await native.patchProject({ expectedVersion: native.settings.version, patch: { assets: { fonts: { [uploaded.file.split('/').at(-1)]: fontDataUrl(900) } } } });
  const stale = await held;
  assert.ok(stale.css.includes(fontDataUrl(900)));
  await native.patchProject({ expectedVersion: native.settings.version, patch: { assets: { fonts: { [uploaded.file.split('/').at(-1)]: fontDataUrl(1200) } } } });
  await page.waitForFunction(render => window.frameCanvas.entries.get('font-proof').doc.render === render, native.getEntry('font-proof').render);
  assert.equal(await page.locator('.artboard[data-artboard-id="font-proof"]').evaluate(node => node.classList.contains('lod')), false, 'stale pixels never hide the live page during font preparation');
  release();
  const wider = await shot(); assert.ok(Math.abs(wider.width - 180) <= 2, `late900 response is rejected; newest1200 bytes move cached glyphs: ${JSON.stringify(wider)}`);
  assert.notEqual(wider.url, firstFont.url); assert.notEqual(wider.render, stale.render);
  await native.undo(); assert.ok(Math.abs((await shot()).width - 150) <= 2, 'first Undo captures900 bytes');
  await native.undo(); assert.ok(Math.abs((await shot()).width - 120) <= 2, 'second Undo refreshes original font pixels');
  assert.equal(await lifetime.evaluate(node => node.isConnected && node === document.querySelector('iframe[data-document-id="font-proof"]')), true, 'font updates retain the same artboard iframe');
  const revision = native.revision, history = native.readHistory();
  await page.evaluate(() => { window.frameStore.selectArtboards([]); window.frameCanvas.setCamera({ x: 40, y: 80, k: 0.1 }); });
  await page.waitForFunction(() => document.querySelector('.artboard[data-artboard-id="font-proof"]').classList.contains('lod'));
  await page.screenshot({ path: 'artifacts/font-capture-far-zoom.png' });
  assert.equal(native.revision, revision); assert.deepEqual(native.readHistory(), history, 'capture is editor state, not content/history');
  await native.patchProject({ expectedVersion: native.settings.version, patch: { css: 'body{margin:0} @font-face{font-family:Unproven;src:url("https://example.invalid/font.ttf")}main{font-family:Unproven}' } });
  await page.waitForFunction(render => window.frameCanvas.entries.get('font-proof').doc.render === render, native.getEntry('font-proof').render);
  await page.waitForFunction(() => !document.querySelector('.artboard[data-artboard-id="font-proof"]').classList.contains('lod'));
  assert.equal(await page.locator('iframe[data-document-id="font-proof"]').evaluate(node => getComputedStyle(node).visibility), 'visible', 'a stale/unembeddable snapshot never hides the live page');
  checks.push('actual uploaded font triangle pixels, byte update and Undo invalidation, same iframe, far-zoom use, payload-free normal reads and truthful live fallback for unproven fonts');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser?.close(); await native?.close(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
