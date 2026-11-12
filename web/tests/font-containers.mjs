// Focused real device/container acceptance, independent of the general Appearance layout battery.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { fontBytes } from '../../core/tests/fixtures/font.js';
import { cffWoff2Bytes, nullWoff2Bytes, woff2Bytes } from '../../core/tests/fixtures/font-woff2.js';
import { referenceCffWoffBytes, referenceCff2Bytes } from '../../core/tests/fixtures/font-reference.js';
import { openRuntime } from '../../core/lib/runtime.js';
import { decodeHtml } from '../../core/lib/codec.ts';
import { setStyleEngines } from '../../core/lib/engine.ts';
setStyleEngines([]);
const directory = await mkdtemp(path.join(os.tmpdir(), 'divlet-font-containers-'));
let runtime, browser, server;
async function waitUntil(check, label) {
  let error;
  for (let i = 0; i < 150; i++) { try { if (await check()) return; } catch (caught) { error = caught; } await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`);
}
try {
  const file = path.join(directory, 'project.divlet'); await legacyProject(file);
  runtime = await openRuntime({ file, watch: false, createDemo: false });
  const frame = decodeHtml('<main><span id="sample" style="display:inline-block">AA</span></main>', { fallbackId: 'proof' });
  frame.css = 'main{font-size:100px;line-height:1;color:rgb(220,0,220)}'; frame.artboard.width = 500; frame.artboard.height = 200;
  await runtime.create({ document: frame });
  const snapshot = async () => ({ source: await readFile(file, 'utf8'), revision: runtime.revision, version: runtime.settings.version, css: runtime.settings.css, assets: structuredClone(runtime.settings.assets), history: runtime.readHistory() });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(20000); page.setDefaultNavigationTimeout(20000);
  await page.goto(runtime.url); await page.waitForFunction(() => document.querySelector('#loading')?.hidden);
  await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('proof', ['sample']));
  const button = page.getByRole('button', { name: 'Upload font', exact: true }); await button.waitFor();
  assert.ok((await page.locator('.font-family-control input[type=file]').getAttribute('accept')).includes('.woff2'));
  const initial = { css: runtime.settings.css, assets: structuredClone(runtime.settings.assets) }, version = runtime.getEntry('proof').document.version;
  const iframe = await page.locator('iframe[data-document-id="proof"]').elementHandle();
  const upload = async (bytes, name, mimeType = 'font/woff2') => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/fonts') && response.request().method() === 'POST');
    const chooser = page.waitForEvent('filechooser'); await button.click();
    await (await chooser).setFiles({ name, mimeType, buffer: bytes });
    const result = await response, body = await result.json();
    await waitUntil(() => button.isEnabled(), 'upload operation settles');
    return { status: result.status(), body };
  };
  const regular = nullWoff2Bytes(fontBytes(600, { family: 'Null Family' })), bold = cffWoff2Bytes();
  const first = await upload(regular, 'regular.woff2'); assert.equal(first.status, 200);
  const second = await upload(bold, 'bold.woff2'); assert.equal(second.status, 200);
  assert.equal(runtime.getEntry('proof').document.version, version, 'registration never silently chooses a family');
  assert.equal(runtime.settings.assets.fonts['regular.woff2'], `data:font/woff2;base64,${regular.toString('base64')}`);
  assert.equal(runtime.settings.assets.fonts['bold.woff2'], `data:font/woff2;base64,${bold.toString('base64')}`);
  const response = await fetch(runtime.url + 'build/assets/fonts/bold.woff2'); assert.equal(response.headers.get('content-type'), 'font/woff2'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bold);
  const family = page.locator('#inspector [data-key=font-family]');
  await family.click(); const choice = page.getByRole('menuitemradio', { name: '"Null Family"', exact: true }); assert.equal(await choice.count(), 1); await choice.click();
  const live = page.locator('iframe[data-document-id="proof"]').contentFrame().locator('#sample');
  await waitUntil(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 120), 'raw TTF null-transform face renders120px');
  await runtime.patch({ documentId: 'proof', expectedVersion: runtime.getEntry('proof').document.version, patch: { nodes: { sample: { style: { 'font-weight': '700' } } } } });
  await waitUntil(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 180), 'real CFF null-transform companion renders180px');
  const accepted = await snapshot();
  const conflict = await upload(bold, 'overlap.woff2'); assert.equal(conflict.status, 400); assert.equal(conflict.body.error, 'FONT_CONFLICT'); assert.deepEqual(await snapshot(), accepted);
  const transformed = await upload(woff2Bytes(), 'transformed.woff2'); assert.equal(transformed.status, 400); assert.equal(transformed.body.error, 'INVALID_FONT'); assert.match(transformed.body.message, /WOFF2.*transformed/i); assert.deepEqual(await snapshot(), accepted);
  await runtime.undo(); await waitUntil(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 120), 'Undo changes the selected face, not its program');
  await runtime.undo(); await runtime.undo(); assert.equal(runtime.settings.assets.fonts['bold.woff2'], undefined);
  await runtime.undo(); assert.deepEqual({ css: runtime.settings.css, assets: runtime.settings.assets }, initial, 'each registration is independently undoable with bytes and CSS together');
  for (let i = 0; i < 4; i++) await runtime.redo();
  await waitUntil(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 180), 'Redo restores exact compressed faces and selection');
  assert.equal(await iframe.evaluate(node => node.isConnected && node === document.querySelector('iframe[data-document-id="proof"]')), true);
  const capture = await runtime.captureFonts('proof', runtime.getEntry('proof').render); assert.ok(capture.css.includes(`data:font/woff2;base64,${bold.toString('base64')}`));
  const exported = await runtime.exportDocument('proof'); assert.ok(exported.html.includes(`data:font/woff2;base64,${bold.toString('base64')}`));
  // Reference programs use an independent SFNT/CFF builder and WOFF encoder, not the local fixture wrappers.
  const referenceRegular = referenceCffWoffBytes(), referenceBold = referenceCff2Bytes();
  for (const [bytes, name, type] of [[referenceRegular, 'reference.woff', 'font/woff'], [referenceBold, 'reference.otf', 'font/otf']]) {
    assert.equal((await upload(bytes, name, type)).status, 200);
    assert.equal(runtime.settings.assets.fonts[name], `data:${type};base64,${bytes.toString('base64')}`);
    const delivered = await fetch(runtime.url + 'build/assets/fonts/' + name); assert.equal(delivered.headers.get('content-type'), type); assert.deepEqual(Buffer.from(await delivered.arrayBuffer()), bytes);
  }
  await runtime.patch({ documentId: 'proof', expectedVersion: runtime.getEntry('proof').document.version, patch: { nodes: { sample: { style: { 'font-weight': '400' } } } } });
  await family.click(); const referenceChoice = page.getByRole('menuitemradio', { name: '"Reference Family"', exact: true }); assert.equal(await referenceChoice.count(), 1); await referenceChoice.click();
  await waitUntil(() => runtime.getEntry('proof').document.nodes.sample.style?.['font-family']?.includes('Reference Family'), 'reference family write accepted before the next versioned edit');
  await waitUntil(() => live.evaluate(node => getComputedStyle(node).fontFamily.includes('Reference Family') && Math.round(node.getBoundingClientRect().width) === 120), 'independently encoded CFF1 WOFF renders120px');
  await runtime.patch({ documentId: 'proof', expectedVersion: runtime.getEntry('proof').document.version, patch: { nodes: { sample: { style: { 'font-weight': '700' } } } } });
  await waitUntil(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 180), 'independently encoded static CFF2 renders180px');
  assert.equal(await iframe.evaluate(node => node.isConnected && node === document.querySelector('iframe[data-document-id="proof"]')), true);
  const referenceCapture = await runtime.captureFonts('proof', runtime.getEntry('proof').render), referenceExport = await runtime.exportDocument('proof');
  for (const [bytes, type] of [[referenceRegular, 'font/woff'], [referenceBold, 'font/otf']]) for (const html of [referenceCapture.css, referenceExport.html]) assert.ok(html.includes(`data:${type};base64,${bytes.toString('base64')}`));
  await page.evaluate(async () => { window.referenceCanvas = await import('./lib/canvas.js'); });
  await page.waitForFunction(() => { const entry = window.referenceCanvas.entries.get('proof'); return entry.shot?.render === entry.doc.render; });
  const ink = await page.evaluate(async () => {
    const image = new Image(); image.src = window.referenceCanvas.entries.get('proof').shot.url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data; let min = Infinity, max = -Infinity, count = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) { const i = (y * canvas.width + x) * 4; if (data[i] > 150 && data[i + 1] < 100 && data[i + 2] > 150) { min = Math.min(min, x); max = Math.max(max, x); count++; } }
    return { width: max - min + 1, count };
  });
  assert.ok(Math.abs(ink.width - 150) <= 2 && ink.count > 3500, JSON.stringify(ink));
  await page.close(); await runtime.close(); runtime = null; await rm(directory, { recursive: true, force: true });
  server = createServer((request, response) => { const html = request.url === '/prefix/index.html' ? exported.html : request.url === '/prefix/reference.html' ? referenceExport.html : null; if (!html) { response.writeHead(404).end(); return; } response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const portable = await browser.newPage(); let foreignRequests = 0;
  portable.on('request', request => { if (!request.url().startsWith(`http://127.0.0.1:${server.address().port}/`) && !request.url().startsWith('data:')) foreignRequests++; });
  await portable.goto(`http://127.0.0.1:${server.address().port}/prefix/index.html`);
  await portable.evaluate(() => document.fonts.ready);
  assert.equal(await portable.locator('#sample').evaluate(node => Math.round(node.getBoundingClientRect().width)), 180, 'portable CFF WOFF2 export needs neither source, cache nor a live board');
  await portable.goto(`http://127.0.0.1:${server.address().port}/prefix/reference.html`); await portable.evaluate(() => document.fonts.ready);
  assert.equal(await portable.locator('#sample').evaluate(node => Math.round(node.getBoundingClientRect().width)), 180, 'independent CFF2 export survives original/cache/board deletion');
  await portable.locator('#sample').evaluate(node => { node.style.fontWeight = '400'; }); await portable.evaluate(() => document.fonts.ready);
  assert.equal(await portable.locator('#sample').evaluate(node => Math.round(node.getBoundingClientRect().width)), 120, 'independent CFF1 WOFF also decodes without its original/cache/board');
  assert.equal(foreignRequests, 0);
  console.log(JSON.stringify({ status: 'passed', checks: ['actual chooser and plain-CSS TTF/CFF null-transform companions120/180px', 'original compressed bytes/MIME, one family choice and no hidden selection', 'overlap/transformed refusal keeps source/state/history', 'four-step Undo/Redo retains iframe and exact programs', 'capture closure and prefixed portable export after source/cache/board deletion', 'FontTools-built CFF1 WOFF/static CFF2 exact bytes/MIME,120/180px and150px captured ink; independent CFF2 portable export'] }, null, 2));
} finally { if (server) await new Promise(resolve => server.close(resolve)); await browser?.close(); await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
