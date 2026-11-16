// Private source acceptance: real preparation, closure, preview envelope and serialized bridge; not a browser writer.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { previewBridge } from '../../core/lib/bridge.js';
import { previewBridgeScript } from '../../core/lib/browser-preview.ts';
import { fontDataUrl } from '../../core/tests/fixtures/font.js';
import { bundleBrowserCodec, bundleBrowserPrepare, bundleBrowserPreview, bundleBrowserStandaloneAssets } from '../../scripts/browser-model.mjs';

const root = process.cwd(), prefix = '/closed-preview/';
const bundles = await Promise.all([bundleBrowserCodec(root, { source: true }), bundleBrowserPrepare(root), bundleBrowserPreview(root), bundleBrowserStandaloneAssets(root)]);
assert.deepEqual(bundles[2].inputs, ['core/lib/browser-preview.ts', '<stdin>'], 'the envelope has no writer, storage, provider or host bootstrap');
const svg = color => `<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"><rect id="mark" width="7" height="9" fill="${color}"/></svg>`;
const data = text => `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`;
const assets = (color, advance) => ({ icons: { 'mark.svg': data(svg(color)), 'equal-alias.svg': data(svg(color)) }, fonts: { 'face.ttf': fontDataUrl(advance) }, unused: 'data:application/octet-stream;base64,AQID' });
const html = padding => `<!doctype html><html><head><style>@font-face{font-family:ClosedProof;src:url(asset:fonts/face.ttf)}main{padding:${padding}px;background-image:url(asset:icons/mark.svg)}#font{display:inline-block;font-family:ClosedProof;font-size:100px;line-height:1}</style></head><body><main data-divlet-id="root"><span data-divlet-id="font" id="font">AA</span><img data-divlet-id="image" id="image" src="asset:icons/mark.svg"><svg data-divlet-id="svg" width="7" height="9"><defs data-divlet-id="defs"><rect data-divlet-id="rect" id="local-mark" width="7" height="9"/></defs><use data-divlet-id="use" id="local-use" href="#local-mark"></use></svg><input data-divlet-id="input" id="input" value="authored"></main></body></html>`;
const fixture = { initial: assets('#123456', 600), next: assets('#654321', 900), html: [html(17), html(31)], expanded: data(svg('#123456').replace('</svg>', `<metadata>${'x'.repeat(3 * 1024 * 1024)}</metadata></svg>`)) };
const files = new Map([
  [prefix, ['text/html', '<!doctype html><html><head><title>Closed preview proof</title></head><body></body></html>']],
  ...['codec', 'prepare', 'preview', 'closure'].map((name, index) => [prefix + name + '.js', ['text/javascript', bundles[index].code]]),
  [prefix + 'bridge.js', ['text/javascript', previewBridgeScript(previewBridge.toString())]],
  [prefix + 'fixtures.json', ['application/json', JSON.stringify(fixture)]],
]);
const served = [];
const server = http.createServer((req, res) => {
  served.push(req.url);
  const file = req.method === 'GET' && files.get(req.url);
  res.writeHead(file ? 200 : 404, { 'Content-Type': file?.[0] || 'text/plain', 'Cache-Control': 'no-store' });
  res.end(file?.[1] || 'not found');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const allowed = [...files.keys()].map(url => origin + url), requests = [], denied = [], errors = [];
  browser = await chromium.launch({ headless: true, executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  context.on('request', request => requests.push(request.url()));
  await context.route('**/*', route => {
    if (route.request().method() === 'GET' && allowed.includes(route.request().url())) return route.continue();
    denied.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + prefix);
  const initial = await page.evaluate(async () => {
    const [codec, prepare, envelope, closure, fixture] = await Promise.all([import('./codec.js'), import('./prepare.js'), import('./preview.js'), import('./closure.js'), fetch('./fixtures.json').then(r => r.json())]);
    const compiler = { compile: () => '', unknown: () => ({}) };
    const source = JSON.stringify(fixture);
    const derive = async (html, assets, maxWorkBytes = 4 * 1024 * 1024) => {
      const document = codec.decodeHtml(html, { fallbackId: 'closed' });
      const before = JSON.stringify({ document, assets });
      const prepared = await prepare.prepareFrameWith(document, { compiler });
      const projected = await closure.inlineDeclaredAssets(prepared.html, assets, { maxWorkBytes });
      if (JSON.stringify({ document, assets }) !== before) throw Error('Canonical source changed');
      if (new TextEncoder().encode(projected).length > 4 * 1024 * 1024 || projected.length > 8 * 1024 * 1024) throw Error('Projection exceeds preview/channel bounds');
      return { document, assets, html: projected };
    };
    const prepared = await derive(fixture.html[0], fixture.initial);
    const frame = document.createElement('iframe');
    frame.sandbox = 'allow-scripts'; frame.referrerPolicy = 'no-referrer'; frame.width = '700'; frame.height = '400';
    const token = crypto.randomUUID(), bridgeUrl = new URL('./bridge.js', location.href).href;
    const blob = URL.createObjectURL(new Blob([envelope.previewDocument(prepared.html, 'closed', 1, token, bridgeUrl)], { type: 'text/html' }));
    const state = window.proof = { fixture, source, derive, frame, blob, prepared, version: 1, posts: 0, messages: [], origin: null };
    const receive = event => {
      if (event.source !== frame.contentWindow || event.data?.type !== 'divlet:connect' || event.data.bridgeToken !== token || event.ports.length !== 1) return;
      // One expected document handoff only; not a replacement for canvas.js lifecycle authentication.
      removeEventListener('message', receive); state.origin = event.origin; state.port = event.ports[0];
      state.port.onmessage = event => state.messages.push(event.data); state.port.start();
      state.port.postMessage({ type: 'divlet:inspect', enabled: false });
    };
    addEventListener('message', receive);
    frame.src = blob; document.body.append(frame);
    state.publish = async (html, assets, maxWorkBytes) => {
      const next = await derive(html, assets, maxWorkBytes);
      state.port.postMessage({ type: 'divlet:update', documentId: 'closed', version: state.version + 1, html: next.html });
      state.prepared = next; state.version++; state.posts++;
    };
    return { bytes: new TextEncoder().encode(prepared.html).length, nodeGlobals: ['Buffer', 'process', 'require'].filter(key => key in globalThis), canonical: prepared.document.css.includes('asset:fonts/face.ttf') && Object.values(prepared.document.nodes).some(node => node.attrs?.src === 'asset:icons/mark.svg') };
  });
  assert.deepEqual(initial.nodeGlobals, []); assert.equal(initial.canonical, true);
  await page.waitForFunction(() => proof.port && proof.messages.some(m => m.type === 'divlet:rendered' && m.version === 1));
  const frame = page.locator('iframe').contentFrame();
  const endpoints = () => frame.locator('main').evaluate(async main => {
    const image = document.getElementById('image'); await image.decode();
    const loaded = await document.fonts.load('100px ClosedProof', 'AA'); await document.fonts.ready;
    const use = document.getElementById('local-use').getBBox();
    const canvas = document.createElement('canvas'); canvas.width = 7; canvas.height = 9;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    let parentDenied = false; try { void parent.document.body; } catch (error) { parentDenied = error.name === 'SecurityError'; }
    return { image: [image.naturalWidth, image.naturalHeight], use: [use.width, use.height], fontWidth: document.getElementById('font').getBoundingClientRect().width, fonts: loaded.length, padding: getComputedStyle(main).paddingTop, background: getComputedStyle(main).backgroundImage.startsWith('url("data:image/svg+xml;base64,'), pixel: [...ctx.getImageData(3, 4, 1, 1).data], referrer: document.referrer, parentDenied };
  });
  const expected = { image: [7, 9], use: [7, 9], fontWidth: 120, fonts: 1, padding: '17px', background: true, pixel: [18, 52, 86, 255], referrer: '', parentDenied: true };
  assert.deepEqual(await endpoints(), expected);
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
  assert.equal(await page.locator('iframe').getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(await page.evaluate(() => proof.origin), 'null');
  const originalSrc = await page.locator('iframe').getAttribute('src');
  await frame.locator('#input').evaluate(input => { window.heldInput = input; input.focus(); input.value = 'local draft'; window.heldRoot = document.querySelector('main'); });
  await page.evaluate(() => proof.publish(proof.fixture.html[1], proof.fixture.next));
  await page.waitForFunction(() => proof.messages.some(m => m.type === 'divlet:rendered' && m.version === 2));
  assert.deepEqual(await endpoints(), { ...expected, fontWidth: 180, padding: '31px', pixel: [101, 67, 33, 255] });
  assert.equal(await page.locator('iframe').getAttribute('src'), originalSrc);
  assert.deepEqual(await frame.locator('#input').evaluate(input => ({ same: input === heldInput, root: document.querySelector('main') === heldRoot, focus: document.activeElement === input, value: input.value })), { same: true, root: true, focus: true, value: 'local draft' });
  const refusals = await page.evaluate(async () => {
    const p = proof, refusals = [];
    const loop = structuredClone(p.fixture.next); loop.loop = 'data:text/css;base64,' + btoa('x{background:url(asset:loop)}');
    const large = structuredClone(p.fixture.next); large.icons['mark.svg'] = p.fixture.expanded;
    const rows = [
      ['query', p.fixture.html[0].replaceAll('asset:icons/mark.svg', 'asset:icons/mark.svg?rev=1'), p.fixture.initial],
      ['external-use', p.fixture.html[0].replace('href="#local-mark"', 'href="asset:icons/mark.svg#mark"'), p.fixture.initial],
      ['cycle', p.fixture.html[0].replaceAll('asset:icons/mark.svg', 'asset:loop'), loop],
      ['expanded-size', p.fixture.html[0], large],
    ];
    const accepted = JSON.stringify(p.prepared), version = p.version, posts = p.posts;
    for (const [name, html, assets] of rows) {
      try { await p.publish(html, assets); refusals.push({ name, error: 'accepted' }); }
      catch (error) { refusals.push({ name, error: error.code }); }
      if (JSON.stringify(p.prepared) !== accepted || p.version !== version || p.posts !== posts) throw Error('Refused preparation changed retained candidate or sent an update');
    }
    return { refusals, sourceSame: JSON.stringify(p.fixture) === p.source, version, posts };
  });
  assert.deepEqual(refusals, { refusals: [{ name: 'query', error: 'UNSUPPORTED_EXPORT' }, { name: 'external-use', error: 'UNSUPPORTED_EXPORT' }, { name: 'cycle', error: 'UNSUPPORTED_EXPORT' }, { name: 'expanded-size', error: 'FILE_TOO_LARGE' }], sourceSame: true, version: 2, posts: 1 });
  assert.deepEqual(await endpoints(), { ...expected, fontWidth: 180, padding: '31px', pixel: [101, 67, 33, 255] });
  // A direct Window message is not the document-bound bridge port. A same-version port message is stale.
  await page.evaluate(() => {
    const forged = { type: 'divlet:update', documentId: 'closed', version: 99, html: proof.prepared.html.replace('padding:31px', 'padding:99px') };
    if (forged.html === proof.prepared.html) throw Error('Forged update must change the measured property');
    proof.selectionBarrier = proof.messages.filter(m => m.type === 'divlet:node-selection').length;
    proof.frame.contentWindow.postMessage(forged, '*');
    proof.port.postMessage({ ...forged, version: 2 });
    proof.port.postMessage({ type: 'divlet:pick', x: 40, y: 40 });
  });
  await page.waitForFunction(() => {
    const selections = proof.messages.filter(m => m.type === 'divlet:node-selection');
    return selections.length > proof.selectionBarrier && selections.at(-1).version === 2;
  });
  assert.deepEqual(await endpoints(), { ...expected, fontWidth: 180, padding: '31px', pixel: [101, 67, 33, 255] });
  // A subsequent legitimate version also proves the bridge was not advanced by the forged Window message.
  await page.evaluate(() => proof.publish(proof.fixture.html[1], proof.fixture.next));
  await page.waitForFunction(() => proof.messages.some(m => m.type === 'divlet:rendered' && m.version === 3));
  assert.deepEqual(await endpoints(), { ...expected, fontWidth: 180, padding: '31px', pixel: [101, 67, 33, 255] });
  assert.equal(await page.locator('iframe').getAttribute('src'), originalSrc);
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  assert.deepEqual([...new Set(requests.filter(url => !url.startsWith('blob:') && !url.startsWith('data:')))].sort(), allowed.sort());
  const control = origin + prefix + 'unrequested';
  assert.equal(await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, control), true);
  assert.deepEqual(denied, [control], 'the network guard rejects a real unrequested parent fetch');
  assert.deepEqual([...new Set(served)].sort(), [...files.keys()].sort());
  await page.evaluate(() => { proof.port.close(); proof.frame.remove(); URL.revokeObjectURL(proof.blob); });
  console.log(JSON.stringify({ status: 'passed', profile: 'private source closed-preview composition; default byte reader/writer gates unchanged', initial, endpoints: ['opaque parent isolation/no referrer', 'real native preparation and same CSP envelope', 'initial and MessagePort live image/font/CSS/inline-use endpoints', 'same iframe/root/focused input and draft', 'query/use/cycle/4MiB expansion refused before harness publication', 'canonical declarations and logical references retained', 'deny-default network with positive control'], browser: browser.version(), bundles: bundles.map(b => b.bytes) }, null, 2));
  await context.close();
} finally {
  await browser?.close(); server.close(); await once(server, 'close');
}
