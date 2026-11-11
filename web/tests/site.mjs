import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openRuntime } from '../../core/lib/runtime.js';
import { decodeHtml } from '../../core/lib/codec.ts';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = await import('playwright'); }
catch {
  if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw new Error('Install dev dependencies and run npx playwright install chromium.');
  playwright = require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright'));
}

const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-site-browser-'));
const divlet = cwd;
const markdownPath = path.join(divlet, 'content/guide/start.md');
const initialMarkdown = '# Getting started\n\n## Install\n\nOriginal instructions.\n\n![Nested diagram](assets/diagram.svg)\n\n[Return home](../index.md)\n';
const updatedMarkdown = initialMarkdown.replace('Original instructions.', 'Updated Markdown instructions.');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80"><rect width="160" height="80" fill="#7755bb"/></svg>';
let runtime;
let browser;

try {
  await mkdir(path.join(divlet, 'content/guide/assets'), { recursive: true });
  await mkdir(path.join(divlet, 'template-assets'), { recursive: true });
  await writeFile(path.join(divlet, 'content/index.md'), '# Welcome\n\n[Start here](guide/start.md?from=test#install)\n');
  await writeFile(markdownPath, initialMarkdown);
  for (const file of ['content/guide/assets/diagram.svg', 'template-assets/logo.svg', 'template-assets/pattern.svg']) await writeFile(path.join(divlet, file), svg);
  await writeFile(path.join(divlet, 'site.json'), JSON.stringify({ schemaVersion: 1, title: 'Browser test docs', templateId: 'docs-template', contentDir: 'content', slots: { content: 'content', title: 'page-title', navigation: 'site-nav' } }));
  const template = decodeHtml(`<style>
    .shell{width:min(calc(100% - 32px),1100px);margin-inline:auto;font-family:system-ui;background-image:url('./template-assets/pattern.svg');background-repeat:no-repeat;background-position:right top}
    .layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:24px}
    img{max-width:100%;height:auto}.divlet-navigation{padding-left:20px}article{min-width:0}
    @media(max-width:767px){.layout{grid-template-columns:minmax(0,1fr)}}
  </style><main id="shell" class="shell"><header><img id="logo" src="./template-assets/logo.svg" alt="Template logo"><h1 id="page-title">Placeholder title</h1><p id="tagline">Original template brand</p></header><div class="layout"><nav id="site-nav">Placeholder navigation</nav><article id="content">Placeholder content</article></div></main>`, { fallbackId: 'docs-template' });
  await legacyProject(path.join(cwd, 'project.divlet'));
  runtime = await openRuntime({ cwd, watch: false, createDemo: false });
  await runtime.create({ document: template });
  assert.equal(runtime.info().site.routes.length, 2);
  assert.deepEqual(runtime.info().diagnostics, []);

  const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
  browser = await playwright.chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(10000);
  const pageErrors = [];
  const assets = new Map();
  context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
  context.on('response', response => {
    if (response.url().includes('/files/')) assets.set(new URL(response.url()).pathname, response.status());
  });
  const board = await context.newPage();
  await board.goto(runtime.url);
  await board.locator('#open-site:not([hidden])').waitFor();
  assert.equal(await board.locator('#open-site').getAttribute('href'), runtime.info().site.url);
  const [site] = await Promise.all([context.waitForEvent('page'), board.locator('#open-site').click()]);
  await site.waitForLoadState('domcontentloaded');
  await site.getByRole('link', { name: 'Start here', exact: true }).waitFor();
  assert.equal(site.url(), runtime.url + 'site/');
  assert.equal(await site.locator('#page-title').textContent(), 'Welcome');
  await site.getByRole('link', { name: 'Start here', exact: true }).click();
  await site.waitForURL(runtime.url + 'site/guide/start/?from=test#install');
  await site.locator('#install').waitFor();
  assert.equal(await site.locator('#page-title').textContent(), 'Getting started');
  assert.equal(await site.locator('nav a[aria-current="page"]').textContent(), 'Getting started');
  await site.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));
  const urls = await site.evaluate(() => ({
    logo: document.getElementById('logo').src,
    diagram: document.querySelector('img[alt="Nested diagram"]').src,
    background: getComputedStyle(document.getElementById('shell')).backgroundImage,
    columns: getComputedStyle(document.querySelector('.layout')).gridTemplateColumns.split(/\s+/).length,
  }));
  assert.equal(urls.logo, runtime.url + 'files/template-assets/logo.svg');
  assert.equal(urls.diagram, runtime.url + 'files/content/guide/assets/diagram.svg');
  assert.ok(urls.background.includes(runtime.url + 'files/template-assets/pattern.svg'));
  assert.equal(urls.columns, 2);
  for (const asset of ['template-assets/logo.svg', 'template-assets/pattern.svg', 'content/guide/assets/diagram.svg']) {
    assert.equal(assets.get(new URL(runtime.url + 'files/' + asset).pathname), 200, asset);
  }

  await site.setViewportSize({ width: 390, height: 900 });
  const mobile = await site.evaluate(() => ({ columns: getComputedStyle(document.querySelector('.layout')).gridTemplateColumns.split(/\s+/).length, overflow: document.documentElement.scrollWidth > innerWidth }));
  assert.equal(mobile.columns, 1);
  assert.equal(mobile.overflow, false);

  let navigations = 0;
  site.on('framenavigated', frame => { if (frame === site.mainFrame()) navigations++; });
  const templateVersion = runtime.read({ view: 'document', documentId: 'docs-template' }).version;
  const beforeMarkdown = runtime.info().site.version;
  await writeFile(markdownPath, updatedMarkdown);
  await runtime.scan();
  assert.ok(runtime.info().site.version > beforeMarkdown);
  assert.equal(runtime.read({ view: 'document', documentId: 'docs-template' }).version, templateVersion);
  await site.waitForFunction(() => document.getElementById('content')?.textContent.includes('Updated Markdown instructions.'));
  assert.ok(navigations > 0, 'Markdown-only change must reload the routed site through SSE');
  assert.equal(site.url(), runtime.url + 'site/guide/start/?from=test#install');

  const acceptedTemplate = runtime.read({ view: 'document', documentId: 'docs-template' });
  const brandTextId = acceptedTemplate.nodes.tagline.children[0];
  await runtime.patch({ documentId: acceptedTemplate.id, expectedVersion: acceptedTemplate.version, patch: { nodes: { [brandTextId]: { content: 'Updated template brand' } } } });
  await site.waitForFunction(() => document.getElementById('tagline')?.textContent === 'Updated template brand');
  assert.match(await site.locator('#content').textContent(), /Updated Markdown instructions/);
  assert.match(runtime.renderSite('/').html, /Updated template brand/);

  const component = decodeHtml('<footer id="component-brand">Initial component footer</footer>', { fallbackId: 'site-components' });
  component.nodes['component-brand'].reusable = true;
  await runtime.create({ document: component });
  await runtime.edit({ documentId: 'docs-template', expectedVersion: runtime.getEntry('docs-template').document.version, op: { type: 'insert', after: 'tagline', spec: { ref: 'site-components/component-brand' } } });
  await site.locator('#component-brand').filter({ hasText: 'Initial component footer' }).waitFor();
  const sourceVersion = runtime.getEntry('docs-template').document.version;
  await runtime.patch({ documentId: component.id, expectedVersion: 1, patch: { nodes: { [component.nodes['component-brand'].children[0]]: { content: 'Updated component footer' } } } });
  await site.locator('#component-brand').filter({ hasText: 'Updated component footer' }).waitFor();
  assert.equal(runtime.getEntry('docs-template').document.version, sourceVersion);
  await runtime.patchProject({ expectedVersion: 1, patch: { css: 'main{border-top:7px solid rgb(1,2,3)}', tokens: { '--route-accent': '#123456' } } });
  await site.waitForFunction(() => getComputedStyle(document.getElementById('shell')).borderTopWidth === '7px' && getComputedStyle(document.documentElement).getPropertyValue('--route-accent').trim() === '#123456');
  assert.equal(site.url(), runtime.url + 'site/guide/start/?from=test#install');

  const lastGoodVersion = runtime.info().site.version;
  await writeFile(markdownPath, '# Invalid\n\n<script>alert("must never run")</script>');
  await runtime.scan();
  assert.equal(runtime.info().site.version, lastGoodVersion);
  assert.ok(runtime.info().diagnostics.some(item => item.code === 'UNSUPPORTED_MARKDOWN_HTML'));
  await board.waitForFunction(() => document.getElementById('diag-count')?.textContent === '1');
  assert.match(await site.locator('#content').textContent(), /Updated Markdown instructions/);
  assert.match(await (await fetch(runtime.url + 'site/guide/start/')).text(), /Updated Markdown instructions/);
  await writeFile(markdownPath, updatedMarkdown.replace('Updated Markdown instructions.', 'Recovered Markdown instructions.'));
  await runtime.scan();
  await site.waitForFunction(() => document.getElementById('content')?.textContent.includes('Recovered Markdown instructions.'));
  assert.deepEqual(runtime.info().diagnostics, []);
  await site.getByRole('link', { name: 'Return home', exact: true }).click();
  await site.waitForURL(runtime.url + 'site/');
  assert.equal(await site.locator('#page-title').textContent(), 'Welcome');
  assert.equal((await fetch(runtime.url + 'site/unknown/')).status, 404);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: 'passed', routes: runtime.info().site.routes.map(route => route.path), checks: ['board Open site link', 'native nested Markdown links and heading fragments', 'nested Markdown image', 'template image and CSS background assets', 'responsive template at 1280px and 390px', 'Markdown-only SSE reload', 'query and fragment retained', 'template patch propagation', 'component-only and shared-theme live updates', 'invalid Markdown last-good retention', 'recovery', 'unknown route 404', 'no browser errors'] }, null, 2));
} finally {
  await browser?.close();
  await runtime?.close();
  await rm(cwd, { recursive: true, force: true });
}
