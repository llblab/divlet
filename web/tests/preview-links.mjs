// Play: a same-page `#fragment` link scrolls its target inside the preview instead of leaving for the project-files `<base>`.
import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openRuntime } from '../../core/lib/runtime.js';

const playwright = await import('playwright');
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-preview-links-'));
await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
const runtime = await openRuntime({ cwd, watch: true });
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const failed = [], navigations = [], errors = [];
let browser;
try {
  const before = await runtime.read({ view: 'document', documentId: 'welcome' });
  await runtime.edit({ documentId: 'welcome', expectedVersion: before.version, actor: 'user', label: 'Add anchors', op: { type: 'insert', parentId: before.rootId, spec: [
    { id: 'jump', tag: 'a', attrs: { href: '#more' }, style: { display: 'block', height: '40px' }, text: 'Jump' },
    { id: 'missing', tag: 'a', attrs: { href: '#nowhere' }, style: { display: 'block', height: '40px' }, text: 'Missing' },
    { id: 'gap', tag: 'div', style: { height: '1800px' } },
    { id: 'more', tag: 'section', attrs: { id: 'more' }, text: 'More' },
    { id: 'back', tag: 'a', attrs: { href: '#' }, style: { display: 'block', height: '40px' }, text: 'Top' },
  ] } });
  browser = await playwright.chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1500, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) failed.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  page.on('framenavigated', frame => { if (frame !== page.mainFrame()) navigations.push(frame.url()); });
  await page.goto(runtime.info().url);
  await page.locator('iframe[data-document-id="welcome"]').waitFor();
  const preview = () => page.frames().find(frame => frame.url().includes('/preview/welcome'));
  await page.waitForFunction(() => document.querySelector('.artboard[data-artboard-id="welcome"]')?.dataset.status === 'live');
  await page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="jump"]').waitFor();
  const settled = navigations.length;
  const scroll = () => preview().evaluate(() => Math.round(scrollY));
  const link = id => page.locator('iframe[data-document-id="welcome"]').contentFrame().locator(`[data-divlet-id="${id}"]`);
  const waitScroll = async (predicate, label) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) { if (predicate(await scroll())) return; await page.waitForTimeout(40); }
    throw new Error(`Timed out: ${label} (scrollY ${await scroll()})`);
  };

  // Select mode inspects; it never follows a link.
  await link('jump').click();
  assert.equal(await scroll(), 0, 'Select inspects an anchor instead of following it');

  await page.keyboard.press('p');
  await page.waitForFunction(() => document.querySelector('#viewport, .viewport')?.classList.contains('mode-interact'));
  await link('jump').click();
  await waitScroll(y => y > 400, 'the fragment target scrolls into view');
  assert.equal(await preview().evaluate(() => document.querySelector('a[href="#more"]').getAttribute('href')), '#more', 'the authored href is untouched');
  await link('back').click({ force: true });
  await waitScroll(y => y === 0, 'a bare # returns to the top');
  await link('missing').click();
  assert.equal(await scroll(), 0, 'an unknown fragment stays put, as a browser would');
  assert.equal(navigations.length, settled, 'no click navigated the preview');
  assert.deepEqual(failed, [], 'no click requested a missing project file');
  assert.deepEqual(errors, []);
  console.log('preview fragment links passed');
} finally {
  await browser?.close();
  await runtime.close?.();
  await rm(cwd, { recursive: true, force: true });
}
process.exit(0);
