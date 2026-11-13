import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { mkdtemp, readFile, writeFile, rm, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { openRuntime } from '../../core/lib/runtime.js';
import { validateDocument } from '../../core/lib/model.ts';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = await import('playwright'); }
catch {
  if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw new Error('Install dev dependencies and run npx playwright install chromium.');
  playwright = require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright'));
}
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-browser-'));
await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
const runtime = await openRuntime({ cwd, watch: true });
await writeFile(path.join(runtime.info().projectDir, 'fixture.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#123456"/></svg>');
const fontPath = process.env.PI_DIVLET_TEST_FONT;
if (fontPath) await copyFile(fontPath, path.join(runtime.info().projectDir, 'fixture.ttf'));
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
let browser;
const errors = [];
const document = validateDocument({
  schemaVersion: 1, id: 'test-board', name: 'Integration fixture', version: 1,
  artboard: { x: 1000, y: 100, width: 390, height: 460 }, rootId: 'root', tokens: {}, css: fontPath ? '@font-face{font-family:DivletQA;src:url("fixture.ttf")}main{font-family:DivletQA}' : '',
  metadata: { intent: 'Browser integration fixture' },
  nodes: {
    root: { id: 'root', type: 'element', tag: 'main', className: 'p-6 bg-white text-slate-900', children: ['a', 'b', 'image'] },
    a: { id: 'a', type: 'element', tag: 'div', className: 'w-[173px] h-[29px] bg-[#123456]', children: ['label'] },
    label: { id: 'label', type: 'text', content: 'Initial fixture' },
    b: { id: 'b', type: 'element', tag: 'section', children: [] },
    image: { id: 'image', type: 'element', tag: 'img', attrs: { src: 'fixture.svg', alt: 'Local fixture' }, children: [] },
  },
});

async function waitUntil(check, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  browser = await playwright.chromium.launch(launch);
  await runtime.create({ document });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1050 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(runtime.info().url);
  await page.locator('.artboard[data-artboard-id="welcome"] iframe').waitFor();
  await page.evaluate(() => document.querySelector('#viewport').focus());
  await page.waitForFunction(() => document.querySelector('#status-dot')?.dataset.kind === 'live');
  await fetch(new URL('api/selection', runtime.info().url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(runtime.info().url).origin }, body: JSON.stringify({ ids: ['test-board'] }) });
  await page.locator('iframe[data-document-id="test-board"]').waitFor();
  const frameElement = page.locator('iframe[data-document-id="test-board"]');
  const frame = await frameElement.contentFrame();
  await frame.locator('[data-divlet-id="a"]').waitFor();
  await waitUntil(() => frame.locator('[data-divlet-id="image"]').evaluate((el) => el.complete && el.naturalWidth === 16), 'relative local image');
  if (fontPath) assert.equal(await frame.locator('main').evaluate(async () => (await document.fonts.load('16px DivletQA')).length), 1);
  await frame.locator('[data-divlet-id="a"]').evaluate((el) => { window.__heldDivletNode = el; });
  assert.equal(await frame.locator('[data-divlet-id="a"]').evaluate((el) => Math.round(el.getBoundingClientRect().width)), 173);
  const iframeIdentity = await frameElement.evaluate((el) => { el.dataset.testIdentity = 'preserved'; return el.src; });
  await runtime.patch({ documentId: 'test-board', expectedVersion: 1, patch: { nodes: { label: { content: 'Updated from model' }, a: { className: 'w-[181px] h-[29px] bg-[#123456]' } } } });
  await frame.getByText('Updated from model', { exact: true }).waitFor();
  await waitUntil(async () => await frame.locator('[data-divlet-id="a"]').evaluate((el) => Math.round(el.getBoundingClientRect().width)) === 181, 'Tailwind CSS update');
  assert.equal(await frame.locator('[data-divlet-id="a"]').evaluate((el) => el === window.__heldDivletNode), true);
  assert.equal(await frameElement.getAttribute('data-test-identity'), 'preserved');
  assert.equal(await frameElement.getAttribute('src'), iframeIdentity);

  // Reparent an existing earlier sibling into a later sibling without replacing it.
  await runtime.patch({ documentId: 'test-board', expectedVersion: 2, patch: { nodes: { root: { children: ['b', 'image'] }, b: { children: ['a'] } } } });
  await frame.locator('[data-divlet-id="b"] > [data-divlet-id="a"]').waitFor();
  assert.equal(await frame.locator('[data-divlet-id="a"]').evaluate((el) => el === window.__heldDivletNode), true);

  await runtime.patch({ documentId: 'test-board', expectedVersion: 3, patch: { nodes: {
    root: { children: ['b', 'image', 'link', 'vector'] },
    link: { id: 'link', type: 'element', tag: 'a', children: [] },
    vector: { id: 'vector', type: 'element', tag: 'svg', attrs: { width: '16', height: '16' }, children: [] },
  } } });
  await frame.locator('[data-divlet-id="link"]').waitFor({ state: 'attached' });
  assert.equal(await frame.locator('[data-divlet-id="link"]').evaluate((el) => el.namespaceURI), 'http://www.w3.org/1999/xhtml');
  await assert.rejects(runtime.patch({ documentId: 'test-board', expectedVersion: 4, patch: { nodes: { root: { children: ['b', 'image', 'vector'] }, vector: { children: ['link'] } } } }), /inside SVG/);
  assert.equal(await frame.locator('[data-divlet-id="link"]').evaluate((el) => el.namespaceURI), 'http://www.w3.org/1999/xhtml');
  await page.locator('[data-mode="select"]').click();
  await frame.locator('[data-divlet-id="a"]').click({ force: true });
  await waitUntil(() => runtime.read({ view: 'preview', documentId: 'test-board' }).observation?.nodes?.some((node) => node.id === 'a'), 'preview observations');

  const paths = runtime.info().documents.find((doc) => doc.id === 'test-board');
  const projectText = await readFile(paths.modelPath, 'utf8');
  await writeFile(paths.modelPath, projectText.replace('"Updated from model"', '"Edited in the project file"'));
  await frame.getByText('Edited in the project file', { exact: true }).waitFor();
  assert.equal(runtime.read({ view: 'document', documentId: 'test-board' }).nodes.label.content, 'Edited in the project file');
  await writeFile(paths.modelPath, projectText.replace('"Updated from model"', '"unfinished'));
  await waitUntil(() => runtime.info().diagnostics.some((entry) => entry.path === paths.modelPath), 'invalid project file diagnosis');
  assert.equal(await frame.getByText('Edited in the project file', { exact: true }).count(), 1);
  await writeFile(paths.modelPath, projectText.replace('"Updated from model"', '"Recovered"'));
  await frame.getByText('Recovered', { exact: true }).waitFor();
  await waitUntil(() => runtime.info().diagnostics.length === 0, 'recovery clears diagnostic');
  const html = await readFile(paths.htmlPath, 'utf8');
  await writeFile(paths.htmlPath, html.replace('Recovered', 'Hand-edited page'));
  await waitUntil(() => runtime.info().diagnostics.some((entry) => entry.code === 'GENERATED_FILE_EDITED'), 'hand edits of generated pages are reported');
  assert.equal(await frame.getByText('Recovered', { exact: true }).count(), 1);
  assert.equal(runtime.read({ view: 'document', documentId: 'test-board' }).nodes.label.content, 'Recovered');

  await page.locator('[data-mode="select"]').click();
  await fetch(new URL('api/selection', runtime.info().url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(runtime.info().url).origin }, body: JSON.stringify({ ids: [] }) });
  await waitUntil(() => runtime.info().selection.ids.length === 0, 'selection cleared');
  const welcomeBox = await page.locator('.artboard[data-artboard-id="welcome"]').boundingBox();
  await page.mouse.move(welcomeBox.x - 30, welcomeBox.y - 50);
  await page.mouse.down();
  await page.mouse.move(welcomeBox.x + welcomeBox.width / 2, welcomeBox.y + welcomeBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await waitUntil(() => runtime.info().selection.ids.includes('welcome'), 'marquee selection');
  await page.setViewportSize({ width: 1300, height: 900 });
  await fetch(new URL('api/selection', runtime.info().url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(runtime.info().url).origin }, body: JSON.stringify({ ids: ['test-board'] }) });
  await page.locator('iframe[data-document-id="test-board"]').waitFor();
  const resized = await page.locator('iframe[data-document-id="test-board"]').contentFrame();
  assert.equal(await resized.locator('body').evaluate(() => innerWidth), 390);
  await page.setViewportSize({ width: 1700, height: 1050 });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/board.png', fullPage: true });
  assert.deepEqual(errors, []);
  const extras = [];
  for (let i = 0; i < 12; i++) {
    const id = `extra-${i}`;
    extras.push(id);
    await runtime.create({ document: { ...document, id, name: id, version: 1, artboard: { x: -600 + i * 260, y: -600, width: 240, height: 180 } }, undoable: false });
  }
  await fetch(new URL('api/selection', runtime.info().url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(runtime.info().url).origin }, body: JSON.stringify({ ids: extras }) });
  await page.waitForFunction(ids => ids.every(id => { const card = document.querySelector('.artboard[data-artboard-id="' + id + '"]'); return card?.classList.contains('selected') && card.querySelector('iframe'); }), extras);
  assert.ok(await page.locator('iframe').count() >= extras.length);
  assert.equal(await page.locator('.artboard').count(), 14);
  const rects = await page.evaluate(() => Object.fromEntries(['extra-0', 'extra-1'].map(id => { const r = document.querySelector(`.artboard[data-artboard-id="${id}"]`).getBoundingClientRect(); return [id, r.x]; })));
  const scale = await page.evaluate(() => Number(document.querySelector('#zoom-value').textContent.replace('%', '')) / 100);
  assert.ok(Math.abs((rects['extra-1'] - rects['extra-0']) - 260 * scale) < 1.5, 'negative world coordinates map linearly through the camera');
  assert.equal(runtime.info().selection.ids.length, 12);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(runtime.info().selection.ids.length, 12);
  // A fresh fixed host composition removes only observation publication; all other native services remain real.
  await page.close();
  runtime.observations.clear();
  const local = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const localErrors = []; let observationPosts = 0;
  local.on('pageerror', error => localErrors.push(error.message));
  local.on('request', request => { if (request.url().endsWith('/api/observations')) observationPosts++; });
  const hostSource = await readFile(new URL('../lib/host.js', import.meta.url), 'utf8');
  const nativePublisher = 'export const publishObservations = composed ? composed.publishObservations : createHttpObservationPublisher(post);';
  assert.equal(hostSource.split(nativePublisher).length, 2, 'one fixed native publisher binding is replaced before module execution');
  await local.route('**/lib/host.js', route => route.fulfill({ contentType: 'text/javascript', body: hostSource.replace(nativePublisher, 'export const publishObservations = undefined;') }));
  await local.goto(runtime.info().url);
  await local.waitForSelector('#loading', { state: 'hidden' });
  await local.evaluate(async () => (await import('./lib/store.js')).selectArtboards(['test-board']));
  await local.waitForFunction(async () => (await import('./lib/store.js')).store.observations.get('test-board')?.nodes.some(node => node.id === 'a'));
  const localFrame = local.frameLocator('iframe[data-document-id="test-board"]');
  await localFrame.locator('[data-divlet-id="a"]').evaluate(node => { node.style.width = '205px'; dispatchEvent(new Event('resize')); });
  await local.waitForFunction(async () => (await import('./lib/store.js')).store.observations.get('test-board')?.nodes.some(node => node.id === 'a' && Math.round(node.rect.width) === 205));
  assert.deepEqual(await local.evaluate(async () => {
    const { entries } = await import('./lib/canvas.js'); const entry = entries.get('test-board');
    return { timer: entry.reportTimer, queued: entry.latestReport };
  }), { timer: null, queued: null }, 'measurements stay local without publication bookkeeping');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(observationPosts, 0, 'no raw observations route fallback after the native publication window');
  assert.equal(runtime.observations.size, 0, 'native observation storage receives no local-only measurements');
  assert.deepEqual(localErrors, []);
  await local.close();
  console.log(JSON.stringify({ status: 'passed', checks: ['real Tailwind', 'keyed DOM and iframe identity', 'node reparenting', 'invalid SVG topology rejected', 'local image assets', ...(fontPath ? ['opaque-origin local fonts'] : []), 'selection and observations', 'project file edits sync live', 'invalid project file retains last good preview', 'recovery', 'hand-edited pages are reported, not imported', 'marquee artboard selection', 'fixed iframe viewport', 'negative artboard coordinates', 'visible/selected frames are not capped by the spare-prefetch target', 'multi-selection retained', 'publisher-less real preview measurements stay local without timers or backend reports'], screenshot: 'artifacts/board.png' }, null, 2));
} finally {
  await browser?.close();
  await runtime.close();
  await rm(cwd, { recursive: true, force: true });
}
