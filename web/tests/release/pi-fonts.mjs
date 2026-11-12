// Real installed Pi owns the board; fixture setup uses validated user routes and invoke must traverse the RPC model/tool loop.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { fontBytes } from '../../../core/tests/fixtures/font.js';
import { cffWoff2Bytes } from '../../../core/tests/fixtures/font-woff2.js';

export async function checkInstalledPiFonts({ url, file, invoke, ownBrowser }) {
  const api = async (route, body) => {
    const response = await fetch(url + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  const until = async (check, label) => {
    let last;
    const deadline = Date.now() + 6000;
    do { try { if (await check()) return; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < deadline);
    throw new Error(label + (last ? ': ' + last.message : ''));
  };
  console.error('[installed Pi fonts] create user fixture');
  const created = await api('api/artboards', { name: 'Pi font proof', width: 500, height: 200, x: 0, y: 0 });
  const id = created.documentId, frame = await api('api/documents/' + id);
  await api('api/edit', { documentId: id, expectedVersion: frame.version, op: { type: 'insert', parentId: frame.rootId, spec: { tag: 'span', id: 'font-sample', attrs: { id: 'font-sample' }, style: { display: 'inline-block', 'font-size': '100px', 'line-height': '1', color: '#dc00dc' }, text: 'AA' } } });
  const before = await api('api/documents/' + id), regular = fontBytes(600, { family: 'Null Family' }), bold = cffWoff2Bytes();
  console.error('[installed Pi fonts] launch browser');
  const browser = await chromium.launch({ headless: true, handleSIGTERM: false, handleSIGINT: false, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.PI_DIVLET_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE } : {}) });
  ownBrowser(browser);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
    page.setDefaultTimeout(20000); page.setDefaultNavigationTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    console.error('[installed Pi fonts] load board');
    await page.goto(url); await page.waitForFunction(() => document.querySelector('#loading')?.hidden);
    await page.evaluate(async id => { window.fontStore = await import('./lib/store.js'); window.fontCanvas = await import('./lib/canvas.js'); window.fontStore.selectNodes(id, ['font-sample']); window.fontCanvas.setCamera({ x: 40, y: 80, k: 1 }); }, id);
    const button = page.getByRole('button', { name: 'Upload font', exact: true }); await button.waitFor();
    console.error('[installed Pi fonts] device uploads');
    const iframe = await page.locator(`iframe[data-document-id="${id}"]`).elementHandle();
    for (const [name, bytes, mimeType] of [['regular.ttf', regular, 'font/ttf'], ['bold.woff2', bold, 'font/woff2']]) {
      const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/fonts') && response.request().method() === 'POST');
      const chooser = page.waitForEvent('filechooser'); await button.click(); await (await chooser).setFiles({ name, mimeType, buffer: bytes });
      const reply = await response; assert.equal(reply.status(), 200, await reply.text()); await until(() => button.isEnabled(), 'Pi upload settles');
      const served = await fetch(url + 'build/assets/fonts/' + name); assert.equal(served.headers.get('content-type'), mimeType); assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes);
    }
    console.error('[installed Pi fonts] select family');
    const source = JSON.parse(await readFile(file, 'utf8')); assert.equal(source.schemaVersion, 1);
    assert.equal(source.assets.fonts['regular.ttf'], 'data:font/ttf;base64,' + regular.toString('base64'));
    assert.equal(source.assets.fonts['bold.woff2'], 'data:font/woff2;base64,' + bold.toString('base64'));
    assert.equal((await api('api/documents/' + id)).version, before.version, 'Pi-host device registration does not select a family');
    await page.locator('#inspector [data-key=font-family]').click();
    const choice = page.getByRole('menuitemradio', { name: '"Null Family"', exact: true }); assert.equal(await choice.count(), 1); await choice.click();
    const live = page.locator(`iframe[data-document-id="${id}"]`).contentFrame().locator('#font-sample'); await live.waitFor();
    await until(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 120), 'Pi-host TTF renders120px');
    console.error('[installed Pi fonts] real Pi tool patch/read/history');
    const current = await api('api/documents/' + id);
    await invoke('patch_divlet', { frameId: id, expectedVersion: current.version, label: 'Use installed Pi bold face', patch: { nodes: { 'font-sample': { style: { 'font-weight': '700' } } } } });
    await until(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 180), 'real Pi patch chooses CFF WOFF2 glyphs180px');
    for (const args of [{ view: 'project' }, { view: 'frame', frameId: id }]) assert.ok(!JSON.stringify(await invoke('read_divlet', args)).includes(';base64,'), 'Pi tool reads do not return font payloads');
    await invoke('undo_divlet', {}); await until(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 120), 'Pi tool Undo shares browser-owned registration history');
    await invoke('undo_divlet', { redo: true }); await until(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 180), 'Pi tool Redo restores font matching');
    assert.equal(await iframe.evaluate((node, id) => node.isConnected && node === document.querySelector(`iframe[data-document-id="${id}"]`), id), true);
    console.error('[installed Pi fonts] capture current render');
    await page.waitForFunction(id => { const entry = window.fontCanvas.entries.get(id); return entry.shot?.render === entry.doc.render; }, id);
    const ink = await page.evaluate(async id => {
      const image = new Image(); image.src = window.fontCanvas.entries.get(id).shot.url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data; let min = Infinity, max = -Infinity, count = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) { const i = (y * canvas.width + x) * 4; if (data[i] > 150 && data[i + 1] < 100 && data[i + 2] > 150) { min = Math.min(min, x); max = Math.max(max, x); count++; } }
      return { width: max - min + 1, count };
    }, id);
    assert.ok(Math.abs(ink.width - 150) <= 2 && ink.count > 3500, JSON.stringify(ink)); assert.deepEqual(errors, []);
    return { status: 'passed', glyphAdvances: [120, 180], snapshotInk: ink.width, realPiToolPatchReadUndoRedo: true, payloadFreeReads: true, sameIframe: true };
  } finally { await browser.close(); ownBrowser(null); }
}
