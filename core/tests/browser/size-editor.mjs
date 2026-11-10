import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { legacyProject } from '../fixtures/legacy-project.js';
import { openRuntime } from '../../lib/runtime.js';
import { resolveOpenFile } from '../../lib/launch.ts';

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
    const installed = async () => page.waitForFunction(async ({ id, version, width, height }) => { const c = await import('./lib/canvas.js'), e = c.entries.get(id); return e?.doc.version === version && e.doc.artboard.width === width && e.doc.artboard.height === height && !e.size.querySelector('input'); }, { id: frameId, version: entry().document.version, width: entry().document.artboard.width, height: entry().document.artboard.height });
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
    await page.waitForFunction(async ({ id, version }) => (await import('./lib/canvas.js')).entries.get(id)?.doc.version === version, { id: frameId, version: entry().document.version });
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
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser.close(); for (const runtime of runtimes) await runtime.close(); await fs.rm(root, { recursive: true, force: true }); }
