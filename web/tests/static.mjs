import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium } from 'playwright';
import { openRuntime } from '../../core/lib/runtime.js';
import { decodeHtml } from '../../core/lib/codec.ts';
import { validateSettings, writeProject } from '../../core/lib/project.ts';
import { fontDataUrl, fontBytes } from '../../core/tests/fixtures/font.js';
import { readFont } from '../../core/lib/font.ts';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-static-browser-'));
const source = path.join(directory, 'source');
await fs.mkdir(path.join(source, 'assets'), { recursive: true });
await fs.mkdir(path.join(source, 'content/guide'), { recursive: true });
await fs.writeFile(path.join(source, 'assets/mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#123456"/></svg>');
const font = process.env.PI_DIVLET_TEST_FONT;
if (font) await fs.copyFile(font, path.join(source, 'assets/font.ttf'));
await legacyProject(path.join(source, 'manual.divlet'));
const runtime = await openRuntime({ file: path.join(source, 'manual.divlet'), watch: false, createDemo: false });
let browser;
let server;
let native;
try {
  const template = decodeHtml(`<style>main{max-width:100%;box-sizing:border-box}${font ? '@font-face{font-family:Bundled;src:url(assets/font.ttf)}main{font-family:Bundled}' : ''}</style><main id="shell" class="min-h-screen p-4 md:p-8 bg-[#123456] text-white"><header><img id="logo" src="assets/mark.svg" alt="Local mark"><svg id="blur-example" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><defs><filter id="soft-edge" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2"/></filter></defs><rect x="8" y="8" width="16" height="16" filter="url(#soft-edge)"/></svg><h1 id="title" class="text-2xl md:text-4xl">Title</h1></header><nav id="navigation"></nav><article id="content" class="max-w-prose"></article></main>`, { fallbackId: 'layout' });
  await runtime.create({ document: template });
  await fs.writeFile(path.join(source, 'site.json'), JSON.stringify({ schemaVersion: 1, title: 'Portable manual', templateId: 'layout', contentDir: 'content', slots: { content: 'content', title: 'title', navigation: 'navigation' } }));
  await fs.writeFile(path.join(source, 'content/index.md'), '# Static home\n\n[Read the chapter](guide/start.md#details)');
  await fs.writeFile(path.join(source, 'content/guide/start.md'), '# Details\n\n![Still local](../../assets/mark.svg)\n\n[Back home](../index.md)');
  await runtime.scan();
  assert.deepEqual(runtime.info().diagnostics, []);
  const output = path.join(directory, 'published');
  await fs.cp(runtime.outputDir, output, { recursive: true });
  const editorURL = runtime.url;
  await runtime.close();
  await fs.rm(source, { recursive: true, force: true });
  const prefix = '/nested/deployment/';
  const mime = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith(prefix)) { res.writeHead(404); return res.end(); }
      const relative = decodeURIComponent(url.pathname.slice(prefix.length));
      if (relative.split('/').includes('..')) { res.writeHead(403); return res.end(); }
      const file = path.join(output, relative.endsWith('/') || !relative ? relative + 'index.html' : relative);
      const bytes = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' });
      res.end(bytes);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}${prefix}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 820 });
    await page.goto(base);
    assert.equal(await page.title(), 'Static home — Portable manual');
    await page.locator('#logo').evaluate(img => img.decode());
    assert.equal(await page.locator('#logo').evaluate(img => img.naturalWidth), 32);
    assert.equal(await page.locator('main').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(18, 52, 86)');
    assert.equal(await page.locator('main').evaluate(node => getComputedStyle(node).paddingLeft), width >= 768 ? '32px' : '16px');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (font) assert.equal(await page.evaluate(async () => (await document.fonts.load('16px Bundled')).length), 1);
  }
  const blurPixels = await page.locator('#blur-example').evaluate(async svg => {
    const primitive = svg.querySelector('feGaussianBlur');
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d');
    context.drawImage(img, 0, 0);
    return { typed: primitive instanceof SVGFEGaussianBlurElement, deviation: primitive.stdDeviationX.baseVal, outside: context.getImageData(6, 16, 1, 1).data[3], center: context.getImageData(16, 16, 1, 1).data[3] };
  });
  assert.equal(blurPixels.typed, true);
  assert.equal(blurPixels.deviation, 2);
  assert.ok(blurPixels.outside > 0 && blurPixels.outside < blurPixels.center, JSON.stringify(blurPixels));
  await page.getByRole('link', { name: 'Read the chapter' }).click();
  await page.waitForURL('**/guide/start/index.html#details');
  await page.locator('article img').evaluate(img => img.decode());
  assert.equal(await page.locator('article img').evaluate(img => img.naturalWidth), 32);
  await page.getByRole('link', { name: 'Back home' }).click();
  await page.waitForURL('**/nested/deployment/index.html');
  assert.deepEqual(errors, []);
  assert.ok(requests.every(url => !url.startsWith(editorURL)));
  assert.equal(await page.locator('script').count(), 0);
  const nativeDirectory = path.join(directory, 'native'); await fs.mkdir(nativeDirectory);
  const nativeFile = path.join(nativeDirectory, 'project.divlet');
  const nativeFrame = decodeHtml('<main><span id="font-proof" style="font-size:100px">AA</span><img id="native-logo" src="asset:icons/mark.svg"></main>', { fallbackId: 'native' });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect id="mark" width="32" height="32" fill="#123456"/></svg>';
  const nativeUse = decodeHtml('<main><svg width="32" height="32"><defs><rect id="local-mark" width="32" height="32"/></defs><use href="#local-mark"></use></svg></main>', { fallbackId: 'native-use' });
  const settings = validateSettings({ css: '@font-face{font-family:NativeAsset;src:url(asset:fonts/typed.html)}main{font-family:NativeAsset}', assets: { fonts: { 'typed.html': fontDataUrl() }, icons: { 'mark.svg': 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') } } });
  await fs.writeFile(nativeFile, writeProject(settings, [nativeFrame, nativeUse]));
  native = await openRuntime({ file: nativeFile, watch: false });
  const nativeUrl = native.url, initialRender = native.getEntry('native').render;
  const fontResponse = await fetch(nativeUrl + 'build/assets/fonts/typed.html');
  assert.equal(fontResponse.headers.get('content-type'), 'font/ttf', 'declared MIME wins over .html; no browsing helper corrupts font bytes');
  assert.ok(Buffer.from(await fontResponse.arrayBuffer()).equals(Buffer.from(fontDataUrl().split(',')[1], 'base64')));
  await page.goto(nativeUrl);
  const live = page.frameLocator('iframe[data-document-id="native"]');
  await live.locator('#font-proof').waitFor();
  assert.equal(await live.locator('body').evaluate(async () => (await document.fonts.load('100px NativeAsset')).length), 1);
  assert.equal(await live.locator('#font-proof').evaluate(node => Math.round(node.getBoundingClientRect().width)), 120, 'the sandboxed board preview actually loads the stored font');
  await live.locator('#native-logo').evaluate(image => image.decode());
  const usePreview = page.frameLocator('iframe[data-document-id="native-use"]');
  await usePreview.locator('use').waitFor();
  await page.waitForTimeout(250);
  assert.equal(await usePreview.locator('use').evaluate(node => node.getBBox().width), 32, 'same-document SVG use remains supported in the real sandboxed preview');
  await page.locator('iframe[data-document-id="native"]').evaluate(node => { node.dataset.lifetimeProof = 'retained'; });
  const liveDocument = await (await page.locator('iframe[data-document-id="native"]').elementHandle()).contentFrame();
  await native.patchProject({ expectedVersion: native.settings.version, patch: { assets: { fonts: { 'typed.html': fontDataUrl(900) } } } });
  await liveDocument.waitForFunction(() => Math.round(document.querySelector('#font-proof').getBoundingClientRect().width) === 180);
  await native.undo();
  await liveDocument.waitForFunction(() => Math.round(document.querySelector('#font-proof').getBoundingClientRect().width) === 120);
  assert.equal(await page.locator('iframe[data-document-id="native"]').getAttribute('data-lifetime-proof'), 'retained', 'font byte changes and Undo keep the same iframe');
  async function checkNativeFont(url, width, family = 'NativeAsset') {
    await page.goto(url);
    assert.equal(await page.evaluate(async family => (await document.fonts.load('100px ' + JSON.stringify(family))).length, family), 1);
    assert.equal(await page.locator('#font-proof').evaluate(node => Math.round(node.getBoundingClientRect().width)), width);
    await page.locator('#native-logo').evaluate(image => image.decode());
    assert.equal(await page.locator('#native-logo').evaluate(image => image.naturalWidth), 32);
  }
  await checkNativeFont(nativeUrl + 'preview/native', 120);
  await native.patchProject({ expectedVersion: native.settings.version, patch: { assets: { fonts: { 'typed.html': fontDataUrl(900) } } } });
  assert.equal(native.getEntry('native').document.version, 1);
  assert.ok(native.getEntry('native').render > initialRender);
  await checkNativeFont(nativeUrl + 'preview/native', 180);
  await native.undo(); await checkNativeFont(nativeUrl + 'preview/native', 120);
  const registered = await native.saveFont({ name: 'portable-device.ttf', data: fontBytes(600, { family: 'UploadedStatic' }), expectedVersion: native.settings.version });
  await native.patchProject({ expectedVersion: native.settings.version, patch: { css: native.settings.css + '\nmain{font-family:UploadedStatic}' } });
  assert.ok(native.settings.css.includes(registered.path));
  const exported = await native.exportDocument('native');
  assert.match(exported.html, /UploadedStatic/, 'the actual font-upload writer reaches portable single-page export');
  assert.ok(exported.html.includes(fontDataUrl()));
  await fs.writeFile(path.join(output, 'native-export.html'), exported.html);
  await native.close(); await fs.rm(nativeDirectory, { recursive: true });
  const requestStart = requests.length;
  await checkNativeFont(base + 'native-export.html', 120, 'UploadedStatic');
  assert.equal(await page.locator('#font-proof').evaluate(node => getComputedStyle(node).fontFamily), 'UploadedStatic');
  assert.ok(requests.slice(requestStart).every(url => !url.startsWith(nativeUrl)), 'standalone fonts/images require neither canonical source, cache nor live board');
  // Metadata inspection is not a glyph validator: separately load its descriptors with the browser's font decoder.
  for (const options of [
    { family: 'Reader Bold Italic', subfamily: 'Bold Italic', weight: 700, italic: true, width: 3 },
    { family: 'Reader Oblique', oblique: true, angle: -12 },
  ]) {
    const bytes = fontBytes(600, options), metadata = readFont(bytes);
    const proof = await page.evaluate(async ({ bytes, metadata }) => {
      const face = new FontFace(metadata.family, Uint8Array.from(atob(bytes), char => char.charCodeAt(0)), { weight: metadata.weight, style: metadata.styles[0], stretch: metadata.stretch });
      await face.load(); document.fonts.add(face);
      const text = document.createElement('span'); text.textContent = 'AA';
      Object.assign(text.style, { fontFamily: JSON.stringify(metadata.family), fontSize: '100px', fontWeight: metadata.weight, fontStyle: metadata.styles[0], fontStretch: metadata.stretch });
      document.body.append(text);
      await document.fonts.load(`${metadata.styles[0]} ${metadata.weight} 100px ${JSON.stringify(metadata.family)}`, 'AA');
      const result = { width: Math.round(text.getBoundingClientRect().width), status: face.status, weight: face.weight, style: face.style, stretch: face.stretch };
      text.remove(); document.fonts.delete(face); return result;
    }, { bytes: bytes.toString('base64'), metadata });
    assert.deepEqual(proof, { width: 120, status: 'loaded', weight: metadata.weight, style: metadata.styles[0], stretch: metadata.stretch });
  }
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/static.png', fullPage: true });
  console.log(JSON.stringify({ status: 'passed', checks: ['copied build after editor shutdown and source removal', 'subpath hosting', 'real Tailwind CSS', '1280/768/390px responsive rendering', 'local SVG resources and rendered inline Gaussian blur', ...(font ? ['bundled local font'] : []), 'nested Markdown navigation and fragments', 'no editor traffic or scripts', 'native MIME-aware image/font bytes independent of extension', 'real font loading, render invalidation and Undo', 'standalone embedded font/image HTML after deleting native source/cache', 'separately browser-decoded SFNT italic/oblique weight/stretch descriptors'],  screenshot: 'artifacts/static.png' }, null, 2));
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await runtime.close();
  await native?.close();
  await fs.rm(directory, { recursive: true, force: true });
}
