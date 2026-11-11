// Serve only the publication copy under a repository prefix: no board, source tree or product server can rescue a bad URL.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { copyLanding } from '../../../scripts/landing-hash.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-landing-browser-'));
const files = new Set(await copyLanding(directory));
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const name = pathname === '/divlet/' ? 'index.html' : pathname.startsWith('/divlet/') ? pathname.slice('/divlet/'.length) : '';
    if (!files.has(name)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
    response.end(await fs.readFile(path.join(directory, name)));
  } catch { response.writeHead(500).end(); }
});
let browser;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.PI_DIVLET_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE } : {}) });
  const base = `http://127.0.0.1:${server.address().port}/divlet/`;
  const checks = [];
  await fs.mkdir('artifacts', { recursive: true });
  for (const colorScheme of ['light', 'dark']) for (const width of [1280, 390, 195]) {
    const context = await browser.newContext({ viewport: { width, height: 850 }, colorScheme, reducedMotion: 'reduce' });
    const page = await context.newPage(), requests = [], failures = [];
    page.on('request', request => requests.push(request.url()));
    page.on('pageerror', error => failures.push(error.message));
    await page.goto(base); await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => ({
      client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
      heading: getComputedStyle(document.querySelector('h1')).fontSize,
      background: getComputedStyle(document.body).backgroundColor,
      logo: [...document.querySelectorAll('.mark svg path')].map(node => ({ fill: getComputedStyle(node).fill, stroke: getComputedStyle(node).stroke })),
      links: [...document.querySelectorAll('a')].map(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width }; }),
    }));
    assert.ok(layout.scroll <= layout.client + 1, `${width}/${colorScheme}: no horizontal page overflow`);
    assert.ok(Number.parseFloat(layout.heading) >= 30, 'the native project retains the authored heading scale');
    assert.equal(layout.background, colorScheme === 'dark' ? 'rgb(20, 19, 26)' : 'rgb(247, 245, 241)');
    assert.equal(layout.logo[0].fill, 'none'); assert.equal(layout.logo[1].stroke, 'none');
    assert.equal(layout.logo[1].fill, layout.logo[0].stroke, 'filled D and outlined bracket share the theme colour');
    for (const rect of layout.links) assert.ok(rect.width > 0 && rect.left >= -1 && rect.right <= width + 1, 'wrapped navigation and CTAs stay reachable');
    const icon = await page.locator('link[rel="icon"]').getAttribute('href');
    assert.match(icon, /^data:image\/svg\+xml;base64,/);
    assert.ok(await page.evaluate(src => new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0);
      image.onerror = () => resolve(false);
      image.src = src;
    }), icon), 'embedded favicon decodes without any source or cache asset file');
    await page.screenshot({ path: `artifacts/landing-native-${width}-${colorScheme}.png`, fullPage: true });
    for (const [label, id] of [['What it is', 'what'], ['How it works', 'how'], ['Formats', 'formats'], ['Get it', 'start'], ['Run it locally', 'start'], ['divlet', 'top']]) {
      await page.getByRole('link', { name: label, exact: true }).click();
      assert.equal(new URL(page.url()).pathname, '/divlet/'); assert.equal(new URL(page.url()).hash, `#${id}`);
      assert.ok(await page.locator(`#${id}`).evaluate(node => { const rect = node.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight; }), `${label}: actual target is in view`);
      assert.equal(await page.locator('h1').count(), 1, 'a fragment click never escapes to a missing resource route');
    }
    assert.deepEqual(failures, []);
    assert.ok(requests.every(url => url.startsWith(base) || url.startsWith('data:')), 'nothing depends on a remote font, image, script or root-only URL');
    checks.push(`${width}px ${colorScheme}: layout, themed mark, prefix favicon and real fragment clicks`);
    await context.close();
  }
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally {
  await browser?.close();
  server.close(); await once(server, 'close');
  await fs.rm(directory, { recursive: true, force: true });
}
