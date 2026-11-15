// Real browser execution of the private compiler slice, not installed-package, versioned-provider or board integration evidence.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { browserStylesheets } from './fixtures/browser-stylesheets.js';

const compiled = process.argv.includes('--compiled');
const { createRenderer } = await import(compiled ? '../../../dist/plugins/tailwind/lib/renderer.js' : '../lib/renderer.ts');
const entry = compiled ? './dist/plugins/tailwind/lib/browser-compiler.js' : './plugins/tailwind/lib/browser-compiler.ts';
const bundle = await build({ stdin: { contents: `export * from '${entry}';`, resolveDir: fileURLToPath(new URL('../../../', import.meta.url)) }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', metafile: true, define: { 'process.env.NODE_ENV': '"production"' } });
const inputs = Object.keys(bundle.metafile.inputs);
assert.equal(Object.values(bundle.metafile.outputs).flatMap(output => output.imports).length, 0, 'no runtime dependency rescue');
assert.equal(inputs.some(file => /@tailwindcss\/node|plugins\/tailwind\/lib\/(?:styling|renderer)|core\//.test(file)), false, 'no Node wrapper, provider bootstrap or core/host imports');
const disabled = inputs.filter(file => file.startsWith('(disabled):'));
const vendorMappings = new Set(['(disabled):node_modules/postcss/lib/terminal-highlight', '(disabled):path', '(disabled):node_modules/source-map-js/source-map.js', '(disabled):url', '(disabled):fs']);
assert.ok(disabled.every(file => vendorMappings.has(file)), 'only the declared vendor browser mappings may disable optional host branches');
const styles = await browserStylesheets(), candidates = ['p-[37px]', 'md:p-[41px]', 'text-brand', 'data-[state=on]:opacity-25'], tokens = { '--color-brand': '#123456' };
const expectedCss = await createRenderer().compileClasses(tokens, candidates), requests = [];
const server = http.createServer((request, response) => {
  requests.push(request.url);
  if (request.url === '/') response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><link rel="icon" href="data:,"><main>New classes, no prepared CSS</main>');
  else if (request.url === '/compiler.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].text);
  else response.writeHead(404).end();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 500, height: 500 }, serviceWorkers: 'block' });
  const origin = `http://127.0.0.1:${server.address().port}`, browserRequests = [];
  page.context().on('request', request => browserRequests.push({ url: request.url(), method: request.method(), type: request.resourceType() }));
  await page.context().route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    const allowed = request.method() === 'GET' && url.origin === origin && !url.search && ((url.pathname === '/' && request.resourceType() === 'document') || (url.pathname === '/compiler.js' && request.resourceType() === 'script'));
    return allowed ? route.continue() : route.abort();
  });
  await page.goto(`${origin}/`);
  const actual = await page.evaluate(async ({ styles, tokens, candidates }) => {
    const { createBrowserCompiler } = await import('/compiler.js'), compile = createBrowserCompiler(styles);
    Object.freeze(tokens); Object.freeze(candidates);
    const beforeInput = JSON.stringify({ styles, tokens, candidates }), element = document.querySelector('main');
    element.className = candidates.join(' ');
    const before = getComputedStyle(element).paddingLeft, css = await compile(tokens, candidates);
    const style = document.createElement('style'); style.id = 'compiled'; style.textContent = css; document.head.append(style);
    const normal = { padding: getComputedStyle(element).paddingLeft, color: getComputedStyle(element).color, opacity: getComputedStyle(element).opacity };
    element.dataset.state = 'on';
    const onOpacity = getComputedStyle(element).opacity;
    const [first, second] = await Promise.all([compile({}, ['p-[37px]']), compile({}, ['p-[19px]'])]);
    const isolated = first.includes('37px') && !first.includes('19px') && second.includes('19px') && !second.includes('37px');
    const refusals = [];
    for (const source of ['@import "https://unrequested.invalid/source.css";', String.raw`@\69mport "https://unrequested.invalid/source.css";`, '@import "../unrequested.css";', '@plugin "unrequested-plugin";', '@config "./unrequested.js";', '@source "./unrequested/**/*";', '@source inline("p-[37px]");']) {
      try { await createBrowserCompiler({ ...styles, 'index.css': source })({}, ['block']); refusals.push('accepted'); }
      catch (error) { refusals.push(error.code); }
    }
    const inert = await createBrowserCompiler({ ...styles, 'index.css': `/*!# sourceMappingURL=data:application/json;base64,not-a-map */\n.probe::before{content:'@import "https://unrequested.invalid/literal.css";'}\n${styles['index.css']}` })({}, ['block']);
    return { css, before, normal, onOpacity, isolated, refusals, inert: inert.includes('unrequested.invalid/literal.css'), unchanged: JSON.stringify({ styles, tokens, candidates }) === beforeInput, nodeGlobals: ['process', 'Buffer', 'require', '__dirname', '__filename'].filter(key => key in globalThis) };
  }, { styles, tokens, candidates });
  assert.equal(actual.before, '0px', 'the utility was not supplied by a prepared snapshot');
  assert.deepEqual(actual.normal, { padding: '37px', color: 'rgb(18, 52, 86)', opacity: '1' });
  assert.equal(actual.onOpacity, '0.25', 'the emitted variant selector matches the actual literal class');
  await page.setViewportSize({ width: 900, height: 500 });
  assert.equal(await page.locator('main').evaluate(element => getComputedStyle(element).paddingLeft), '41px');
  assert.equal(actual.css, expectedCss, 'finite selected Node/browser output equality, not a compatibility identity');
  assert.equal(actual.isolated && actual.inert && actual.unchanged, true);
  assert.deepEqual(actual.refusals, ['TAILWIND_BROWSER_STYLESHEET_UNAVAILABLE', 'TAILWIND_BROWSER_STYLESHEET_UNAVAILABLE', 'TAILWIND_BROWSER_STYLESHEET_UNAVAILABLE', 'TAILWIND_BROWSER_MODULE_UNAVAILABLE', 'TAILWIND_BROWSER_MODULE_UNAVAILABLE', 'TAILWIND_BROWSER_SOURCE_UNSUPPORTED', 'TAILWIND_BROWSER_SOURCE_UNSUPPORTED']);
  assert.deepEqual(actual.nodeGlobals, []);
  assert.deepEqual([...new Set(requests)].sort(), ['/', '/compiler.js'], 'only the declared local routes were requested');
  assert.deepEqual(browserRequests, [{ url: `${origin}/`, method: 'GET', type: 'document' }, { url: `${origin}/compiler.js`, method: 'GET', type: 'script' }], 'browser-wide observation also detects blocked out-of-origin or nonstatic requests');
  console.log(JSON.stringify({ status: 'passed', mode: compiled ? 'private compiled-workspace bundle in Chromium' : 'private source-bundle in Chromium', bytes: bundle.outputFiles[0].contents.length, inputs: inputs.length, vendorBrowserMappings: disabled, newUtility: actual.normal, responsivePadding: '41px', stateOpacity: actual.onOpacity, finiteNodeCssEqual: true, refusals: actual.refusals, nodeGlobals: actual.nodeGlobals, requests, browserRequests: browserRequests.map(({ url, ...request }) => ({ ...request, path: new URL(url).pathname })) }, null, 2));
} finally { await browser?.close(); server.close(); await once(server, 'close'); }
