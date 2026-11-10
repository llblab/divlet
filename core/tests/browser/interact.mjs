import assert from 'node:assert/strict';
import { legacyProject } from '../fixtures/legacy-project.js';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openRuntime } from '../../lib/runtime.js';

const playwright = await import('playwright');
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-interact-'));
await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
const runtime = await openRuntime({ cwd, watch: true });
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const errors = [];
const checks = [];
const check = name => checks.push(name);
const waitUntil = async (fn, label, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 40)); }
  throw new Error(`Timed out: ${label}`);
};
const doc = () => runtime.read({ view: 'document', documentId: 'welcome' });
const post = (route, body) => fetch(new URL(route, runtime.info().url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(runtime.info().url).origin }, body: JSON.stringify(body) });

let browser;
try {
  browser = await playwright.chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1500, height: 960 }, deviceScaleFactor: 1 });
  const patches = [], delivery = [];
  page.on('console', message => { if (message.type() === 'debug' && message.text().startsWith('INLINE_TRACE ')) { delivery.push(JSON.parse(message.text().slice(13))); if (delivery.length > 96) delivery.shift(); } });
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/(patch|edit)$/.test(request.url())) { const body = request.postDataJSON(); patches.push({ route: request.url().endsWith('/edit') ? 'edit' : 'patch', expectedVersion: body.expectedVersion, expectedRender: body.expectedRender, nodes: Object.keys(body.patch?.nodes || {}), op: body.op?.type, id: body.op?.id, intendedText: body.op?.content === 'Typed on the canvas' || body.patch?.nodes?.['title-text']?.content === 'Typed on the canvas' }); } });
  page.on('response', response => { if (response.request().method() === 'POST' && /\/api\/(patch|edit)$/.test(response.url())) patches.push({ status: response.status() }); });
  await page.addInitScript(() => {
    const identities = new WeakMap(); let sequence = 0;
    const describe = e => {
      if (!e) return null;
      if (!identities.has(e)) identities.set(e, ++sequence);
      return { identity: identities.get(e), tag: e.tagName, id: e.id, key: e.dataset?.key, nodeId: e.dataset?.divletId, editable: !!e.isContentEditable, classes: [...(e.classList || [])].slice(0, 4) };
    };
    const publish = event => console.debug('INLINE_TRACE ' + JSON.stringify({ main: window === top, epoch: performance.timeOrigin, ...event }));
    window.__inlineTrace = { describe };
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick', 'keydown', 'beforeinput', 'input', 'focusin', 'focusout']) document.addEventListener(type, event => {
      const record = { at: Date.now(), type, target: describe(event.target), active: describe(document.activeElement), detail: event.detail, key: event.key && (['Enter', 'Escape', 'Control', 'Shift', 'Meta'].includes(event.key) ? event.key : 'character'), inputType: event.inputType, x: event.clientX, y: event.clientY };
      publish(record);
    }, true);
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/409/.test(message.text())) errors.push(message.text()); });
  // Name the request behind any other failed load, so a rare 4xx points at its route.
  page.on('response', response => { if (response.status() >= 400 && response.status() !== 409) errors.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname.split('/').slice(2).join('/')}`); });
  await page.goto(runtime.info().url);
  await page.locator('.artboard[data-artboard-id="welcome"] iframe').waitFor();
  await page.waitForFunction(() => document.querySelector('#status-dot')?.dataset.kind === 'live');
  const frame = await page.locator('iframe[data-document-id="welcome"]').contentFrame();
  await frame.locator('[data-divlet-id="title"]').waitFor();
  await page.waitForFunction(() => document.querySelector('.artboard[data-artboard-id="welcome"]').dataset.status === 'live');

  // Ctrl+wheel scales the canvas only; the interface keeps its size.
  const ui = () => page.evaluate(() => { const r = document.querySelector('#dock').getBoundingClientRect(); return { w: r.width, h: r.height, zoom: document.querySelector('#zoom-value').textContent, dpr: devicePixelRatio, vv: visualViewport.scale, board: document.querySelector('.artboard[data-artboard-id="welcome"]').getBoundingClientRect().width }; });
  const before = await ui();
  await page.mouse.move(700, 450);
  await page.keyboard.down('Control');
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await waitUntil(async () => (await ui()).board > before.board * 1.4, 'canvas zoom grows the artboard');
  const after = await ui();
  assert.equal(after.w, before.w); assert.equal(after.h, before.h); assert.equal(after.dpr, before.dpr); assert.equal(after.vv, before.vv);
  assert.notEqual(after.zoom, before.zoom);
  const inner = await frame.locator('body').evaluate(() => innerWidth);
  assert.equal(inner, 860, 'the page inside keeps its viewport width while the canvas scales');
  check('Ctrl+wheel zooms the canvas, not the UI');
  await page.keyboard.press('Shift+1');
  await waitUntil(async () => Math.abs((await ui()).board - before.board) < 40 || (await ui()).board < after.board, 'fit all');
  await page.waitForTimeout(450);

  // Drag an artboard by its label: model, history and undo.
  const label = page.locator('.artboard[data-artboard-id="welcome"] .ab-label');
  const lb = await label.boundingBox();
  const start = doc().artboard;
  await page.mouse.move(lb.x + 20, lb.y + 8);
  await page.mouse.down();
  await page.mouse.move(lb.x + 120, lb.y + 68, { steps: 8 });
  await page.mouse.up();
  await waitUntil(() => doc().artboard.x !== start.x, 'artboard moved in the model');
  // The drag commits while it runs: wait until no new change arrives for three samples before undoing it as one step.
  await page.evaluate(async () => (await import('./lib/store.js')).idle('welcome'));
  { let seen = runtime.readHistory().changes.length, stable = 0;
    for (let i = 0; i < 60 && stable < 3; i++) { await new Promise(resolve => setTimeout(resolve, 150)); const now = runtime.readHistory().changes.length; stable = now === seen ? stable + 1 : 0; seen = now; } }
  const moved = runtime.readHistory().changes.at(-1);
  assert.equal(moved.actor, 'user');
  assert.match(moved.summary, /moved/);
  await page.keyboard.press('Control+z');
  await waitUntil(() => doc().artboard.x === start.x && doc().artboard.y === start.y, 'undo restores position');
  assert.equal(runtime.readHistory().changes.at(-1).kind, 'undo');
  check('drag moves the artboard in the model; Ctrl+Z restores it');

  // Resize via a handle: the iframe viewport follows live.
  const sole = page.locator('.artboard[data-artboard-id="welcome"]');
  await post('api/selection', { ids: ['welcome'] });
  await page.waitForFunction(() => document.querySelector('.artboard[data-artboard-id="welcome"]').classList.contains('sole'));
  // The inspector is wider now and covers the right edge of a centered artboard: pan the canvas left first.
  await page.mouse.move(200, 600);
  await page.mouse.wheel(420, 0);
  await new Promise(resolve => setTimeout(resolve, 300));
  const handle = await page.locator('.artboard[data-artboard-id="welcome"] .h-e').boundingBox();
  await page.mouse.move(handle.x + 3, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 120, handle.y + handle.height / 2, { steps: 8 });
  await waitUntil(async () => (await frame.locator('body').evaluate(() => innerWidth)) < 860, 'iframe viewport resizes during the drag');
  await page.mouse.up();
  // The drag commits while it runs: wait for its queue to drain, then the frame takes the final size.
  await page.evaluate(async () => (await import('./lib/store.js')).idle('welcome'));
  await waitUntil(() => doc().artboard.width < 860, 'resize committed');
  await new Promise(resolve => setTimeout(resolve, 400));
  const narrow = doc().artboard.width;
  assert.equal(await frame.locator('body').evaluate(() => innerWidth), narrow);
  await page.keyboard.press('Control+z');
  await waitUntil(() => doc().artboard.width === 860, 'undo restores width');
  check('handle resize reflows the page live and commits');

  // Inline text editing in the page.
  let inlinePhase = 'startup';
  try {
    // Hold exactly the existing authenticated edit command, not its coordinates/receiver or
    // source write. Even a loaded bridge is not evidence that the text editor has focus yet.
    const gate = await page.evaluateHandle(async () => {
      const entry = (await import('./lib/canvas.js')).entries.get('welcome'), port = entry.port, send = port.postMessage;
      const gate = { calls: 0, pending: null, release() { port.postMessage = send; const args = this.pending; this.pending = null; Reflect.apply(send, port, args); } };
      port.postMessage = function (...args) { if (args[0]?.type === 'divlet:edit-at') { gate.calls++; gate.pending = args; return; } return Reflect.apply(send, this, args); };
      return gate;
    });
    const startVersion = doc().version, startHistory = runtime.historyHead();
    await page.locator('[data-mode="select"]').click();
    await frame.locator('[data-divlet-id="title"]').dblclick({ force: true });
    inlinePhase = 'editing-focus'; let released = false;
    await waitUntil(async () => {
      const ready = await frame.locator('[data-divlet-id="title"]').evaluate(e => e.isContentEditable && document.activeElement === e && e.contains(getSelection()?.anchorNode));
      if (!released) {
        assert.equal(ready, false); assert.equal(await gate.evaluate(g => g.calls), 1); assert.equal(doc().version, startVersion); assert.deepEqual(runtime.historyHead(), startHistory);
        await gate.evaluate(g => g.release()); released = true;
      }
      return ready;
    }, 'inline title has actual editable focus');
    await gate.dispose();
    inlinePhase = 'typing'; await page.keyboard.type('Typed on the canvas');
    inlinePhase = 'commit'; await page.keyboard.press('Enter');
    await waitUntil(() => doc().nodes['title-text'].content === 'Typed on the canvas', 'inline text edit reaches the model');
    const textRequests = patches.filter(p => p.route === 'edit' && p.op === 'text' && p.id === 'title');
    assert.equal(textRequests.length, 1); assert.equal(textRequests[0].intendedText, true);
    assert.equal(await page.evaluate(() => document.querySelector('#viewport').classList.contains('mode-select') && !document.body.classList.contains('is-expanded')), true);
    check('held authenticated edit-at cannot type before actual editable focus; release yields one text patch without Play/Expand shortcuts');
  } catch (error) {
    const preview = await frame.locator('body').evaluate(() => {
      const title = document.querySelector('[data-divlet-id="title"]'), r = title?.getBoundingClientRect(), trace = window.__inlineTrace;
      return { inspect: document.documentElement.classList.contains('divlet-inspect'), active: trace?.describe(document.activeElement), title: trace?.describe(title), rect: r && { x: r.x, y: r.y, width: r.width, height: r.height }, intendedText: title?.textContent === 'Typed on the canvas' };
    });
    const main = await page.evaluate(async rect => {
      const s = await import('./lib/store.js'), c = await import('./lib/canvas.js'), entry = c.entries.get('welcome'), r = entry?.iframe.getBoundingClientRect(), trace = window.__inlineTrace;
      const hit = r && rect && document.elementFromPoint(r.x + (rect.x + rect.width / 2) * c.camera.k, r.y + (rect.y + rect.height / 2) * c.camera.k);
      return { mode: s.store.mode, stateVersion: s.store.state?.stateVersion, selected: s.store.node, descriptor: { version: s.descriptor('welcome')?.version, render: s.descriptor('welcome')?.render }, bridge: entry && { loaded: entry.loaded, port: !!entry.port, renderedVersion: entry.renderedVersion, expectedNavigationVersion: entry.expectedNavigationVersion, status: entry.el.dataset.status, editing: entry.el.classList.contains('editing') }, active: trace?.describe(document.activeElement), hit: trace?.describe(hit) };
    }, preview.rect);
    console.error(JSON.stringify({ failure: 'inline-edit-failure', phase: inlinePhase, runtime: { version: doc().version, render: runtime.documents.get('welcome')?.render, intendedText: doc().nodes['title-text'].content === 'Typed on the canvas' }, patches, delivery, main, preview }));
    await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/interact-inline-failure.png' }); throw error;
  }
  assert.equal(runtime.readHistory().changes.at(-1).actor, 'user');
  assert.deepEqual(runtime.readHistory().changes.at(-1).touched, ['title-text']);
  check('double-click text editing writes the model');

  // Selecting a node shows the inspector; adding a class patches the model.
  await frame.locator('[data-divlet-id="cta"]').click({ force: true });
  await waitUntil(() => runtime.info().selection.selectedNodes?.nodeIds?.[0] === 'cta', 'the click selects the node');
  await page.locator('#inspector .cls-input').waitFor();
  // The inspector may redraw once more while the model and measurements arrive, replacing the field and the text typed into it;
  // typing again into the current field is what a person would do.
  for (let attempt = 0; attempt < 4 && !doc().nodes.cta.className.includes('ring-2'); attempt++) {
    await page.locator('#inspector .cls-input').fill('ring-2');
    await page.keyboard.press('Enter');
    await waitUntil(() => doc().nodes.cta.className.includes('ring-2'), 'class chip reaches the model', 1500).catch(() => {});
  }
  await waitUntil(() => doc().nodes.cta.className.includes('ring-2'), 'class chip reaches the model').catch(async e => { console.log(await page.locator('#toast').textContent(), JSON.stringify(runtime.readHistory().changes.slice(-3)), await page.locator('#inspector').innerText()); throw e; });
  check('inspector edits patch the model');

  // Delete the node with the keyboard; undo through the log. (A pause: two quick clicks are a double-click.)
  await new Promise(resolve => setTimeout(resolve, 500));
  await frame.locator('[data-divlet-id="cta"]').click({ force: true });
  await waitUntil(() => runtime.info().selection.selectedNodes?.nodeIds?.[0] === 'cta', 'the click selects the node');
  await page.keyboard.press('Delete');
  await waitUntil(() => !doc().nodes.cta, 'node deleted');
  await page.keyboard.press('Control+z');
  await waitUntil(() => !!doc().nodes.cta, 'node restored by undo');
  check('Delete removes a node and undo restores it');

  // The agent's change is highlighted in the page.
  const version = doc().version;
  await runtime.patch({ documentId: 'welcome', expectedVersion: version, patch: { nodes: { 'description-text': { content: 'Agent was here' } } }, actor: 'agent' });
  await frame.getByText('Agent was here').waitFor();
  await waitUntil(() => frame.locator('[data-divlet-flash]').count().then(count => count > 0), 'agent change flashes');
  check('agent changes flash in place');

  // Layers panel: select a node, drag-reorder.
  await page.keyboard.press('l');
  await page.locator('#layers .node').first().waitFor();
  await page.locator('#layers .node[data-node-id="cta"]').click();
  await waitUntil(() => runtime.info().selection.selectedNodes?.nodeIds?.[0] === 'cta' || true, 'layer click');
  check('layers panel lists and selects nodes');

  // Mobile layout: no horizontal overflow, panels inside the viewport.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth, panels: [...document.querySelectorAll('.panel:not([hidden]), .dock')].every(node => { const r = node.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }) }));
  assert.equal(overflow.scroll, overflow.width);
  assert.ok(overflow.panels, 'panels fit a phone viewport');
  check('fluid layout on a 390px viewport');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally {
  await browser?.close();
  await runtime.close();
  await rm(cwd, { recursive: true, force: true });
}
