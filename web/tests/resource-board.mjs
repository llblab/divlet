// Opt-in trusted resource policy in the actual board. Default Pages/clipboard activation and separate browsing are NOT selected.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { connectBrowserMcp } from '../../core/lib/browser-mcp.ts';
import { pagesEntries } from '../../scripts/pages-build.mjs';
import { bundleBrowserBoard, bundleBrowserClosedPreview } from '../../scripts/browser-model.mjs';
import { fontDataUrl } from '../../core/tests/fixtures/font.js';
import { image, css, projectedSource, resourceEndpoints } from './fixtures/projected-resources.js';

const prefix = '/resource-board/', files = new Map(await pagesEntries());
const [board, closed] = await Promise.all([bundleBrowserBoard(process.cwd()), bundleBrowserClosedPreview(process.cwd())]);
files.set('resource-board.js', Buffer.from(board.code)); files.set('resource-closure.js', Buffer.from(closed.code));
const source = projectedSource(), originalImage = image('#123456'), originalFont = fontDataUrl(600), literal = image('#abcdef');
source.name = 'Declared resource board'; source.metadata = { value: null };
source.assets = { images: { 'mark.svg': originalImage, 'alias.svg': originalImage }, fonts: { 'proof.ttf': originalFont }, unused: 'data:text/plain;base64,VW51c2Vk', empty: {} };
source.frames[0].css = css(17, 600).replace(originalFont, 'asset:fonts/proof.ttf');
source.frames[0].nodes.image.attrs.src = 'asset:images/mark.svg';
source.frames[0].nodes.root.children.push('literal');
source.frames[0].nodes.literal = { id: 'literal', type: 'element', tag: 'img', attrs: { src: literal }, children: [] };
files.set('project.divlet', Buffer.from(JSON.stringify(source)));
files.set('styles.json', Buffer.from(JSON.stringify({ entries: [{ tokens: {}, candidates: [], css: '' }] })));
const shell = files.get('index.html').toString('utf8'); const hostSrc = /src="\.\/divlet-host\.js\?v=[0-9a-f]{12}"/g;
assert.equal(shell.match(hostSrc)?.length, 1, 'the shell loads one stamped host bundle');
files.set('index.html', Buffer.from(shell.replace(hostSrc, 'src="./resource-host.js"')));
// Test-owned policy controls and runtime handle; no production module or public snapshot is replaced.
files.set('resource-host.js', Buffer.from(`
import { startBrowserBoard } from ${JSON.stringify('./resource-board.js')};
import { projectClosedPreview } from ${JSON.stringify('./resource-closure.js')};
const here = new URL('./', import.meta.url);
globalThis.resourceControl = { mode: localStorage.getItem('fixture.resource-mode') || 'pass', bytes: 0, projections: 0 };
const projectPreview = async (html, assets) => { resourceControl.projections++; return resourceControl.mode === 'large' ? 'x'.repeat(4 * 1024 * 1024 + 1) : projectClosedPreview(html, assets); };
const resourcePolicy = { requireAssetBytes: () => { resourceControl.bytes++; if (resourceControl.mode === 'deny') throw Object.assign(Error('Test host refuses bytes'), { code: 'HOST_BYTES' }); }, projectPreview };
try {
  globalThis.resourceApp = await startBrowserBoard({ projectUrl: new URL('project.divlet', here), stylesUrl: new URL('styles.json', here), bridgeUrl: new URL('preview-bridge.js', here), storageKey: location.pathname + '#resources', file: 'project.divlet', version: 'source-test',
    ...(resourceControl.mode === 'default' ? { projectPreview } : { resourcePolicy }),
  });
  await import('./board.js');
} catch (error) {
  globalThis.startupFailure = { code: error.code, details: error.details };
  console.warn('RESOURCE_STARTUP', JSON.stringify(startupFailure));
  document.getElementById('loading').replaceChildren(Object.assign(document.createElement('p'), { className: 'host-error', textContent: error.message }));
}
`));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.divlet': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const name = req.url?.startsWith(prefix) ? req.url.slice(prefix.length).split('?')[0] || 'index.html' : '';
  const bytes = req.method === 'GET' && files.get(name);
  res.writeHead(bytes ? 200 : 404, { 'Content-Type': types[path.extname(name)] || 'text/plain', 'Cache-Control': 'no-store' }); res.end(bytes || 'missing');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
async function storedRecord() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('divlet-browser', 1); request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('projects'), get = tx.objectStore('projects').get(location.pathname + '#resources');
      let result; get.onsuccess = () => { result = get.result; };
      tx.oncomplete = () => { db.close(); resolve(result); }; tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
const descriptor = (file, data) => { const comma = data.indexOf(','); return { file, path: `asset:${file}`, mediaType: data.slice(5, comma - 7), size: Buffer.from(data.slice(comma + 1), 'base64').length }; };
const summaries = (mark, font) => [descriptor('images/mark.svg', mark), descriptor('images/alias.svg', originalImage), descriptor('fonts/proof.ttf', font), descriptor('unused', source.assets.unused)];
let browser, connection, page;
try {
  const url = `http://127.0.0.1:${server.address().port}${prefix}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  // The shell stamps the files of one publication (`?v=<hash>`); the allowlist names the files themselves.
  const unstamped = target => target.replace(/\?v=[0-9a-f]{12}$/, '');
  const allowed = new Set([...files.keys()].map(name => url + (name === 'index.html' ? '' : name))), requested = [], denied = [], errors = [];
  const guard = async context => {
    context.on('request', request => requested.push(request.url())); context.on('page', p => {
      p.on('pageerror', error => errors.push(error.message));
      p.on('console', message => { if (message.text().startsWith('RESOURCE_STARTUP')) console.error(message.text()); });
    });
    await context.route('**/*', route => {
      if (route.request().method() === 'GET' && allowed.has(unstamped(route.request().url()))) return route.continue();
      denied.push(route.request().url()); return route.abort();
    });
  };
  // Real URL-based MCP transport, with test-owned context network/download policy; no fake provider or agent binding.
  const guardedBrowser = { on: browser.on.bind(browser), close: browser.close.bind(browser), async newContext(options) {
    const context = await browser.newContext({ ...options, serviceWorkers: 'block', acceptDownloads: true }); await guard(context);
    await context.addInitScript(() => {
      if (top !== self) return;
      globalThis.resourcePutRequests = 0;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        const request = put.apply(this, args);
        if (this.name === 'projects' && args[1] === location.pathname + '#resources') resourcePutRequests++;
        return request;
      };
    });
    context.on('page', value => { page ??= value; }); return context;
  } };
  try { connection = await connectBrowserMcp(url, { browser: guardedBrowser, readyTimeoutMs: 15000 }); }
  catch (error) { if (page && !page.isClosed()) console.error('STARTUP', await page.evaluate(() => ({ failure: globalThis.startupFailure, control: globalThis.resourceControl }))); throw error; }
  page = connection.page;
  const context = page.context(), frame = page.frameLocator('iframe[data-document-id="index"]');
  const parse = result => { assert.equal(result.isError, false, result.content?.[0]?.text); return result.structuredContent; };
  const ready = async () => {
    await page.waitForSelector('#loading', { state: 'hidden' });
    await page.evaluate(async () => { globalThis.testCanvas = await import('./lib/canvas.js'); });
    await page.waitForFunction(() => { const e = testCanvas.entries.get('index'); return e?.loaded && e.renderedVersion === resourceApp.runtime.getEntry('index').render; });
  };
  const rendered = () => page.waitForFunction(() => { const e = testCanvas.entries.get('index'); return e?.loaded && e.renderedVersion === resourceApp.runtime.getEntry('index').render; });
  const endpoints = (target = frame, clean = false) => target.locator('main').evaluate(resourceEndpoints, clean);
  const state = () => page.evaluate(() => JSON.stringify({ source: resourceApp.runtime.source(), entries: [...resourceApp.runtime.documents], revision: resourceApp.runtime.revision, renderSeq: resourceApp.runtime.renderSeq, history: resourceApp.runtime.readHistory(), undo: resourceApp.runtime.undoStack, redo: resourceApp.runtime.redoStack, resources: resourceApp.runtime.info().project.resources }));
  const resources = () => page.evaluate(() => globalThis[Symbol.for('divlet.board-host/1')].readSession.readState().then(state => state.project.resources));
  await ready(); assert.ok(await page.evaluate(() => resourceControl.bytes > 0 && resourceControl.projections === 1), 'published bytes reach the paired policy before real board startup');
  assert.match(String(connection.discovery.instructions), /embedded source assets/); assert.match(String(connection.discovery.instructions), /upload/);
  const initial = { image: [7, 9], use: [7, 9], fonts: 1, fontWidth: 120, padding: '17px', pixel: [18, 52, 86, 255], isolated: true, referrer: '' };
  assert.deepEqual(await endpoints(), initial); assert.deepEqual(await resources(), summaries(originalImage, originalFont));
  assert.equal(await page.locator('iframe[data-document-id="index"]').getAttribute('sandbox'), 'allow-scripts');
  assert.equal(await page.locator('iframe[data-document-id="index"]').getAttribute('referrerpolicy'), 'no-referrer');
  assert.deepEqual(await frame.locator('[data-divlet-id="literal"]').evaluate(async img => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; }), [7, 9]);
  const project = parse(await connection.callTool('divlet_read', { view: 'project' }));
  assert.deepEqual(project.project.resources, summaries(originalImage, originalFont)); assert.ok(!JSON.stringify(project).includes(';base64,'));
  const beforeDevicePaste = await state(), deviceRecord = await page.evaluate(storedRecord);
  await page.evaluate(async () => {
    const store = await import('./lib/store.js'), clip = await import('./lib/clip.js');
    store.selectArtboards(['index']); await store.loadModel('index');
    await clip.paste({ files: [new File(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'], 'device.svg', { type: 'image/svg+xml' })] });
    await store.idle('index');
  });
  assert.deepEqual(denied, [], 'declared source-byte admission must not dispatch clipboard/device files to native assets HTTP');
  assert.equal(await state(), beforeDevicePaste); assert.deepEqual(await page.evaluate(storedRecord), deviceRecord);
  assert.equal(project.project.capabilities.assets, false); assert.equal(project.project.capabilities.sourceAssets, true);
  assert.ok(!('fontUpload' in project.project.capabilities)); assert.equal(project.site, null);
  await page.evaluate(async () => { const store = await import('./lib/store.js'); store.selectNodes('index', ['image']); });
  await page.waitForSelector('#inspector .image-box');
  assert.equal(await page.locator('#inspector .image-buttons button').count(), 0, 'native picker/upload controls are absent');
  assert.deepEqual(await page.locator('#inspector .image-box .thumb img').evaluateAll(images => images.map(img => img.getAttribute('src'))), [], 'unavailable declared thumbnail resolution does not guess a native build URL');
  assert.equal(await page.locator('#inspector [data-key="font-upload"]').count(), 0);
  const forged = await page.evaluate(async () => {
    const store = await import('./lib/store.js'), inspector = await import('./lib/inspector.js');
    const caps = store.store.state.project.capabilities, previous = caps.assets;
    try {
      caps.assets = true; await inspector.render({ force: true });
      return { buttons: document.querySelectorAll('#inspector .image-buttons button').length, images: [...document.querySelectorAll('#inspector .image-box .thumb img')].map(img => img.getAttribute('src')) };
    } finally { caps.assets = previous; await inspector.render({ force: true }); }
  });
  assert.deepEqual(forged, { buttons: 0, images: [] }, 'capability data alone cannot authorize absent native picker/thumbnail routes');
  assert.deepEqual(denied, [], 'selection/inspector also avoids native image routes');
  await page.evaluate(async () => { const store = await import('./lib/store.js'); store.selectNodes('index', ['literal']); });
  await page.waitForFunction(() => { const img = document.querySelector('#inspector .image-box .thumb img'); return img?.complete && img.naturalWidth === 7; });
  assert.equal(await page.locator('#inspector .image-box .thumb img').getAttribute('src'), literal, 'literal URLs retain ordinary inspector thumbnails without a resource-host route');
  assert.equal(await page.evaluate(() => typeof globalThis[Symbol.for('divlet.board-host/1')].exports.nodes), 'undefined');
  const src = await page.locator('iframe[data-document-id="index"]').getAttribute('src');
  await frame.locator('input').evaluate(input => { window.heldRoot = document.querySelector('main'); window.heldInput = input; input.focus(); input.value = 'retained draft'; });
  const replacement = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 7; c.height = 9; const ctx = c.getContext('2d'); ctx.fillStyle = '#654321'; ctx.fillRect(0, 0, 7, 9); return c.toDataURL('image/png'); });
  assert.notEqual(descriptor('images/mark.svg', replacement).size, descriptor('images/mark.svg', originalImage).size);
  const nextFont = fontDataUrl(900);
  parse(await connection.callTool('divlet_patch', { expectedVersion: project.project.version, patch: { assets: { images: { 'mark.svg': replacement }, fonts: { 'proof.ttf': nextFont } }, metadata: { value: [null] } } }));
  await rendered(); assert.deepEqual(await endpoints(), { ...initial, fontWidth: 180, pixel: [101, 67, 33, 255] });
  assert.equal(await page.evaluate(() => resourceApp.runtime.getEntry('index').document.version), 1, 'project-byte updates repaint even with unchanged frame content version');
  assert.deepEqual(await resources(), summaries(replacement, nextFont));
  const afterBytes = parse(await connection.callTool('divlet_read', { view: 'project' }));
  assert.deepEqual(afterBytes.project.resources, summaries(replacement, nextFont), 'agent reads changed MIME/size, not stale replacement descriptions');
  assert.deepEqual(afterBytes.project.metadata.value, [null], 'the initial patch stores an authored nullable array');
  await page.evaluate(() => globalThis[Symbol.for('divlet.board-host/1')].writer.patch({ documentId: 'index', expectedVersion: 1, patch: { nodes: { root: { style: { padding: '31px' } } } } }));
  await rendered(); const changed = { ...initial, fontWidth: 180, padding: '31px', pixel: [101, 67, 33, 255] };
  assert.deepEqual(await endpoints(), changed); assert.equal(await page.evaluate(() => resourceApp.runtime.history.length), 2);
  assert.equal(await page.locator('iframe[data-document-id="index"]').getAttribute('src'), src);
  const retained = () => frame.locator('input').evaluate(input => ({ input: input === heldInput, root: document.querySelector('main') === heldRoot, focus: document.activeElement === input, value: input.value }));
  assert.deepEqual(await retained(), { input: true, root: true, focus: true, value: 'retained draft' });
  const changedPoint = await page.evaluate(() => resourceApp.runtime.historyHead().pointId);
  const boundary = () => page.evaluate(() => ({ revision: resourceApp.runtime.revision, puts: resourcePutRequests }));
  const beforeUndo = await boundary();
  await page.evaluate(target => globalThis[Symbol.for('divlet.board-host/1')].historyService.navigate(target), { pointId: project.history.pointId, expectedPoint: changedPoint }); await rendered();
  assert.deepEqual(await boundary(), { revision: beforeUndo.revision + 1, puts: beforeUndo.puts + 1 }, 'two-step backward navigation has one accepted revision and one native project put request');
  assert.deepEqual(await endpoints(), initial); assert.deepEqual(await resources(), summaries(originalImage, originalFont));
  assert.equal(await page.evaluate(() => resourceApp.runtime.settings.metadata.value), null);
  const beforeRedo = await boundary();
  await page.evaluate(target => globalThis[Symbol.for('divlet.board-host/1')].historyService.navigate(target), { pointId: changedPoint, expectedPoint: project.history.pointId }); await rendered();
  assert.deepEqual(await boundary(), { revision: beforeRedo.revision + 1, puts: beforeRedo.puts + 1 }, 'two-step forward navigation has one accepted revision and one native project put request');
  assert.deepEqual(await page.evaluate(() => globalThis[Symbol.for('divlet.board-host/1')].readSession.readState().then(state => state.project.metadata.value)), [null], 'forward replay restores the independently authored nullable endpoint');
  assert.deepEqual(await endpoints(), changed); assert.deepEqual(await resources(), summaries(replacement, nextFont)); assert.deepEqual(await retained(), { input: true, root: true, focus: true, value: 'retained draft' });
  const accepted = await state(), record = await page.evaluate(storedRecord);
  for (const [reference, expected] of [['asset:images/mark.svg?rev=1', 'UNSUPPORTED_EXPORT'], ['asset:missing', 'INVALID_ASSET'], ['asset:images/alias.svg#mark', 'UNSUPPORTED_EXPORT']]) {
    const result = await page.evaluate(async reference => { const r = resourceApp.runtime; try { await globalThis[Symbol.for('divlet.board-host/1')].writer.patch({ documentId: 'index', expectedVersion: r.getEntry('index').document.version, patch: { nodes: { [reference.includes('#mark') ? 'use' : 'image']: { attrs: { [reference.includes('#mark') ? 'href' : 'src']: reference } } } } }); return 'accepted'; } catch (error) { return error.code; } }, reference);
    assert.equal(result, expected); assert.equal(await state(), accepted); assert.deepEqual(await page.evaluate(storedRecord), record); assert.deepEqual(await endpoints(), changed);
  }
  const invalid = await connection.callTool('divlet_patch', { expectedVersion: (await page.evaluate(() => resourceApp.runtime.settings.version)), patch: { assets: { unused: 'data:text/plain;base64,!' } } });
  assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, /INVALID_ASSET/); assert.equal(await state(), accepted); assert.deepEqual(await page.evaluate(storedRecord), record);
  const loop = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="asset:loop.svg"/></svg>').toString('base64')}`;
  const cycle = await connection.callTool('divlet_patch', { expectedVersion: await page.evaluate(() => resourceApp.runtime.settings.version), patch: { assets: { 'loop.svg': loop }, css: 'main{background-image:url("asset:loop.svg")}' } });
  assert.equal(cycle.isError, true); assert.match(cycle.content[0].text, /UNSUPPORTED_EXPORT/); assert.equal(await state(), accepted); assert.deepEqual(await page.evaluate(storedRecord), record); assert.deepEqual(await endpoints(), changed);
  await page.evaluate(() => { globalThis.refusalEvents = []; globalThis.stopObserver = resourceApp.runtime.subscribe(type => refusalEvents.push(type)); resourceControl.mode = 'large'; });
  const oversized = await page.evaluate(async () => { const r = resourceApp.runtime; try { await globalThis[Symbol.for('divlet.board-host/1')].writer.patch({ documentId: 'index', expectedVersion: r.getEntry('index').document.version, patch: { name: 'Refused' } }); return 'accepted'; } catch (error) { return error.code; } });
  assert.equal(oversized, 'FILE_TOO_LARGE'); assert.equal(await state(), accepted); assert.deepEqual(await page.evaluate(storedRecord), record);
  assert.deepEqual(await page.evaluate(() => { stopObserver(); resourceControl.mode = 'pass'; return refusalEvents; }), []);
  const canonical = JSON.parse(record.text);
  assert.deepEqual(canonical.metadata.value, [null], 'canonical storage/source retains the authored nullable endpoint');
  assert.equal(canonical.assets.images['mark.svg'], replacement); assert.equal(canonical.assets.images['alias.svg'], originalImage); assert.equal(canonical.assets.fonts['proof.ttf'], nextFont);
  assert.equal(canonical.assets.unused, source.assets.unused); assert.deepEqual(canonical.assets.empty, {});
  assert.equal(canonical.frames[0].nodes.image.attrs.src, 'asset:images/mark.svg'); assert.equal(canonical.frames[0].nodes.literal.attrs.src, literal); assert.match(canonical.frames[0].css, /asset:fonts\/proof.ttf/); assert.doesNotMatch(canonical.frames[0].css, /base64/);
  const projectCopy = await page.evaluate(() => globalThis[Symbol.for('divlet.board-host/1')].exports.project()); assert.equal(projectCopy.text, record.text);
  const downloadPending = page.waitForEvent('download'); await page.click('#status'); await page.getByRole('menuitem', { name: 'Download project file', exact: true }).click();
  const download = await downloadPending, stream = await download.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.equal(download.suggestedFilename(), 'project.divlet'); assert.equal(Buffer.concat(chunks).toString('utf8'), record.text);
  const exported = await page.evaluate(() => globalThis[Symbol.for('divlet.board-host/1')].exports.page('index'));
  assert.ok(!exported.html.includes('asset:') && !exported.html.includes('data-divlet-id') && !exported.html.includes('preview-bridge.js'));
  const standalone = await context.newPage(); await standalone.setContent(exported.html); assert.deepEqual(await endpoints(standalone, true), { ...changed, isolated: false }); await standalone.close();
  assert.equal(await state(), accepted); assert.deepEqual(await page.evaluate(storedRecord), record);
  await page.locator('.ab-expand').click(); await page.waitForSelector('#expanded-preview:not([hidden])');
  assert.equal(await page.locator('iframe[data-document-id="index"]').getAttribute('src'), src); assert.deepEqual(await endpoints(), changed);
  await page.click('#expanded-back'); await ready(); assert.notEqual(await page.locator('iframe[data-document-id="index"]').getAttribute('src'), src);
  assert.deepEqual(await endpoints(), changed); assert.equal(await frame.locator('input').inputValue(), 'authored'); assert.equal(await state(), accepted);
  await page.evaluate(() => localStorage.setItem('fixture.resource-mode', 'deny')); await page.reload(); await page.waitForSelector('#loading .host-error');
  assert.deepEqual(await page.evaluate(() => startupFailure), { code: 'BROWSER_RESTORE_FAILED', details: { causeCode: 'HOST_BYTES' } });
  assert.deepEqual(await page.evaluate(storedRecord), record); assert.deepEqual(await page.evaluate(() => [!!globalThis[Symbol.for('divlet.board-host/1')], !!globalThis[Symbol.for('browser-mcp/1')]]), [false, false]);
  await page.evaluate(() => localStorage.removeItem('fixture.resource-mode')); await page.reload(); await ready();
  assert.equal(await page.evaluate(() => resourceApp.restored), true); assert.deepEqual(await page.evaluate(() => resourceApp.runtime.settings.metadata.value), [null]); assert.deepEqual(await page.evaluate(storedRecord), record); assert.deepEqual(await endpoints(), changed); assert.deepEqual(await resources(), summaries(replacement, nextFont));
  const copyContext = await browser.newContext({ serviceWorkers: 'block' }); await guard(copyContext);
  const copyPage = await copyContext.newPage(); await copyPage.route(url + 'project.divlet', route => route.fulfill({ contentType: 'application/octet-stream', body: projectCopy.text }));
  await copyPage.goto(url); await copyPage.waitForFunction(() => globalThis.resourceApp && document.querySelector('.artboard')?.dataset.status === 'live');
  assert.equal(await copyPage.evaluate(() => resourceApp.restored), false); assert.equal(await copyPage.evaluate(() => resourceApp.runtime.source()), record.text); assert.deepEqual(await copyPage.evaluate(() => resourceApp.runtime.settings.metadata.value), [null]);
  assert.deepEqual(await endpoints(copyPage.frameLocator('iframe[data-document-id="index"]')), changed); assert.equal(await copyPage.evaluate(storedRecord), undefined); await copyContext.close();
  for (const mode of ['default', 'large']) {
    const freshContext = await browser.newContext({ serviceWorkers: 'block' }); await guard(freshContext);
    const fresh = await freshContext.newPage(); await fresh.addInitScript(mode => { if (top === self) localStorage.setItem('fixture.resource-mode', mode); }, mode);
    await fresh.goto(url); await fresh.waitForSelector('#loading .host-error');
    assert.equal(await fresh.evaluate(() => startupFailure.code), mode === 'default' ? 'ASSETS_UNAVAILABLE' : 'FILE_TOO_LARGE');
    assert.equal(await fresh.evaluate(() => resourceControl.projections), mode === 'default' ? 0 : 1);
    assert.deepEqual(await fresh.evaluate(() => [!!globalThis[Symbol.for('divlet.board-host/1')], !!globalThis[Symbol.for('browser-mcp/1')], document.querySelectorAll('.artboard').length]), [false, false, 0]);
    assert.equal(await fresh.evaluate(storedRecord), undefined); await freshContext.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.ok(requested.every(target => target.startsWith('blob:') || target.startsWith('data:') || allowed.has(unstamped(target))));
  const control = url + 'unrequested'; assert.equal(await page.evaluate(async target => { try { await fetch(target); return false; } catch { return true; } }, control), true); assert.deepEqual(denied, [control]);
  assert.deepEqual(await page.evaluate(() => ['Buffer', 'process', 'require'].filter(key => key in globalThis)), []);
  assert.deepEqual(JSON.parse(files.get('project.divlet').toString('utf8')), source, 'visitor/agent/copied projects never mutate the published master');
  console.log(JSON.stringify({ status: 'passed', scope: 'opt-in paired policy in real board; declared bytes, actual URL-based MCP, shared visitor writer, opaque initial/live/reset, IDB/reopen, project download/copy and page export; defaults/node Copy-Cut/separate browsing remain gated', browser: browser.version() }, null, 2));
} finally { await connection?.close(); await browser?.close(); server.close(); await once(server, 'close'); }
