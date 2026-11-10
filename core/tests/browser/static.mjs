import assert from 'node:assert/strict';
import { legacyProject } from '../fixtures/legacy-project.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium } from 'playwright';
import { openRuntime } from '../../lib/runtime.js';
import { decodeHtml } from '../../lib/codec.ts';

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
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/static.png', fullPage: true });
  console.log(JSON.stringify({ status: 'passed', checks: ['copied build after editor shutdown and source removal', 'subpath hosting', 'real Tailwind CSS', '1280/768/390px responsive rendering', 'local SVG resources and rendered inline Gaussian blur', ...(font ? ['bundled local font'] : []), 'nested Markdown navigation and fragments', 'no editor traffic or scripts'], screenshot: 'artifacts/static.png' }, null, 2));
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await runtime.close();
  await fs.rm(directory, { recursive: true, force: true });
}
