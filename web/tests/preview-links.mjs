// Play: a same-page `#fragment` link scrolls its target inside the preview, and a link to another frame's page reveals that
// artboard and takes it to the fragment, instead of leaving for the project-files `<base>`.
import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openRuntime } from '@divlet/core/runtime';

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
  // A script URL is refused at admission, so no preview ever holds a link that would run code when followed.
  await assert.rejects(
    runtime.edit({ documentId: 'welcome', expectedVersion: (await runtime.read({ view: 'document', documentId: 'welcome' })).version, actor: 'user', label: 'Script link', op: { type: 'insert', parentId: before.rootId, spec: [{ id: 'bad-link', tag: 'a', attrs: { href: 'javascript:alert(1)' }, text: 'Bad' }] } }),
    /Unsupported URL scheme/, 'a script URL is not an address',
  );
  const second = await runtime.createArtboard({ name: 'Pricing', width: 390, height: 500, x: 900, y: 0 });
  const secondId = second.documentId ?? second.id ?? second.document?.id;
  const secondRoot = (await runtime.read({ view: 'document', documentId: secondId }));
  await runtime.edit({ documentId: secondId, expectedVersion: secondRoot.version, actor: 'user', label: 'Add plans', op: { type: 'insert', parentId: secondRoot.rootId, spec: [
    { id: 'pad', tag: 'div', style: { height: '1800px' } },
    { id: 'plans', tag: 'section', attrs: { id: 'plans' }, text: 'Plans' },
  ] } });
  const pricingPage = decodeURIComponent(new URL(runtime.info().documents.find(item => item.id === secondId).viewUrl).pathname.split('/').pop());
  const withLinks = await runtime.read({ view: 'document', documentId: 'welcome' });
  await runtime.edit({ documentId: 'welcome', expectedVersion: withLinks.version, actor: 'user', label: 'Add page links', op: { type: 'insert', parentId: withLinks.rootId, spec: [
    { id: 'to-plans', tag: 'a', attrs: { href: `${pricingPage}#plans` }, style: { display: 'block', height: '40px' }, text: 'Plans' },
    { id: 'to-pricing', tag: 'a', attrs: { href: `./${pricingPage}` }, style: { display: 'block', height: '40px' }, text: 'Pricing' },
    { id: 'to-query', tag: 'a', attrs: { href: `${pricingPage}?plan=pro#plans` }, style: { display: 'block', height: '40px' }, text: 'Query' },
    { id: 'to-nothing', tag: 'a', attrs: { href: 'no-such-page.html#x' }, style: { display: 'block', height: '40px' }, text: 'Nothing' },
    // A link that leaves the project: the preview frame is sandboxed without popups or top navigation, so only the board can follow it.
    { id: 'to-github', tag: 'a', attrs: { href: 'https://github.com/llblab/divlet' }, style: { display: 'block', height: '40px' }, text: 'GitHub' },
    { id: 'to-github-blank', tag: 'a', attrs: { href: 'https://github.com/llblab/divlet', target: '_blank', rel: 'noreferrer noopener' }, style: { display: 'block', height: '40px' }, text: 'GitHub (new tab)' },
    { id: 'to-mail', tag: 'a', attrs: { href: 'mailto:hello@example.test' }, style: { display: 'block', height: '40px' }, text: 'Mail' },
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
  const expectScroll = async (min, label) => {
    const end = Date.now() + 8000;
    const here = async () => Math.round((await sibling()?.evaluate(() => scrollY).catch(() => -1)) ?? -1);
    while (Date.now() < end) { const y = await here(); if (min === 0 ? y === 0 : y > min) return; await page.waitForTimeout(40); }
    assert.fail(`${label} (scrollY ${await here()})`);
  };
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

  // A page link reveals the sibling artboard, selects it and scrolls its page to the fragment.
  const sibling = () => page.frames().find(frame => frame.url().includes(`/preview/${secondId}`));
  await page.locator(`iframe[data-document-id="${secondId}"]`).waitFor();
  await link('to-plans').click();
  const end = Date.now() + 8000;
  while (Date.now() < end && !((await sibling()?.evaluate(() => Math.round(scrollY)).catch(() => 0)) > 400)) await page.waitForTimeout(40);
  assert.ok((await sibling().evaluate(() => scrollY)) > 400, 'the sibling page scrolled to #plans');
  assert.ok(await page.evaluate(id => document.querySelector(`.artboard[data-artboard-id="${id}"]`).classList.contains('selected'), secondId), 'the target artboard is selected');
  assert.equal(await scroll(), 0, 'the source page stayed where it was');
  await link('to-pricing').click();
  await expectScroll(0, 'a plain page link first returns the sibling to the top');
  await link('to-query').click();
  await expectScroll(400, 'a query string is ignored when naming the page, the fragment still applies');
  await link('to-nothing').click();
  await page.locator('#toast', { hasText: 'no-such-page.html' }).waitFor();
  assert.match(await page.locator('#toast').innerText(), /not an artboard of this project/, 'an unknown page is named, not silently ignored');
  await link('to-pricing').click();
  await page.waitForTimeout(400);
  assert.equal(await sibling().evaluate(() => Math.round(scrollY)), 0, 'a plain page link lands at the top');
  assert.equal(navigations.length, settled, 'no page link navigated an iframe');

  // A link that leaves the project opens from the board's own window — the frame stays sandboxed without popups or top navigation,
  // so a click there would otherwise be swallowed and the authored link would simply be dead. What the board asks the browser for
  // is what this records; the real popup follows below.
  const dialogs = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
  await page.context().route('https://github.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>divlet</title>' }));
  await page.evaluate(() => {
    window.__opened = [];
    window.__realOpen = window.open;
    window.open = (url, name, features) => { window.__opened.push({ url, name, features }); return null; };
  });
  // These links sit at the end of the page, where the board's own toast lands: bring them into the middle so the click is the frame's.
  await preview().evaluate(() => document.querySelector('[data-divlet-id="to-mail"]')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(120);
  const opened = async (id, label) => {
    await link(id).click();
    const end = Date.now() + 6000;
    while (Date.now() < end && !(await page.evaluate(() => window.__opened.length))) await page.waitForTimeout(40);
    const asked = await page.evaluate(() => window.__opened.splice(0));
    assert.equal(asked.length, 1, label);
    return asked[0];
  };
  const newTab = { name: '_blank', features: 'noopener,noreferrer' };
  assert.deepEqual(await opened('to-github', 'a link to another site leaves the preview'), { url: 'https://github.com/llblab/divlet', ...newTab }, 'resolved in full, opened in a new tab with its opener cut');
  assert.deepEqual(await opened('to-github-blank', 'a link asking for a new tab is opened by the board'), { url: 'https://github.com/llblab/divlet', ...newTab }, 'even though the frame may not open one itself');
  assert.deepEqual(await opened('to-mail', 'a mail link is handed to the system'), { url: 'mailto:hello@example.test', ...newTab }, 'as a mailto, not a navigation');
  // And the real thing: one popup, at the authored address, from a plain external link.
  await page.evaluate(() => { window.open = window.__realOpen; });
  const popups = [];
  page.context().on('page', popup => popups.push(popup));
  await link('to-github').click();
  const popup = await (async () => {
    const end = Date.now() + 6000;
    while (Date.now() < end && !popups.length) await page.waitForTimeout(40);
    assert.ok(popups.length, 'the browser opens the tab the board asked for');
    return popups[0];
  })();
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  assert.equal(popup.url(), 'https://github.com/llblab/divlet', 'at the authored address');
  await popup.close();
  assert.deepEqual(dialogs, [], 'no click ran a script');
  assert.equal(navigations.length, settled, 'nothing navigated the preview');
  assert.deepEqual(failed, [], 'no click requested a missing project file');
  assert.deepEqual(errors, []);
  console.log('preview fragment links passed');
} finally {
  await browser?.close();
  await runtime.close?.();
  await rm(cwd, { recursive: true, force: true });
}
process.exit(0);
