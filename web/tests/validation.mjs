// Real browser ESM executes the shared core admission code; this is not a browser-only validator or an API mock.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import * as nodeModel from '../../core/lib/model.ts';
import { captureFrame, frameCases } from '../../core/tests/fixtures/frame-portability.js';
import { bundleBrowserModel } from '../../scripts/browser-model.mjs';
import { landingDemoSnapshot } from '../../scripts/landing-demo.mjs';

const prefix = '/divlet-kernel/';
const bundle = await bundleBrowserModel(fileURLToPath(new URL('../../', import.meta.url)), { source: true });
const expectedFrames = frameCases.map(({ name, run }) => ({ name, result: captureFrame(nodeModel, run) }));
const publicSnapshot = await landingDemoSnapshot();
const files = new Map([
  [prefix, ['text/html', '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Portable validation</title>']],
  [`${prefix}validation.ts`, ['text/javascript', stripTypeScriptTypes(await readFile(new URL('../../core/lib/validation.ts', import.meta.url), 'utf8'))]],
  [`${prefix}asset-reference.ts`, ['text/javascript', stripTypeScriptTypes(await readFile(new URL('../../core/lib/asset-reference.ts', import.meta.url), 'utf8'))]],
  [`${prefix}asset-cases.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/asset-references.js', import.meta.url), 'utf8')]],
  [`${prefix}cases.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/validation.js', import.meta.url), 'utf8')]],
  [`${prefix}model.js`, ['text/javascript', bundle.code]],
  [`${prefix}frames.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/frame-portability.js', import.meta.url), 'utf8')]],
  [`${prefix}read-session.js`, ['text/javascript', stripTypeScriptTypes(await readFile(new URL('../../core/lib/board-session.ts', import.meta.url), 'utf8'))]],
  [`${prefix}session-cases.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/board-session.js', import.meta.url), 'utf8')]],
  [`${prefix}public-snapshot.json`, ['application/json', JSON.stringify({ state: publicSnapshot.state, frames: [...publicSnapshot.frames] })]],
]);
const [storeSource, utilSource, selectionHost, selectionCases] = await Promise.all([
  readFile(new URL('../lib/store.js', import.meta.url), 'utf8'), readFile(new URL('../lib/util.js', import.meta.url), 'utf8'),
  readFile(new URL('./fixtures/selection-host.js', import.meta.url), 'utf8'), readFile(new URL('./fixtures/selection-cases.js', import.meta.url), 'utf8'),
]);
files.set(`${prefix}selection-cases.js`, ['text/javascript', selectionCases]);
for (const mode of ['local', 'shared']) {
  files.set(`${prefix}${mode}/store.js`, ['text/javascript', storeSource]);
  files.set(`${prefix}${mode}/util.js`, ['text/javascript', utilSource]);
  files.set(`${prefix}${mode}/host.js`, ['text/javascript', selectionHost]);
}
const [activitySource, projectSource, servicesHost, servicesCases] = await Promise.all([
  readFile(new URL('../lib/activity.js', import.meta.url), 'utf8'), readFile(new URL('../lib/project.js', import.meta.url), 'utf8'),
  readFile(new URL('./fixtures/services-host.js', import.meta.url), 'utf8'), readFile(new URL('./fixtures/services-cases.js', import.meta.url), 'utf8'),
]);
files.set(`${prefix}services-cases.js`, ['text/javascript', servicesCases]);
const pickerSource = await readFile(new URL('../lib/file-picker.js', import.meta.url), 'utf8');
for (const mode of ['absent', 'audit', 'services']) {
  for (const [file, source] of Object.entries({ 'store.js': storeSource, 'util.js': utilSource, 'host.js': servicesHost, 'selection-host.js': selectionHost, 'activity.js': activitySource, 'project.js': projectSource, 'file-picker.js': pickerSource,
    'canvas.js': 'export const reveal = () => {}; export const flashNodes = () => {};',
    'sidebar.js': 'export const isOpen = () => true; export const toggle = () => {}; export const show = () => {}; export const close = () => {};',
    'chat.js': 'export const render = () => {}; export const note = () => {};',
  })) files.set(`${prefix}${mode}/${file}`, ['text/javascript', source]);
}
const requests = [];
const server = http.createServer((request, response) => {
  requests.push(request.url);
  const file = files.get(request.url);
  if (!file) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': file[0], 'Cache-Control': 'no-store' }).end(file[1]);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.PI_DIVLET_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}${prefix}`);
  const result = await page.evaluate(async () => {
    const [api, { validationCases, utf8BudgetCases, captureValidation }, frameApi, { frameCases, captureFrame, sampleFrame }] = await Promise.all([
      import(new URL('validation.ts', location.href).href), import(new URL('cases.js', location.href).href),
      import(new URL('model.js', location.href).href), import(new URL('frames.js', location.href).href),
    ]);
    const [{ createSnapshotReadSession }, { snapshotCases }] = await Promise.all([
      import(new URL('read-session.js', location.href).href), import(new URL('session-cases.js', location.href).href),
    ]);
    const [assetApi, { assetReferenceCases }] = await Promise.all([
      import(new URL('asset-reference.ts', location.href).href), import(new URL('asset-cases.js', location.href).href),
    ]);
    const referenceApi = { ...assetApi, DivletError: api.DivletError };
    const references = assetReferenceCases.map(({ name, run, expected }) => ({ name, actual: run(referenceApi), expected }));
    const sessions = [];
    for (const { name, run, expected } of snapshotCases) sessions.push({ name, actual: await run(createSnapshotReadSession), expected });
    const data = await (await fetch(new URL('public-snapshot.json', location.href))).json();
    const publicReader = createSnapshotReadSession({ state: data.state, frames: new Map(data.frames) });
    const publicState = await publicReader.readState(), publicFrame = await publicReader.readFrame('index');
    frameApi.validateDocument(publicFrame);
    const publicPage = { projectId: publicState.projectId, keys: Object.keys(publicState), descriptor: publicState.documents[0], capabilities: publicState.project.capabilities, nodes: Object.keys(publicFrame.nodes).length, metadataEmpty: Object.keys(publicFrame.metadata).length === 0 && Object.values(publicFrame.nodes).every(node => Object.keys(node.metadata).length === 0), versionMatches: publicFrame.version === publicState.documents[0].version };
    const [local, localHost, shared, sharedHost, { selectionCases }] = await Promise.all(['local/store.js', 'local/host.js', 'shared/store.js', 'shared/host.js', 'selection-cases.js'].map(path => import(new URL(path, location.href).href)));
    const selection = await selectionCases(local, localHost, shared, sharedHost);
    const { serviceCases } = await import(new URL('services-cases.js', location.href).href);
    const services = await serviceCases();
    return {
      selection,
      references,
      services,
      publicPage,
      sessions,
      nodeGlobals: ['Buffer', 'process', 'require'].filter(name => name in globalThis),
      cases: validationCases.map(({ name, run, expected }) => ({ name, actual: captureValidation(api, run), expected })),
      bytes: utf8BudgetCases.map(({ name, text, max, expected }) => ({ name, actual: api.withinUtf8Budget(text, max), expected })),
      frames: frameCases.map(({ name, run }) => ({ name, result: captureFrame(frameApi, run) })),
      lowering: captureFrame(frameApi, api => api.applyDocumentPatch(sampleFrame(), { nodes: { root: { styles: { color: 'red' } } } })),
    };
  });
  assert.deepEqual(result.nodeGlobals, [], 'no Node globals/polyfills supply the kernel');
  assert.ok(result.cases.length > 25, 'the shared acceptance/refusal regions are exercised');
  for (const { name, actual, expected } of [...result.cases, ...result.bytes, ...result.references, ...result.sessions, ...result.selection, ...result.services]) assert.deepEqual(actual, expected, name);
  assert.deepEqual(result.frames, expectedFrames, 'the same full-frame validation, patch and inspection semantics run in Node and browser');
  assert.deepEqual(result.publicPage.keys.sort(), ['clientPlugins', 'diagnostics', 'documents', 'project', 'projectId', 'revision', 'selection', 'stateVersion', 'work']);
  assert.equal(result.publicPage.descriptor.viewUrl, 'index.html');
  assert.equal(result.publicPage.metadataEmpty && result.publicPage.versionMatches, true);
  assert.ok(result.publicPage.nodes > 100);
  assert.deepEqual(Object.values(result.publicPage.capabilities), [false, false, false, false]);
  assert.deepEqual(result.lowering, { ok: false, code: 'NO_STYLE_ENGINE', name: 'Error', message: 'No style engine is installed, so applyStyles is unavailable (the project still renders with its own CSS).', domainError: false });
  assert.deepEqual([...new Set(requests)].sort(), [...files.keys()].sort(), 'only static module/fixture bytes are served; no API, SSE or dependency rescue');
  assert.deepEqual(errors, []);
  console.log(`PASS: ${result.cases.length} admission + ${result.bytes.length} UTF-8 + ${result.frames.length} frame + ${result.references.length} asset-reference + ${result.sessions.length} snapshot-session witnesses + ${result.selection.length} actual-store selection checks + ${result.services.length} optional-service consumer checks + verified public landing data in native browser ESM; no Node globals, provider bootstrap or backend API (${bundle.bytes} model bytes)`);
} finally {
  await browser?.close();
  server.close();
  await once(server, 'close');
}
