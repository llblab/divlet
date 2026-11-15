// Real browser execution of private renderer internals in source, workspace-build or installed modes; not a public SDK or board integration.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { registerHooks, findPackageJSON } from 'node:module';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const compiled = process.argv.includes('--compiled'), installedAt = process.argv.indexOf('--installed');
assert.ok(installedAt < 0 || (process.argv[installedAt + 1] && !process.argv[installedAt + 1].startsWith('--')), '--installed requires an existing consumer directory');
const installed = installedAt < 0 ? null : realpathSync(path.resolve(process.argv[installedAt + 1]));
assert.ok(!installed || !compiled, 'installed mode never uses the workspace build');
const checkout = fileURLToPath(new URL('../../../', import.meta.url)), workingDir = installed ?? checkout;
const nodeModules = installed && realpathSync(path.join(installed, 'node_modules'));
const product = installed ? realpathSync(path.join(nodeModules, '@divlet/core/dist')) : path.join(checkout, compiled ? 'dist' : '.');
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
const nodeCoreOnly = process.argv.includes('--node-core-only'), browserCoreOnly = process.argv.includes('--browser-core-only');
assert.ok(installed || !(nodeCoreOnly || browserCoreOnly), 'narrow-root refusal controls require installed mode');
if (installed) {
  assert.ok(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'installed mode requires cleared source conditions/search paths');
  assert.ok(inside(installed, nodeModules) && inside(nodeModules, product), 'the dependency directory and product must be installed, not linked outside the consumer');
}
const observedNodeFiles = new Set();
const nodeGuard = installed && registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  const parent = context.parentURL?.startsWith('file:') && fileURLToPath(context.parentURL);
  const file = result.url.startsWith('file:') && realpathSync(fileURLToPath(result.url));
  if (parent && inside(nodeModules, parent) && !result.url.startsWith('node:') && (!file || !inside(nodeCoreOnly ? product : nodeModules, file))) {
    throw Object.assign(new Error(`Installed renderer dependency escaped its allowed root: ${specifier}`), { code: 'INSTALLED_DEPENDENCY_ESCAPE' });
  }
  if (file && inside(nodeModules, file)) {
    assert.ok(!file.endsWith('.ts'), 'installed Node controls execute emitted JavaScript, never product source');
    observedNodeFiles.add(file);
  }
  return result;
} });
const extension = installed || compiled ? 'js' : 'ts';
const moduleFile = name => path.join(product, `plugins/tailwind/lib/${name}.${extension}`);
if (installed) for (const name of ['renderer', 'identity']) assert.ok(inside(nodeModules, realpathSync(moduleFile(name))), 'Node control entries cannot escape through links');
const { createRenderer } = await import(pathToFileURL(moduleFile('renderer')).href);
const { rendererSource } = await import(pathToFileURL(moduleFile('identity')).href);
const entryFiles = [moduleFile('compiler'), moduleFile('renderer-profile'), path.join(product, `core/lib/style-engines.${extension}`)];
const entry = entryFiles.map(file => `export * from ${JSON.stringify(file)};`).join('\n');
const bundle = await build({ absWorkingDir: workingDir, stdin: { contents: entry, resolveDir: workingDir }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', metafile: true, define: { 'process.env.NODE_ENV': '"production"' } });
const inputs = Object.keys(bundle.metafile.inputs);
assert.equal(Object.values(bundle.metafile.outputs).flatMap(output => output.imports).length, 0, 'no runtime dependency rescue');
assert.equal(inputs.some(file => /@tailwindcss\/node|plugins\/tailwind\/lib\/(?:styling|renderer|identity)\.(?:js|ts)$/.test(file)), false, 'no Node wrapper, identity discovery or provider bootstrap');
const productInputs = inputs.map(file => path.relative(product, path.resolve(workingDir, file)).split(path.sep).join('/'));
assert.ok(productInputs.filter(file => file.startsWith('core/')).every(file => /^core\/lib\/(?:style-engines|validation)\.(?:js|ts)$/.test(file)), 'only the portable registry/validation slice enters the test composition');
if (installed) for (const file of inputs.filter(file => !file.startsWith('(disabled):') && file !== '<stdin>')) {
  const real = realpathSync(path.resolve(workingDir, file));
  if (!inside(browserCoreOnly ? product : nodeModules, real)) throw Object.assign(new Error(`Installed browser renderer input escaped its allowed root: ${file}`), { code: 'INSTALLED_BROWSER_DEPENDENCY_ESCAPE' });
  assert.ok(!/\.ts$/.test(real), 'installed browser inputs are emitted JavaScript, never product source');
}
const disabled = inputs.filter(file => file.startsWith('(disabled):'));
const vendorMappings = new Set(['(disabled):node_modules/postcss/lib/terminal-highlight', '(disabled):path', '(disabled):node_modules/source-map-js/source-map.js', '(disabled):url', '(disabled):fs']);
assert.ok(disabled.every(file => vendorMappings.has(file)), 'only the declared vendor browser mappings may disable optional host branches');
const source = rendererSource(), candidates = ['p-[37px]', 'md:p-[41px]', 'text-brand', 'data-[state=on]:opacity-25'], tokens = { '--color-brand': '#123456' };
const nodeRenderer = createRenderer(), expectedCss = await nodeRenderer.compileClasses(tokens, candidates), requests = [];
assert.equal(nodeRenderer.version, source.version);
if (installed) {
  const manifest = findPackageJSON('tailwindcss', pathToFileURL(moduleFile('identity')));
  assert.ok(inside(nodeModules, realpathSync(manifest)), 'stylesheet discovery stays in the installed consumer');
  for (const name of Object.keys(source.stylesheets)) assert.ok(inside(nodeModules, realpathSync(path.join(path.dirname(manifest), name))), 'captured stylesheet files cannot escape through links');
  assert.ok(observedNodeFiles.size > 0, 'the Node import guard observed installed product execution');
}
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
  const actual = await page.evaluate(async ({ source, tokens, candidates }) => {
    const api = await import('/compiler.js'), { createCompiler, createRendererFromSource } = api, styles = source.stylesheets;
    const mutable = { version: source.version, stylesheets: { ...styles } }, provider = createRendererFromSource(mutable);
    mutable.version = 'changed-after-capture'; mutable.stylesheets['index.css'] = '@plugin "unrequested";';
    let fallbackCalls = 0;
    const fallback = { id: 'default-probe', compileClasses: async () => { fallbackCalls++; return 'unwanted fallback CSS'; } };
    api.setStyleEngines([fallback, provider]);
    const required = { id: provider.id, version: provider.version }, compile = (tokens, candidates) => api.compileClasses(tokens, candidates, 'untrusted-consumer-base', required);
    const exact = api.resolveStyleEngine(required) === provider && provider.version === source.version && Object.isFrozen(provider);
    const selectionRefusals = [];
    for (const requirement of [{ id: 'missing', version: source.version }, { ...required, version: 'unknown-policy' }]) {
      try { await api.compileClasses(tokens, candidates, undefined, requirement); selectionRefusals.push('accepted'); }
      catch (error) { selectionRefusals.push(error.code); }
    }
    const native = await api.compileClasses(tokens, candidates, undefined, null);
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
      try { await createCompiler({ ...styles, 'index.css': source })({}, ['block']); refusals.push('accepted'); }
      catch (error) { refusals.push(error.code); }
    }
    const inert = await createCompiler({ ...styles, 'index.css': `/*!# sourceMappingURL=data:application/json;base64,not-a-map */\n.probe::before{content:'@import "https://unrequested.invalid/literal.css";'}\n${styles['index.css']}` })({}, ['block']);
    return { css, before, normal, onOpacity, isolated, refusals, exact, selectionRefusals, native, fallbackCalls, defaultUnchanged: api.styleEngine() === fallback, version: provider.version, inert: inert.includes('unrequested.invalid/literal.css'), unchanged: JSON.stringify({ styles, tokens, candidates }) === beforeInput, nodeGlobals: ['process', 'Buffer', 'require', '__dirname', '__filename'].filter(key => key in globalThis) };
  }, { source, tokens, candidates });
  assert.equal(actual.before, '0px', 'the utility was not supplied by a prepared snapshot');
  assert.deepEqual(actual.normal, { padding: '37px', color: 'rgb(18, 52, 86)', opacity: '1' });
  assert.equal(actual.onOpacity, '0.25', 'the emitted variant selector matches the actual literal class');
  await page.setViewportSize({ width: 900, height: 500 });
  assert.equal(await page.locator('main').evaluate(element => getComputedStyle(element).paddingLeft), '41px');
  assert.equal(actual.css, expectedCss, 'the declared Node/browser profiles execute the same captured-source kernel');
  assert.equal(actual.exact && actual.defaultUnchanged, true);
  assert.deepEqual(actual.selectionRefusals, ['STYLE_ENGINE_UNAVAILABLE', 'STYLE_ENGINE_VERSION_MISMATCH']);
  assert.equal(actual.native, ''); assert.equal(actual.fallbackCalls, 0);
  assert.equal(actual.version, source.version);
  assert.equal(actual.isolated && actual.inert && actual.unchanged, true);
  assert.deepEqual(actual.refusals, ['TAILWIND_COMPILER_STYLESHEET_UNAVAILABLE', 'TAILWIND_COMPILER_STYLESHEET_UNAVAILABLE', 'TAILWIND_COMPILER_STYLESHEET_UNAVAILABLE', 'TAILWIND_COMPILER_MODULE_UNAVAILABLE', 'TAILWIND_COMPILER_MODULE_UNAVAILABLE', 'TAILWIND_COMPILER_SOURCE_UNSUPPORTED', 'TAILWIND_COMPILER_SOURCE_UNSUPPORTED']);
  assert.deepEqual(actual.nodeGlobals, []);
  assert.deepEqual([...new Set(requests)].sort(), ['/', '/compiler.js'], 'only the declared local routes were requested');
  assert.deepEqual(browserRequests, [{ url: `${origin}/`, method: 'GET', type: 'document' }, { url: `${origin}/compiler.js`, method: 'GET', type: 'script' }], 'browser-wide observation also detects blocked out-of-origin or nonstatic requests');
  console.log(JSON.stringify({ status: 'passed', mode: installed ? 'private installed-package bundle in Chromium' : compiled ? 'private compiled-workspace bundle in Chromium' : 'private source-bundle in Chromium', ...(installed ? { installedInputsConfined: true, nodeImportsConfined: true, nodeFileCount: observedNodeFiles.size } : {}), bytes: bundle.outputFiles[0].contents.length, inputs: inputs.length, vendorBrowserMappings: disabled, newUtility: actual.normal, responsivePadding: '41px', stateOpacity: actual.onOpacity, sharedProfile: actual.version, nodeCssEqual: true, selectionRefusals: actual.selectionRefusals, nativeCss: actual.native, fallbackCalls: actual.fallbackCalls, refusals: actual.refusals, nodeGlobals: actual.nodeGlobals, requests, browserRequests: browserRequests.map(({ url, ...request }) => ({ ...request, path: new URL(url).pathname })) }, null, 2));
} finally { await browser?.close(); server.close(); await once(server, 'close'); nodeGuard?.deregister(); }
