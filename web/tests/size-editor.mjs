import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { openRuntime } from '@divlet/core/runtime';
import { resolveOpenFile } from '../../core/lib/launch.ts';
import { decodeHtml } from '../../core/lib/codec.ts';
import { waitForPage } from './fixtures/wait-for-page.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-size-editor-'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const runtimes = [], checks = [];
try {
  for (const format of ['legacy', 'pen']) {
    const dir = path.join(root, format), file = path.join(dir, 'project.divlet'); await fs.mkdir(dir);
    if (format === 'legacy') await legacyProject(file, { demo: true });
    else await fs.writeFile(file, JSON.stringify({ version: '2.21', children: [{ id: 'canvas', type: 'frame', width: 640, height: 480, fill: '#fff', children: [] }] }));
    const runtime = await openRuntime({ file: (await resolveOpenFile(file)).file, watch: false }); runtimes.push(runtime);
    const entry = () => [...runtime.documents.values()][0], frameId = entry().document.id;
    const page = await browser.newPage({ viewport: { width: 1500, height: 960 } }), errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/patch')) requests.push(request.postDataJSON()); });
    await page.goto(runtime.url); await page.waitForFunction(() => document.querySelector('.artboard')?.dataset.status === 'live');
    await page.evaluate(async id => { const s = await import('./lib/store.js'), c = await import('./lib/canvas.js'); s.selectArtboards([id]); c.fit([id], { animate: false }); }, frameId);
    const size = page.locator('.artboard .ab-size'), input = page.getByRole('textbox', { name: 'Artboard size, width × height', exact: true });
    const installed = async () => waitForPage(page, async ({ id, version, width, height }) => { const c = await import('./lib/canvas.js'), e = c.entries.get(id); return e?.doc.version === version && e.doc.artboard.width === width && e.doc.artboard.height === height && !e.size.querySelector('input'); }, { id: frameId, version: entry().document.version, width: entry().document.artboard.width, height: entry().document.artboard.height });
    const submit = async status => {
      const count = requests.length;
      const [response] = await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/patch')), input.press('Enter')]);
      assert.equal(response.status(), status); await installed(); assert.equal(requests.length, count + 1);
    };
    const wire = await fs.readFile(file), head = runtime.historyHead();
    await size.dblclick(); await input.fill('500 × 300');
    const sample = await page.evaluate(async id => {
      const c = await import('./lib/canvas.js'), e = c.entries.get(id), input = e.size.querySelector('input');
      const snapshot = () => ({ connected: input.isConnected, focused: document.activeElement === input, value: input.value, version: e.doc.version, render: e.doc.render });
      const before = snapshot(); c.reconcileArtboards(); return { before, after: snapshot() };
    }, frameId);
    assert.equal(sample.after.connected, true, format); assert.equal(sample.after.focused, true, format); assert.deepEqual(sample.after, sample.before);
    assert.deepEqual(await fs.readFile(file), wire); assert.deepEqual(runtime.historyHead(), head); assert.equal(requests.length, 0);
    const shown = { version: entry().document.version, render: entry().render };
    await submit(200); assert.equal(entry().document.artboard.width, 500); assert.equal(entry().document.artboard.height, 300);
    assert.equal(requests.at(-1).expectedVersion, shown.version); assert.equal(requests.at(-1).expectedRender, shown.render);
    await size.dblclick(); assert.equal(await input.inputValue(), '500 × 300'); await input.fill('4:3');
    await submit(200); assert.equal(entry().document.artboard.width, 500); assert.equal(entry().document.artboard.height, 375);
    checks.push(`${format}: same-clock reconciliation retains draft/focus without writes; completed pair→ratio edits use installed dimensions and displayed clocks`);

    await size.dblclick(); await input.fill('16:9');
    const stale = { version: entry().document.version, render: entry().render }, oldInput = await input.elementHandle();
    await runtime.patch({ documentId: frameId, expectedVersion: stale.version, expectedRender: stale.render, patch: { artboard: { width: 600 } } });
    await waitForPage(page, async ({ id, version }) => (await import('./lib/canvas.js')).entries.get(id)?.doc.version === version, { id: frameId, version: entry().document.version });
    assert.equal(await oldInput.evaluate(e => e.isConnected && document.activeElement === e && e.value === '16:9'), true);
    const acceptedWire = await fs.readFile(file), acceptedHistory = runtime.historyHead(), count = requests.length;
    await submit(409);
    if (requests.length !== count + 1) console.error(JSON.stringify({ failure: 'size-submit-count', format, count, requests: requests.map(r => ({ version: r.expectedVersion, render: r.expectedRender, artboard: r.patch?.artboard })) }));
    assert.equal(requests.length, count + 1); assert.equal(requests.at(-1).expectedVersion, stale.version); assert.equal(requests.at(-1).expectedRender, stale.render);
    assert.deepEqual(await fs.readFile(file), acceptedWire); assert.deepEqual(runtime.historyHead(), acceptedHistory);
    assert.equal(entry().document.artboard.width, 600); assert.equal(entry().document.artboard.height, 375);
    assert.match(await size.innerText(), /600\s*×\s*375/);
    await size.dblclick(); assert.equal(await input.inputValue(), '600 × 375'); await input.fill('900 × 800'); await input.press('Escape');
    await installed(); assert.deepEqual(await fs.readFile(file), acceptedWire); assert.equal(requests.length, count + 1);
    checks.push(`${format}: changed authority preserves the old draft but stale submit refuses once without retry/source/history overwrite; fresh label/editor and Escape use latest dimensions`);
    await oldInput.dispose(); assert.deepEqual(errors, []); await page.close();
  }
  // Fit height has one inspector home even while a real preview offers a different content height.
  const runtime = runtimes[0];
  const fitted = decodeHtml('<main id="fit-root"><section style="height:640px">Measured content</section></main>', { fallbackId: 'fit-height-once' });
  fitted.artboard.height = 200;
  await runtime.create({ document: fitted });
  const page = await browser.newPage({ viewport: { width: 1500, height: 960 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(runtime.url);
  await page.waitForSelector(`.artboard[data-artboard-id="${fitted.id}"]`);
  await page.evaluate(async id => { const s = await import('./lib/store.js'); s.selectArtboards([id]); (await import('./lib/canvas.js')).fit([id], { animate: false }); }, fitted.id);
  await waitForPage(page, async id => (await import('./lib/actions.js')).canFitHeight(id), fitted.id);
  await page.locator('#viewport').focus(); await page.mouse.move(5, 5);
  await page.locator('#inspector .smart-bar button[aria-label="Fit height to content"]:enabled').waitFor({ timeout: 4000 }).catch(async error => {
    console.error('fit-height readiness', await page.evaluate(async id => { const s = await import('./lib/store.js'); return { ids: [...s.store.selected], view: document.querySelector('#inspector').dataset.view, height: s.descriptor(id)?.artboard.height, measured: s.store.observations.get(id)?.contentHeight, ready: (await import('./lib/actions.js')).canFitHeight(id) }; }, fitted.id));
    throw error;
  });
  const measured = await page.evaluate(async id => (await import('./lib/store.js')).store.observations.get(id).contentHeight, fitted.id);
  assert.ok(measured > 200, 'the real preview reports taller content');
  assert.equal(await page.locator('#inspector [data-key="fit-height"]').count(), 0, 'no duplicate geometry-block Fit height button');
  assert.equal(await page.getByRole('button', { name: /^Fit height/ }).count(), 1, 'exactly one Fit height control in the inspector');
  assert.equal(await page.locator('#inspector [data-key="height"]').count(), 1, 'the authored height input stays available');
  await page.screenshot({ path: 'artifacts/fit-height-desktop.png' });
  const [fitResponse] = await Promise.all([page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/patch')), page.locator('#inspector .smart-bar button[aria-label="Fit height to content"]').click()]);
  assert.equal(fitResponse.status(), 200); await runtime.queue;
  await waitForPage(page, async ({ id, height }) => (await import('./lib/store.js')).descriptor(id)?.artboard.height === height, { id: fitted.id, height: Math.min(16384, measured) });
  assert.equal(runtime.read({ view: 'frame', documentId: fitted.id }).artboard.height, Math.min(16384, measured), 'the lower action fits to the actual measurement');
  await page.locator('#viewport').focus();
  const [undoResponse] = await Promise.all([page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/undo')), page.keyboard.press('Control+z')]);
  assert.equal(undoResponse.status(), 200); await runtime.queue;
  await waitForPage(page, async id => (await import('./lib/store.js')).descriptor(id)?.artboard.height === 200, fitted.id);
  assert.equal(runtime.read({ view: 'frame', documentId: fitted.id }).artboard.height, 200, 'one Undo restores authored height');
  assert.equal(await page.locator('#inspector [data-key="fit-height"]').count(), 0, 'Undo does not reintroduce the duplicate');
  for (const scale of [100, 200]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async size => (await import('./lib/help.js')).setUiSize(size), scale);
    await page.mouse.move(5, 5);
    await waitForPage(page, async id => (await import('./lib/actions.js')).canFitHeight(id), fitted.id);
    const lowerFit = page.locator('#inspector .smart-bar button[aria-label="Fit height to content"]');
    await page.locator('#inspector .smart-bar button[aria-label="Fit height to content"]:enabled').waitFor({ state: 'attached' });
    await lowerFit.click({ trial: true });
    assert.equal(await page.getByRole('button', { name: /^Fit height/ }).count(), 1, `one reachable lower Fit height at phone/${scale}%`);
  }
  await page.screenshot({ path: 'artifacts/fit-height-phone-200.png' });
  assert.deepEqual(errors, []); await page.close();
  checks.push('Fit height exists only in the lower action bar on desktop/phone/200%, fits real preview content and remains undoable without removing the height input');
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser.close(); for (const runtime of runtimes) await runtime.close(); await fs.rm(root, { recursive: true, force: true }); }
