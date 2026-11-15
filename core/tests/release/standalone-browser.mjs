// Private installed-artifact acceptance: checkout supplies fixtures/tools, never product or vendor inputs.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { chromium } from 'playwright';
import { bundleBrowserStandaloneAssets, bundleBrowserProject } from '../../../scripts/browser-model.mjs';
import { standaloneAssetCases, captureStandalone } from '../fixtures/standalone-assets.js';

const at = process.argv.indexOf('--installed');
assert.ok(at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--'), '--installed requires an existing consumer');
assert.ok(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'installed checks require cleared source conditions/search paths');
const consumer = realpathSync(path.resolve(process.argv[at + 1]));
const modules = realpathSync(path.join(consumer, 'node_modules'));
const product = realpathSync(path.join(modules, '@divlet/core/dist'));
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
assert.ok(inside(consumer, modules) && inside(modules, product), 'installed dependency/product roots cannot link outside the consumer');
const entry = realpathSync(path.join(product, 'core/lib/standalone-assets.js'));
assert.ok(inside(product, entry));
const nodeCoreOnly = process.argv.includes('--node-core-only'), browserCoreOnly = process.argv.includes('--browser-core-only');
const nodeFiles = new Set();
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  const parent = context.parentURL?.startsWith('file:') && realpathSync(fileURLToPath(context.parentURL));
  const file = result.url.startsWith('file:') && realpathSync(fileURLToPath(result.url));
  if (parent && inside(modules, parent) && !result.url.startsWith('node:') && (!file || !inside(nodeCoreOnly ? product : modules, file))) {
    throw Object.assign(new Error(`Installed standalone dependency escaped: ${specifier}`), { code: 'INSTALLED_STANDALONE_DEPENDENCY_ESCAPE' });
  }
  if (file && inside(modules, file)) { assert.ok(!file.endsWith('.ts'), 'Node control executes installed emitted JS'); nodeFiles.add(file); }
  return result;
} });
const api = await import(pathToFileURL(entry).href);
const expected = await Promise.all(standaloneAssetCases.map(({ run }) => captureStandalone(api, run)));
for (let index = 0; index < standaloneAssetCases.length; index++) assert.deepEqual(expected[index], standaloneAssetCases[index].expected, standaloneAssetCases[index].name);
assert.ok(nodeFiles.size > 0);
const standalone = await bundleBrowserStandaloneAssets(consumer, { entry, source: false });
const project = await bundleBrowserProject(consumer, { workingDir: consumer });
assert.ok(project.inputs.some(file => /core\/lib\/browser-assets\.js$/.test(file)), 'installed project reader selects the fixed browser refusal port');
const disabled = new Set(['(disabled):node_modules/postcss/lib/terminal-highlight', '(disabled):path', '(disabled):node_modules/source-map-js/source-map.js', '(disabled):url', '(disabled):fs']);
const browserFiles = new Set();
for (const bundle of [standalone, project]) assert.ok(bundle.inputs.includes('<stdin>'), 'in-memory composition entry is explicitly virtual, not an exempt filesystem path');
for (const bundle of [standalone, project]) for (const input of bundle.inputs) {
  if (input.startsWith('(disabled):')) { assert.ok(disabled.has(input), 'only vendor-owned optional browser mappings are disabled'); continue; }
  if (input === '<stdin>') continue;
  const real = realpathSync(path.resolve(consumer, input));
  if (!inside(browserCoreOnly ? product : modules, real)) throw Object.assign(new Error(`Installed standalone browser input escaped: ${input}`), { code: 'INSTALLED_STANDALONE_BROWSER_ESCAPE' });
  assert.ok(!real.endsWith('.ts'), 'browser product inputs are installed emitted JS'); browserFiles.add(real);
}
const coreInputs = standalone.inputs.filter(file => !file.startsWith('(disabled):') && file !== '<stdin>').map(file => realpathSync(path.resolve(consumer, file))).filter(file => inside(product, file)).map(file => path.relative(product, file).split(path.sep).join('/'));
assert.deepEqual(coreInputs.sort(), ['asset-base64', 'asset-data', 'asset-reference', 'canonical-media-type', 'css-literals', 'resource-carriers', 'source-budget', 'standalone-assets', 'svg-resource-attributes', 'svg-resource', 'validation'].map(name => `core/lib/${name}.js`).sort());
const prefix = '/installed-export/';
const routes = new Map([
  [prefix, ['text/html', '<!doctype html><link rel="icon" href="data:,"><title>Installed standalone export</title>']],
  [`${prefix}exporter.js`, ['text/javascript', standalone.code]],
  [`${prefix}project.js`, ['text/javascript', project.code]],
  [`${prefix}cases.js`, ['text/javascript', await readFile(new URL('../fixtures/standalone-assets.js', import.meta.url), 'utf8')]],
]);
const serverRequests = [];
const server = http.createServer((request, response) => {
  serverRequests.push(request.url); const found = routes.get(request.url);
  if (!found) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': found[0], 'Cache-Control': 'no-store' }).end(found[1]);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const origin = `http://127.0.0.1:${server.address().port}`, allowed = [...routes.keys()].map(route => origin + route), observed = [], denied = [], errors = [];
  context.on('request', request => observed.push({ url: request.url(), method: request.method() }));
  await context.route('**/*', route => {
    const request = route.request();
    if (request.method() === 'GET' && allowed.includes(request.url())) return route.continue();
    denied.push(request.url()); return route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + prefix);
  const actual = await page.evaluate(async () => {
    const [api, fixtures, project] = await Promise.all(['exporter.js', 'cases.js', 'project.js'].map(file => import(new URL(file, location.href).href)));
    const vectors = await Promise.all(fixtures.standaloneAssetCases.map(({ run }) => fixtures.captureStandalone(api, run)));
    project.readProject({ schemaVersion: 1, frames: [] });
    let projectRefusal;
    try { project.readProject({ schemaVersion: 1, assets: { one: 'data:application/octet-stream;base64,AQID' }, frames: [] }); }
    catch (error) { projectRefusal = error.code; }
    const html = await api.inlineDeclaredAssets('<link rel="stylesheet" href="asset:paint.css"><img src="asset:pixel"><div class="standalone-proof"></div>', fixtures.standalonePaintAssets(), { fragment: true });
    const host = document.createElement('div'); host.innerHTML = html;
    const link = host.querySelector('link');
    const loaded = new Promise((resolve, reject) => { link.addEventListener('load', resolve, { once: true }); link.addEventListener('error', reject, { once: true }); });
    document.body.append(host); const image = host.querySelector('img'); await Promise.all([loaded, image.decode()]);
    const canvas = document.createElement('canvas'); canvas.width = 7; canvas.height = 9;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const rendering = { image: [image.naturalWidth, image.naturalHeight], padding: getComputedStyle(host.querySelector('.standalone-proof')).paddingLeft, background: getComputedStyle(host.querySelector('.standalone-proof')).backgroundImage.includes('data:image/svg+xml;base64,'), pixel: [...ctx.getImageData(3, 4, 1, 1).data] }; host.remove();
    return { vectors, rendering, projectRefusal, nodeGlobals: ['Buffer', 'process', 'require', '__dirname', '__filename'].filter(name => name in globalThis) };
  });
  assert.deepEqual(actual.vectors, expected, 'installed Node and Chromium execute the same emitted product');
  for (let index = 0; index < standaloneAssetCases.length; index++) assert.deepEqual(actual.vectors[index], standaloneAssetCases[index].expected, standaloneAssetCases[index].name);
  assert.deepEqual(actual.rendering, { image: [7, 9], padding: '17px', background: true, pixel: [18, 52, 86, 255] });
  assert.equal(actual.projectRefusal, 'ASSETS_UNAVAILABLE'); assert.deepEqual(actual.nodeGlobals, []); assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  assert.deepEqual(observed.filter(({ url }) => !url.startsWith('data:')).map(({ url, method }) => [url, method]).sort(), allowed.map(url => [url, 'GET']).sort());
  assert.deepEqual([...new Set(serverRequests)].sort(), [...routes.keys()].sort());
  const control = origin + prefix + 'unrequested';
  assert.equal(await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, control), true);
  assert.deepEqual(denied, [control]);
  console.log(JSON.stringify({ status: 'passed', mode: 'private installed standalone export in Chromium', nodeVersion: process.version, nodeImportsConfined: true, installedInputsConfined: true, nodeFileCount: nodeFiles.size, browserFileCount: browserFiles.size, vectors: actual.vectors.length, rendering: actual.rendering, projectRefusal: actual.projectRefusal, nodeGlobals: actual.nodeGlobals, bytes: standalone.bytes, projectBytes: project.bytes, requests: serverRequests }));
} finally { await browser?.close(); server.close(); await once(server, 'close'); hook.deregister(); }
