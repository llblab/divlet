// Ask Pi, search and commands, clipboard, export, images and components — exercised in real
// Chromium and verified against the runtime model. Pi is simulated through the runtime events.
import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { cp, mkdtemp, readdir, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../core/lib/runtime.js';

const playwright = await import('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-features-'));
await cp(path.join(root, 'examples', 'studio'), cwd, { recursive: true });
await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
const runtime = await openRuntime({ cwd, watch: true });
const asks = [];
let stops = 0;
runtime.on('ask', request => asks.push(request));
runtime.on('stop', () => { stops++; });
runtime.setAgent({ connected: true });
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
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoAAC0dAQHuP5EBAAAAAElFTkSuQmCC';

let browser;
try {
  browser = await playwright.chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 1500, height: 960 }, deviceScaleFactor: 1, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/409|400|404/.test(message.text())) errors.push(message.text()); });
  page.on('response', response => { if (response.status() === 404) errors.push(`404 ${new URL(response.url()).pathname.replace(/^\/[0-9a-f]+\//, '')}`); });
  await page.goto(runtime.info().url);
  await page.waitForFunction(() => document.querySelectorAll('.artboard').length === 5 && [...document.querySelectorAll('.artboard')].every(node => node.dataset.status === 'live'));

  const board = id => page.locator(`.artboard[data-artboard-id="${id}"]`);
  const menuItem = text => page.locator('.menu .menu-item', { hasText: text }).first();
  const frameOf = id => page.frames().find(frame => frame.url().includes(`/preview/${id}`));
  const nodePoint = async (documentId, nodeId) => {
    const frame = frameOf(documentId);
    const inner = await frame.evaluate(id => { const r = document.querySelector(`[data-divlet-id="${id}"]`).getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 40), y: r.y + Math.min(r.height / 2, 12) }; }, nodeId);
    const outer = await page.evaluate(id => { const f = document.querySelector(`iframe[data-document-id="${id}"]`); const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, k: r.width / f.offsetWidth }; }, documentId);
    return { x: outer.x + inner.x * outer.k, y: outer.y + inner.y * outer.k };
  };
  const selectedNodes = () => runtime.info().selection.selectedNodes?.nodeIds || [];
  const focusCanvas = () => page.locator('#viewport').focus();
  const showAll = async () => { await focusCanvas(); await page.keyboard.press('Shift+1'); await sleep(450); };
  // A panel that opens after a fit can cover an artboard that was in the clear when the camera moved: refit once with it on
  // screen instead of clicking through the panel (the fit itself already avoids the panels it can see).
  const coveredPoint = async locator => {
    const box = await locator.boundingBox();
    if (!box) return true;
    return page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return !hit || !hit.closest('.artboard');
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  };
  const pickBoard = async id => {
    await showAll();
    if (await coveredPoint(board(id).locator('.ab-label'))) await showAll();
    await board(id).locator('.ab-label').click();
    await waitUntil(() => runtime.info().selection.ids.join() === id, `select ${id}`);
  };
  const pickNode = async (documentId, nodeId) => {
    await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards([]); });
    await pickBoard(documentId);
    await page.locator('#zoom-value').click(); await page.locator('.menu .menu-item', { hasText: 'Zoom to selection' }).first().click();
    await sleep(450);
    await page.keyboard.press('i');
    const p = await nodePoint(documentId, nodeId);
    await page.mouse.click(p.x, p.y);
    await waitUntil(() => selectedNodes()[0] === nodeId, `select ${documentId}/${nodeId}`);
  };
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const setClipboard = text => page.evaluate(value => navigator.clipboard.writeText(value), text);
  const textsOf = (document, tag) => Object.values(document.nodes).filter(node => node.type === 'element' && node.tag === tag).map(node => document.nodes[node.children[0]]?.content);

  /* ---- Agent tab ----------------------------------------------------------- */
  const openAgent = async () => { if (!(await page.locator('#agent').isVisible())) await page.locator('#open-agent').click(); await page.locator('#agent').waitFor(); };
  assert.equal(await page.locator('#open-agent').isVisible(), true);
  assert.equal(await page.locator('#dock-ask, #agent-label, .ask-button').count(), 0, 'no separate Ask button or corner chip: the Agent tab is the one home');
  await pickBoard('welcome');
  await focusCanvas();
  await page.keyboard.press('a');
  await page.locator('#agent').waitFor();
  assert.equal(await page.locator('#open-agent').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#agent .ask-about, #agent .crumbs').count(), 0, 'the composer carries no breadcrumbs: the path lives at the bottom centre');
  assert.equal(await page.locator('#crumbs button[aria-label="Select root element"]').count(), 1, 'an artboard-only context has a compact root-entry icon');
  await page.keyboard.type('Make the hero warmer');
  await page.keyboard.press('Enter');
  await waitUntil(() => asks.length === 1, 'the request reaches Pi');
  assert.deepEqual(asks[0].context.documents.map(item => item.id), ['welcome']);
  // The prompt block comes first (identity, counts, lists), then the request after a blank line.
  assert.match(asks[0].message, /^\[divlet\|project:[^|]+\|frames:1\] /);
  assert.ok(asks[0].message.endsWith('\n\nMake the hero warmer'), `the request is last (${JSON.stringify(asks[0].message.slice(-80))})`);
  await page.locator('#agent .bubble.from-user', { hasText: 'Make the hero warmer' }).waitFor();
  assert.equal(await page.locator('#agent').isVisible(), true, 'the conversation stays open after sending');
  // A host may offer more than answering prompts: with the Pi extension the board changes the session's model and thinking
  // level. An MCP client cannot, so the row is absent — never present-but-disabled.
  assert.equal(await page.locator('#agent .agent-session').isHidden(), true, 'a host without controls shows no session row');
  runtime.setAgent({ controls: { model: { value: 'anthropic/claude-sonnet-4-5', options: [{ id: 'anthropic/claude-sonnet-4-5', label: 'claude-sonnet-4-5' }, { id: 'anthropic/claude-haiku-4-5', label: 'claude-haiku-4-5' }] }, thinking: { value: 'medium', options: ['off', 'low', 'medium', 'high'] } } });
  await waitUntil(async () => (await page.locator('#agent .agent-chip').count()) === 2, 'the session chips appear for a host that offers them');
  assert.deepEqual(await page.locator('#agent .agent-chip').allInnerTexts(), ['claude-sonnet-4-5', 'medium'], 'values only, no labels');
  // One slot, two occupants: on Pi the selectors take the place of the key hints (in the same footer row), on MCP the hints stay.
  assert.equal(await page.locator('#agent .ask-hint').isHidden(), true, 'the selectors replace the hints rather than stacking under them');
  const footRow = await page.evaluate(() => {
    const chips = document.querySelector('#agent .agent-session').getBoundingClientRect();
    const send = document.querySelector('#agent .ask-send').getBoundingClientRect();
    return Math.abs((chips.y + chips.height / 2) - (send.y + send.height / 2));
  });
  assert.ok(footRow < 8, `the selectors and Send share one row (${footRow.toFixed(1)}px apart)`);
  const settingsAsked = [];
  runtime.on('agent-setting', request => settingsAsked.push(request));
  const versionBefore = runtime.info().project.version;
  await page.locator('#agent .agent-chip').nth(1).click();
  await page.locator('.menu .menu-item', { hasText: 'high' }).click();
  await waitUntil(() => settingsAsked.length === 1, 'choosing a level asks the host');
  assert.deepEqual(settingsAsked[0], { thinking: 'high' });
  runtime.setAgent({ controls: { model: { value: 'anthropic/claude-sonnet-4-5', options: [{ id: 'anthropic/claude-sonnet-4-5', label: 'claude-sonnet-4-5' }] }, thinking: { value: 'high', options: ['off', 'low', 'medium', 'high'] } } });
  await waitUntil(async () => (await page.locator('#agent .agent-chip').nth(1).innerText()) === 'high', 'and the chip shows what the host applied');
  assert.equal(runtime.info().project.version, versionBefore, 'a session setting never touches the project');
  runtime.setAgent({ controls: null });
  await waitUntil(async () => (await page.locator('#agent .agent-session').isHidden()) === true, 'and it disappears again when the host stops offering it');
  assert.equal(await page.locator('#agent .ask-hint').isVisible(), true, 'while the hints come back for a host that cannot change anything');
  check('A opens the Agent tab with the selection; Enter sends it to Pi and the request shows in the conversation');

  // Right after clicking inside a page the frame has focus: fast typing must still land in order.
  await pickNode('welcome', 'cta');
  await page.keyboard.press('a');
  await page.keyboard.type('Make it rounder, softer and calmer');
  await waitUntil(() => page.locator('#agent .ask-input').inputValue().then(value => value === 'Make it rounder, softer and calmer'), 'typed text arrives in order');
  assert.match((await page.locator('#crumbs').innerText()).replace(/\s+/g, ' '), /A space for ideas.*button#cta/);
  await page.keyboard.press('Enter');
  await waitUntil(() => asks.length === 2 && asks[1].context.nodes?.ids?.[0] === 'cta', 'the request names the element');
  asks.pop();
  check('typing right after A from inside a page keeps every character in order');

  runtime.setAgent({ busy: true, activity: 'editing “A space for ideas”' });
  await openAgent();
  await page.locator('#agent .agent-status:not([hidden])').waitFor();
  assert.match(await page.locator('#agent .agent-status-text').textContent(), /editing “A space for ideas”/);
  // One busy place, above the box; the tab shows the work as a sweep over its own label instead of a spinner that shifts it.
  const busyUi = await page.evaluate(() => {
    const plaque = document.querySelector('#agent .agent-status'), composer = document.querySelector('#agent .agent-composer'), tab = document.querySelector('#open-agent');
    const grid = getComputedStyle(plaque), stop = plaque.querySelector('.ask-stop'), position = getComputedStyle(stop);
    return {
      grid: { display: grid.display, columns: grid.gridTemplateColumns.split(' ').length, rows: grid.gridTemplateRows.split(' ').length, stopColumn: position.gridColumnStart, stopRow: position.gridRowStart },
      gap: Math.round(composer.getBoundingClientRect().top - plaque.getBoundingClientRect().bottom),
      spinner: document.querySelectorAll('#agent-busy, #agent .agent-status .spinner').length,
      sweep: getComputedStyle(tab).animationName,
      ariaBusy: tab.getAttribute('aria-busy'),
      hint: document.querySelector('#agent .ask-hint').textContent,
      label: document.querySelector('#open-agent .tool-label').textContent,
    };
  });
  assert.deepEqual(busyUi.grid, { display: 'grid', columns: 5, rows: 3, stopColumn: '5', stopRow: '3' }, 'the activity plaque is a 5×3 grid with Stop in its bottom-right cell');
  assert.ok(busyUi.gap >= 0 && busyUi.gap <= 12, `the plaque sits right above the composer (${busyUi.gap}px)`);
  assert.equal(busyUi.spinner, 1, 'the only spinner is the plaque\'s own');
  assert.equal(busyUi.sweep, 'tab-sweep', 'the tab carries a sweeping highlight');
  assert.equal(busyUi.ariaBusy, 'true');
  assert.equal(busyUi.label, 'Agent', 'and the tab label is unchanged');
  assert.equal(/Pi is|syncing/.test(busyUi.hint), false, `the hint no longer repeats the busy state (${busyUi.hint})`);
  assert.equal(await page.locator('#ask-send').textContent(), 'Queue');
  const activityNode = await page.locator('.agent-status').elementHandle();
  await page.locator('#open-agent').click();
  assert.equal(await activityNode.evaluate(node => node.parentElement.id), 'agent-status-dock', 'folding moves the original plaque above the tabs');
  await page.getByRole('button', { name: 'Stop the agent', exact: true }).waitFor();
  assert.equal(await page.locator('.agent-status').count(), 1, 'there is still only one plaque');
  assert.equal(await page.locator('.ask-stop').count(), 1, 'Stop has no second copy');
  await page.locator('#open-layers').click();
  assert.equal(await activityNode.evaluate(node => node.parentElement.id), 'agent', 'an open non-Agent pane does not get a floating duplicate');
  assert.equal(await page.getByRole('button', { name: 'Stop the agent', exact: true }).count(), 0);
  await page.locator('#open-layers').click();
  await openAgent();
  assert.equal(await activityNode.evaluate(node => node.parentElement.id), 'agent', 'opening returns that same plaque to the composer');
  await page.getByRole('button', { name: 'Stop the agent', exact: true }).focus();
  await page.keyboard.press('Enter');
  await waitUntil(() => stops === 1, 'stop from the Agent tab');
  await waitUntil(() => page.locator('#agent .agent-status-text').textContent().then(text => text.includes('stopping')), 'the status shows that Pi is stopping');
  runtime.say({ text: 'Done — the hero is **warmer** now.\nAnything else?', seq: asks[0].seq });
  runtime.setAgent({ busy: false });
  await page.locator('#agent .agent-status').waitFor({ state: 'hidden' });
  await page.locator('#agent .bubble.from-agent').first().waitFor();
  assert.match(await page.locator('#agent .bubble.from-agent .rich').first().textContent(), /Done — the hero is warmer now\./);
  await page.locator('#agent .bubble.from-user', { hasText: 'Make the hero warmer' }).waitFor();
  assert.equal(await page.locator('#activity .bubble').count(), 0, 'History holds changes only, not the conversation');
  await page.locator('#agent .bubble-about').first().click();
  await waitUntil(() => runtime.info().selection.ids.join() === 'welcome', 'the request chip selects what it was about');
  check('Pi status and Stop in the Agent tab, queued sends and the conversation there; History keeps only changes');
  await page.evaluate(async () => (await import('./lib/sidebar.js')).close());
  runtime.setAgent({ busy: true, activity: 'checking the closed-sidebar activity signal' });
  await page.locator('#agent-status-dock > .agent-status:not([hidden])').waitFor();
  assert.equal(await page.locator('#agent-status-dock .ask-stop').isVisible(), true, 'busy starting while folded must reveal Stop without opening Agent');
  await page.getByRole('button', { name: 'Stop the agent', exact: true }).focus();
  await page.keyboard.press('Enter');
  await waitUntil(() => stops === 2, 'keyboard Stop while the sidebar stays folded');
  assert.equal(await page.locator('#sidebar').evaluate(node => node.hidden), true);
  await waitUntil(() => page.locator('.agent-status-text').textContent().then(text => text.includes('stopping')), 'the moved plaque keeps the same stopping state');
  const tabsBusy = await page.locator('#side-tabs').boundingBox();
  runtime.setAgent({ busy: false });
  await page.locator('.agent-status').waitFor({ state: 'hidden' });
  assert.deepEqual(await page.locator('#side-tabs').boundingBox(), tabsBusy, 'appearing/disappearing activity never moves the tabs');
  assert.equal(await page.locator('#agent-status-dock').evaluate(node => node.childElementCount), 0, 'idle leaves no floating shell');
  check('one activity plaque moves between Agent and the folded sidebar footer, with working keyboard Stop and no idle shell');

  await focusCanvas();
  await page.keyboard.press('a');
  await openAgent();
  await page.locator('#agent .ask-input').press('ArrowUp');
  assert.equal(await page.locator('#agent .ask-input').inputValue(), 'Make it rounder, softer and calmer');
  await page.locator('#agent .ask-input').press('ArrowUp');
  assert.equal(await page.locator('#agent .ask-input').inputValue(), 'Make the hero warmer');
  // Nothing selected: the request is about the whole project.
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards([]); });
  await page.locator('#agent .ask-input').fill('Plan a pricing page');
  await page.locator('#ask-send').click();
  await waitUntil(() => asks.length === 2, 'second request');
  assert.equal(asks[1].context.documents.length, 0);
  runtime.setAgent({ connected: false });
  await waitUntil(() => page.locator('#agent .ask-input').isDisabled(), 'the composer is disabled without an agent');
  await focusCanvas();
  await page.keyboard.press('a');
  await page.locator('#toast', { hasText: 'No agent is connected to this board' }).waitFor();
  runtime.setAgent({ connected: true });
  await waitUntil(() => page.locator('#agent .ask-input').isEnabled(), 'the composer is enabled again');
  check('↑ recalls requests, a request without a selection is about the whole project, the composer is disabled without an agent');

  /* ---- search and commands ------------------------------------------------ */
  await focusCanvas();
  await page.keyboard.press('Control+k');
  await page.locator('#palette:not([hidden])').waitFor();
  await page.keyboard.type('zoom to 100');
  await page.keyboard.press('Enter');
  await waitUntil(() => page.locator('#zoom-value').textContent().then(text => text === '100%'), 'palette runs zoom to 100%');
  await page.locator('#palette-open').click();
  await page.keyboard.type('theme dark');
  await page.keyboard.press('Enter');
  await waitUntil(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'palette switches the theme');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('theme auto');
  await page.keyboard.press('Enter');
  await pickBoard('plain-css');
  const before = ids();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('duplicate artboard');
  await page.keyboard.press('Enter');
  await waitUntil(() => ids().length === before.length + 1, 'palette duplicates the artboard');
  const copy = ids().find(id => !before.includes(id));
  await waitUntil(() => runtime.info().selection.ids.join() === copy, 'the copy is selected');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('delete artboard');
  await page.keyboard.press('Enter');
  await waitUntil(() => !ids().includes(copy), 'palette deletes the artboard');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('make the footer quieter please');
  assert.equal(await page.locator('.palette-item.on').getAttribute('class').then(value => value.includes('pal-ask')), true);
  await page.keyboard.press('Enter');
  await waitUntil(() => asks.length === 3 && asks[2].text === 'make the footer quieter please', 'palette asks Pi');
  await pickBoard('welcome');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('#cta');
  await page.locator('.palette-item', { hasText: 'Start exploring' }).first().click();
  await waitUntil(() => selectedNodes()[0] === 'cta', 'palette selects an element');
  check('Ctrl+K and the Search pill: commands, theme, duplicate/delete, Ask Pi, elements');

  /* ---- clipboard ---------------------------------------------------------- */
  await focusCanvas();
  await page.keyboard.press('Control+c');
  await page.locator('#toast', { hasText: 'Copied <button>' }).waitFor();
  assert.match(await clipboard(), /^<button type="button" class="[^"]+">Start exploring/);
  await pickBoard('plain-css');
  await focusCanvas();
  await page.keyboard.press('Control+v');
  await waitUntil(() => textsOf(doc('plain-css'), 'button').includes('Start exploring  ↗'), 'paste the copied element into another frame');
  const pasted = await waitUntil(() => { const id = selectedNodes()[0]; return doc('plain-css').nodes[id]?.tag === 'button' && id; }, 'the pasted element is selected');
  await focusCanvas();
  await page.keyboard.press('Control+x');
  await waitUntil(() => !doc('plain-css').nodes[pasted], 'cut removes it');
  await pickBoard('plain-css');
  await focusCanvas();
  await page.keyboard.press('Control+v');
  await waitUntil(() => textsOf(doc('plain-css'), 'button').includes('Start exploring  ↗'), 'paste after cut');
  await setClipboard('<section class="p-4"><h2>Pasted heading</h2><p onclick="x()">From HTML</p></section>');
  await pickBoard('plain-css');
  await focusCanvas();
  await page.keyboard.press('Control+v');
  await waitUntil(() => textsOf(doc('plain-css'), 'h2').includes('Pasted heading'), 'paste HTML');
  await setClipboard('A pasted paragraph');
  await pickBoard('plain-css');
  await focusCanvas();
  await page.keyboard.press('Control+v');
  await waitUntil(() => textsOf(doc('plain-css'), 'p').includes('A pasted paragraph'), 'paste plain text');
  check('Ctrl+C / Ctrl+X / Ctrl+V of elements across frames, HTML and text paste');

  const artboardCopyBase = ids();
  await page.evaluate(async () => {
    const actions = await import('./lib/actions.js'), lifecycle = await import('./lib/artboards.js');
    for (const name of ['newArtboard', 'duplicateArtboards', 'deleteArtboards']) if (actions[name] !== lifecycle[name]) throw new Error(`Lifecycle alias changed: ${name}`);
    (await import('./lib/store.js')).selectArtboards(['components', 'pricing']);
  });
  await focusCanvas(); await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v');
  await waitUntil(() => ids().length === artboardCopyBase.length + 2, 'clipboard duplicates both artboards');
  const pastedArtboards = ids().filter(id => !artboardCopyBase.includes(id));
  await waitUntil(() => runtime.info().selection.ids.join() === pastedArtboards.join(), 'pasted artboards are selected together');
  await focusCanvas(); await page.keyboard.press('Control+z');
  await waitUntil(() => ids().join() === artboardCopyBase.join(), 'one Undo removes the grouped pasted artboards');
  check('artboard clipboard uses the shared lifecycle commands and one undo group; facade exports retain function identity');

  const deleteBase = ids(), refusedFrame = doc('components'), removedFrame = doc('plain-css');
  const deleteRequests = [];
  const recordDelete = request => { if (request.url().endsWith('/api/artboards/delete')) deleteRequests.push(request.postDataJSON()); };
  await waitUntil(async () => (await page.evaluate(async () => (await import('./lib/store.js')).descriptor('plain-css')?.version)) === removedFrame.version, 'restored frame version is visible before deletion');
  page.on('request', recordDelete);
  let deletionMessages;
  try {
    deletionMessages = await page.evaluate(async () => {
      const m = await import('./lib/store.js'), messages = [];
      const stop = m.on('toast', event => messages.push(event.message));
      try { await (await import('./lib/actions.js')).deleteArtboards(['components', 'plain-css']); return messages; }
      finally { stop(); }
    });
  } finally { page.off('request', recordDelete); }
  assert.deepEqual(ids(), deleteBase.filter(id => id !== 'plain-css'));
  assert.deepEqual(doc('components'), refusedFrame, 'a refused component library remains unchanged');
  assert.ok(deletionMessages.some(message => /components used by/.test(message)), 'the component refusal is still reported');
  assert.equal(deletionMessages.at(-1), `“${removedFrame.name}” deleted`, 'success names the accepted deletion, not the refused first request');
  assert.deepEqual(deleteRequests.map(request => [request.documentId, request.expectedVersion]), [['components', refusedFrame.version], ['plain-css', removedFrame.version]], 'optimistic hiding does not discard version guards');
  await page.locator('#toast .toast-action', { hasText: 'Undo' }).click();
  await waitUntil(() => ids().join() === deleteBase.join(), 'one toast Undo restores only the accepted deletion in its original slot');
  assert.deepEqual(doc('components'), refusedFrame);
  assert.deepEqual(doc('plain-css').nodes, removedFrame.nodes);
  await waitUntil(async () => !(await page.evaluate(async () => (await import('./lib/store.js')).store.leaving.has('components'))), 'the refused frame is no longer optimistically hidden');
  check('mixed component refusal and successful deletion report the accepted frame and preserve versions, visibility and grouped toast Undo');

  let releaseDelete, heldDelete;
  const deleteGate = new Promise(resolve => { releaseDelete = resolve; });
  const holdDelete = async route => { heldDelete = route.request().postDataJSON(); await deleteGate; await route.continue(); };
  await waitUntil(async () => (await page.evaluate(async () => (await import('./lib/store.js')).descriptor('plain-css')?.version)) === doc('plain-css').version, 'the restored version reaches the client');
  const guardedVersion = doc('plain-css').version;
  await page.route('**/api/artboards/delete', holdDelete);
  let deleteCommand;
  try {
    deleteCommand = page.evaluate(async () => {
      const m = await import('./lib/store.js'), messages = [];
      const stop = m.on('toast', event => messages.push(event.message));
      try { await (await import('./lib/actions.js')).deleteArtboards(['plain-css']); return messages; }
      finally { stop(); }
    });
    await waitUntil(() => heldDelete !== undefined, 'the actual deletion request is held');
    await runtime.patch({ documentId: 'plain-css', expectedVersion: doc('plain-css').version, patch: { metadata: { peerDuringDelete: true } } });
    const peerFrame = structuredClone(doc('plain-css')), peerRevision = runtime.revision, peerDepth = runtime.undoStack.length;
    releaseDelete();
    const messages = await deleteCommand;
    assert.equal(heldDelete.expectedVersion, guardedVersion, 'deletion retains its observed version after hiding');
    assert.ok(messages.some(message => /Expected frame version/.test(message)), 'a peer edit forces an explicit stale-version refusal');
    assert.ok(!messages.some(message => /deleted$/.test(message)), 'a wholly refused command cannot announce success or offer its Undo');
    assert.deepEqual(doc('plain-css'), peerFrame); assert.equal(runtime.revision, peerRevision); assert.equal(runtime.undoStack.length, peerDepth);
    await waitUntil(async () => !(await page.evaluate(async () => (await import('./lib/store.js')).store.leaving.has('plain-css'))), 'stale refusal restores frame visibility');
  } finally { releaseDelete(); await deleteCommand; await page.unroute('**/api/artboards/delete', holdDelete); }
  check('a held deletion cannot discard a concurrent peer edit, create an Undo step or leave the refused frame hidden');

  const dependencyDeleteBase = ids();
  deleteRequests.length = 0;
  page.on('request', recordDelete);
  try { await page.evaluate(async () => (await import('./lib/actions.js')).deleteArtboards(['components', 'pricing'])); }
  finally { page.off('request', recordDelete); }
  assert.deepEqual(deleteRequests.map(request => request.documentId), ['pricing', 'components'], 'component consumers are deleted before the library, regardless of request order');
  assert.deepEqual(ids(), dependencyDeleteBase.filter(id => !['components', 'pricing'].includes(id)));
  await page.locator('#toast', { hasText: '2 artboards deleted' }).waitFor();
  await page.locator('#toast .toast-action', { hasText: 'Undo' }).click();
  await waitUntil(() => ids().join() === dependencyDeleteBase.join(), 'one Undo restores library and consumer in source order');
  assert.deepEqual(doc('components').nodes, refusedFrame.nodes);
  check('multi-delete keeps dependency order, accepted success count and one grouped Undo for component library plus consumer');

  let releaseOverlap, overlapRequests = 0;
  const overlapGate = new Promise(resolve => { releaseOverlap = resolve; });
  const holdOverlap = async route => { overlapRequests++; if (overlapRequests === 1) await overlapGate; await route.continue(); };
  await waitUntil(async () => (await page.evaluate(async () => (await import('./lib/store.js')).descriptor('plain-css')?.version)) === doc('plain-css').version, 'the peer-edited frame is ready before overlap');
  await page.route('**/api/artboards/delete', holdOverlap);
  let firstDelete;
  try {
    firstDelete = page.evaluate(async () => (await import('./lib/actions.js')).deleteArtboards(['plain-css']));
    await waitUntil(() => overlapRequests === 1, 'first overlapping request is held');
    await runtime.patch({ documentId: 'plain-css', expectedVersion: doc('plain-css').version, patch: { metadata: { overlappingPeer: true } } });
    const peerFrame = structuredClone(doc('plain-css')), peerRevision = runtime.revision, peerDepth = runtime.undoStack.length;
    await page.evaluate(async () => (await import('./lib/actions.js')).deleteArtboards(['plain-css', 'missing-frame']));
    assert.equal(overlapRequests, 1, 'hidden or absent targets must not send an unguarded second delete');
    assert.equal(await page.evaluate(async () => (await import('./lib/store.js')).store.leaving.has('plain-css')), true, 'the second call does not release the first call visibility reservation');
    assert.equal(await page.evaluate(async () => (await import('./lib/store.js')).store.leaving.has('missing-frame')), false, 'an absent target cannot leak a visibility reservation');
    releaseOverlap(); await firstDelete;
    assert.deepEqual(doc('plain-css'), peerFrame); assert.equal(runtime.revision, peerRevision); assert.equal(runtime.undoStack.length, peerDepth);
    await waitUntil(async () => !(await page.evaluate(async () => (await import('./lib/store.js')).store.leaving.has('plain-css'))), 'the first refused deletion releases its own visibility reservation');
  } finally { releaseOverlap(); await firstDelete; await page.unroute('**/api/artboards/delete', holdOverlap); }
  check('overlapping or absent deletion targets cannot bypass version guards, overwrite peers or steal/leak optimistic visibility');

  /* ---- export ------------------------------------------------------------- */
  await pickBoard('welcome');
  const label = await board('welcome').locator('.ab-label').boundingBox();
  await page.mouse.click(label.x + 30, label.y + label.height / 2, { button: 'right' });
  await menuItem('Copy HTML').click();
  await waitUntil(async () => /^<!doctype html>[\s\S]*--accent: #d7b474;[\s\S]*Make room for/.test(await clipboard()), 'page HTML on the clipboard');
  await page.mouse.click(label.x + 30, label.y + label.height / 2, { button: 'right' });
  const [download] = await Promise.all([page.waitForEvent('download'), menuItem('Download HTML').click()]);
  assert.equal(download.suggestedFilename(), 'welcome.html');
  check('artboard menu: Copy HTML and Download HTML');

  /* ---- images ------------------------------------------------------------- */
  await pickBoard('plain-css');
  await page.locator('#dock [data-mode="select"]').click();
  await page.evaluate(png => {
    const bytes = Uint8Array.from(atob(png), ch => ch.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'Dropped Photo.png', { type: 'image/png' }));
    const target = document.querySelector('.artboard[data-artboard-id="plain-css"] .frame-cover');
    for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
  }, PNG);
  await waitUntil(() => Object.values(doc('plain-css').nodes).some(node => node.tag === 'img' && node.attrs.src === 'asset:images/dropped-photo.png'), 'dropping an image adds an <img>');
  assert.ok(!(await readdir(path.join(cwd, 'assets')).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).includes('dropped-photo.png'));
  assert.equal(runtime.settings.assets.images['dropped-photo.png'], `data:image/png;base64,${PNG}`);
  const uploadedId = Object.values(doc('plain-css').nodes).find(node => node.attrs?.src === 'asset:images/dropped-photo.png').id;
  await focusCanvas(); await page.keyboard.press('Control+z');
  await waitUntil(() => !doc('plain-css').nodes[uploadedId] && !runtime.settings.assets.images?.['dropped-photo.png'], 'one Undo removes the image and its new project bytes');
  await page.keyboard.press('Control+Shift+z');
  await waitUntil(() => !!doc('plain-css').nodes[uploadedId] && !!runtime.settings.assets.images?.['dropped-photo.png'], 'one Redo restores image and bytes');
  // Redo restores content, not ephemeral selection; this 1px image is selected through the actual UI store.
  await page.evaluate(async id => { const store = await import('./lib/store.js'); await store.loadModel('plain-css'); store.selectNodes('plain-css', [id]); }, uploadedId);
  await waitUntil(() => doc('plain-css').nodes[selectedNodes()[0]]?.tag === 'img', 'the image is selected');
  await page.locator('#inspector [data-key="image-alt"]').fill('A tiny test pattern');
  await page.keyboard.press('Enter');
  await waitUntil(() => Object.values(doc('plain-css').nodes).some(node => node.attrs?.alt === 'A tiny test pattern'), 'alt text');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#inspector .image-buttons button', { hasText: 'Upload' }).click()]);
  await chooser.setFiles({ name: 'second.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
  await waitUntil(() => Object.values(doc('plain-css').nodes).some(node => node.attrs?.src === 'asset:images/second.png'), 'upload replaces the source');
  await page.locator('#inspector [data-key="image-replace"]').click();
  await menuItem('images/dropped-photo.png').click();
  await waitUntil(() => Object.values(doc('plain-css').nodes).some(node => node.tag === 'img' && node.attrs.src === 'asset:images/dropped-photo.png'), 'replace picks a local image');
  await focusCanvas(); await page.keyboard.press('Control+c');
  await waitUntil(async () => (await clipboard()).includes(`data:image/png;base64,${PNG}`), 'declared image clipboard HTML embeds bytes, not a project URI or capability');
  assert.ok(!(await clipboard()).includes('asset:') && !(await clipboard()).includes(runtime.url));
  await setClipboard(`<img alt="external literal" src="data:image/png;base64,${PNG}">`);
  await page.keyboard.press('Control+v');
  await waitUntil(() => Object.values(doc('plain-css').nodes).some(node => node.attrs?.alt === 'external literal' && node.attrs.src === `data:image/png;base64,${PNG}`), 'foreign clipboard image bytes remain a literal Data URL');
  const beforeForeign = doc('plain-css');
  await setClipboard('<span style="background:url(asset:images/dropped-photo.png)">foreign namespace</span>');
  const refusedNamespace = page.waitForResponse(response => response.url().endsWith('/api/edit') && response.request().method() === 'POST');
  await focusCanvas(); await page.keyboard.press('Control+v');
  assert.equal((await refusedNamespace).status(), 400);
  assert.deepEqual(doc('plain-css'), beforeForeign, 'foreign inline CSS cannot borrow a receiving project declaration');
  check('native image upload/replace, grouped history, portable clipboard, literal image paste and foreign namespace refusal');

  /* ---- components --------------------------------------------------------- */
  await pickNode('pricing', 'pro');
  await page.locator('#inspector .instance-head').waitFor();
  await page.locator('#inspector .instance-name', { hasText: 'Card/Plan' }).waitFor();
  await page.locator('#inspector [data-key="override:plan-price-text"]').fill('$15');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc('pricing').nodes.pro.descendants['plan-price-text']?.content === '$15', 'override a text of an instance');
  await waitUntil(() => frameOf('pricing').evaluate(() => document.body.textContent.includes('$15')), 'the instance shows the override');
  await page.locator('#inspector .kv.override button[aria-label="Back to the component text"]').first().click();
  await waitUntil(() => !doc('pricing').nodes.pro.descendants['plan-name-text'], 'reset one override');
  await page.locator('#inspector [data-key="go-to-component"]').click();
  await waitUntil(() => runtime.info().selection.ids.join() === 'components' && selectedNodes()[0] === 'plan', 'go to the component');
  await page.locator('#inspector .component-mark').waitFor();
  check('instance inspector: override, reset one, go to the component');

  const priceBefore = await frameOf('pricing').evaluate(() => document.querySelector('[data-divlet-id="starter"]').className);
  await runtime.patch({ documentId: 'components', expectedVersion: doc('components').version, patch: { nodes: { plan: { className: `${doc('components').nodes.plan.className} ring-1 ring-white/20` } } }, actor: 'agent' });
  await waitUntil(() => frameOf('pricing').evaluate(() => document.querySelector('[data-divlet-id="starter"]').className.includes('ring-white/20')), 'instances follow their component');
  assert.ok(!priceBefore.includes('ring-white/20'));
  await page.keyboard.press('Escape');
  const team = await nodePoint('pricing', 'team');
  await page.locator('#dock [data-mode="select"]').click();
  await pickBoard('pricing');
  await page.locator('#zoom-value').click(); await page.locator('.menu .menu-item', { hasText: 'Zoom to selection' }).first().click();
  await sleep(450);
  await page.keyboard.press('i');
  const price = await frameOf('pricing').evaluate(() => { const r = document.querySelector('[data-divlet-in="team"][data-divlet-at="plan-price"]').getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; });
  const outer = await page.evaluate(() => { const f = document.querySelector('iframe[data-document-id="pricing"]'); const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, k: r.width / f.offsetWidth }; });
  void team;
  await page.mouse.dblclick(outer.x + price.x * outer.k, outer.y + price.y * outer.k);
  await waitUntil(() => frameOf('pricing').evaluate(() => document.querySelector('[data-divlet-in="team"][data-divlet-at="plan-price"]')?.isContentEditable), 'double-click edits text inside an instance');
  await page.keyboard.type('Free');
  await page.keyboard.press('Control+Enter');
  await waitUntil(() => doc('pricing').nodes.team.descendants['plan-price-text']?.content === 'Free', 'the edit becomes an override of that instance');
  assert.equal(doc('components').nodes['plan-price-text'].content, '$0');
  check('editing a component re-renders instances; typing inside an instance overrides it');

  await pickNode('welcome', 'cta');
  let p = await nodePoint('welcome', 'cta');
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await menuItem('Make component').click();
  await waitUntil(() => doc('welcome').nodes.cta.reusable === true, 'make component');
  await pickBoard('plain-css');
  // (an earlier search result may already have opened the Layers sidebar)
  if (!(await page.locator('#layers-add').isVisible())) await page.keyboard.press('l');
  await page.locator('#layers-add').click();
  await page.locator('.menu .menu-item', { has: page.locator('.menu-label', { hasText: /^cta$/ }) }).click();
  await waitUntil(() => Object.values(doc('plain-css').nodes).some(node => node.type === 'ref' && node.ref === 'welcome/cta'), 'insert an instance from Add element');
  const instance = Object.values(doc('plain-css').nodes).find(node => node.type === 'ref').id;
  await page.locator(`#layers .node[data-node-id="${instance}"]`).click();
  await page.locator('#inspector .link-button', { hasText: 'Detach' }).click();
  await waitUntil(() => doc('plain-css').nodes[instance]?.type === 'element', 'detach the instance');
  await page.keyboard.press('l');
  await pickNode('welcome', 'cta');
  p = await nodePoint('welcome', 'cta');
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await menuItem('Stop being a component').click();
  await waitUntil(() => !doc('welcome').nodes.cta.reusable, 'stop being a component');
  check('make component, insert an instance from Add element, detach, stop being a component');

  /* ---- history and canvas ------------------------------------------------- */
  await pickBoard('mobile');
  await focusCanvas();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await waitUntil(() => runtime.readHistory().changes.filter(change => change.label === 'nudge artboard').length === 3, 'three nudges');
  await page.keyboard.press('h');
  await page.locator('#activity .history-log summary').click();
  await page.locator('#activity .change .times', { hasText: '×3' }).waitFor();
  await page.keyboard.press('h');
  check('History folds one gesture into one row (×3)');

  await pickNode('welcome', 'cta');
  const zoom = Number((await page.locator('#zoom-value').textContent()).replace('%', ''));
  await focusCanvas();
  await page.keyboard.press('f');
  await waitUntil(async () => Number((await page.locator('#zoom-value').textContent()).replace('%', '')) > zoom, 'F zooms to the element');
  check('F zooms to the selected element');

  /* ---- one Select tool ---------------------------------------------------- */
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards([]); });
  await pickNode('welcome', 'cta');
  await sleep(500);
  await page.keyboard.press('Escape');
  await waitUntil(() => selectedNodes()[0] === 'hero', 'Esc selects the parent');
  for (let i = 0; i < 4 && selectedNodes().length; i++) { await page.keyboard.press('Escape'); await sleep(150); }
  await waitUntil(() => !selectedNodes().length && runtime.info().selection.ids.join() === 'welcome', 'Esc climbs to the artboard');
  assert.equal(await page.locator('#dock [data-mode]').count(), 2, 'two tools: select and interact');
  check('Select picks elements and artboards; Esc climbs element → parent → artboard');

  /* ---- layout tools write Tailwind classes --------------------------------- */
  await pickBoard('welcome');
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectNodes('welcome', ['nav']); });
  await waitUntil(() => selectedNodes()[0] === 'nav', 'nav selected');
  const navClasses = () => doc('welcome').nodes.nav.className.split(' ');
  await page.locator('#inspector button[aria-label="Align children top right"]').click();
  await waitUntil(() => navClasses().includes('justify-end') && navClasses().includes('items-start') && !navClasses().includes('justify-between'), 'alignment grid sets justify and items');
  await page.locator('#inspector [data-key="pick:Align"]').click();
  await menuItem('Stretch').click();
  await waitUntil(() => navClasses().includes('items-stretch') && !navClasses().includes('items-start'), 'Align → Stretch stretches the children across');
  await page.locator('#inspector [data-key="pick:Justify"]').click();
  await menuItem('Evenly').click();
  await waitUntil(() => navClasses().includes('justify-evenly') && !navClasses().includes('justify-end'), 'Justify → Evenly');
  await page.locator('#inspector [data-key="pick:Justify"]').click();
  await menuItem('Around').click();
  await waitUntil(() => navClasses().includes('justify-around'), 'Justify → Around');
  await page.locator('#inspector [data-key="pick:Align"]').click();
  await menuItem('Baseline').click();
  await waitUntil(() => navClasses().includes('items-baseline'), 'Align → Baseline');
  await page.locator('#inspector button[aria-label="Align children top right"]').click();
  await waitUntil(() => navClasses().includes('justify-end') && navClasses().includes('items-start'), 'the 3×3 pad takes over again');
  await page.locator('#inspector [data-key="p-t"]').fill('16');
  await page.keyboard.press('Enter');
  await waitUntil(() => navClasses().includes('pt-4'), 'padding top 16px is pt-4');
  await page.locator('#inspector [data-key="p-l"]').fill('13');
  await page.keyboard.press('Enter');
  await waitUntil(() => navClasses().includes('pl-[13px]'), 'an off-scale value becomes an arbitrary one');
  await page.locator('#inspector [data-key="opacity"]').fill('50');
  await page.keyboard.press('Enter');
  await waitUntil(() => navClasses().includes('opacity-50'), 'opacity');
  await sleep(300);
  await page.locator('#inspector [data-key="z"]').fill('3');
  await page.keyboard.press('Enter');
  await waitUntil(() => navClasses().includes('opacity-50') && navClasses().includes('z-3'), 'opacity and z-index');
  assert.equal(runtime.readHistory().changes.at(-1).actor, 'user');
  await page.locator('#inspector [data-key="pick:Position"]').click();
  await menuItem('Absolute').click();
  await waitUntil(() => navClasses().includes('absolute'), 'position menu');
  await page.locator('#inspector button[aria-label="Pin to top right"]').click();
  await waitUntil(() => navClasses().includes('right-0') && navClasses().includes('top-0'), 'pin grid writes inset classes');
  await page.locator('#inspector [data-key="pick:Display"]').click();
  await menuItem('Grid').click();
  await waitUntil(() => navClasses().includes('grid') && !navClasses().includes('flex'), 'display menu replaces flex');
  await page.keyboard.press('Control+z');
  await waitUntil(() => navClasses().includes('flex') && !navClasses().includes('grid'), 'each tool change is one undo step');
  check('layout tools: align, pin, padding, margin, position, display, opacity, z-index write classes');

  // The same fields change several elements at once.
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectNodes('welcome', ['nav', 'footer']); });
  await page.locator('#inspector .count', { hasText: 'elements selected' }).waitFor();
  await sleep(400);
  await page.locator('#inspector [data-key="opacity"]').fill('80');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc('welcome').nodes.nav.className.includes('opacity-80') && doc('welcome').nodes.footer.className.includes('opacity-80'), 'a multi-selection changes every element');
  check('with several elements selected, shared fields change all of them');

  /* ---- attributes --------------------------------------------------------- */
  await pickNode('welcome', 'cta');
  await page.locator('#inspector .quick-attrs .chip', { hasText: 'aria-label' }).click();
  await page.keyboard.type('Start now');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc('welcome').nodes.cta.attrs['aria-label'] === 'Start now', 'quick attribute chip + value');
  const nameField = page.locator('#inspector [data-key="attr-new-key"]');
  await nameField.click();
  await page.keyboard.type('ro');
  await page.locator('.suggest-item', { hasText: 'role' }).first().waitFor();
  await page.keyboard.press('Tab');
  await page.locator('.suggest-item', { hasText: 'button' }).first().waitFor();
  await page.keyboard.press('Tab');
  await waitUntil(() => doc('welcome').nodes.cta.attrs.role === 'button', 'name and value complete with Tab');
  check('attributes: quick chips for the tag, name and value suggestions');

  /* ---- custom CSS is laid out and colored ---------------------------------- */
  await pickBoard('plain-css');
  await page.locator('#inspector .code-ta').waitFor();
  assert.match(await page.locator('#inspector .code-ta').inputValue(), /\{\n {2}\S/);
  assert.ok(await page.locator('#inspector .code-hl .syn-prop').count() > 0);
  assert.ok(await page.locator('#inspector .code-hl .syn-class').count() > 0);
  await page.locator('#inspector .code-ta').fill('.x{color:red;margin:0 auto}');
  await page.locator('#inspector .code-ta').blur();
  await waitUntil(() => doc('plain-css').css === '.x {\n  color: red;\n  margin: 0 auto;\n}\n', 'css is formatted when committed');
  check('custom CSS: formatted on commit, syntax colors');

  /* ---- the middle button pans, in every tool but Interact ------------------ */
  await showAll();
  const probe = board('welcome');
  const box = await probe.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx - 90, cy - 40, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  const moved = await probe.boundingBox();
  assert.ok(Math.abs(moved.x - (box.x - 90)) < 2 && Math.abs(moved.y - (box.y - 40)) < 2, 'middle drag over a page pans the canvas');
  await page.mouse.move(40, 600);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(70, 620, { steps: 3 });
  await page.mouse.up({ button: 'middle' });
  assert.equal(runtime.read({ view: 'document', documentId: 'welcome' }).artboard.x, runtime.info().documents.find(item => item.id === 'welcome').artboard.x, 'panning never edits artboards');
  check('middle button pans the canvas over pages and empty space');

  /* ---- shortcuts and settings ---------------------------------------------- */
  await page.keyboard.press('Escape');
  await focusCanvas();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ф', code: 'KeyA', bubbles: true })));
  await page.locator('#agent').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#agent').waitFor({ state: 'hidden' });
  await page.locator('#dock-help').click();
  assert.equal((await page.locator('#help h2').textContent()).trim(), 'Settings');
  await page.locator('#help .seg[data-theme="light"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.locator('#help .seg[data-theme="auto"]').click();
  await page.keyboard.press('Escape');
  check('shortcuts follow the key, not the layout (Ф = A); the gear opens settings with theme');

  /* ---- double-click edits what is under the pointer ------------------------- */
  const t0 = doc('welcome');
  await runtime.patch({ documentId: 'welcome', expectedVersion: t0.version, patch: { nodes: {
    'title-em-text': { id: 'title-em-text', type: 'text', content: ' (accent)' },
    'title-em': { id: 'title-em', type: 'element', tag: 'span', className: 'text-amber-300', children: ['title-em-text'] },
    photo: { id: 'photo', type: 'element', tag: 'img', className: 'block h-16 w-32 bg-white/20', attrs: { alt: 'A photo' }, children: [] },
    title: { children: [...t0.nodes.title.children, 'title-em'] },
    hero: { children: [...t0.nodes.hero.children, 'photo'] },
  } } });
  await runtime.saveAsset({ name: 'photo.png', data: Buffer.from(PNG, 'base64') });
  await pickNode('welcome', 'cta');
  await sleep(600);
  const titleBox = await frameOf('welcome').evaluate(() => { const r = document.querySelector('[data-divlet-id="title"]').getBoundingClientRect(); return { x: r.x + 24, y: r.y + Math.min(r.height / 2, 14) }; });
  const frameOuter = await page.evaluate(() => { const f = document.querySelector('iframe[data-document-id="welcome"]'); const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, k: r.width / f.offsetWidth }; });
  await page.mouse.click(frameOuter.x + titleBox.x * frameOuter.k, frameOuter.y + titleBox.y * frameOuter.k);
  await sleep(200);
  await page.mouse.click(frameOuter.x + titleBox.x * frameOuter.k, frameOuter.y + titleBox.y * frameOuter.k);
  await waitUntil(() => frameOuter && frameOf('welcome').evaluate(() => document.querySelector('[contenteditable]')?.textContent.length > 3), 'double-click edits the heading text even with an element inside it');
  await page.keyboard.type('Brand new headline');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc('welcome').nodes['title-text'].content === 'Brand new headline', 'the text part under the pointer is edited on its own');
  assert.equal(doc('welcome').nodes['title-em-text'].content, ' (accent)', 'the element inside is untouched');
  await sleep(500);
  const photo = await nodePoint('welcome', 'photo');
  await page.mouse.click(photo.x, photo.y);
  await sleep(200);
  await page.mouse.click(photo.x, photo.y);
  await waitUntil(() => page.evaluate(() => document.activeElement?.dataset.key), 'double-click on an image focuses its source field').then(key => assert.equal(key, 'attr-new-value'));
  assert.equal(await page.evaluate(() => document.querySelector('[data-key="attr-new-key"]').value), 'src');
  await page.keyboard.type('asset:images/photo.png');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc('welcome').nodes.photo.attrs.src === 'asset:images/photo.png', 'the typed address becomes the image source');
  check('double-click edits the text under the pointer (also among child elements); on an image it asks for the source');

  /* ---- the Ask Pi context is a path you can walk ------------------------------ */
  await pickNode('welcome', 'cta');
  await focusCanvas();
  await page.locator('#crumbs:not([hidden])').waitFor();
  assert.match((await page.locator('#crumbs').innerText()).replace(/\s+/g, ' '), /A space for ideas.*button#cta/);
  await page.locator('#crumbs .crumb', { hasText: 'section' }).first().click();
  await waitUntil(() => selectedNodes()[0] === 'hero', 'a crumb above the dock re-selects that container');
  await page.locator('#crumbs .crumb', { hasText: 'A space for ideas' }).click();
  await waitUntil(() => !selectedNodes().length, 'the artboard crumb selects the artboard');
  await waitUntil(async () => (await page.locator('#crumbs .crumb').count()) === 1, 'at the artboard the path folds to one root-entry crumb');
  await pickNode('welcome', 'cta');
  await focusCanvas();
  await page.keyboard.press('a');
  await page.locator('#agent').waitFor();
  assert.equal(await page.locator('#crumbs .crumb', { hasText: 'button#cta' }).count(), 1, 'with room, the path also stays between the sidebar and the tools; it is never in more than these two places');
  assert.equal(await page.locator('#inspector .crumbs').count(), 0, 'the inspector no longer repeats the path');
  const crumbs = () => page.locator('#crumbs .crumb').allInnerTexts();
  await waitUntil(async () => (await crumbs()).some(text => text.includes('button#cta')), 'the path ends at the selected element');
  assert.deepEqual((await crumbs()).slice(0, 2).map(text => text.trim()).filter(Boolean).length > 0, true);
  await page.locator('#crumbs .crumb', { hasText: 'section' }).first().click();
  await waitUntil(() => selectedNodes()[0] === 'hero', 'a crumb points Pi at that container (and selects it)');
  await waitUntil(async () => (await page.locator('#crumbs .crumb.current').innerText()).includes('section#hero'), 'the last crumb is the new context');
  await page.locator('#crumbs .home').click();
  await waitUntil(() => !selectedNodes().length, 'the artboard crumb widens the context to the whole artboard');
  assert.equal(await page.locator('#agent .crumb-x, #crumbs .crumb-x').count(), 0, 'no × in either place: the artboard crumb is the way back up');
  assert.equal(await page.locator('#crumbs .crumb').count(), 1, 'at the artboard the path is folded');
  assert.equal(await page.locator('#crumbs [aria-label="Select root element"]').innerText(), '', 'the collapsed root entry is icon-only');
  await page.keyboard.press('Escape');
  check('the path sits in the bottom row between the sidebar tabs and the tools, and the Agent tab shows the same crumbs (no ×); crumbs walk up and widen the context');

  /* ---- the element ID can be edited --------------------------------------- */
  await pickNode('welcome', 'cta');
  assert.equal(await page.locator('#inspector [data-key="node-id"]').inputValue(), 'cta');
  await page.locator('#inspector [data-key="node-id"]').fill('start-button');
  await page.keyboard.press('Enter');
  await waitUntil(() => doc('welcome').nodes['start-button'] && !doc('welcome').nodes.cta, 'the node has its new ID');
  assert.ok(doc('welcome').nodes.hero.children.includes('start-button'), 'the parent follows');
  await waitUntil(() => selectedNodes()[0] === 'start-button', 'the selection follows the rename');
  await waitUntil(() => page.locator('#inspector [data-key="node-id"]').inputValue().then(value => value === 'start-button'), 'the field shows the new ID');
  await page.locator('#inspector [data-key="node-id"]').fill('9bad id');
  await page.keyboard.press('Enter');
  await page.locator('#toast', { hasText: 'not a valid ID' }).waitFor();
  assert.equal(await page.locator('#inspector [data-key="node-id"]').inputValue(), 'start-button');
  await page.keyboard.press('Control+z');
  await waitUntil(() => doc('welcome').nodes.cta && !doc('welcome').nodes['start-button'], 'undo gives the old ID back');
  check('the element ID is an editable field: rename, validation, selection follows, undo');

  /* ---- deleting an artboard from its right-click menu --------------------- */
  await pickBoard('plain-css');
  const pcBox = await board('plain-css').boundingBox();
  await page.mouse.click(pcBox.x + pcBox.width / 2, pcBox.y + pcBox.height / 2, { button: 'right' });
  await menuItem('Delete artboard').click();
  await waitUntil(() => !ids().includes('plain-css'), 'the menu deletes the artboard');
  await page.keyboard.press('Control+z');
  await waitUntil(() => ids().includes('plain-css'), 'undo brings it back');
  check('right-click on a selected artboard offers Delete (undoable)');

  /* ---- the agent marks where it works --------------------------------------- */
  runtime.setAgent({ connected: true, busy: true, activity: 'planning' });
  assert.throws(() => runtime.markWork({ documentId: 'welcome', nodeIds: ['nope'] }), /no node nope/);
  runtime.markWork({ documentId: 'welcome', nodeIds: ['cta'], note: 'restyling the button' });
  runtime.markWork({ documentId: 'pricing', note: 'checking prices', add: true });
  await waitUntil(() => frameOf('welcome').evaluate(() => document.querySelector('[data-divlet-id="cta"]')?.hasAttribute('data-divlet-work')), 'the element glows in the page');
  await waitUntil(() => page.evaluate(() => document.querySelector('.artboard[data-artboard-id="pricing"]').classList.contains('working')), 'the whole artboard glows');
  assert.equal(await page.evaluate(() => document.querySelector('.artboard[data-artboard-id="welcome"]').classList.contains('working')), false, 'an element mark does not light the artboard');
  runtime.clearWork({ documentId: 'pricing' });
  await waitUntil(() => page.evaluate(() => !document.querySelector('.artboard[data-artboard-id="pricing"]').classList.contains('working')), 'clearing stops it');
  runtime.setAgent({ busy: false });
  await waitUntil(() => frameOf('welcome').evaluate(() => !document.querySelector('[data-divlet-work]')), 'marks end with the agent turn');
  assert.deepEqual(runtime.info().work, []);
  check('the agent can mark a frame or elements; the board animates them until its turn ends');

  /* ---- resizable panels --------------------------------------------------- */
  await pickNode('welcome', 'cta');
  const panelWidth = () => page.evaluate(() => document.querySelector('#inspector').getBoundingClientRect().width);
  const w0 = await panelWidth();
  const grip = await page.locator('.resize-handle[data-panel="inspector"]').boundingBox();
  await page.mouse.move(grip.x + 4, grip.y + 60);
  await page.mouse.down();
  await page.mouse.move(grip.x - 76, grip.y + 60, { steps: 5 });
  await page.mouse.up();
  assert.ok(Math.abs((await panelWidth()) - (w0 + 80)) < 3, 'dragging the left edge widens the inspector');
  assert.equal(await page.evaluate(() => { const p = document.querySelector('#inspector'); return p.scrollWidth <= p.clientWidth; }), true, 'no horizontal scrollbar');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
  assert.ok(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--inspector-w')) === `${Math.round(w0 + 80)}px`, 'the width is remembered');
  await page.locator('#viewport').focus();
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); });
  await page.locator('.resize-handle[data-panel="inspector"]').dblclick();
  await waitUntil(async () => Math.abs((await panelWidth()) - w0) < 3, 'double-click resets the width');
  check('side panels resize by dragging the edge, remember the width, and never scroll sideways');

  /* ---- a list from the keyboard alone ------------------------------------- */
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards([]); });
  await pickBoard('plain-css');
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectNodes('plain-css', ['card']); });
  await waitUntil(() => selectedNodes()[0] === 'card', 'a container is selected');
  await focusCanvas();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('add list');
  await page.locator('#palette .palette-item', { hasText: 'Add list' }).first().waitFor();
  await page.keyboard.press('Enter');
  await waitUntil(() => Object.values(doc('plain-css').nodes).some(node => node.tag === 'ul'), 'the list is created from the palette');
  const list = () => Object.values(doc('plain-css').nodes).find(node => node.tag === 'ul');
  const items = () => list().children.map(id => doc('plain-css').nodes[doc('plain-css').nodes[id].children[0]].content);
  await waitUntil(() => selectedNodes()[0] === list().id, 'the new list is selected');
  await page.keyboard.press('Enter');
  await waitUntil(() => selectedNodes()[0] === list().children[0], 'Enter selects the first item');
  await page.keyboard.press('Enter');
  await waitUntil(() => page.locator('.artboard[data-artboard-id="plain-css"].editing').count().then(count => count === 1), 'Enter again edits its text');
  await page.keyboard.type('Alpha');
  await page.keyboard.press('Tab');
  await waitUntil(() => selectedNodes()[0] === list().children[1], 'Tab saves and moves to the next item instead of leaving the page');
  await waitUntil(() => items()[0] === 'Alpha', 'Tab persists the first item before continuing');
  await page.keyboard.press('Enter');
  await waitUntil(() => page.locator('.artboard[data-artboard-id="plain-css"].editing').count().then(count => count === 1), 'Enter edits the second item');
  await page.keyboard.type('Beta');
  await page.keyboard.press('Enter');
  await waitUntil(() => items().length === 3 && items()[1] === 'Beta', 'Enter in a list item saves it and starts a new one');
  await waitUntil(() => frameOf('plain-css').evaluate(() => document.querySelector('[contenteditable]')?.textContent === 'New item'), 'the new item is open for typing');
  await page.keyboard.type('Gamma');
  await page.keyboard.press('Control+Enter');
  await waitUntil(() => items().join() === 'Alpha,Beta,Gamma', 'Ctrl+Enter saves without adding another');
  await page.keyboard.press('ArrowUp');
  await waitUntil(() => selectedNodes()[0] === list().children[1], 'the arrows walk the tree: ↑ previous sibling');
  await sleep(250); // let the previous selection settle before the next key
  await page.keyboard.press('ArrowLeft');
  await waitUntil(() => selectedNodes()[0] === list().id, '← selects the parent');
  await page.keyboard.press('ArrowRight');
  await waitUntil(() => selectedNodes()[0] === list().children[0], '→ selects the first child');
  check('a list can be created, walked, edited and extended with the keyboard alone');

  /* ---- exact artboard size ------------------------------------------------- */
  const sizeTrace = await page.evaluateHandle(async () => {
    const s = await import('./lib/store.js'), c = await import('./lib/canvas.js'), events = [], identities = new WeakMap(); let seq = 0;
    const record = event => {
      const input = event.target; if (!input.classList?.contains('ab-size-input') || (event.type === 'keydown' && event.key !== 'Enter')) return;
      if (!identities.has(input)) identities.set(input, ++seq);
      const d = s.descriptor('plain-css'), shown = c.entries.get('plain-css')?.doc;
      events.push({ type: event.type, identity: identities.get(input), value: /^[\d\s.:×x/]+$/.test(input.value) ? input.value.slice(0, 40) : 'non-numeric', focused: document.activeElement === input, descriptor: { version: d?.version, width: d?.artboard.width, height: d?.artboard.height }, shown: { version: shown?.version, width: shown?.artboard.width, height: shown?.artboard.height } });
      if (events.length > 12) events.shift();
    };
    for (const type of ['focusin', 'focusout', 'keydown']) document.addEventListener(type, record, true);
    return { events, cleanup() { for (const type of ['focusin', 'focusout', 'keydown']) document.removeEventListener(type, record, true); } };
  });
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards([]); });
  await pickBoard('plain-css');
  const size = () => doc('plain-css').artboard;
  await page.locator('#inspector [data-key="width"]').fill('800');
  await page.keyboard.press('Enter');
  await waitUntil(() => size().width === 800, 'W is typed exactly');
  await page.locator('#inspector .ratio-row .chip', { hasText: '16:9' }).click();
  await waitUntil(() => size().height === 450, '16:9 sets the height from the width (800 × 450)');
  await page.locator('#inspector [data-key="ratio-lock"]').click();
  assert.equal(await page.locator('#inspector [data-key="ratio-lock"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#inspector [data-key="width"]').fill('400');
  await page.keyboard.press('Enter');
  await waitUntil(() => size().width === 400 && size().height === 225, 'with the lock on, H follows W (400 × 225)');
  await page.locator('#inspector [data-key="ratio-lock"]').click();
  let sizePhase = 'pair-activation', beforeRatio;
  try {
    await page.locator('.artboard[data-artboard-id="plain-css"] .ab-size').dblclick({ force: true });
    await page.locator('.ab-size-input').waitFor();
    sizePhase = 'pair-fill'; await page.locator('.ab-size-input').fill('500 × 300');
    sizePhase = 'pair-submit';
    const [pairResponse] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/patch') && r.request().postDataJSON()?.patch?.artboard?.width === 500), page.keyboard.press('Enter')]);
    assert.equal(pairResponse.status(), 200);
    await waitUntil(() => size().width === 500 && size().height === 300, 'the size above the artboard is editable (500 × 300)');
    beforeRatio = { version: doc('plain-css').version, width: size().width, height: size().height };
    // A backend value is not the header's installed descriptor: the next ratio must start
    // from the completed first submission, never from a still-visible older control.
    sizePhase = 'pair-installed';
    await waitUntil(() => page.evaluate(async expected => { const s = await import('./lib/store.js'), c = await import('./lib/canvas.js'), d = s.descriptor('plain-css'), e = c.entries.get('plain-css'); return d?.version === expected.version && e?.doc.version === expected.version && e.doc.artboard.width === expected.width && e.doc.artboard.height === expected.height && !e.size.querySelector('input'); }, beforeRatio), 'resized header descriptor is installed');
    sizePhase = 'ratio-activation'; await page.locator('.artboard[data-artboard-id="plain-css"] .ab-size').dblclick({ force: true });
    sizePhase = 'ratio-fill'; await page.locator('.ab-size-input').fill('4:3');
    sizePhase = 'ratio-submit'; await page.keyboard.press('Enter');
    await waitUntil(() => size().width === 500 && size().height === 375, 'a ratio typed there keeps the width');
  } catch (error) {
    const installed = await page.evaluate(async () => { const c = await import('./lib/canvas.js'), e = c.entries.get('plain-css'), input = e?.size.querySelector('input'); return { version: e?.doc.version, width: e?.doc.artboard.width, height: e?.doc.artboard.height, inputConnected: !!input?.isConnected, focused: input === document.activeElement }; });
    console.error(JSON.stringify({ failure: 'size-editor-lifecycle', phase: sizePhase, before: beforeRatio, after: { version: doc('plain-css').version, width: size().width, height: size().height }, installed, events: await sizeTrace.evaluate(t => t.events) }));
    await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/size-ratio-failure.png' }); throw error;
  } finally { await sizeTrace.evaluate(t => t.cleanup()); await sizeTrace.dispose(); }
  check('artboard size: typed W/H, ratio chips, a ratio lock, and an editable size label');

  /* ---- layers: two blocks — the artboards on top, the tree of the chosen one below ---- */
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards([]); });
  await page.locator('#open-layers').click();
  await page.locator('#layers .board-list .board').first().waitFor();
  // The rule: while Layers is open one artboard is always chosen (the remembered one, else the first), so the tree is never empty
  // for a project that has artboards; only a project without artboards has nothing chosen.
  await waitUntil(() => page.locator('#layers .board.on').count().then(count => count === 1), 'opening Layers chooses an artboard');
  assert.ok(await page.locator('#layers .node').count() > 0, 'and the chosen artboard brings its tree');
  // Measured only once a row has a height: the pane re-renders on every model event, and a locator can catch a replaced node.
  const listed = await waitUntil(async () => {
    const rowHeight = await page.locator('#layers .board').first().evaluate(node => node.getBoundingClientRect().height);
    const listBox = await page.locator('#layers .board-list').boundingBox();
    return rowHeight > 0 && listBox ? { rowHeight, listBox } : null;
  }, 'the artboard list is laid out');
  assert.ok(listed.listBox.height <= 7 * listed.rowHeight + 14, `the artboard list is about seven rows at most (${JSON.stringify({ listBox: listed.listBox, rowHeight: listed.rowHeight })})`);
  await page.locator('#layers .board', { hasText: 'Plain CSS' }).click();
  await waitUntil(() => runtime.info().selection.ids.join() === 'plain-css', 'choosing an artboard in the list selects it on the canvas');
  await waitUntil(() => page.locator(`#layers .node[data-node-id="${doc('plain-css').rootId}"]`).count().then(count => count === 1), 'its tree appears below, starting at the root element');
  assert.equal(await page.locator('#layers .node').first().getAttribute('data-node-id'), doc('plain-css').rootId, 'the root element is the first row of the tree');
  assert.equal(await page.locator('#layers .board.on').count(), 1);
  // The header is one word: the chosen artboard is already lit in the list above, so naming it again only costs width.
  assert.equal(await page.locator('#layers .panel-head .caption').last().innerText(), 'Elements', 'the tree header names the block, not the artboard');
  // Reactive both ways: selecting another artboard on the canvas redraws the tree and moves the highlight.
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); });
  await waitUntil(() => page.locator('#layers .board.on').innerText().then(text => text.includes('A space for ideas')), 'the list follows the canvas');
  await waitUntil(() => page.locator('#layers .node[data-node-id="cta"]').count().then(count => count === 1), 'the tree follows the canvas');
  const treeBox = await waitUntil(() => page.locator('#layers .panel-body').boundingBox(), 'the tree body is laid out');
  assert.ok(treeBox.y > listed.listBox.y + listed.listBox.height - 2, 'the tree is its own block below the list');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#layers .tree')).borderLeftWidth), '0px', 'no vertical guide line');
  assert.ok(await page.evaluate(() => { const side = document.querySelector('#sidebar').getBoundingClientRect(), brand = document.querySelector('#brand').getBoundingClientRect(), tabs = document.querySelector('#side-tabs').getBoundingClientRect(); return side.top >= brand.bottom && side.bottom <= tabs.top + 2 && Math.abs(side.left - tabs.left) < 1 && Math.abs(side.width - tabs.width) < 1; }), 'the sidebar sits between the logo/search islands and the tabs, joined to them');
  await page.locator('#open-layers').click();
  check('layers: a short artboard list on top, the tree of the chosen artboard below, in sync with the canvas');

  /* ---- a dropdown toggles on its own control ------------------------------ */
  await pickNode('welcome', 'cta');
  const display = page.locator('#inspector [data-key="pick:Display"]');
  const trace = await page.evaluateHandle(async () => {
    const s = await import('./lib/store.js'), identities = new WeakMap(); let seq = 0;
    const original = document.querySelector('#inspector [data-key="pick:Display"]'), events = [];
    const describe = e => { if (!e) return null; if (!identities.has(e)) identities.set(e, ++seq); const r = e.getBoundingClientRect(); return { identity: identities.get(e), connected: e.isConnected, key: e.dataset.key, tag: e.tagName, label: e.getAttribute('aria-label'), rect: { x: r.x, y: r.y, width: r.width, height: r.height } }; };
    const sample = (type, target) => {
      const p = document.querySelector('#inspector'), d = s.store.node?.documentId;
      events.push({ type, target: describe(target), original: describe(original), current: describe(p?.querySelector('[data-key="pick:Display"]')), menu: describe(document.querySelector('.menu')), subject: s.store.node, version: s.descriptor(d)?.version, render: s.descriptor(d)?.render, view: p?.dataset.view });
      if (events.length > 32) events.shift();
    };
    const before = e => sample(e.type + ':capture', e.target), after = e => sample(e.type + ':bubble', e.target);
    for (const type of ['pointerdown', 'pointerup', 'click']) { document.addEventListener(type, before, true); document.addEventListener(type, after); }
    const observer = new MutationObserver(records => { for (const r of records) if ([...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 && (n.classList.contains('menu') || n.contains(original)))) { sample('mutation'); break; } });
    observer.observe(document.body, { childList: true, subtree: true }); sample('start');
    return { events, sample, cleanup() { observer.disconnect(); for (const type of ['pointerdown', 'pointerup', 'click']) { document.removeEventListener(type, before, true); document.removeEventListener(type, after); } } };
  });
  try {
    await display.click();
    await page.locator('.menu').waitFor();
    const first = await page.locator('.menu').elementHandle();
    await display.click();
    await page.locator('.menu').waitFor({ state: 'detached' });
    assert.equal(await first.evaluate(node => node.isConnected), false, 'the second press closes the menu instead of reopening it');
    await display.click();
    await page.locator('.menu').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.menu').waitFor({ state: 'detached' });
    check('pressing a dropdown control again closes its menu (no close-and-reopen)');
  } catch (error) {
    console.error(JSON.stringify({ failure: 'display-toggle', trace: await trace.evaluate(t => { t.sample('failure'); return t.events; }) }));
    await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/display-toggle-failure.png' }); throw error;
  } finally { await trace.evaluate(t => t.cleanup()); await trace.dispose(); }

  /* ---- interface size ----------------------------------------------------- */
  // (a search result opens the Layers sidebar, which would cover the artboard label clicked below)
  if (await page.evaluate(() => !document.querySelector('#sidebar').hidden)) { await focusCanvas(); await page.keyboard.press('Escape'); }
  await waitUntil(() => page.evaluate(() => document.querySelector('#sidebar').hidden), 'the sidebar is closed');
  const dockWidth = () => page.evaluate(() => document.querySelector('#dock').getBoundingClientRect().width);
  const d100 = await dockWidth();
  await page.locator('#dock-help').click();
  await page.locator('#help .seg[data-ui="150"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--ui')), '1.5');
  assert.ok(Math.abs((await dockWidth()) / d100 - 1.5) < 0.03, 'the dock is 1.5 times larger');
  assert.equal(await page.evaluate(() => { const c = document.querySelector('#viewport').getBoundingClientRect(); return [c.width, c.height].join('x'); }), `${await page.evaluate(() => innerWidth)}x${await page.evaluate(() => innerHeight)}`, 'the canvas is not scaled');
  await page.keyboard.press('Escape');
  // (the wider inspector would sit on top of the label's right end)
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards([]); });
  await showAll();
  const moreTrace = await page.evaluateHandle(async () => {
    const s = await import('./lib/store.js'), events = [], identities = new WeakMap(); let seq = 0;
    const button = document.querySelector('.artboard[data-artboard-id="welcome"] .ab-more');
    const describe = e => { if (!e) return null; if (!identities.has(e)) identities.set(e, ++seq); return { identity: identities.get(e), tag: e.tagName, id: e.id, classes: [...(e.classList || [])].slice(0, 4) }; };
    const sample = (type, target, point) => {
      const r = button.getBoundingClientRect(), b = button.closest('.artboard'), label = button.closest('.ab-label'), style = getComputedStyle(button), d = s.descriptor('welcome');
      const p = point || { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      events.push({ at: performance.now(), type, target: describe(target), hit: describe(document.elementFromPoint(p.x, p.y)), point: p, trigger: { ...describe(button), connected: button.isConnected, opacity: style.opacity, visibility: style.visibility, rect: { x: r.x, y: r.y, width: r.width, height: r.height } }, labelTransform: getComputedStyle(label).transform, hovered: b.matches(':hover'), selected: b.classList.contains('selected'), active: describe(document.activeElement), menus: [...document.querySelectorAll('.menu')].map(e => ({ ...describe(e), label: e.getAttribute('aria-label') })), version: d?.version, render: d?.render });
      if (events.length > 32) events.shift();
    };
    const capture = e => sample(e.type, e.target, Number.isFinite(e.clientX) ? { x: e.clientX, y: e.clientY } : undefined);
    const types = ['pointerover', 'pointerdown', 'pointerup', 'click', 'blur', 'resize', 'wheel', 'divlet:menu-close'];
    for (const type of types) window.addEventListener(type, capture, true);
    const observer = new MutationObserver(records => { for (const r of records) for (const [op, nodes] of [['add', r.addedNodes], ['remove', r.removedNodes]]) for (const n of nodes) if (n.nodeType === 1 && n.classList.contains('menu')) sample('menu:' + op, n); });
    observer.observe(document.body, { childList: true, subtree: true }); sample('before-more-activation');
    return { events, sample, cleanup() { observer.disconnect(); for (const type of types) window.removeEventListener(type, capture, true); } };
  });
  let menuBox;
  try {
    // Idle headings shrink and hide actions; forcing their pre-hover point can hit the
    // expanded label or canvas instead. Reveal the real control, then retain hit testing.
    await page.locator('.artboard[data-artboard-id="welcome"] .ab-body').hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.artboard[data-artboard-id="welcome"] .ab-more')).opacity === '1');
    await page.locator('.artboard[data-artboard-id="welcome"] .ab-more').click();
    menuBox = await page.locator('.menu').boundingBox();
  } catch (error) {
    console.error(JSON.stringify({ failure: 'scaled-more-menu', trace: await moreTrace.evaluate(t => { t.sample('failure'); return t.events; }) }));
    await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/scaled-more-failure.png' }); throw error;
  } finally { await moreTrace.evaluate(t => t.cleanup()); await moreTrace.dispose(); }
  const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  assert.ok(menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= vp.w && menuBox.y + menuBox.height <= vp.h, 'a scaled menu stays on screen');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1000, height: 800 });
  await waitUntil(() => page.evaluate(() => document.documentElement.classList.contains('w720')), 'layouts follow the width the interface really has (1000 / 1.5)');
  await page.setViewportSize({ width: 1500, height: 960 });
  await waitUntil(() => page.evaluate(() => !document.documentElement.classList.contains('w720')), 'and back');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--ui')), '1.5', 'the size is remembered');
  await page.locator('#viewport').focus();
  await page.keyboard.press('Control+Alt+-');
  await waitUntil(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--ui') === '1.25'), 'Ctrl+Alt+− steps down');
  await page.locator('#dock-help').click();
  await page.locator('#help .seg[data-ui="100"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--ui')), '');
  await page.keyboard.press('Escape');
  check('interface size 100–200%: the chrome scales, the canvas does not; menus stay on screen; layouts follow the effective width; remembered');

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
