import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { openRuntime } from '../../core/lib/runtime.js';

const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-bridge-security-'));
const forged = { type: 'divlet:text-edit', documentId: 'welcome', version: 999999, nodeId: 'title', content: 'Forged edit' };
const hostile = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<h1>External page</h1><script>
    window.received = [];
    addEventListener('message', event => received.push(event.data));
    const channel = new MessageChannel();
    channel.port1.onmessage = event => received.push(event.data);
    parent.postMessage({ type: 'divlet:connect', bridgeToken: 'wrong-token' }, '*', [channel.port2]);
    parent.postMessage(${JSON.stringify(forged)}, '*');
    parent.postMessage({ type: 'divlet:rendered', documentId: 'welcome', version: 999999 }, '*');
  </script>`);
});
await new Promise(resolve => hostile.listen(0, '127.0.0.1', resolve));
const externalUrl = `http://127.0.0.1:${hostile.address().port}/`;
let runtime;
let browser;
try {
  await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
  runtime = await openRuntime({ cwd, watch: false });
  const initial = runtime.documents.get('welcome').document;
  const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" onload="parent.postMessage({dataImageScript:true},\'*\')"><path d="M0 0h20v20H0z"/></svg>');
  await runtime.patch({ documentId: 'welcome', expectedVersion: 1, patch: { nodes: {
    cta: { tag: 'a', attrs: { type: null, href: externalUrl } },
    [initial.rootId]: { children: [...initial.nodes[initial.rootId].children, 'data-image'] },
    'data-image': { id: 'data-image', type: 'element', tag: 'img', attrs: { src: image }, children: [] },
  } } });
  await mkdir(path.join(cwd, 'content'));
  await writeFile(path.join(cwd, 'content', 'index.md'), '# Site home');
  await writeFile(path.join(cwd, 'site.json'), JSON.stringify({ schemaVersion: 1, title: 'Private site', templateId: 'welcome', contentDir: 'content', slots: { content: 'cards' } }));
  await runtime.scan();
  assert.ok(runtime.info().site);
  const before = runtime.read({ view: 'frame', documentId: 'welcome' }).nodes['title-text'].content;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.addInitScript(() => {
    window.dataImageMessages = [];
    addEventListener('message', event => { if (event.data?.dataImageScript) window.dataImageMessages.push(event.data); });
  });
  const live = () => page.waitForFunction(() => document.querySelector('.artboard[data-artboard-id="welcome"]')?.dataset.status === 'live');
  await page.goto(runtime.url);
  await live();
  const preview = page.locator('iframe[data-document-id="welcome"]').contentFrame();
  assert.ok(await preview.locator('[data-divlet-id="data-image"]').evaluate(async node => { await node.decode(); return node.naturalWidth === 20; }), 'data image decodes under the real preview CSP');
  assert.deepEqual(await preview.locator('body').evaluate(() => window.dataImageMessages), [], 'no script message in the preview');
  assert.deepEqual(await page.evaluate(() => window.dataImageMessages), [], 'SVG image scripts cannot message the board parent either');
  await preview.locator('body').evaluate(() => parent.postMessage({ dataImageScript: true, probe: true }, '*'));
  await page.waitForFunction(() => window.dataImageMessages.some(message => message.probe), null, { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => window.dataImageMessages), [{ dataImageScript: true, probe: true }], 'positive control proves the actual parent receiver is observed');
  const previousCapability = new URL(await page.locator('iframe[data-document-id="welcome"]').getAttribute('src')).searchParams.get('bridge');
  assert.ok(previousCapability);
  await page.locator('#viewport').focus();
  await page.keyboard.press('p');
  const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url() === externalUrl });
  await page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').click();
  const foreign = await navigation;
  assert.ok(foreign, 'the page can still navigate in Play mode');
  await foreign.waitForFunction(() => Array.isArray(window.received));
  await page.waitForTimeout(250);
  assert.equal(runtime.read({ view: 'frame', documentId: 'welcome' }).nodes['title-text'].content, before, 'window messages cannot edit the project');
  assert.equal(await foreign.evaluate(() => document.referrer), '', 'the preview capability is not sent as a referrer');
  await page.evaluate(async () => (await import('./lib/canvas.js')).openExpanded('welcome'));
  await foreign.waitForURL(runtime.info().site.url);
  await foreign.locator('[data-divlet-id="cta"]').click();
  await foreign.waitForURL(externalUrl);
  await foreign.waitForFunction(() => Array.isArray(window.received));
  await foreign.evaluate(token => {
    const channel = new MessageChannel();
    channel.port1.onmessage = event => received.push(event.data);
    parent.postMessage({ type: 'divlet:connect', bridgeToken: token }, '*', [channel.port2]);
  }, previousCapability);
  await foreign.evaluate(() => parent.postMessage({ type: 'divlet:site-ready' }, '*'));
  const version = runtime.read({ view: 'frame', documentId: 'welcome' }).version;
  await runtime.patch({ documentId: 'welcome', expectedVersion: version, patch: { name: 'Trusted change' } });
  await page.waitForTimeout(250);
  const leaked = await foreign.evaluate(() => received.filter(message => ['divlet:update', 'divlet:select', 'divlet:work', 'divlet:writable', 'divlet:inspect'].includes(message?.type) || (message?.site && Object.keys(message.site).some(key => key !== 'version'))));
  assert.deepEqual(leaked, [], 'model updates and selection stay on the old document-bound port');
  await page.locator('#expanded-back').click();
  await live();
  await page.evaluate(async () => (await import('./lib/canvas.js')).editText('welcome', 'title'));
  const title = page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="title"]');
  await title.fill('Trusted edit after reset');
  await title.press('Control+Enter');
  await page.waitForFunction(async () => {
    const doc = await fetch('api/documents/welcome').then(response => response.json());
    return doc.nodes['title-text'].content === 'Trusted edit after reset';
  });
  console.log(JSON.stringify({ status: 'passed', checks: ['data SVG images load under preview CSP without executing their scripts', 'forged window edits and fake channel handshakes rejected', 'pre-view capability replay rejected after navigation', 'preview capability not leaked in referrers', 'model, selection and site capabilities not delivered to a navigated page', 'trusted editing works after remount'] }, null, 2));
} finally {
  await browser?.close();
  await runtime?.close();
  await new Promise(resolve => hostile.close(resolve));
  await rm(cwd, { recursive: true, force: true });
}
