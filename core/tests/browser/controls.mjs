// Every control of the board, exercised in real Chromium and verified against the runtime model.
import assert from 'node:assert/strict';
import { legacyProject } from '../fixtures/legacy-project.js';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../lib/runtime.js';

const playwright = await import('playwright');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-controls-'));
await cp(path.join(root, 'examples', 'studio'), cwd, { recursive: true });
await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
const runtime = await openRuntime({ cwd, watch: true });
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const errors = [];
const checks = [];
const check = name => { checks.push(name); if (process.env.VERBOSE) console.log('✓', name); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitUntil = async (fn, label, timeout = 8000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (error) { last = error; } await sleep(40); }
  throw new Error(`Timed out: ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
};
const doc = id => runtime.read({ view: 'document', documentId: id });
const ids = () => runtime.info().documents.map(item => item.id);
const last = () => runtime.readHistory().changes.at(-1);

let browser;
try {
  browser = await playwright.chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 1500, height: 960 }, deviceScaleFactor: 1, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/409|400|404/.test(message.text())) errors.push(message.text()); });
  page.on('response', response => { if (response.status() === 404) errors.push(`404 ${new URL(response.url()).pathname.replace(/^\/[0-9a-f]+\//, '')}`); });
  await page.goto(runtime.info().url);
  await page.waitForFunction(() => document.querySelector('#status-dot')?.dataset.kind === 'live');
  await page.waitForFunction(() => [...document.querySelectorAll('.artboard')].every(node => node.dataset.status === 'live')).catch(async error => {
    const frames = await page.evaluate(async () => [...(await import('./lib/canvas.js')).entries.values()].map(entry => ({ id: entry.doc.id, status: entry.el.dataset.status, mounted: !!entry.iframe, loaded: entry.loaded, port: !!entry.port, render: entry.doc.render, expected: entry.expectedNavigationVersion, rendered: entry.renderedVersion, awaiting: entry.awaitingVersion, fetching: entry.pendingFetch, rect: entry.iframe?.getBoundingClientRect().toJSON() }))).catch(() => null);
    console.log('controls boot evidence', JSON.stringify({ frames, errors, runtime: runtime.info().documents.map(({ id, version, render }) => ({ id, version, render })) }));
    throw error;
  });

  const board = id => page.locator(`.artboard[data-artboard-id="${id}"]`);
  const frameOf = id => page.frames().find(frame => frame.url().includes(`/preview/${id}`));
  const camera = () => page.evaluate(() => ({ zoom: document.querySelector('#zoom-value').textContent }));
  const menuItem = text => page.locator('.menu .menu-item', { hasText: text }).first();
  /** Screen point of a node inside an artboard iframe (the iframe is scaled with the canvas). */
  const nodePoint = async (documentId, nodeId) => {
    const frame = frameOf(documentId);
    const inner = await frame.evaluate(id => { const r = document.querySelector(`[data-divlet-id="${id}"]`).getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 40), y: r.y + Math.min(r.height / 2, 12) }; }, nodeId);
    const outer = await page.evaluate(id => { const f = document.querySelector(`iframe[data-document-id="${id}"]`); const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, k: r.width / f.offsetWidth }; }, documentId);
    return { x: outer.x + inner.x * outer.k, y: outer.y + inner.y * outer.k };
  };
  // The page may still be re-rendering after an edit; like a person, click again if nothing was picked.
  const clickNode = async (documentId, nodeId, options) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const p = await nodePoint(documentId, nodeId);
      await page.mouse.click(p.x, p.y, options);
      if (options?.modifiers) return;
      const end = Date.now() + 1200;
      while (Date.now() < end) { if (selectedNodes()[0] === nodeId) return; await sleep(40); }
      await sleep(500);
    }
  };
  const selectedNodes = () => runtime.info().selection.selectedNodes?.nodeIds || [];
  const focusCanvas = () => page.locator('#viewport').focus();
  const showAll = async () => { await focusCanvas(); await page.keyboard.press('Shift+1'); await sleep(450); };

  /* ---- dock ---------------------------------------------------------------- */
  for (const [mode, key] of [['interact', 'P'], ['select', 'V']]) {
    await page.locator(`#dock [data-mode="${mode}"]`).click();
    await waitUntil(() => page.evaluate(m => document.body.dataset.canvasMode === m && document.querySelector('#viewport').classList.contains(`mode-${m}`), mode), `mode ${mode}`);
    assert.equal(await page.locator(`#dock [data-mode="${mode}"]`).getAttribute('aria-pressed'), 'true');
    void key;
  }
  check('dock tool buttons switch select / interact');

  const z0 = (await camera()).zoom;
  await page.locator('#dock .zoom-step').nth(1).click();
  await waitUntil(async () => (await camera()).zoom !== z0, 'zoom in');
  const z1 = (await camera()).zoom;
  await page.locator('#dock .zoom-step').nth(0).click();
  await waitUntil(async () => (await camera()).zoom !== z1, 'zoom out');
  await page.locator('#zoom-value').click();
  await menuItem('100%').click();
  await waitUntil(async () => (await camera()).zoom === '100%', 'zoom menu 100%');
  await page.locator('#zoom-value').click();
  await menuItem('Fit everything').click();
  await waitUntil(async () => (await camera()).zoom !== '100%', 'zoom menu fit');
  await page.locator('#dock button[aria-label="Zoom in"]').click();
  assert.equal(await page.locator('#dock button[aria-label="Fit everything"], #dock .dock-fit').count(), 0, 'fit lives in the zoom menu and Shift+1, not as a second button');
  await page.locator('#zoom-value').click();
  await menuItem('Fit everything').click();
  await waitUntil(async () => (await camera()).zoom === z0, 'the zoom menu restores the overview');
  check('zoom out / in / value menu / fit');

  assert.equal(await page.locator('#dock-layers, #dock-new').count(), 0, 'the dock no longer repeats Layers and New artboard');
  await page.locator('#open-layers').click();
  await page.locator('#layers .board').first().waitFor();
  assert.equal(await page.locator('#open-layers').getAttribute('aria-selected'), 'true');
  await page.locator('#open-layers').click();
  await waitUntil(() => page.locator('#sidebar').isHidden(), 'layers toggles off');
  await page.locator('#open-history').click();
  assert.equal(await page.locator('#open-history').getAttribute('aria-selected'), 'true');
  await page.locator('#activity').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#sidebar .tab, #sidebar .tabs').count(), 0, 'the tabs live under the sidebar, not inside its own');
  assert.match(await page.locator('#open-layers').innerText(), /Layers/);
  assert.match(await page.locator('#open-history').innerText(), /History/);
  await page.locator('#open-layers').click();
  await page.locator('#layers .board').first().waitFor();
  assert.equal(await page.locator('#open-layers').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#open-history').getAttribute('aria-selected'), 'false');
  await page.locator('#open-layers').click();
  await waitUntil(() => page.locator('#sidebar').isHidden(), 'sidebar close button');
  check('layers button, status pill, tabs and sidebar close');

  await page.locator('#dock-help').click();
  await page.locator('#help .dialog h2').waitFor();
  await page.locator('#help .seg[data-theme="dark"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.locator('#help .seg[data-theme="auto"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? null), null);
  await page.keyboard.press('Escape');
  await waitUntil(() => page.locator('#help').isHidden(), 'help closes on Escape');
  assert.equal(await page.locator('#help .shortcut-grid, #help dl').count(), 0, 'Settings holds only settings');
  await focusCanvas();
  await page.keyboard.press('?');
  await page.locator('#shortcuts .dialog dl').first().waitFor();
  assert.equal(await page.locator('#shortcuts input, #shortcuts select').count(), 0, 'the shortcuts modal is read-only');
  await page.locator('#shortcuts .dialog-head button').click();
  await waitUntil(() => page.locator('#shortcuts').isHidden(), 'shortcuts close button');
  await focusCanvas();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('keyboard shortcuts');
  await page.locator('#palette .palette-item', { hasText: 'Keyboard shortcuts' }).first().click();
  await page.locator('#shortcuts .dialog dl').first().waitFor();
  await page.keyboard.press('Escape');
  await waitUntil(() => page.locator('#shortcuts').isHidden(), 'shortcuts close on Escape');
  await focusCanvas();
  await page.keyboard.press('Control+,');
  await page.locator('#help .dialog h2', { hasText: 'Settings' }).waitFor();
  await page.keyboard.press('Escape');
  check('settings appearance controls and the separate read-only shortcuts modal from ? and Ctrl+K');

  /* ---- artboards ----------------------------------------------------------- */
  const before = ids().length;
  await page.locator('#open-layers').click();
  await page.locator('#layers [aria-label="New artboard"]').click();
  await waitUntil(() => ids().length === before + 1, 'new artboard');
  await page.locator('#open-layers').click();
  await waitUntil(() => page.locator('#sidebar').isHidden(), 'sidebar closes again');
  const fresh = ids().find(id => !['welcome', 'mobile', 'plain-css', 'components', 'pricing'].includes(id));
  await waitUntil(() => page.evaluate(id => { const r = document.querySelector(`.artboard[data-artboard-id="${id}"]`)?.getBoundingClientRect(); return r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }, fresh), 'new artboard is revealed');
  assert.equal(runtime.info().selection.ids[0], fresh);
  check('new artboard is created, selected and brought into view');

  await page.locator('#inspector [data-key="name"]').fill('Landing');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc(fresh).name === 'Landing', 'inspector rename');
  await page.locator('#inspector [data-key="width"]').fill('1024');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc(fresh).artboard.width === 1024, 'inspector width');
  await page.locator('#inspector [data-key="height"]').fill('700+20');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc(fresh).artboard.height === 720, 'arithmetic in number fields');
  await waitUntil(() => page.locator('#inspector [data-key="height"]').inputValue().then(value => value === '720'), 'inspector shows the new height');
  await sleep(200);
  const scrubFrom = doc(fresh).artboard.x;
  const label = await page.locator('#inspector .num-label', { hasText: 'X' }).boundingBox();
  await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(label.x + label.width / 2 + i * 8, label.y + label.height / 2); await sleep(40); }
  await page.mouse.up();
  await waitUntil(() => doc(fresh).artboard.x === scrubFrom + 40, 'scrubbing keeps working for the whole drag').catch(async error => { console.log('scrub', scrubFrom, doc(fresh).artboard.x, label, JSON.stringify(runtime.readHistory().changes.slice(-4).map(c => [c.label, c.summary]))); throw error; });
  await page.keyboard.press('Control+z');
  await waitUntil(() => doc(fresh).artboard.x === scrubFrom, 'one undo reverts the whole scrub').catch(error => { console.log(JSON.stringify(runtime.readHistory().changes.slice(-14).map(c => [c.seq, c.actor, c.kind, c.label, c.summary, c.group]), null, 0), runtime.historyHead()); throw error; });
  check('inspector name, number fields, arithmetic and scrubbing (one undo step)');

  await page.locator('#inspector .chip', { hasText: '390' }).click();
  await waitUntil(() => doc(fresh).artboard.width === 390, 'width preset');
  await page.locator('#inspector button[aria-label="Swap width and height"]').click();
  await waitUntil(() => doc(fresh).artboard.width === 720 && doc(fresh).artboard.height === 390, 'rotate');
  check('width preset chips and rotate');

  await focusCanvas();
  await page.keyboard.press('r');
  await board(fresh).locator('.ab-rename').fill('Landing page');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc(fresh).name === 'Landing page', 'R renames');
  const nameBox = await board(fresh).locator('.ab-name').boundingBox();
  await page.mouse.dblclick(nameBox.x + 10, nameBox.y + nameBox.height / 2);
  await board(fresh).locator('.ab-rename').fill('Home');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc(fresh).name === 'Home', 'double-click on the label renames');
  check('rename with R and by double-clicking the label');

  // tokens, css, metadata (the artboard is named explicitly: with the Layers pane open the board always keeps one selected,
  // so the inspector can be showing a different artboard after an Escape)
  await page.evaluate(async id => { const m = await import('./lib/store.js'); m.selectArtboards([id]); }, fresh);
  await waitUntil(async () => await page.locator('#inspector summary', { hasText: 'Tokens' }).count() === 1, 'the inspector shows the artboard');
  const openFold = async name => {
    const fold = page.locator('#inspector details').filter({ has: page.locator('summary', { hasText: name }) });
    if (!(await fold.evaluate(details => details.open))) await fold.locator('summary').click();
    await waitUntil(() => fold.evaluate(details => details.open), `the ${name} fold is open`);
  };
  await openFold('Tokens');
  await page.locator('#inspector [data-key="token-new-key"]').fill('brand');
  await page.locator('#inspector [data-key="token-new-value"]').fill('#ff0066');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc(fresh).tokens['--brand'] === '#ff0066', 'add token');
  await page.locator('#inspector [data-key="token:--brand"]').fill('#00aa88');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc(fresh).tokens['--brand'] === '#00aa88', 'edit token');
  await page.locator('#inspector button[aria-label="Remove token"]').click();
  await waitUntil(() => !doc(fresh).tokens['--brand'], 'remove token');
  await openFold('CSS');
  await page.locator('#inspector [data-key="css"]').fill('main { outline: 1px solid red; }');
  await page.locator('#inspector [data-key="css"]').press('Control+Enter');
  await waitUntil(() => doc(fresh).css.includes('outline'), 'edit css');
  await page.locator('#inspector summary', { hasText: 'Metadata' }).click();
  await page.locator('#inspector [data-key="metadata"]').fill('{ "intent": "Landing for tests" }');
  await page.locator('#inspector [data-key="metadata"]').press('Control+Enter');
  await waitUntil(() => doc(fresh).metadata.intent === 'Landing for tests', 'edit metadata');
  check('tokens add / edit / remove, CSS and metadata');

  // more menu, duplicate, delete with undo toast
  await board(fresh).hover();
  await board(fresh).locator('.ab-more').click();
  const idsBeforeMenu = ids();
  await menuItem('Duplicate').click();
  await waitUntil(() => ids().length === before + 2, 'duplicate from the more menu');
  const copy = ids().find(id => !idsBeforeMenu.includes(id));
  await waitUntil(() => runtime.info().selection.ids[0] === copy, 'the copy is selected');
  await waitUntil(() => page.evaluate(id => { const r = document.querySelector(`.artboard[data-artboard-id="${id}"] .ab-label`)?.getBoundingClientRect(); return r && r.left >= 0 && r.right <= innerWidth && r.top >= 0; }, copy), 'the copy is revealed');
  await sleep(400);
  const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  for (const other of runtime.info().documents) if (other.id !== copy) assert.equal(overlaps(doc(copy).artboard, other.artboard), false, `the copy overlaps ${other.id}`);
  const copyBox = await board(copy).locator('.ab-label').boundingBox();
  await page.mouse.click(copyBox.x + 30, copyBox.y + copyBox.height / 2, { button: 'right' });
  await menuItem('Delete artboard').click();
  await waitUntil(() => !ids().includes(copy), 'delete from the context menu');
  await page.locator('#toast .toast-action', { hasText: 'Undo' }).click();
  await waitUntil(() => ids().includes(copy), 'undo from the toast restores the artboard');
  check('more menu, non-overlapping duplicate, context-menu delete and toast undo');

  // inspector action bar on an artboard
  await focusCanvas();
  await page.keyboard.press('Shift+1');
  await sleep(450);
  await page.locator('.artboard[data-artboard-id="welcome"] .ab-label').click();
  await page.locator('#inspector [data-key="name"]').waitFor();
  await waitUntil(() => page.locator('#inspector [data-key="name"]').inputValue().then(value => value === doc('welcome').name), 'welcome inspector');
  await page.locator('#zoom-value').click(); await page.locator('.menu .menu-item', { hasText: 'Zoom to selection' }).first().click();
  await waitUntil(async () => (await camera()).zoom !== z0, 'zoom to artboard');
  await page.locator('.artboard[data-artboard-id="welcome"] .ab-expand').click();
  await page.locator('#expanded-preview:not([hidden])').waitFor();
  await page.locator('#expanded-back').click();
  await page.locator('#expanded-preview').waitFor({ state: 'hidden' });
  await waitUntil(() => page.evaluate(() => document.querySelector('.artboard[data-artboard-id="welcome"]').dataset.status === 'live'), 'frame reloads after expanded browsing');
  const idsBeforeCopy = ids();
  await page.locator('#inspector .smart-bar button[aria-label="Duplicate"]').click();
  await waitUntil(() => ids().length === before + 3, 'duplicate button');
  const welcomeCopy = ids().find(id => !idsBeforeCopy.includes(id));
  await waitUntil(() => runtime.info().selection.ids[0] === welcomeCopy, 'the copy is selected');
  await page.locator('#inspector button[aria-label="More"]').click(); await menuItem('Delete artboard').click();
  await waitUntil(() => !ids().includes(welcomeCopy), 'delete button');
  await showAll();
  await page.locator('.artboard[data-artboard-id="welcome"] .ab-label').click();
  await page.locator('#viewport').focus();
  await page.keyboard.press('Shift+F10');
  await menuItem('Copy ID').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'welcome');
  check('artboard action bar: zoom, expand, duplicate, delete, more → copy ID');

  // multi-selection: align, distribute, tidy
  await focusCanvas();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+1');
  await sleep(450);
  const firstHeading = page.locator('.artboard[data-artboard-id="mobile"] .ab-label');
  const secondHeading = page.locator('.artboard[data-artboard-id="plain-css"] .ab-label');
  // Overview headings shrink; activate and measure the target instead of assuming an 8px inset.
  await firstHeading.hover();
  await firstHeading.click({ position: { x: 20, y: (await firstHeading.boundingBox()).height / 2 } });
  await secondHeading.hover();
  await secondHeading.click({ position: { x: 20, y: (await secondHeading.boundingBox()).height / 2 }, modifiers: ['Shift'] });
  await page.locator('#inspector .count').waitFor();
  await page.locator('#inspector button[aria-label="Align top edges"]').click();
  await waitUntil(() => doc('mobile').artboard.y === doc('plain-css').artboard.y, 'align top');
  await page.keyboard.press('Control+k'); await page.keyboard.type('Tidy up in a row'); await page.keyboard.press('Enter');
  await waitUntil(() => { const a = doc('mobile').artboard; const b = doc('plain-css').artboard; return a.y === b.y && !overlaps(a, b) && (Math.abs(a.x + a.width + 80 - b.x) < 1 || Math.abs(b.x + b.width + 80 - a.x) < 1); }, 'tidy up');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await focusCanvas();
  await page.keyboard.press('Control+a');
  await waitUntil(() => runtime.info().selection.ids.length === ids().length, 'select all');
  await page.locator('#inspector button[aria-label="Distribute horizontally"]').click();
  await page.locator('#zoom-value').click(); await page.locator('.menu .menu-item', { hasText: 'Zoom to selection' }).first().click();
  check('multi-selection: align, tidy, select all, distribute, zoom to selection');

  // canvas context menu
  await page.keyboard.press('Escape');
  await page.locator('#zoom-value').click();
  await menuItem('Fit everything').click();
  await sleep(450);
  const count = ids().length;
  await page.mouse.click(30, 520, { button: 'right' });
  await menuItem('New artboard here').click();
  await waitUntil(() => ids().length === count + 1, 'new artboard from the canvas menu');
  const placed = runtime.info().selection.ids[0];
  await page.locator('#inspector button[aria-label="More"]').click(); await menuItem('Delete artboard').click();
  await waitUntil(() => !ids().includes(placed), 'cleanup');
  check('canvas context menu → new artboard here');

  // keyboard: nudge grouping, Escape cancels a drag
  await showAll();
  await page.locator('.artboard[data-artboard-id="plain-css"] .ab-label').click();
  await focusCanvas();
  const nudgeFrom = doc('plain-css').artboard.x;
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await waitUntil(() => doc('plain-css').artboard.x === nudgeFrom + 5, 'five nudges land');
  await page.keyboard.press('Control+z');
  await waitUntil(() => doc('plain-css').artboard.x === nudgeFrom, 'one undo reverts the nudges');
  const dragBox = await page.locator('.artboard[data-artboard-id="plain-css"] .ab-label').boundingBox();
  const dragFrom = doc('plain-css').artboard;
  await page.mouse.move(dragBox.x + 20, dragBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + 140, dragBox.y + 90, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  // A cancelled drag undoes only after its own queued commits settle (a busy side must not revert an unrelated step), so the
  // test waits for the outcome instead of assuming a fixed delay.
  await waitUntil(() => doc('plain-css').artboard.x === dragFrom.x && doc('plain-css').artboard.y === dragFrom.y, `Escape cancels a drag (${JSON.stringify(doc('plain-css').artboard)})`);
  assert.deepEqual(doc('plain-css').artboard, dragFrom, 'Escape cancels a drag');
  // The model settles first and the canvas follows: read the label only once it has stopped moving, or the next drag starts
  // where the artboard used to be.
  await waitUntil(async () => { const first = await page.locator('.artboard[data-artboard-id="plain-css"] .ab-label').boundingBox(); await sleep(120); const again = await page.locator('.artboard[data-artboard-id="plain-css"] .ab-label').boundingBox(); return first && again && Math.abs(first.x - again.x) < 1 && Math.abs(first.y - again.y) < 1; }, 'the artboard label settles back');
  assert.equal(runtime.info().selection.ids[0], 'plain-css', 'Escape during a drag keeps the selection');
  check('nudges form one undo step; Escape cancels a drag');

  // The move is live: the project follows the pointer, and one undo still reverts the whole drag.
  // An open inline editor swallows the label's press: blur it (the product closes it on blur) before dragging.
  await page.evaluate(() => document.querySelector('#viewport .ab-rename')?.blur());
  await sleep(150);
  await focusCanvas();
  const liveFrom = doc('plain-css').artboard;
  const liveBox = await page.locator('.artboard[data-artboard-id="plain-css"] .ab-label').boundingBox();
  await page.mouse.move(liveBox.x + 20, liveBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(liveBox.x + 130, liveBox.y + 80, { steps: 6 });
  const chromeBox = await page.evaluate(() => ['#side-tabs', '#dock'].map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { selector, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }));
  await waitUntil(() => doc('plain-css').artboard.x !== liveFrom.x, `the project moves while the pointer is still down (${doc('plain-css').artboard.x}; label ${JSON.stringify(liveBox)}; chrome ${JSON.stringify(chromeBox)}; element at press ${await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className || document.elementFromPoint(x, y)?.tagName, { x: liveBox.x + 20, y: liveBox.y + 8 })})`);
  await page.mouse.up();
  await page.evaluate(async () => (await import('./lib/store.js')).idle('plain-css'));
  const landed = doc('plain-css').artboard;
  await waitUntil(() => doc('plain-css').artboard.x !== liveFrom.x, 'the release keeps the new position');
  // A live drag commits while it runs: wait until no new commit has arrived for three samples, then undo it as one step.
  await page.evaluate(async () => (await import('./lib/store.js')).idle('plain-css'));
  { let seen = runtime.readHistory().changes.length, stable = 0;
    for (let i = 0; i < 60 && stable < 3; i++) { await sleep(150); const now = runtime.readHistory().changes.length; stable = now === seen ? stable + 1 : 0; seen = now; } }
  await page.keyboard.press('Control+z');
  await waitUntil(() => doc('plain-css').artboard.x === liveFrom.x && doc('plain-css').artboard.y === liveFrom.y,
    `one undo reverts the whole live drag (now ${JSON.stringify(doc('plain-css').artboard)} want ${JSON.stringify(liveFrom)}; top ${JSON.stringify(runtime.undoStack.at(-1)?.label)} items ${runtime.undoStack.at(-1)?.items.length}; last ${JSON.stringify(runtime.readHistory().changes.slice(-3).map(change => change.label || change.text))})`);
  assert.ok(landed.x !== liveFrom.x, 'the drag really moved it');
  check('an artboard drag commits live and is still one undo step');

  // A slow drag with pauses: every landed commit re-publishes the model, and the rect must still follow the pointer, not
  // compound its own deltas.
  {
    // Two presses on the same label point within the double-click window open the rename field instead of a drag: separate them.
    await sleep(500);
    await page.evaluate(() => document.querySelector('#viewport .ab-rename')?.blur());
    await sleep(150);
    await focusCanvas();
    const from = doc('plain-css').artboard;
    const zoom = await page.evaluate(async () => (await import('./lib/canvas.js')).camera.k);
    const box = await page.locator('.artboard[data-artboard-id="plain-css"] .ab-label').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 8);
    await page.mouse.down();
    for (let step = 1; step <= 6; step++) { await page.mouse.move(box.x + 20 + step * 20, box.y + 8 + step * 10); await sleep(180); }
    await page.mouse.up();
    // The release is issued on pointerup and posted from the client's per-document queue: drain it before reading the result.
    await page.evaluate(async () => (await import('./lib/store.js')).idle('plain-css'));
    { let version = doc('plain-css').version; for (let i = 0; i < 60; i++) { await sleep(150); const next = doc('plain-css').version; if (next === version) break; version = next; } }
    const landed = doc('plain-css').artboard;
    const dx = landed.x - from.x, dy = landed.y - from.y;
    const wantX = 120 / zoom, wantY = 60 / zoom;
    assert.ok(Math.abs(dx - wantX) <= 4 && Math.abs(dy - wantY) <= 4, `a slow drag moves by the pointer delta (${wantX.toFixed(0)} × ${wantY.toFixed(0)} page px at ${zoom.toFixed(2)}), not a compounded one (dx ${dx}, dy ${dy})`);
    await page.keyboard.press('Control+z');
    await waitUntil(() => doc('plain-css').artboard.x === from.x && doc('plain-css').artboard.y === from.y, 'one undo reverts the slow drag');
  }
  check('a slow artboard drag moves by the pointer delta and is one undo step');

  // A drag that loses the window (no pointerup) is cancelled: its preview rect must not outlive it and later overwrite a
  // newer position written by someone else.
  {
    const before = doc('plain-css').artboard;
    const box = await page.locator('.artboard[data-artboard-id="plain-css"] .ab-label').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 8);
    await page.mouse.down();
    for (let step = 1; step <= 3; step++) { await page.mouse.move(box.x + 20 + step * 30, box.y + 8); await sleep(160); }
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await sleep(700);
    assert.equal(doc('plain-css').artboard.x, before.x, 'the cancelled drag put the artboard back');
    await runtime.patch({ documentId: 'plain-css', expectedVersion: doc('plain-css').version, actor: 'user', patch: { artboard: { x: 2000, y: 50 } } });
    await sleep(500);
    const shown = await page.evaluate(async () => (await import('./lib/canvas.js')).rectOf((await import('./lib/store.js')).descriptor('plain-css')));
    assert.equal(shown.x, 2000, 'the board shows the newer position (no stale preview rect)');
  }
  check('a drag cut short by a window blur is cancelled and leaves no stale rect');

  // Several artboards move together by the same pointer delta, with the live commits running.
  {
    await showAll();
    await page.evaluate(async () => (await import('./lib/store.js')).selectArtboards(['plain-css', 'welcome']));
    await sleep(400);
    const zoom = await page.evaluate(async () => (await import('./lib/canvas.js')).camera.k);
    const fromA = doc('plain-css').artboard, fromB = doc('welcome').artboard;
    const box = await page.locator('.artboard[data-artboard-id="plain-css"] .ab-label').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 8);
    await page.mouse.down();
    for (let step = 1; step <= 5; step++) { await page.mouse.move(box.x + 20 + step * 20, box.y + 8 + step * 10); await sleep(180); }
    await page.mouse.up();
    // Both artboards commit from their own client queue: drain both before comparing, or one still sits at an intermediate value.
    await page.evaluate(async () => { const m = await import('./lib/store.js'); await Promise.all([m.idle('plain-css'), m.idle('welcome')]); });
    for (const id of ['plain-css', 'welcome']) { let version = doc(id).version; for (let i = 0; i < 60; i++) { await sleep(150); const next = doc(id).version; if (next === version) break; version = next; } }
    const wantX = 100 / zoom, wantY = 50 / zoom;
    const movedA = doc('plain-css').artboard.x - fromA.x, movedB = doc('welcome').artboard.x - fromB.x;
    // Snapping may pull the pair sideways; what must hold is that both move by the same delta, close to the pointer's and never
    // compounded (the reported bug multiplied it by the number of landed commits).
    assert.equal(movedA, movedB, `both artboards move by the same delta (${movedA} vs ${movedB})`);
    assert.ok(Math.abs(movedA - wantX) <= 25, `the pair moves by about the pointer delta (${movedA} vs ${wantX.toFixed(0)})`);
    assert.ok(Math.abs(doc('welcome').artboard.y - fromB.y - wantY) <= 25, 'and so does its other axis');
    await page.keyboard.press('Control+z');
    await waitUntil(() => doc('plain-css').artboard.x === fromA.x && doc('welcome').artboard.x === fromB.x, 'one undo puts both back');
    // Leave the board with one artboard selected: the tests after this one read the single-artboard inspector.
    await page.evaluate(async () => (await import('./lib/store.js')).selectArtboards(['plain-css']));
    await waitUntil(async () => (await page.locator('#inspector [data-key="width"]').count()) === 1, 'the inspector shows one artboard again');
  }
  check('several artboards move together by the pointer delta, live and in one undo step');

  // Typing an artboard width commits without Enter, in one undo step per focus.
  const widthBefore = doc('plain-css').artboard.width;
  const widthInput = page.locator('#inspector [data-key="width"]');
  await widthInput.click();
  await widthInput.fill(String(widthBefore + 40));
  await waitUntil(() => doc('plain-css').artboard.width === widthBefore + 40, `typing a width commits without Enter (${doc('plain-css').artboard.width})`);
  await widthInput.fill(String(widthBefore + 80));
  await waitUntil(() => doc('plain-css').artboard.width === widthBefore + 80, 'the next width commits too');
  await page.keyboard.press('Escape');
  { let version = doc('plain-css').version; for (let i = 0; i < 60; i++) { await sleep(150); const next = doc('plain-css').version; if (next === version) break; version = next; } }
  await page.keyboard.press('Control+z');
  await waitUntil(() => doc('plain-css').artboard.width === widthBefore, `one undo reverts the whole width typing (${doc('plain-css').artboard.width})`);
  check('typing an artboard width commits live and is one undo step');

  /* ---- elements ------------------------------------------------------------ */
  await showAll();
  await page.locator('.artboard[data-artboard-id="welcome"] .ab-label').click();
  await page.locator('#zoom-value').click(); await page.locator('.menu .menu-item', { hasText: 'Zoom to selection' }).first().click();
  await sleep(450);
  await page.locator('#dock [data-mode="select"]').click();
  const pick = await nodePoint('welcome', 'title');
  await page.mouse.dblclick(pick.x, pick.y);
  await waitUntil(() => selectedNodes()[0] === 'title' || selectedNodes()[0] === 'title-text', 'double-click edits the text under the pointer');
  assert.equal(await page.evaluate(() => document.body.dataset.canvasMode), 'select');
  await page.keyboard.press('Escape');
  await clickNode('welcome', 'title');
  await waitUntil(() => selectedNodes()[0] === 'title', 'click selects a node');
  assert.equal(await page.locator('#inspector .crumbs').count(), 0);
  check('double-click edit, node click');

  await clickNode('welcome', 'title');
  await waitUntil(() => selectedNodes()[0] === 'title', 'title selected');
  await page.locator('#inspector .tag').click();
  await menuItem('<h2>').click();
  await waitUntil(() => doc('welcome').nodes.title.tag === 'h2', 'tag menu changes the tag');
  await page.locator('#viewport').focus();
  await page.keyboard.press('Shift+F10');
  await menuItem('Copy ID').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'title');
  await page.locator('#inspector [data-key="text"]').fill('Hello controls');
  await page.locator('#inspector [data-key="text"]').press('Control+Enter');
  await waitUntil(() => doc('welcome').nodes['title-text'].content === 'Hello controls', 'text field');
  await page.locator('#inspector .cls-input').fill('italic underline');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc('welcome').nodes.title.className.includes('italic') && doc('welcome').nodes.title.className.includes('underline'), 'add classes');
  // A chip edits in place on click…
  await page.locator('#inspector .cls-name', { hasText: 'underline' }).click();
  await page.locator('#inspector .cls-edit').fill('line-through');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc('welcome').nodes.title.className.includes('line-through') && !doc('welcome').nodes.title.className.includes('underline'), 'edit a class chip in place');
  // …and its × removes it.
  const chip = page.locator('#inspector .cls', { hasText: 'italic' });
  await chip.hover();
  await chip.locator('.cls-x').click();
  await waitUntil(() => !doc('welcome').nodes.title.className.split(' ').includes('italic'), 'remove a class chip').catch(async error => { console.log('cls', doc('welcome').nodes.title.className, selectedNodes(), await page.locator('#inspector .classes').innerHTML(), JSON.stringify(runtime.readHistory().changes.slice(-3).map(c => [c.label, c.summary])), await page.locator('#toast').textContent()); throw error; });
  check('tag menu, copy node ID, text, class chips');

  await waitUntil(() => page.locator('#inspector [data-key="style-new-key"]').isVisible(), 'style rows visible');
  await page.locator('#inspector [data-key="style-new-key"]').fill('color: rgb(255, 0, 0); letter-spacing: 1px');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc('welcome').nodes.title.style.color === 'rgb(255, 0, 0)' && doc('welcome').nodes.title.style['letter-spacing'] === '1px', 'pasted declarations');
  await waitUntil(() => page.locator('#inspector [data-section="style"] input[type="color"]').count().then(n => n > 0), 'color swatch for a color value');
  await page.locator('#inspector button[aria-label="Remove letter-spacing"]').click();
  await waitUntil(() => !doc('welcome').nodes.title.style['letter-spacing'], 'remove style');
  await page.locator('#inspector [data-key="attr-new-key"]').fill('title');
  await page.locator('#inspector [data-key="attr-new-value"]').fill('Greeting');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc('welcome').nodes.title.attrs.title === 'Greeting', 'add attribute');
  check('style declarations, color swatch, remove style, add attribute');

  const heroKids = () => doc('welcome').nodes.hero.children;
  const titleAt = heroKids().indexOf('title');
  assert.equal(await page.locator('#inspector .actions').count(), 0, 'the element panel has no row of repeated buttons');
  await page.locator('#viewport').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await waitUntil(() => heroKids().indexOf('title') === titleAt + 1, 'move down');
  await page.keyboard.press('Alt+ArrowUp');
  await waitUntil(() => heroKids().indexOf('title') === titleAt, 'move up').catch(async error => { console.log('move', titleAt, heroKids(), selectedNodes(), await page.locator('#inspector').innerHTML().then(h => h.slice(-1500)), JSON.stringify(runtime.readHistory().changes.slice(-3).map(c => [c.label, c.summary]))); throw error; });
  await page.keyboard.press('Control+g');
  await waitUntil(() => { const group = selectedNodes()[0]; return group && doc('welcome').nodes[group]?.children?.[0] === 'title'; }, 'wrap');
  const group = selectedNodes()[0];
  await page.keyboard.press('Shift+F10');
  await menuItem('Unwrap').click();
  await waitUntil(() => !doc('welcome').nodes[group] && heroKids().includes('title'), 'unwrap');
  await waitUntil(() => selectedNodes()[0] === 'title', 'unwrap selects the children');
  await page.locator('#viewport').focus();
  await page.keyboard.press('Control+d');
  await waitUntil(() => selectedNodes()[0] === 'title-copy' && doc('welcome').nodes['title-copy'], 'duplicate node');
  await page.keyboard.press('Delete');
  await waitUntil(() => !doc('welcome').nodes['title-copy'], 'delete node');
  await clickNode('welcome', 'title');
  await page.locator('#viewport').focus();
  await page.keyboard.press('Shift+Enter');
  await waitUntil(() => selectedNodes()[0] === 'hero', 'select parent');
  check('element actions by keyboard and menu key: move, wrap, unwrap, duplicate, delete, parent');

  // keyboard navigation in the page
  await focusCanvas();
  await page.keyboard.press('Enter');
  await waitUntil(() => selectedNodes()[0] === doc('welcome').nodes.hero.children[0], 'Enter selects the first child');
  await page.keyboard.press('Tab');
  await waitUntil(() => selectedNodes()[0] === doc('welcome').nodes.hero.children[1], 'Tab selects the next sibling');
  await page.keyboard.press('Shift+Enter');
  await waitUntil(() => selectedNodes()[0] === 'hero', 'Shift+Enter selects the parent');
  await page.keyboard.press('Control+g');
  await waitUntil(() => doc('welcome').nodes[selectedNodes()[0]]?.children?.[0] === 'hero', 'Ctrl+G wraps');
  await page.keyboard.press('Control+Shift+g');
  await waitUntil(() => doc('welcome').nodes.root.children.includes('hero'), 'Ctrl+Shift+G unwraps');
  await clickNode('welcome', 'cta');
  await waitUntil(() => selectedNodes()[0] === 'cta', 'cta selected');
  const ctaAt = heroKids().indexOf('cta');
  await page.keyboard.press('Alt+ArrowUp');
  await waitUntil(() => heroKids().indexOf('cta') === ctaAt - 1, 'Alt+Up reorders');
  await page.keyboard.press('Control+z');
  await waitUntil(() => heroKids().indexOf('cta') === ctaAt, 'undo reorder');
  check('Enter / Tab / Shift+Enter navigation, Ctrl+G / Ctrl+Shift+G, Alt+↑');

  // right-click inside the page (after the page settled from the previous edits)
  await sleep(500);
  const cta = await nodePoint('welcome', 'cta');
  await page.mouse.click(cta.x, cta.y, { button: 'right' });
  await menuItem('Duplicate').waitFor();
  assert.ok(await menuItem('Wrap in container').isVisible());
  await menuItem('Duplicate').click();
  const duplicateEvidence = async error => {
    const state = runtime.info(), frame = state.documents.find(frame => frame.id === 'welcome');
    const browser = await page.evaluate(async () => {
      const { store, descriptor, cachedModel, isSelectionPending } = await import('./lib/store.js'), frame = descriptor('welcome');
      return { stateVersion: store.state?.stateVersion, revision: store.state?.revision, version: frame?.version, render: frame?.render, nodeIds: store.node?.nodeIds.slice(0, 8), selectionPending: isSelectionPending(), copyInModel: !!cachedModel('welcome')?.nodes['cta-copy'], focus: { tag: document.activeElement?.tagName, id: document.activeElement?.id }, menu: !!document.querySelector('.menu'), connection: store.connection };
    }).catch(() => null);
    console.log('controls context duplicate-delete evidence', JSON.stringify({ runtime: { stateVersion: state.stateVersion, revision: state.revision, version: frame?.version, render: frame?.render, nodeIds: state.selection.selectedNodes?.nodeIds.slice(0, 8), original: !!doc('welcome').nodes.cta, copy: !!doc('welcome').nodes['cta-copy'] }, browser }));
    throw error;
  };
  // Acceptance of the duplicate graph can precede the action response and its selection effect.
  await waitUntil(() => doc('welcome').nodes['cta-copy'] && selectedNodes()[0] === 'cta-copy', 'context duplicate is selected').catch(duplicateEvidence);
  assert.equal(await page.locator('#viewport').evaluate(node => document.activeElement === node), true, 'context menu restores canvas keyboard focus');
  await page.keyboard.press('Delete');
  await waitUntil(() => !doc('welcome').nodes['cta-copy'] && doc('welcome').nodes.cta, 'Delete removes only the selected duplicate').catch(duplicateEvidence);
  check('right-click inside the page opens the element menu');

  /* ---- layers ------------------------------------------------------------- */
  await page.keyboard.press('l');
  await page.locator('#layers .node[data-node-id="cta"]').click();
  await waitUntil(() => selectedNodes()[0] === 'cta', 'layer row selects');
  await page.locator('#layers-add').click();
  await menuItem('Heading').click();
  await waitUntil(() => Object.values(doc('welcome').nodes).some(node => node.tag === 'h2' && node.id.startsWith('h2')), 'add heading');
  await waitUntil(() => { const id = selectedNodes()[0]; return id && doc('welcome').nodes[id]?.tag === 'h2'; }, 'the new heading is selected');
  const heading = selectedNodes()[0];
  await waitUntil(() => heroKids().indexOf(heading) === heroKids().indexOf('cta') + 1, 'inserted right after the selected element');
  await waitUntil(() => frameOf('welcome').evaluate(id => document.querySelector(`[data-divlet-id="${id}"]`)?.isContentEditable, heading), 'inline editing starts for the new heading');
  await page.keyboard.type('Fresh heading');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc('welcome').nodes[`${heading}-text`]?.content === 'Fresh heading', 'type into the new heading');
  check('layers: add element after the selection with inline text editing');

  assert.equal(await page.locator('#layers input').count(), 0, 'the layers sidebar has no search field of its own; Ctrl+K searches layers');
  // Ctrl+K finds the layer; running it opens the element on the canvas and in the layers tree at once.
  await page.locator('#viewport').focus();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Fresh heading');
  await page.locator('#palette .palette-item', { hasText: 'Fresh heading' }).first().waitFor();
  await page.keyboard.press('Enter');
  await waitUntil(() => selectedNodes()[0] === heading, 'the search result selects the layer');
  await waitUntil(() => page.locator(`#layers .node[data-node-id="${heading}"].on`).count().then(n => n === 1), 'and lights it in the layers tree');
  await page.locator(`#layers .node[data-node-id="${heading}"]`).dblclick();
  await page.locator('#layers .row-rename').fill('Section title');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc('welcome').nodes[heading].metadata.name === 'Section title', 'layer rename writes metadata.name');
  await page.locator('#layers .node[data-node-id="cards"] .twist').click();
  await waitUntil(() => page.locator('#layers .node[data-node-id="card-one"]').count().then(n => n === 0), 'collapse');
  await page.locator('#layers .node[data-node-id="cards"] .twist').click();
  await page.locator('#layers .node[data-node-id="card-one"]').waitFor();
  await page.locator('#layers .node[data-node-id="card-one"]').click();
  await page.keyboard.press('ArrowDown');
  await waitUntil(() => selectedNodes()[0] && selectedNodes()[0] !== 'card-one', 'arrow keys move through layers');
  await page.locator('#layers .node[data-node-id="card-three"]').dragTo(page.locator('#layers .node[data-node-id="card-one"]'), { targetPosition: { x: 40, y: 2 } });
  await waitUntil(() => doc('welcome').nodes.cards.children[0] === 'card-three', 'drag and drop reorders');
  const twoAt = doc('welcome').nodes.cards.children.indexOf('card-two');
  await page.locator('#layers .node[data-node-id="card-two"]').click({ button: 'right' });
  await menuItem('Move up').click();
  await waitUntil(() => doc('welcome').nodes.cards.children.indexOf('card-two') === twoAt - 1, 'layer context menu');
  // An artboard is chosen in the list; renaming it is not done in the layers panel.
  const welcomeRow = page.locator('#layers .board[data-document-id="welcome"]');
  await welcomeRow.dblclick();
  assert.equal(await page.locator('#layers .row-rename').count(), 0, 'no rename in the layers panel for an artboard');
  await page.locator('#layers .node[data-node-id="root"] .twist').click();
  await waitUntil(() => page.locator('#layers .node').count().then(n => n === 1), 'the root triangle collapses the whole tree');
  await page.locator('#layers .node[data-node-id="root"] .twist').click();
  await page.locator('#layers .node[data-node-id="card-one"]').waitFor();
  check('layers: search, rename, collapse, arrows, drag-and-drop, context menu, collapsing the root');

  /* ---- history ------------------------------------------------------------ */
  await page.locator('#open-history').click();
  await page.locator('#activity .change').first().waitFor();
  assert.equal(await page.locator('#activity .chip, #activity [data-filter]').count(), 0, 'History has no author filters: it lists every change, the conversation is in the Agent tab');
  assert.ok(await page.locator('#activity .change.actor-user').count() > 0);
  await runtime.patch({ documentId: 'mobile', expectedVersion: doc('mobile').version, patch: { name: 'Mobile by Pi' }, actor: 'agent', label: 'rename mobile' });
  await page.locator('#activity .change.actor-agent', { hasText: 'rename mobile' }).click();
  await waitUntil(() => runtime.info().selection.ids[0] === 'mobile', 'history row focuses its artboard');
  check('history: every change in one list, focusing a change');

  /* ---- resize snapping to device widths --------------------------------- */
  await showAll();
  await page.locator('.artboard[data-artboard-id="welcome"] .ab-label').click();
  const width = doc('welcome').artboard.width;
  const k = await page.evaluate(() => { const f = document.querySelector('iframe[data-document-id="welcome"]'); return f.getBoundingClientRect().width / f.offsetWidth; });
  const handle = await page.locator('.artboard[data-artboard-id="welcome"] .h-e').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + (771 - width) * k, handle.y + handle.height / 2, { steps: 6 });
  await page.mouse.up();
  await waitUntil(() => doc('welcome').artboard.width === 768, 'resize snaps to 768').catch(error => { console.log('resize', width, k, doc('welcome').artboard, runtime.info().documents.map(d => [d.id, d.artboard])); throw error; });
  check('resizing snaps to common device widths');

  /* ---- the Layers pane always has an artboard to show --------------------- */
  await page.evaluate(async () => (await import('./lib/sidebar.js')).show('layers'));
  await waitUntil(() => page.evaluate(async () => (await import('./lib/layers.js')).isOpen()), 'the Layers pane is open');
  const selection = () => page.evaluate(async () => [...(await import('./lib/store.js')).store.selected]);
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards([]); });
  await waitUntil(async () => (await selection()).length === 1, 'clearing the selection with Layers open selects an artboard again');
  const restored = (await selection())[0];
  // The chosen artboard is remembered: clearing the selection returns to it, not to whichever row is first.
  await page.evaluate(async id => { const m = await import('./lib/store.js'); m.selectArtboards([id]); }, ids()[1]);
  const chosen = ids()[1];
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards([]); });
  await waitUntil(async () => (await selection())[0] === chosen, 'the remembered artboard comes back');
  // Deleting the chosen one picks another instead of leaving the pane with nothing.
  await runtime.removeDocument({ documentId: chosen });
  await waitUntil(async () => { const picked = await selection(); return picked.length === 1 && picked[0] !== chosen; }, 'deleting the chosen artboard selects another one');
  check('the Layers pane always has an artboard selected (remembered, or another one after a delete)');

  /* ---- empty state -------------------------------------------------------- */
  await focusCanvas();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await waitUntil(() => ids().length === 0, 'delete everything');
  await waitUntil(async () => (await selection()).length === 0, 'a project without artboards has nothing selected, even in Layers');
  await waitUntil(async () => await page.locator('#layers .quiet', { hasText: 'No artboards yet' }).count() === 1, 'and the Layers list says so');
  await page.locator('#empty-new').click();
  await waitUntil(() => ids().length === 1, 'empty-state button creates an artboard');
  await waitUntil(async () => (await selection()).length === 1, 'the new artboard is selected in Layers');
  check('empty state offers a working “New artboard” button');
  await page.evaluate(async () => (await import('./lib/sidebar.js')).close());

  /* ---- long element trees must not crush the artboard chooser ------------ */
  const denseId = ids()[0];
  await runtime.edit({ documentId: denseId, expectedVersion: doc(denseId).version, op: { type: 'insert', parentId: doc(denseId).rootId, spec: Array.from({ length: 90 }, (_, index) => ({ tag: 'div', id: `dense-${index}`, text: `Layer ${index}` })) } });
  if (!(await page.evaluate(async () => (await import('./lib/layers.js')).isOpen()))) await page.locator('#open-layers').click();
  await page.locator(`#layers .node[data-node-id="dense-89"]`).waitFor();
  const assertChooser = async (label, longTree = true) => {
    const geometry = await page.locator('#layers').evaluate(pane => {
      const list = pane.querySelector('.board-list');
      const selected = list.querySelector('.board.on');
      const row = selected.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      const sidebar = pane.getBoundingClientRect();
      const body = pane.querySelector('.panel-body');
      return { rowHeight: row.height, visible: Math.max(0, Math.min(row.bottom, bounds.bottom, sidebar.bottom) - Math.max(row.top, bounds.top, sidebar.top)), listHeight: bounds.height, scrollable: list.scrollHeight > list.clientHeight, treeHeight: body.clientHeight, treeScrollable: body.scrollHeight > body.clientHeight };
    });
    assert.ok(geometry.visible >= geometry.rowHeight - 1, `${label}: selected artboard is not fully visible ${JSON.stringify(geometry)}`);
    assert.ok(geometry.treeHeight > 0 && (!longTree || geometry.treeScrollable), `${label}: the element tree retains its own scroll area ${JSON.stringify(geometry)}`);
    return geometry;
  };
  await assertChooser('single artboard / long tree');
  for (let index = 0; index < 9; index++) await runtime.create({ document: { schemaVersion: 1, id: `overflow-${index}`, name: `Overflow ${index}`, version: 1, artboard: { x: 2000 + index * 420, y: 0, width: 390, height: 600 }, rootId: 'root', nodes: { root: { id: 'root', type: 'element', tag: 'main', children: [] } } } });
  await waitUntil(() => page.locator('#layers .board').count().then(count => count === 10), 'all artboards listed');
  for (const width of [1280, 768, 390]) for (const percent of [100, 200]) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(percent => import(new URL('lib/help.js', location.href)).then(module => module.setUiSize(percent)), percent);
    await page.evaluate(id => import(new URL('lib/store.js', location.href)).then(module => module.selectArtboards([id])), 'overflow-8');
    await waitUntil(() => page.locator('#layers .board.on').getAttribute('data-document-id').then(id => id === 'overflow-8'), 'last artboard selected');
    await assertChooser(`${width}px / ${percent}% / selected last row`, false);
    await page.locator('#layers .board-list').evaluate(list => { list.scrollTop = list.scrollHeight; });
    await page.locator('#layers .board[data-document-id="overflow-8"]').click();
    await page.evaluate(id => import(new URL('lib/store.js', location.href)).then(module => module.selectArtboards([id])), denseId);
    await page.locator('#layers .node[data-node-id="dense-89"]').waitFor();
    const geometry = await assertChooser(`${width}px / ${percent}% / 10 artboards`);
    assert.ok(geometry.scrollable, 'many artboards scroll instead of enlarging or collapsing the list');
  }
  await page.evaluate(() => import(new URL('lib/help.js', location.href)).then(module => module.setUiSize(100)));
  await page.setViewportSize({ width: 1280, height: 960 });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/layers.png' });
  check('artboard chooser stays visible and independently scrollable beside a long tree at 100/200% and desktop/tablet/phone widths');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', count: checks.length, checks }, null, 2));
} catch (error) {
  console.error(error);
  if (errors.length) console.error('browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await runtime.close();
  await rm(cwd, { recursive: true, force: true });
}
