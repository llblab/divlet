import assert from 'node:assert/strict';
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

const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-fullscreen-'));
const divlet = cwd;
const markdownPath = path.join(divlet, 'content/guide/start.md');
let runtime;
let browser;

try {
  await mkdir(path.join(divlet, 'raw'), { recursive: true });
  await mkdir(path.join(divlet, 'content/guide'), { recursive: true });
  await writeFile(path.join(divlet, 'raw/page.css'), 'body{background:rgb(238,221,255)}');
  await writeFile(path.join(divlet, 'raw/mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><path fill="purple" d="M0 0h12v12H0z"/></svg>');
  await writeFile(path.join(divlet, 'raw/sibling.html'), '<!doctype html><html><head><link rel="stylesheet" href="page.css"><style>body{font:20px system-ui;padding:30px}</style></head><body><h1>Raw sibling page</h1><img src="mark.svg" alt="Raw marker"><input aria-label="Raw value" value="raw initial"></body></html>');
  await writeFile(path.join(divlet, 'content/index.md'), '# Site home\n\n[Go nested](guide/start.md?from=expanded#section)\n');
  await writeFile(markdownPath, '# Nested page\n\n## Section\n\nOriginal routed text.\n');
  await writeFile(path.join(divlet, 'site.json'), JSON.stringify({ schemaVersion: 1, title: 'Expanded site', templateId: 'docs-template', contentDir: 'content', slots: { content: 'content', title: 'title', navigation: 'navigation' } }));
  await writeFile(path.join(divlet, 'project.divlet'), JSON.stringify({ schemaVersion: 1, name: 'Expanded fixture', version: 1, frames: [] }));
  const original = decodeHtml('<style>main{padding:24px;font:16px/1.5 system-ui}a{display:block;margin-block:12px}input{border:1px solid #999}</style><main id="root"><h1 id="title">Original page</h1><nav id="navigation">Navigation placeholder</nav><article id="content"><p id="label">Original accepted layout</p></article><label>Draft value<input id="draft" value="initial"></label><a href="raw/sibling.html">Visit raw sibling</a><a href="#details">Jump to details</a><section id="details" style="margin-top:1000px"><h2>Details</h2><a href="second.html?from=expanded#second-target">Second page</a></section></main>', { fallbackId: 'original' });
  original.name = 'Original artboard';
  original.artboard = { x: 80, y: 80, width: 450, height: 420 };
  runtime = await openRuntime({ cwd, watch: false, createDemo: false });
  await runtime.create({ document: original });
  const template = { ...structuredClone(original), id: 'docs-template', name: 'Site template', artboard: { x: 1100, y: 80, width: 450, height: 420 } };
  await runtime.create({ document: template });
  const secondary = decodeHtml('<main><h1 id="second-target">Second artboard content</h1><input aria-label="Second value" value="second"><a href="original.html#details">Back to original</a></main>', { fallbackId: 'second' });
  secondary.name = 'Second artboard';
  secondary.artboard = { x: 650, y: 80, width: 320, height: 360 };
  await runtime.create({ document: secondary });
  const budgetIds = [];
  for (let index = 0; index < 9; index++) {
    const document = decodeHtml(`<main>Budget frame ${index}</main>`, { fallbackId: `budget-${index}` });
    document.artboard = { x: 5000 + index * 400, y: 100, width: 300, height: 300 };
    budgetIds.push(document.id);
    await runtime.create({ document });
  }
  assert.deepEqual(runtime.info().diagnostics, []);
  const originalGeometry = runtime.read({ view: 'document', documentId: 'original' }).artboard;
  const originalView = runtime.info().documents.find(document => document.id === 'original').viewUrl;
  const secondView = runtime.info().documents.find(document => document.id === 'second').viewUrl;
  const rawView = runtime.url + 'build/' + [...runtime.staticFiles.keys()].find(name => name.endsWith('-sibling.html'));

  const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
  browser = await playwright.chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(10000);
  const errors = [];
  const connectionErrors = [];
  const eventRequests = [];
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /EventSource|CORS policy/.test(message.text())) connectionErrors.push(message.text());
  });
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/events')) eventRequests.push(request.url()); });
  runtime.setSelection({ ids: ['original'] });
  await page.goto(runtime.url);
  await page.waitForFunction(() => document.querySelector('.artboard.selected'));
  await page.evaluate(() => document.querySelector('#viewport').focus());
  await page.keyboard.press('f');
  const card = page.locator('.artboard[data-artboard-id="original"]');
  const iframe = card.locator('iframe:not(.frame-ghost)');
  await iframe.waitFor();
  let frame = await (await iframe.elementHandle()).contentFrame();
  // Closing full screen swaps in a fresh authenticated frame behind the old page; re-acquire it once the ghost is gone.
  const reframe = async () => { await page.waitForFunction(() => !document.querySelector('.frame-ghost')); frame = await (await iframe.elementHandle()).contentFrame(); };
  await frame.locator('#label').waitFor();
  await page.waitForFunction(() => document.querySelector('.artboard[data-artboard-id="original"]')?.dataset.renderedVersion === '1');
  await iframe.evaluate(element => { element.dataset.qaIdentity = 'original-frame'; });
  await page.locator('[data-mode="select"]').click();
  const beforeScroll = await card.boundingBox();
  await card.locator('.ab-expand').click();
  await page.locator('#expanded-preview:not([hidden])').waitFor();
  const expandedBounds = await iframe.boundingBox();
  assert.equal(Math.round(expandedBounds.x), 0);
  assert.equal(Math.round(expandedBounds.y), 0);
  assert.equal(Math.round(expandedBounds.width), 1400);
  assert.equal(Math.round(expandedBounds.height), 900);
  assert.deepEqual(await frame.evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 1400, height: 900 });
  assert.equal(await iframe.getAttribute('data-qa-identity'), 'original-frame');
  assert.deepEqual(runtime.read({ view: 'document', documentId: 'original' }).artboard, originalGeometry);

  // Every frame keeps one long-lived iframe; explicitly selected distant frames are promoted to eager loading.
  // The expanded browsing context must also survive when it is no longer selected.
  await page.waitForFunction(() => document.querySelectorAll('.artboard.selected').length === 1);
  runtime.setSelection({ ids: budgetIds });
  await page.waitForFunction(ids => document.querySelectorAll('.artboard.selected').length === ids.length && ids.every(id => document.querySelector('iframe[data-document-id="' + id + '"]')?.loading === 'eager'), budgetIds);
  assert.equal(await iframe.count(), 1);
  assert.equal(await iframe.getAttribute('data-qa-identity'), 'original-frame');
  runtime.setSelection({ ids: ['original'] });
  await page.waitForFunction(() => document.querySelectorAll('.artboard.selected').length === 1);
  await frame.waitForURL(originalView);
  assert.equal(await page.locator('#expanded-preview button').count(), 1, 'viewing has only the return control, no link/site enable switch');
  await frame.getByRole('link', { name: 'Jump to details', exact: true }).click();
  await frame.waitForURL(originalView + '#details');
  assert.ok(await frame.locator('#details').evaluate(element => element.getBoundingClientRect().top < innerHeight), 'fragment navigation scrolls in the current public document');
  await frame.getByRole('link', { name: 'Second page', exact: true }).focus();
  await frame.getByRole('link', { name: 'Second page', exact: true }).press('Enter');
  await frame.waitForURL(secondView + '?from=expanded#second-target');
  await frame.getByRole('heading', { name: 'Second artboard content' }).waitFor();
  await frame.getByRole('link', { name: 'Back to original', exact: true }).click();
  await frame.waitForURL(originalView + '#details');
  assert.equal(await iframe.getAttribute('data-qa-identity'), 'original-frame', 'navigation keeps the same browsing iframe');
  await frame.locator('#draft').fill('Unsaved local draft');
  await frame.getByRole('link', { name: 'Visit raw sibling', exact: true }).click();
  await frame.waitForURL(rawView);
  await frame.getByRole('heading', { name: 'Raw sibling page' }).waitFor();
  await frame.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  assert.equal(await frame.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(238, 221, 255)');
  await frame.getByRole('textbox', { name: 'Raw value' }).fill('Raw navigation draft');
  // Only the page's name stays, and it is the way back; the corner indicator is hidden, never turned into a back button.
  assert.equal(await page.locator('#expanded-back').isVisible(), true);
  assert.match(await page.locator('#expanded-back').innerText(), /\S/);
  assert.equal(await page.locator('#status').isVisible(), false, 'the corner is hidden in full screen');
  assert.equal(await page.locator('#open-layers').isVisible(), false, 'the other corner tools hide in full screen');
  assert.equal(await page.locator('#status .back-label').count(), 0, 'the indicator has no back mode');
  // The name can be dragged to look underneath; dragging does not go back, a click does.
  const before = await page.locator('#expanded-back').boundingBox();
  await page.mouse.move(before.x + 20, before.y + 12);
  await page.mouse.down();
  await page.mouse.move(before.x + 20 - 180, before.y + 12 + 240, { steps: 6 });
  await page.mouse.up();
  const moved = await page.locator('#expanded-back').boundingBox();
  assert.ok(Math.abs(moved.x - (before.x - 180)) < 6 && Math.abs(moved.y - (before.y + 240)) < 6, 'the back control follows the drag');
  assert.equal(await page.locator('#expanded-preview').isVisible(), true, 'a drag does not leave full screen');
  const accepted = runtime.read({ view: 'document', documentId: 'original' });
  const textId = accepted.nodes.label.children[0];
  await runtime.patch({ documentId: accepted.id, expectedVersion: accepted.version, patch: { nodes: { [textId]: { content: 'Latest accepted original' } } } });
  await page.waitForTimeout(500);
  assert.equal(frame.url(), rawView);
  assert.equal(await frame.getByRole('heading', { name: 'Raw sibling page' }).count(), 1);

  await page.evaluate(() => { window.__ghostSeen = false; new MutationObserver(() => { if (document.querySelector('.frame-ghost')) window.__ghostSeen = true; }).observe(document.body, { subtree: true, childList: true }); });
  await page.locator('#expanded-back').click();
  await page.locator('#expanded-preview').waitFor({ state: 'hidden' });
  await reframe();
  assert.equal(await page.evaluate(() => window.__ghostSeen), true, 'the previous page is held as a ghost while the fresh frame loads, so closing never flashes blank');
  await frame.locator('#label').filter({ hasText: 'Latest accepted original' }).waitFor();
  const render = String(runtime.getEntry('original').render);
  await page.waitForFunction(value => document.querySelector('.artboard[data-artboard-id="original"]')?.dataset.renderedVersion === value, render);
  assert.equal(await frame.locator('#draft').inputValue(), 'initial');
  assert.equal(await iframe.getAttribute('data-qa-identity'), null, 'reset swaps in a fresh frame element; the interacted page is not reused');
  const resetUrl = new URL(frame.url());
  assert.equal(resetUrl.origin + resetUrl.pathname, runtime.url + 'preview/original');
  assert.equal(resetUrl.searchParams.get('revision'), render);
  assert.match(resetUrl.searchParams.get('bridge'), /^[a-f0-9-]{36}$/i);
  assert.deepEqual(await frame.evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 450, height: 420 });
  assert.deepEqual(runtime.read({ view: 'document', documentId: 'original' }).artboard, originalGeometry);
  assert.equal(await page.locator('[data-mode="select"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await card.boundingBox(), beforeScroll);

  // Both parent-window Escape and the original preview's trusted bridge close
  // expanded mode. Reset always gets a fresh original document.
  await card.locator('.ab-expand').click();
  await page.locator('#expanded-back').focus();
  await page.keyboard.press('Escape');
  await page.locator('#expanded-preview').waitFor({ state: 'hidden' });
  await reframe();
  await frame.locator('#draft').waitFor();
  await card.locator('.ab-expand').click();
  await frame.locator('#draft').focus();
  await frame.locator('#draft').press('Escape');
  await page.locator('#expanded-preview').waitFor({ state: 'hidden' });
  await reframe();
  await frame.locator('#label').waitFor();

  // The routed site runs in the same opaque iframe, receiving accepted site
  // state from its parent instead of opening an EventSource from origin null.
  const existingEventRequests = eventRequests.length;
  await page.locator('.artboard[data-artboard-id="docs-template"] .ab-expand').click();
  const siteIframe = page.locator('iframe[data-document-id="docs-template"]');
  frame = await (await siteIframe.elementHandle()).contentFrame();
  await frame.waitForURL(runtime.url + 'site/');
  assert.equal(await page.locator('#expanded-preview button').count(), 1);
  assert.equal(await page.locator('#expanded-open-site').count(), 0, 'site content and links are active immediately');
  await page.setViewportSize({ width: 390, height: 844 });
  await frame.waitForFunction(() => innerWidth === 390 && innerHeight === 844);
  const mobileBack = await page.locator('#expanded-back').boundingBox();
  assert.ok(mobileBack.x >= 0 && mobileBack.x + mobileBack.width <= 390, 'the single return control remains reachable on a phone');
  await frame.getByRole('link', { name: 'Go nested', exact: true }).click();
  await frame.waitForURL(runtime.url + 'site/guide/start/?from=expanded#section');
  await frame.locator('#section').waitFor();
  assert.equal(await frame.evaluate(() => self.origin), 'null');
  const siteVersion = runtime.info().site.version;
  await writeFile(markdownPath, '# Nested page\n\n## Section\n\nLive embedded Markdown update.\n');
  await runtime.scan();
  assert.ok(runtime.info().site.version > siteVersion);
  await frame.waitForFunction(() => document.getElementById('content')?.textContent.includes('Live embedded Markdown update.'));
  const component = decodeHtml('<footer id="embedded-brand">Initial embedded brand</footer>', { fallbackId: 'site-components' });
  component.nodes['embedded-brand'].reusable = true;
  await runtime.create({ document: component });
  await runtime.edit({ documentId: 'docs-template', expectedVersion: runtime.getEntry('docs-template').document.version, op: { type: 'insert', parentId: 'root', spec: { ref: 'site-components/embedded-brand' } } });
  await frame.locator('#embedded-brand').filter({ hasText: 'Initial embedded brand' }).waitFor();
  await runtime.patch({ documentId: component.id, expectedVersion: 1, patch: { nodes: { [component.nodes['embedded-brand'].children[0]]: { content: 'Updated embedded brand' } } } });
  await frame.locator('#embedded-brand').filter({ hasText: 'Updated embedded brand' }).waitFor();
  await runtime.patchProject({ expectedVersion: 1, patch: { css: 'body{color:rgb(9,8,7)}' } });
  await frame.waitForFunction(() => getComputedStyle(document.body).color === 'rgb(9, 8, 7)');
  assert.equal(frame.url(), runtime.url + 'site/guide/start/?from=expanded#section');
  assert.equal(eventRequests.length, existingEventRequests);
  assert.deepEqual(connectionErrors, []);
  await frame.getByRole('link', { name: 'Visit raw sibling', exact: true }).focus();
  await frame.getByRole('link', { name: 'Visit raw sibling', exact: true }).press('Escape');
  await page.locator('#expanded-preview').waitFor({ state: 'hidden' });
  await reframe();
  await frame.locator('#label').filter({ hasText: 'Latest accepted original' }).waitFor();

  await page.setViewportSize({ width: 1400, height: 900 });
  runtime.setSelection({ ids: ['second'] });
  await page.waitForFunction(() => document.querySelector('.artboard[data-artboard-id="second"]')?.classList.contains('selected'));
  await page.evaluate(() => document.querySelector('#viewport').focus());
  await page.keyboard.press('f');
  const secondCard = page.locator('.artboard[data-artboard-id="second"]');
  await secondCard.locator('.ab-expand').click();
  const secondFrame = secondCard.locator('iframe').contentFrame();
  await secondFrame.getByRole('heading', { name: 'Second artboard content' }).waitFor();
  assert.equal(await secondCard.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
  assert.equal(await secondFrame.locator('body').evaluate(() => innerWidth), 1400);
  await page.locator('#expanded-back').click();
  await page.locator('#expanded-preview').waitFor({ state: 'hidden' });
  await reframe();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks: ['any artboard expansion', 'client viewport geometry', 'same iframe identity', 'unchanged model geometry', 'lifetime iframe retained across selection changes', 'native fragments and keyboard cross-frame navigation', 'native raw HTML navigation and styles', 'original patches suppressed while browsing', 'reset loads latest accepted original', 'unsaved local form state reset', 'board mode and camera restored', 'parent Escape', 'read-only page Escape', 'site content opens without a second control', 'phone viewport and single return control', 'same iframe routed site navigation', 'opaque-origin parent-forwarded live update without EventSource/CORS errors', 'embedded component-only and shared-theme updates', 'trusted site Escape', 'no browser errors'] }, null, 2));
} finally {
  await browser?.close();
  await runtime?.close();
  await rm(cwd, { recursive: true, force: true });
}
