// Real browser ESM executes the shared core admission code; this is not a browser-only validator or an API mock.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import * as nodeModel from '../../core/lib/model.ts';
import { captureFrame, frameCases, resourceFrame } from '../../core/tests/fixtures/frame-portability.js';
import { prepareFrame } from '../../core/lib/render.ts';
import { bundleBrowserModel, bundleBrowserCodec, bundleBrowserProject } from '../../scripts/browser-model.mjs';
import { cssAnnotationCases } from '../../core/tests/fixtures/css-annotations.js';
import { landingDemoSnapshot } from '../../scripts/landing-demo.mjs';
import { buildStatic } from '../../core/lib/static.js';
import { svgResourceCases } from '../../core/tests/fixtures/svg-resources.js';

const prefix = '/divlet-kernel/';
const bundle = await bundleBrowserModel(fileURLToPath(new URL('../../', import.meta.url)), { source: true });
const codecBundle = await bundleBrowserCodec(fileURLToPath(new URL('../../', import.meta.url)), { source: true });
const projectBundle = await bundleBrowserProject(fileURLToPath(new URL('../../', import.meta.url)), { source: true });
const expectedFrames = frameCases.map(({ name, run }) => ({ name, result: captureFrame(nodeModel, run) }));
const publicSnapshot = await landingDemoSnapshot();
const files = new Map([
  [prefix, ['text/html', '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Portable validation</title>']],
  [`${prefix}validation.ts`, ['text/javascript', stripTypeScriptTypes(await readFile(new URL('../../core/lib/validation.ts', import.meta.url), 'utf8'))]],
  [`${prefix}declarations.ts`, ['text/javascript', stripTypeScriptTypes(await readFile(new URL('../../core/lib/declarations.ts', import.meta.url), 'utf8'))]],
  [`${prefix}requirements.ts`, ['text/javascript', stripTypeScriptTypes(await readFile(new URL('../../core/lib/requirements.ts', import.meta.url), 'utf8'))]],
  [`${prefix}requirement-cases.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/requirements.js', import.meta.url), 'utf8')]],
  [`${prefix}asset-reference.ts`, ['text/javascript', stripTypeScriptTypes(await readFile(new URL('../../core/lib/asset-reference.ts', import.meta.url), 'utf8'))]],
  [`${prefix}asset-cases.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/asset-references.js', import.meta.url), 'utf8')]],
  [`${prefix}cases.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/validation.js', import.meta.url), 'utf8')]],
  [`${prefix}json-cases.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/native-json.js', import.meta.url), 'utf8')]],
  [`${prefix}value-cases.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/native-values.js', import.meta.url), 'utf8')]],
  [`${prefix}model.js`, ['text/javascript', bundle.code]],
  [`${prefix}codec.js`, ['text/javascript', codecBundle.code]],
  [`${prefix}project.js`, ['text/javascript', projectBundle.code]],
  [`${prefix}component-text.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/component-text.js', import.meta.url), 'utf8')]],
  [`${prefix}css-annotations.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/css-annotations.js', import.meta.url), 'utf8')]],
  [`${prefix}inline-css-cases.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/inline-css.js', import.meta.url), 'utf8')]],
  [`${prefix}frames.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/frame-portability.js', import.meta.url), 'utf8')]],
  [`${prefix}read-session.js`, ['text/javascript', stripTypeScriptTypes(await readFile(new URL('../lib/board-session.ts', import.meta.url), 'utf8'))]],
  [`${prefix}session-cases.js`, ['text/javascript', await readFile(new URL('./fixtures/board-session.js', import.meta.url), 'utf8')]],
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
const dataUrl = (value, mime) => `data:${mime};base64,${Buffer.from(value).toString('base64')}`;
const nativeImage = await prepareFrame({ ...resourceFrame('img', { src: 'asset:icon' }), id: 'native-image', head: { icon: 'asset:icon' } });
const nativeUse = await prepareFrame({ ...resourceFrame('use', { href: 'asset:icon#mark' }, true), id: 'native-use' });
const proof = await buildStatic({ projectDir: '/no-original-resources', assets: {
  styles: { 'main.css': dataUrl('@IMPORT "other.css";', 'text/css'), 'other.css': dataUrl('.asset-proof{color:#123}', 'text/css') },
  icon: dataUrl('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><title aria-label="&lt;brand&gt;" data-line="one&#10;two">&#160;</title><rect id="mark" width="20" height="20" fill="#123"/></svg>', 'image/svg+xml'),
}, frames: new Map([['asset-proof', '<link rel="stylesheet" href="asset:styles/main.css"><p class="asset-proof">proof</p><img src="asset:icon">'], ['native-image', nativeImage.fileHtml], ['native-use', nativeUse.fileHtml]]) });
for (const [name, body] of proof.files) files.set(`${prefix}${name}`, [proof.mediaTypes.get(name) || 'text/html', body]);
const svgProfile = [];
for (const { name, text, accepted, expectedText } of svgResourceCases) {
  try {
    const prepared = await buildStatic({ projectDir: '/no-original-resources', assets: { icon: dataUrl(text, 'image/svg+xml') }, frames: new Map([['proof', '<img src="asset:icon">']]) });
    assert.equal(accepted, true, name);
    svgProfile.push({ name, xml: prepared.files.get('assets/icon'), expectedText: expectedText ?? null });
  } catch (error) { assert.equal(accepted, false, name); assert.equal(error.code, 'INVALID_ASSET', name); }
}
files.set(`${prefix}svg-profile.json`, ['application/json', JSON.stringify(svgProfile)]);
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
    const [requirements, { requirementCases, captureRequirements }] = await Promise.all(['requirements.ts', 'requirement-cases.js'].map(file => import(new URL(file, location.href).href)));
    const requirementApi = { ...requirements, DivletError: api.DivletError };
    const requirementResults = requirementCases.map(({ name, input, expected, error }) => ({ name, actual: captureRequirements(requirementApi, input), expected: error ? { ok: false, code: error, domainError: true } : { ok: true, value: expected } }));
    const { nativeJsonCases, captureNativeJson } = await import(new URL('json-cases.js', location.href).href);
    const nativeJson = nativeJsonCases.map(({ name, text, limits, expected }) => ({ name, actual: captureNativeJson(api, text, limits), expected }));
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
    const { serializeDeclarations } = await import(new URL('declarations.ts', location.href).href);
    const declarations = frameApi.validDeclarations([['padding-left', '20px'], ['padding', '10px']], 'root');
    const orderedCssPadding = [declarations, [...declarations].reverse()].map(value => {
      const element = document.createElement('div');
      element.style.cssText = serializeDeclarations(value);
      document.body.append(element);
      const padding = getComputedStyle(element).paddingLeft;
      element.remove();
      return padding;
    });
    const { nativeValueCases, nativeEqualityCases, captureNativeValue } = await import(new URL('value-cases.js', location.href).href);
    const nativeValues = nativeValueCases.map(({ name, input, limits, expected }) => ({ name, actual: captureNativeValue(api, input(), limits), expected }));
    const nativeEquality = nativeEqualityCases.map(({ name, a, b, expected }) => ({ name, actual: api.sameNativeJson(a(), b()), expected }));
    let deepValue = -0;
    for (let index = 0; index < 10000; index++) deepValue = [deepValue];
    const deepCopy = api.normalizeNativeJson(deepValue, { nodes: 10001, nesting: 10000 });
    const deepNativeEqual = api.sameNativeJson(deepValue, deepCopy);
    const [project, { componentTextCases }] = await Promise.all(['project.js', 'component-text.js'].map(file => import(new URL(file, location.href).href)));
    const componentTexts = componentTextCases.map(({ name, run, expected, error }) => {
      let actual;
      try { actual = { value: run(project) }; } catch (cause) { actual = { error: cause.code || cause.message }; }
      return { name, actual, expected: error ? { error } : { value: expected } };
    });
    const [codec, { cssAnnotationCases }] = await Promise.all(['codec.js', 'css-annotations.js'].map(file => import(new URL(file, location.href).href)));
    const { inlineCssCases, captureInlineCss } = await import(new URL('inline-css-cases.js', location.href).href);
    const inlineCss = inlineCssCases.map(({ name, input, expected }) => ({ name, actual: captureInlineCss(codec, input), expected }));
    const parsedCssRendering = [
      ['padding-left:20px;padding:10px', 'padding-left'],
      ['padding:10px;padding-left:20px', 'padding-left'],
      ['display:grid;display:not-a-layout', 'display'],
      ['color:red!important;color:blue', 'color'],
    ].map(([text, property]) => {
      const element = document.createElement('div');
      element.style.cssText = serializeDeclarations(frameApi.validDeclarations(codec.parseInlineDeclarations(text), 'root'));
      document.body.append(element);
      const value = getComputedStyle(element).getPropertyValue(property);
      element.remove(); return value;
    });
    const draftDuplicateRefusal = (() => { try { codec.decodeHtml('<main style="color:red;color:blue"></main>'); return 'accepted'; } catch (error) { return error.code; } })();
    const cssAnnotations = cssAnnotationCases.map(({ name, literal, comment, html }) => {
      const inline = codec.decodeHtml(html), pasted = codec.htmlToSpecs(html);
      const frame = frameApi.validateDocument({ ...inline, tokens: { '--note': literal }, css: `.note{content:${literal}}${comment}` });
      const reopened = codec.decodeHtml(codec.encodeHtml(frame));
      const refusals = [`<main style='color:red;${comment}'></main>`, `<style data-divlet-tokens>:root{--note:red;${comment}}</style><main></main>`].map(source => {
        try { codec.decodeHtml(source); return 'accepted'; } catch (error) { return error.code; }
      });
      const element = document.createElement('span'); element.style.content = literal; document.body.append(element);
      const computed = getComputedStyle(element).content; element.remove();
      return { name, inline: inline.nodes[inline.rootId].style.content, pasted: pasted[0].style.content, frame, reopened, refusals, computed };
    });
    return {
      componentTexts,
      inlineCss,
      parsedCssRendering,
      draftDuplicateRefusal,
      nativeValues,
      nativeEquality,
      deepNativeEqual,
      cssAnnotations,
      orderedCssPadding,
      requirements: requirementResults,
      nativeJson,
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
  const assetProof = await page.evaluate(async () => {
    const iframe = document.createElement('iframe');
    const loaded = new Promise((resolve, reject) => { iframe.onload = resolve; iframe.onerror = reject; });
    iframe.src = new URL('asset-proof.html', location.href).href; document.body.append(iframe); await loaded;
    const childDocument = iframe.contentDocument, image = childDocument.querySelector('img'); await image.decode();
    const xml = new DOMParser().parseFromString(await (await fetch(new URL('assets/icon', location.href))).text(), 'image/svg+xml');
    const result = { color: iframe.contentWindow.getComputedStyle(childDocument.querySelector('.asset-proof')).color, imageWidth: image.naturalWidth, xmlErrors: xml.querySelectorAll('parsererror').length, title: xml.querySelector('title')?.textContent, label: xml.querySelector('title')?.getAttribute('aria-label'), line: xml.querySelector('title')?.getAttribute('data-line') };
    iframe.remove(); return result;
  });
  const nativeResources = await page.evaluate(async () => {
    const results = [];
    for (const name of ['native-image', 'native-use']) {
      const iframe = document.createElement('iframe');
      const loaded = new Promise((resolve, reject) => { iframe.onload = resolve; iframe.onerror = reject; });
      iframe.src = new URL(`${name}.html`, location.href).href; document.body.append(iframe); await loaded;
      const childDocument = iframe.contentDocument;
      if (name === 'native-image') {
        const image = childDocument.querySelector('img'); await image.decode();
        results.push({ name, width: image.naturalWidth, icon: childDocument.querySelector('link[rel="icon"]').getAttribute('href') });
      } else {
        const use = childDocument.querySelector('use');
        for (let i = 0; i < 100 && !use.getBBox().width; i++) await new Promise(resolve => setTimeout(resolve, 20));
        results.push({ name, width: use.getBBox().width, href: use.getAttribute('href') });
      }
      iframe.remove();
    }
    return results;
  });
  assert.deepEqual(nativeResources, [{ name: 'native-image', width: 20, icon: 'assets/icon' }, { name: 'native-use', width: 20, href: 'assets/icon#mark' }], 'native validated models survive strict preparation, declared closure and real browser image/SVG-use loading');
  const svgProfileResults = await page.evaluate(async () => (await (await fetch(new URL('svg-profile.json', location.href))).json()).map(({ name, xml, expectedText }) => {
    const parsed = new DOMParser().parseFromString(xml, 'image/svg+xml');
    return { name, errors: parsed.querySelectorAll('parsererror').length, textMatches: expectedText === null || parsed.querySelector('text')?.textContent === expectedText };
  }));
  for (const row of svgProfileResults) assert.deepEqual(row, { name: row.name, errors: 0, textMatches: true }, row.name);
  assert.deepEqual(assetProof, { color: 'rgb(17, 34, 51)', imageWidth: 20, xmlErrors: 0, title: '\u00a0', label: '<brand>', line: 'one\ntwo' }, 'actual browser XML/image and case-insensitive CSS import rendering under a prefix');
  assert.deepEqual(result.nodeGlobals, [], 'no Node globals/polyfills supply the kernel');
  assert.deepEqual(result.orderedCssPadding, ['10px', '20px'], 'validated declaration order survives the shared serializer and actual browser cascade');
  assert.ok(result.cases.length > 25, 'the shared acceptance/refusal regions are exercised');
  for (const { name, actual, expected } of [...result.cases, ...result.bytes, ...result.references, ...result.requirements, ...result.nativeJson, ...result.nativeValues, ...result.nativeEquality, ...result.inlineCss, ...result.componentTexts, ...result.sessions, ...result.selection, ...result.services]) assert.deepEqual(actual, expected, name);
  assert.deepEqual(result.parsedCssRendering, ['10px', '20px', 'grid', 'rgb(255, 0, 0)'], 'ordered parsing/admission/serialization preserves browser cascade, fallback and priority');
  assert.equal(result.draftDuplicateRefusal, 'INVALID_HTML', 'draft HTML still refuses repeated properties until cutover');
  assert.equal(result.deepNativeEqual, true, 'caller-selected deep native value normalization/equality is iterative in Chromium');
  assert.deepEqual(result.frames, expectedFrames, 'the same full-frame validation, patch and inspection semantics run in Node and browser');
  for (let index = 0; index < cssAnnotationCases.length; index++) {
    const { name, literal } = cssAnnotationCases[index], row = result.cssAnnotations[index];
    assert.equal(row.name, name);
    for (const value of [row.inline, row.pasted, row.frame.tokens['--note'], row.computed]) assert.equal(value, literal, name);
    assert.deepEqual(row.reopened, row.frame, name);
    assert.deepEqual(row.refusals, ['INVALID_HTML', 'INVALID_HTML'], name);
  }
  assert.deepEqual(result.publicPage.keys.sort(), ['clientPlugins', 'diagnostics', 'documents', 'project', 'projectId', 'revision', 'selection', 'stateVersion', 'work']);
  assert.equal(result.publicPage.descriptor.viewUrl, 'index.html');
  assert.equal(result.publicPage.metadataEmpty && result.publicPage.versionMatches, true);
  assert.ok(result.publicPage.nodes > 100);
  assert.deepEqual(Object.values(result.publicPage.capabilities), [false, false, false, false]);
  assert.deepEqual(result.lowering, { ok: false, code: 'NO_STYLE_ENGINE', name: 'Error', message: 'No style engine is installed, so applyStyles is unavailable (the project still renders with its own CSS).', domainError: false });
  assert.deepEqual([...new Set(requests)].sort(), [...files.keys()].sort(), 'only static module/fixture bytes are served; no API, SSE or dependency rescue');
  assert.deepEqual(errors, []);
  console.log(`PASS: ${result.cases.length} admission + ${result.bytes.length} UTF-8 + ${result.frames.length} frame + ${result.componentTexts.length} component-text + ${result.cssAnnotations.length} inert CSS-annotation codec + ${result.inlineCss.length} ordered inline-CSS syntax + ${result.references.length} asset-reference + ${result.requirements.length} requirement + ${result.nativeJson.length} native-JSON + ${result.nativeValues.length} object-value + ${result.nativeEquality.length} native-equality + ${result.sessions.length} snapshot-session witnesses + ${result.selection.length} actual-store selection checks + ${result.services.length} optional-service consumer checks + verified public landing data + declared SVG/CSS and native model image/use rendering in native browser ESM; no Node globals, provider bootstrap or backend API (${bundle.bytes} model bytes)`);
} finally {
  await browser?.close();
  server.close();
  await once(server, 'close');
}
