// Trusted source composition of the actual board/canvas; literal resources only, never a byte-reader override.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { pagesEntries } from '../../scripts/pages-build.mjs';
import { bundleBrowserBoard, bundleBrowserClosedPreview } from '../../scripts/browser-model.mjs';
import { image, css, projectedSource, resourceEndpoints } from './fixtures/projected-resources.js';

const prefix = '/projected-board/', files = new Map(await pagesEntries());
const [board, closed] = await Promise.all([bundleBrowserBoard(process.cwd()), bundleBrowserClosedPreview(process.cwd())]);
files.set('projected-board.js', Buffer.from(board.code)); files.set('projected-closure.js', Buffer.from(closed.code));
const source = projectedSource();
files.set('project.divlet', Buffer.from(JSON.stringify(source)));
files.set('styles.json', Buffer.from(JSON.stringify({ entries: [{ tokens: {}, candidates: [], css: '' }] })));
const shell = files.get('index.html').toString('utf8');
assert.equal(shell.split('src="./divlet-host.js"').length, 2);
files.set('index.html', Buffer.from(shell.replace('src="./divlet-host.js"', 'src="./projected-host.js"')));
// This caller owns the trusted callback. Mutable failure controls and returned runtime handle exist only in this fixture.
files.set('projected-host.js', Buffer.from(`
import { startBrowserBoard } from ${JSON.stringify('./projected-board.js')};
import { projectClosedPreview } from ${JSON.stringify('./projected-closure.js')};
const here = new URL('./', import.meta.url);
globalThis.projectionControl = { mode: localStorage.getItem('fixture.projector-mode') || 'pass', calls: 0 };
try {
  globalThis.projectedApp = await startBrowserBoard({ projectUrl: new URL('project.divlet', here), stylesUrl: new URL('styles.json', here), bridgeUrl: new URL('preview-bridge.js', here), storageKey: location.pathname + '#projection', file: 'project.divlet', version: 'source-test',
    projectPreview: async (html, assets) => {
      projectionControl.calls++;
      if (projectionControl.mode === 'large') return 'x'.repeat(4 * 1024 * 1024 + 1);
      return projectClosedPreview(html, assets);
    },
  });
  await import('./board.js');
} catch (error) {
  globalThis.startupFailure = { code: error.code, details: error.details };
  document.getElementById('loading').replaceChildren(Object.assign(document.createElement('p'), { className: 'host-error', textContent: error.message }));
}
`));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.divlet': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const name = req.url?.startsWith(prefix) ? req.url.slice(prefix.length) || 'index.html' : '';
  const bytes = req.method === 'GET' && files.get(name);
  res.writeHead(bytes ? 200 : 404, { 'Content-Type': types[path.extname(name)] || 'text/plain', 'Cache-Control': 'no-store' }); res.end(bytes || 'missing');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
async function storedRecord() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('divlet-browser', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('projects'), get = tx.objectStore('projects').get(location.pathname + '#projection');
      let value; get.onsuccess = () => { value = get.result; };
      tx.oncomplete = () => { db.close(); resolve(value); }; tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
try {
  const origin = `http://127.0.0.1:${server.address().port}`, url = origin + prefix;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
  const allowed = new Set([...files.keys()].map(name => url + (name === 'index.html' ? '' : name))), requested = [], denied = [], errors = [];
  const guard = async ctx => {
    ctx.on('request', request => requested.push(request.url()));
    await ctx.route('**/*', route => {
      if (route.request().method() === 'GET' && allowed.has(route.request().url())) return route.continue();
      denied.push(route.request().url()); return route.abort();
    });
  };
  await guard(context);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    if (top !== self) {
      // Privileged fixture observation of the real child endpoint; every send still invokes the native method.
      const post = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function (message, ...args) {
        if (message?.type === 'divlet:rendered' && message.documentId === 'index') globalThis.previewEndpoint = this;
        return post.call(this, message, ...args);
      };
      return;
    }
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    globalThis.previewUrls = { created: [], revoked: [], firedTimers: [] };
    const timeout = setTimeout;
    window.setTimeout = function (callback, delay, ...args) {
      if (typeof callback !== 'function' || delay !== 4000) return timeout.call(this, callback, delay, ...args);
      let id;
      id = timeout.call(this, function (...values) { previewUrls.firedTimers.push(id); return callback.apply(this, values); }, delay, ...args);
      return id;
    };
    URL.createObjectURL = function (blob) { const url = create.call(this, blob); previewUrls.created.push(url); return url; };
    URL.revokeObjectURL = function (url) { const result = revoke.call(this, url); previewUrls.revoked.push(url); return result; };
  });
  const ready = async () => {
    await page.waitForSelector('#loading', { state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('.artboard[data-artboard-id="index"]')?.dataset.status === 'live', null, { timeout: 10000 });
    await page.evaluate(async () => { globalThis.testCanvas = await import('./lib/canvas.js'); });
  };
  const rendered = version => page.waitForFunction(version => {
    const entry = testCanvas.entries.get('index'); return entry?.loaded && entry.renderedVersion === version;
  }, version);
  const frame = page.frameLocator('iframe[data-document-id="index"]');
  const endpoints = (target = frame, clean = false) => target.locator('main').evaluate(resourceEndpoints, clean);
  await page.goto(url); await ready();
  assert.equal(await page.evaluate(() => projectionControl.calls), 1, 'real board forwards the trusted projector during initial preparation');
  const initial = { image: [7, 9], use: [7, 9], fonts: 1, fontWidth: 120, padding: '17px', pixel: [18, 52, 86, 255], isolated: true, referrer: '' };
  assert.deepEqual(await endpoints(), initial);
  assert.equal(await page.locator('iframe[data-document-id="index"]').getAttribute('sandbox'), 'allow-scripts');
  assert.equal(await page.locator('iframe[data-document-id="index"]').getAttribute('referrerpolicy'), 'no-referrer');
  const src = await page.locator('iframe[data-document-id="index"]').getAttribute('src');
  await frame.locator('[data-divlet-id="input"]').evaluate(input => { window.heldInput = input; window.heldRoot = document.querySelector('main'); input.focus(); input.value = 'local draft'; });
  const user = await page.evaluate(async ({ css, image }) => globalThis[Symbol.for('divlet.board-host/1')].writer.patch({ documentId: 'index', expectedVersion: 1, patch: { css, nodes: { image: { attrs: { src: image } } } } }), { css: css(31, 900), image: image('#654321') });
  await rendered(user.render);
  const changed = { ...initial, fontWidth: 180, padding: '31px', pixel: [101, 67, 33, 255] };
  assert.deepEqual(await endpoints(), changed);
  assert.equal(await page.locator('iframe[data-document-id="index"]').getAttribute('src'), src);
  assert.deepEqual(await frame.locator('[data-divlet-id="input"]').evaluate(input => ({ same: input === heldInput, root: document.querySelector('main') === heldRoot, focus: document.activeElement === input, value: input.value })), { same: true, root: true, focus: true, value: 'local draft' });
  const agent = await page.evaluate(() => projectedApp.runtime.callTool('divlet_patch', { frameId: 'index', expectedVersion: 2, patch: { nodes: { root: { style: { padding: '43px' } } } } }));
  await rendered(agent.render); assert.deepEqual(await endpoints(), { ...changed, padding: '43px' });
  assert.equal(await page.evaluate(() => projectedApp.runtime.history.length), 2, 'one accepted history entry per host-writer/shared-tool action');
  await page.evaluate(() => globalThis[Symbol.for('divlet.board-host/1')].writer.undo());
  await rendered(await page.evaluate(() => projectedApp.runtime.getEntry('index').render)); assert.deepEqual(await endpoints(), changed);
  await page.evaluate(() => globalThis[Symbol.for('divlet.board-host/1')].writer.redo());
  await rendered(await page.evaluate(() => projectedApp.runtime.getEntry('index').render)); assert.deepEqual(await endpoints(), { ...changed, padding: '43px' });
  assert.equal(await page.evaluate(() => projectionControl.calls), 5);
  assert.deepEqual(await frame.locator('[data-divlet-id="input"]').evaluate(input => ({ same: input === heldInput, root: document.querySelector('main') === heldRoot, focus: document.activeElement === input, value: input.value })), { same: true, root: true, focus: true, value: 'local draft' });
  const beforeRecord = await page.evaluate(storedRecord);
  const snapshot = () => page.evaluate(() => JSON.stringify({ source: projectedApp.runtime.source(), entries: [...projectedApp.runtime.documents], revision: projectedApp.runtime.revision, renderSeq: projectedApp.runtime.renderSeq, history: projectedApp.runtime.readHistory(), undo: projectedApp.runtime.undoStack, redo: projectedApp.runtime.redoStack }));
  const before = await snapshot();
  await page.evaluate(() => {
    globalThis.refusalEvents = [];
    globalThis.stopRefusalObserver = projectedApp.runtime.subscribe(type => refusalEvents.push(type));
  });
  const refusal = await page.evaluate(async () => {
    projectionControl.mode = 'large';
    const host = globalThis[Symbol.for('divlet.board-host/1')], current = await host.readSession.readFrame('index');
    try { await host.writer.patch({ documentId: 'index', expectedVersion: current.version, patch: { name: 'Must refuse' } }); return 'accepted'; } catch (error) { return error.code; }
  });
  assert.equal(refusal, 'FILE_TOO_LARGE'); assert.equal(await snapshot(), before); assert.deepEqual(await page.evaluate(storedRecord), beforeRecord);
  assert.deepEqual(await endpoints(), { ...changed, padding: '43px' });
  assert.equal(await page.locator('iframe[data-document-id="index"]').getAttribute('src'), src);
  const assetGate = await page.evaluate(async () => {
    const r = projectedApp.runtime, calls = projectionControl.calls;
    try { await r.patchProject({ expectedVersion: r.settings.version, patch: { assets: { unused: 'data:application/octet-stream;base64,AQID' } } }); return { error: 'accepted' }; }
    catch (error) { return { error: error.code, callsUnchanged: projectionControl.calls === calls }; }
  });
  assert.deepEqual(assetGate, { error: 'ASSETS_UNAVAILABLE', callsUnchanged: true });
  assert.deepEqual(await page.evaluate(() => { stopRefusalObserver(); return refusalEvents; }), [], 'neither refusal publishes state/change');
  const recovered = await page.evaluate(async () => {
    projectionControl.mode = 'pass';
    const host = globalThis[Symbol.for('divlet.board-host/1')], current = await host.readSession.readFrame('index');
    return host.writer.patch({ documentId: 'index', expectedVersion: current.version, patch: { name: 'Recovered literal frame' } });
  });
  await rendered(recovered.render);
  assert.deepEqual(await endpoints(), { ...changed, padding: '43px' });
  assert.equal(await page.locator('iframe[data-document-id="index"]').getAttribute('src'), src);
  assert.deepEqual(await frame.locator('[data-divlet-id="input"]').evaluate(input => ({ same: input === heldInput, root: document.querySelector('main') === heldRoot, focus: document.activeElement === input, value: input.value })), { same: true, root: true, focus: true, value: 'local draft' });
  const restoredRecord = await page.evaluate(storedRecord);
  assert.equal(JSON.parse(restoredRecord.text).frames[0].name, 'Recovered literal frame');
  await page.evaluate(() => localStorage.setItem('fixture.projector-mode', 'large'));
  await page.reload(); await page.waitForSelector('#loading .host-error');
  assert.deepEqual(await page.evaluate(() => startupFailure), { code: 'BROWSER_RESTORE_FAILED', details: { causeCode: 'FILE_TOO_LARGE' } });
  assert.equal(await page.evaluate(() => projectionControl.calls), 1); assert.deepEqual(await page.evaluate(storedRecord), restoredRecord);
  assert.deepEqual(await page.evaluate(() => ({ host: !!globalThis[Symbol.for('divlet.board-host/1')], provider: !!globalThis[Symbol.for('browser-mcp/1')] })), { host: false, provider: false });
  await page.evaluate(() => localStorage.removeItem('fixture.projector-mode'));
  await page.reload(); await ready(); assert.equal(await page.evaluate(() => projectedApp.restored), true);
  assert.equal(await page.evaluate(() => projectionControl.calls), 1); assert.deepEqual(await page.evaluate(storedRecord), restoredRecord);
  assert.deepEqual(await endpoints(), { ...changed, padding: '43px' });
  const canonical = JSON.parse(restoredRecord.text);
  assert.equal(canonical.frames[0].nodes.image.attrs.src, image('#654321')); assert.match(canonical.frames[0].css, /data:font\/ttf;base64,/); assert.deepEqual(canonical.assets ?? {}, {});
  assert.deepEqual(await page.evaluate(() => ({ assets: projectedApp.runtime.info().project.capabilities.assets, nodes: typeof globalThis[Symbol.for('divlet.board-host/1')].exports.nodes, nodeGlobals: ['Buffer', 'process', 'require'].filter(key => key in globalThis) })), { assets: false, nodes: 'undefined', nodeGlobals: [] });
  // This host has no public viewUrl: expansion keeps the opaque editor document; collapse explicitly resets it.
  for (const cycle of [0, 1]) {
    const activeSrc = await page.locator('iframe[data-document-id="index"]').getAttribute('src');
    assert.deepEqual(await page.evaluate(src => ({ allocated: previewUrls.created.includes(src), revoked: previewUrls.revoked.includes(src) }), activeSrc), { allocated: true, revoked: false }, 'actual URL APIs allocate the current preview');
    const content = () => page.evaluate(() => JSON.stringify({ source: projectedApp.runtime.source(), revision: projectedApp.runtime.revision, renderSeq: projectedApp.runtime.renderSeq, history: projectedApp.runtime.readHistory() }));
    let accepted = await content();
    await page.evaluate(() => { const e = testCanvas.entries.get('index'); globalThis.retiredPreview = { iframe: e.iframe, port: e.port, token: e.bridgeToken }; });
    await frame.locator('input').evaluate(input => { input.value = 'expanded local draft'; });
    await page.locator('.ab-expand').click();
    await page.waitForSelector('#expanded-preview:not([hidden])');
    assert.equal(await content(), accepted, 'entering expansion is not authored content');
    assert.deepEqual(await page.evaluate(() => { const e = testCanvas.entries.get('index'); return { same: e.iframe === retiredPreview.iframe, port: e.port === retiredPreview.port, token: e.bridgeToken === retiredPreview.token, publicView: !!e.doc.viewUrl }; }), { same: true, port: true, token: true, publicView: false });
    assert.equal(await frame.locator('input').inputValue(), 'expanded local draft');
    if (cycle === 0) {
      await page.evaluate(async () => { const r = projectedApp.runtime; await r.callTool('divlet_patch', { frameId: 'index', expectedVersion: r.getEntry('index').document.version, patch: { nodes: { root: { style: { padding: '47px' } } } } }); });
      const expandedFrame = await (await page.locator('iframe[data-document-id="index"]').elementHandle()).contentFrame();
      await expandedFrame.waitForFunction(() => getComputedStyle(document.querySelector('main')).paddingTop === '47px');
      assert.deepEqual(await endpoints(), { ...changed, padding: '47px' });
      assert.equal(await frame.locator('input').inputValue(), 'expanded local draft');
      accepted = await content();
    }
    const reset = await page.locator('#expanded-back').evaluate((button, cycle) => {
      button.click();
      const e = testCanvas.entries.get('index');
      let ghost = retiredPreview.iframe, displaced = null;
      if (cycle === 1) {
        // Another reset in the same browser task supersedes the first ghost before a replacement can paint.
        ghost = e.iframe;
        document.querySelector('.ab-expand').click(); button.click();
        displaced = { removed: !retiredPreview.iframe.isConnected, releases: previewUrls.revoked.filter(url => url === retiredPreview.iframe.src).length };
      }
      return { replaced: e.iframe !== retiredPreview.iframe, ghost: e.ghost === ghost && ghost.isConnected, ghostSrc: ghost.src, rotated: e.bridgeToken !== retiredPreview.token, portRetired: e.port !== retiredPreview.port, displaced };
    }, cycle);
    assert.deepEqual({ ...reset, ghostSrc: undefined }, { replaced: true, ghost: true, ghostSrc: undefined, rotated: true, portRetired: true, displaced: cycle === 1 ? { removed: true, releases: 1 } : null });
    await rendered(await page.evaluate(() => projectedApp.runtime.getEntry('index').render));
    await page.waitForFunction(() => !testCanvas.entries.get('index').ghost);
    assert.equal(await content(), accepted, 'collapse/reset is not authored content');
    assert.notEqual(await page.locator('iframe[data-document-id="index"]').getAttribute('src'), activeSrc);
    assert.deepEqual(await endpoints(), { ...changed, padding: '47px' });
    assert.equal(await frame.locator('input').inputValue(), 'authored', 'explicit reset discards only the local DOM draft');
    for (const retiredSrc of new Set([activeSrc, reset.ghostSrc])) assert.equal(await page.evaluate(src => previewUrls.revoked.filter(url => url === src).length, retiredSrc), 1, 'each removed or superseded ghost URL is revoked once');
    assert.equal(await page.evaluate(() => previewUrls.revoked.includes(testCanvas.entries.get('index').iframe.src)), false, 'current generation remains allocated');
    await page.evaluate(() => {
      globalThis.resetPort = testCanvas.entries.get('index').port;
      globalThis.windowBarrier = new Promise(resolve => {
        const listener = event => { if (event.source === testCanvas.entries.get('index').iframe.contentWindow && event.data?.type === 'fixture:reset-barrier') { removeEventListener('message', listener); resolve(); } };
        addEventListener('message', listener);
      });
    });
    const attack = await page.evaluate(() => ({ token: retiredPreview.token, version: projectedApp.runtime.getEntry('index').render }));
    await frame.locator('main').evaluate((_, { token, version }) => {
      const channel = new MessageChannel(); globalThis.replayPort = channel.port1; channel.port1.start();
      parent.postMessage({ type: 'divlet:connect', bridgeToken: token }, '*', [channel.port2]);
      parent.postMessage({ type: 'divlet:text-edit', documentId: 'index', version, renderVersion: version, nodeId: 'label', content: 'FORGED' }, '*');
      parent.postMessage({ type: 'fixture:reset-barrier' }, '*');
    }, attack);
    await page.evaluate(async () => { await windowBarrier; await projectedApp.runtime.enqueue(() => undefined); });
    assert.equal(await page.evaluate(() => testCanvas.entries.get('index').port === resetPort), true, 'old capability cannot replace the current document port');
    assert.equal(await content(), accepted, 'Window traffic cannot edit the accepted model');
    const next = await page.evaluate(async cycle => { const r = projectedApp.runtime; return r.patch({ documentId: 'index', expectedVersion: r.getEntry('index').document.version, patch: { name: `After reset ${cycle}` } }); }, cycle);
    await rendered(next.render);
    assert.deepEqual(await endpoints(), { ...changed, padding: '47px' });
    assert.equal(await page.locator('iframe[data-document-id="index"]').getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await page.locator('iframe[data-document-id="index"]').getAttribute('referrerpolicy'), 'no-referrer');
  }
  const generationContent = () => page.evaluate(() => JSON.stringify({ source: projectedApp.runtime.source(), revision: projectedApp.runtime.revision, renderSeq: projectedApp.runtime.renderSeq, history: projectedApp.runtime.readHistory() }));
  const beforeGeneration = await generationContent(), generationRecord = await page.evaluate(storedRecord);
  // Control parent animation callbacks only; child painting and authenticated bridge ACKs remain real.
  await page.evaluate(() => {
    const request = requestAnimationFrame, cancel = cancelAnimationFrame, callbacks = new Map();
    let next = 0;
    globalThis.paintClock = {
      step() { const batch = [...callbacks.values()]; callbacks.clear(); for (const callback of batch) callback(performance.now()); },
      restore() { window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel; for (const callback of callbacks.values()) request(callback); callbacks.clear(); },
    };
    window.requestAnimationFrame = callback => { const id = --next; callbacks.set(id, callback); return id; };
    window.cancelAnimationFrame = id => { if (!callbacks.delete(id)) cancel(id); };
    document.querySelector('.ab-expand').click(); document.querySelector('#expanded-back').click();
  });
  const paintVersion = await page.evaluate(() => projectedApp.runtime.getEntry('index').render);
  await page.waitForFunction(version => testCanvas.entries.get('index').renderedVersion === version, paintVersion, { polling: 20, timeout: 10000 });
  const acknowledged = await page.evaluate(() => {
    const e = testCanvas.entries.get('index');
    globalThis.acknowledgedGhost = e.ghost;
    const result = { ghost: !!e.ghost?.isConnected, port: !!e.port, loaded: e.loaded, released: previewUrls.revoked.includes(e.ghost?.src) };
    paintClock.step(); // The acknowledged generation's outer rAF schedules its inner retirement callback.
    return result;
  });
  assert.deepEqual(acknowledged, { ghost: true, port: true, loaded: true, released: false });
  const deferred = await page.evaluate(() => {
    const e = testCanvas.entries.get('index'), previous = e.iframe;
    document.querySelector('.ab-expand').click(); document.querySelector('#expanded-back').click();
    const current = e.iframe;
    globalThis.latestPaintGhost = previous;
    const before = { ghost: e.ghost === previous && previous.isConnected, authenticated: !!e.port, rendered: e.renderedVersion };
    paintClock.step(); // Earlier inner cleanup runs in this task, before the new document can authenticate.
    return { before, retained: e.ghost === previous && previous.isConnected, released: previewUrls.revoked.includes(previous.src), current: e.iframe === current && current.isConnected, olderRetired: !acknowledgedGhost.isConnected && previewUrls.revoked.includes(acknowledgedGhost.src) };
  });
  assert.deepEqual(deferred, { before: { ghost: true, authenticated: false, rendered: 0 }, retained: true, released: false, current: true, olderRetired: true }, 'an older paint callback must not retire a later reset ghost');
  await page.waitForFunction(version => testCanvas.entries.get('index').renderedVersion === version, paintVersion, { polling: 20, timeout: 10000 });
  const ownPaint = await page.evaluate(() => {
    const before = { retained: latestPaintGhost.isConnected && testCanvas.entries.get('index').ghost === latestPaintGhost, released: previewUrls.revoked.includes(latestPaintGhost.src) };
    paintClock.step(); paintClock.step(); // Its own ACK's two rAF callbacks, not the four-second fallback timer.
    const after = { removed: !latestPaintGhost.isConnected, releases: previewUrls.revoked.filter(url => url === latestPaintGhost.src).length, currentRevoked: previewUrls.revoked.includes(testCanvas.entries.get('index').iframe.src) };
    paintClock.restore();
    return { before, after };
  });
  assert.deepEqual(ownPaint, { before: { retained: true, released: false }, after: { removed: true, releases: 1, currentRevoked: false } }, 'its own authenticated paint callbacks still retire the latest ghost without the fallback timer');
  assert.deepEqual(await endpoints(), { ...changed, padding: '47px' });
  assert.equal(await generationContent(), beforeGeneration, 'deferred cleanup and reset do not author content or history');
  assert.deepEqual(await page.evaluate(storedRecord), generationRecord);
  const afterPaint = await page.evaluate(async () => { const r = projectedApp.runtime; return r.patch({ documentId: 'index', expectedVersion: r.getEntry('index').document.version, patch: { name: 'After deferred paint reset' } }); });
  await rendered(afterPaint.render);
  assert.deepEqual(await endpoints(), { ...changed, padding: '47px' });
  for (const trigger of ['timeout', 'unmount']) {
    const beforeCleanup = await generationContent(), cleanupRecord = await page.evaluate(storedRecord);
    let captureRoute;
    const capturedRoute = new Promise(resolve => { captureRoute = resolve; });
    const bridgeUrl = url + 'preview-bridge.js', holdBridge = route => { captureRoute(route); };
    let held, settled = false;
    await page.route(bridgeUrl, holdBridge);
    try {
      const request = page.waitForRequest(bridgeUrl, { timeout: 10000 });
      const pending = await page.evaluate(() => {
        const e = testCanvas.entries.get('index'), previous = e.iframe;
        document.querySelector('.ab-expand').click(); document.querySelector('#expanded-back').click();
        globalThis.cleanupPreview = { ghost: e.ghost, iframe: e.iframe, src: e.iframe.src, timer: e.ghostTimer };
        return { oldSrc: e.ghost.src, activeSrc: e.iframe.src, ghost: e.ghost === previous && previous.isConnected, port: !!e.port, rendered: e.renderedVersion, timer: e.ghostTimer };
      });
      await request; held = await capturedRoute;
      assert.deepEqual({ ...pending, oldSrc: undefined, activeSrc: undefined, timer: undefined }, { oldSrc: undefined, activeSrc: undefined, ghost: true, port: false, rendered: 0, timer: undefined });
      assert.notEqual(pending.oldSrc, pending.activeSrc);
      assert.equal(await page.evaluate(() => previewUrls.firedTimers.includes(cleanupPreview.timer)), false);
      if (trigger === 'timeout') {
        await page.waitForFunction(() => previewUrls.firedTimers.includes(cleanupPreview.timer), null, { timeout: 10000 });
        assert.deepEqual(await page.evaluate(() => { const e = testCanvas.entries.get('index'); return { oldRemoved: !cleanupPreview.ghost.isConnected, current: e.iframe === cleanupPreview.iframe && e.iframe.isConnected, port: !!e.port, rendered: e.renderedVersion, oldReleases: previewUrls.revoked.filter(url => url === cleanupPreview.ghost.src).length, currentRevoked: previewUrls.revoked.includes(e.iframe.src) }; }), { oldRemoved: true, current: true, port: false, rendered: 0, oldReleases: 1, currentRevoked: false }, 'native timeout retires only its ghost while the bridge remains held');
        assert.equal(await generationContent(), beforeCleanup); assert.deepEqual(await page.evaluate(storedRecord), cleanupRecord);
        await held.continue(); settled = true;
      } else {
        const authored = frame => { const { version, ...content } = frame; return content; };
        const previousFrame = authored(JSON.parse(cleanupRecord.text).frames[0]);
        await page.evaluate(async () => { const host = globalThis[Symbol.for('divlet.board-host/1')], r = projectedApp.runtime; await host.writer.deleteArtboard({ documentId: 'index', expectedVersion: r.getEntry('index').document.version }); });
        await page.waitForFunction(() => !testCanvas.entries.has('index') && !document.querySelector('.artboard[data-artboard-id="index"]'));
        assert.deepEqual(await page.evaluate(() => ({ ghostRemoved: !cleanupPreview.ghost.isConnected, currentRemoved: !cleanupPreview.iframe.isConnected, timerFired: previewUrls.firedTimers.includes(cleanupPreview.timer), releases: [cleanupPreview.ghost.src, cleanupPreview.iframe.src].map(src => previewUrls.revoked.filter(url => url === src).length) })), { ghostRemoved: true, currentRemoved: true, timerFired: false, releases: [1, 1] }, 'unmount releases both URLs without paint or fallback');
        assert.deepEqual(JSON.parse((await page.evaluate(storedRecord)).text).frames, []);
        await held.abort('aborted'); settled = true;
        await page.unroute(bridgeUrl, holdBridge);
        await page.evaluate(() => globalThis[Symbol.for('divlet.board-host/1')].writer.undo());
        await ready();
        const restoredFrame = JSON.parse((await page.evaluate(storedRecord)).text).frames[0];
        assert.deepEqual(authored(restoredFrame), previousFrame, 'Undo restores authored frame and literal resources');
        const restoredSrc = await page.locator('iframe[data-document-id="index"]').getAttribute('src');
        assert.ok(restoredSrc !== pending.oldSrc && restoredSrc !== pending.activeSrc);
        assert.equal(await page.evaluate(src => previewUrls.revoked.includes(src), restoredSrc), false);
      }
    } finally {
      if (held && !settled) await held.abort('aborted');
      await page.unroute(bridgeUrl, holdBridge);
    }
    await rendered(await page.evaluate(() => projectedApp.runtime.getEntry('index').render));
    if (trigger === 'timeout') assert.equal(await page.evaluate(() => { const e = testCanvas.entries.get('index'); return e.iframe === cleanupPreview.iframe && e.iframe.src === cleanupPreview.src; }), true, 'late bridge resumes the same current iframe and URL');
    assert.deepEqual(await endpoints(), { ...changed, padding: '47px' });
    const resumed = await page.evaluate(async trigger => { const r = projectedApp.runtime; return r.patch({ documentId: 'index', expectedVersion: r.getEntry('index').document.version, patch: { name: `After ${trigger} cleanup` } }); }, trigger);
    await rendered(resumed.render); assert.deepEqual(await endpoints(), { ...changed, padding: '47px' });
  }
  const beforeRetiredPacket = await generationContent(), retiredPacketRecord = await page.evaluate(storedRecord);
  await page.evaluate(async () => {
    globalThis.portStore = await import('./lib/store.js');
    const e = testCanvas.entries.get('index'), port = e.port, handler = port.onmessage;
    globalThis.retiredDelivery = { port, handler, iframe: e.iframe, packet: null };
    port.onmessage = function (event) {
      if (event.data?.type === 'divlet:text-edit' && event.data.content === 'STALE PORT REPLAY') retiredDelivery.packet = event;
      else handler.call(this, event);
    };
  });
  const oldRender = await page.evaluate(() => projectedApp.runtime.getEntry('index').render);
  await frame.locator('main').evaluate((_, version) => {
    previewEndpoint.postMessage({ type: 'divlet:text-edit', documentId: 'index', version, renderVersion: version, nodeId: 'label', content: 'STALE PORT REPLAY' });
  }, oldRender);
  await page.waitForFunction(() => !!retiredDelivery.packet, null, { timeout: 10000 });
  assert.deepEqual(await page.evaluate(() => ({ native: retiredDelivery.packet instanceof MessageEvent, trusted: retiredDelivery.packet.isTrusted, target: retiredDelivery.packet.target === retiredDelivery.port, current: testCanvas.entries.get('index').port === retiredDelivery.port })), { native: true, trusted: true, target: true, current: true });
  assert.equal(await generationContent(), beforeRetiredPacket, 'holding delivery does not edit accepted content');
  const replay = await page.evaluate(async () => {
    document.querySelector('.ab-expand').click(); document.querySelector('#expanded-back').click();
    const e = testCanvas.entries.get('index');
    const state = { replaced: e.iframe !== retiredDelivery.iframe, retired: e.port !== retiredDelivery.port, authenticated: !!e.port, rendered: e.renderedVersion };
    // Delay an actual native MessageEvent's original product callback until its captured frame/port have retired.
    retiredDelivery.handler.call(retiredDelivery.port, retiredDelivery.packet);
    await portStore.idle('index'); // Drain the UI document queue before the runtime writer fence.
    await projectedApp.runtime.enqueue(() => undefined);
    return state;
  });
  assert.deepEqual(replay, { replaced: true, retired: true, authenticated: false, rendered: 0 });
  assert.equal(await generationContent(), beforeRetiredPacket, 'delayed old-port delivery cannot edit the accepted model/history');
  assert.deepEqual(await page.evaluate(storedRecord), retiredPacketRecord);
  await rendered(await page.evaluate(() => projectedApp.runtime.getEntry('index').render));
  assert.equal(await page.evaluate(() => testCanvas.entries.get('index').port !== retiredDelivery.port), true);
  assert.deepEqual(await endpoints(), { ...changed, padding: '47px' });
  const liveRender = await page.evaluate(() => projectedApp.runtime.getEntry('index').render);
  await frame.locator('main').evaluate((_, version) => {
    previewEndpoint.postMessage({ type: 'divlet:text-edit', documentId: 'index', version, renderVersion: version, nodeId: 'label', content: 'AAA' });
  }, liveRender);
  await page.waitForFunction(() => projectedApp.runtime.getEntry('index').document.nodes.label.content === 'AAA', null, { timeout: 10000 });
  await page.evaluate(() => portStore.idle('index'));
  await rendered(await page.evaluate(() => projectedApp.runtime.getEntry('index').render));
  assert.deepEqual(await endpoints(), { ...changed, padding: '47px', fontWidth: 270 });
  assert.equal(JSON.parse((await page.evaluate(storedRecord)).text).frames[0].nodes.label.content, 'AAA');
  await page.evaluate(() => globalThis[Symbol.for('divlet.board-host/1')].writer.undo());
  await rendered(await page.evaluate(() => projectedApp.runtime.getEntry('index').render));
  assert.deepEqual(await endpoints(), { ...changed, padding: '47px' });
  assert.equal(JSON.parse((await page.evaluate(storedRecord)).text).frames[0].nodes.label.content, 'AA');
  const beforeExport = await generationContent(), exportRecord = await page.evaluate(storedRecord);
  const exported = await page.evaluate(() => globalThis[Symbol.for('divlet.board-host/1')].exports.page('index'));
  assert.equal(exported.documentId, 'index'); assert.equal(exported.fileName, 'index.html');
  assert.equal(exported.version, await page.evaluate(() => projectedApp.runtime.getEntry('index').document.version));
  assert.ok(exported.html.includes(image('#654321'))); assert.match(exported.html, /data:font\/ttf;base64,/);
  assert.ok(!exported.html.includes('data-divlet-id')); assert.ok(!exported.html.includes('data-divlet-manifest')); assert.ok(!exported.html.includes('preview-bridge.js'));
  const standalone = await context.newPage(); standalone.on('pageerror', error => errors.push(error.message));
  await standalone.setContent(exported.html);
  assert.deepEqual(await endpoints(standalone, true), { ...changed, padding: '47px', isolated: false });
  await standalone.close();
  assert.equal(await generationContent(), beforeExport); assert.deepEqual(await page.evaluate(storedRecord), exportRecord);
  assert.equal(await page.evaluate(() => typeof globalThis[Symbol.for('divlet.board-host/1')].exports.nodes), 'undefined');
  for (const kind of ['initial projection refusal', 'byte reader refusal']) {
    const isolated = await browser.newContext({ serviceWorkers: 'block' }); await guard(isolated);
    const fresh = await isolated.newPage();
    if (kind === 'initial projection refusal') await fresh.addInitScript(() => { if (top === self) localStorage.setItem('fixture.projector-mode', 'large'); });
    else await fresh.route(url + 'project.divlet', route => route.fulfill({ contentType: 'application/octet-stream', body: JSON.stringify({ ...source, assets: { unused: 'data:application/octet-stream;base64,AQID' } }) }));
    await fresh.goto(url); await fresh.waitForSelector('#loading .host-error');
    assert.equal(await fresh.evaluate(() => startupFailure.code), kind === 'initial projection refusal' ? 'FILE_TOO_LARGE' : 'ASSETS_UNAVAILABLE');
    assert.equal(await fresh.evaluate(() => projectionControl.calls), kind === 'initial projection refusal' ? 1 : 0);
    assert.deepEqual(await fresh.evaluate(() => ({ host: !!globalThis[Symbol.for('divlet.board-host/1')], provider: !!globalThis[Symbol.for('browser-mcp/1')], frames: document.querySelectorAll('.artboard').length })), { host: false, provider: false, frames: 0 });
    assert.equal(await fresh.evaluate(storedRecord), undefined);
    await isolated.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  assert.ok(requested.every(target => target.startsWith('blob:') || target.startsWith('data:') || allowed.has(target)), 'context-wide requests stay in the fixed public static graph');
  assert.ok(requested.some(target => target.endsWith('/lib/canvas.js')) && requested.some(target => target.endsWith('/preview-bridge.js')));
  const control = url + 'unrequested';
  assert.equal(await page.evaluate(async target => { try { await fetch(target); return false; } catch { return true; } }, control), true); assert.deepEqual(denied, [control]);
  await context.close();
  console.log(JSON.stringify({ status: 'passed', scope: 'trusted projector in actual board/canvas with literal Data URLs only; declared bytes still refused', checks: ['initial and live authenticated preview', 'same iframe/root/input focus/draft', 'host writer and shared tool', 'Undo/Redo and one history entry per action', 'refused output retains render/source/history/IndexedDB without publication', 'same-session post-refusal ACK retains root/focus/draft', 'restored-copy projection refusal preserves record', 'successful restoration reuses projector', 'no byte/node-export activation or native fallback', 'two opaque expand/reset cycles with literal endpoints', 'ghost URL release through actual API', 'old capability and Window edit refusal with causal barrier and writer fence', 'post-reset live ACK', 'ACK then reset then earlier cleanup retains the newer ghost', 'own ACK releases that ghost once; later writer remains live', 'native four-second timeout with bridge held; same-frame recovery', 'unmount releases ghost/current before timeout; Undo and new live ACK', 'held native old-port MessageEvent refused after reset with UI/runtime fences', 'new genuine port edit persists and renders; Undo restores literal endpoints', 'awaited page-export port produces clean standalone literal-resource rendering', 'context-wide network refusal control'], browser: browser.version() }, null, 2));
} finally { await browser?.close(); server.close(); await once(server, 'close'); }
