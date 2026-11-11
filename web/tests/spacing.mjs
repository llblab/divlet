// Spacing: a quiet margin/padding overlay on the selection, and the box-model inspector that edits it.
import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { cp, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { decodeHtml } from '../../core/lib/codec.ts';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../core/lib/runtime.js';

const playwright = await import('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-spacing-'));
await cp(path.join(root, 'examples', 'studio'), cwd, { recursive: true });
await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
const runtime = await openRuntime({ cwd, watch: false });
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const errors = [], checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitUntil = async (fn, label, timeout = 8000) => {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (error) { last = error; } await sleep(40); }
  throw new Error(`Timed out: ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
};
const classes = () => runtime.read({ view: 'document', documentId: 'welcome' }).nodes.nav.className.split(' ');
let browser;
try {
  browser = await playwright.chromium.launch(launch);
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(runtime.info().url);
  await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); });
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectNodes('welcome', ['nav']); });
  const frame = page.locator('iframe[data-document-id="welcome"]').contentFrame();
  await page.waitForSelector('#inspector .boxmodel');
  assert.equal(await page.locator('#inspector .bm-field').count(), 8, 'one margin and one padding field per side');
  // Four nested bands match the developer-tools reference; editable spacing keeps its original edge semantics.
  const model = await page.evaluate(() => {
    const box = document.querySelector('#inspector .boxmodel');
    const rect = selector => { const node = box.querySelector(selector); const r = node?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; };
    const field = side => rect(`.bm-margin .bm-cell.bm-${side} .bm-field`);
    return { position: rect('.bm-position'), outer: rect('.bm-sq.bm-margin'), border: rect('.bm-border'), inner: rect('.bm-sq.bm-padding'), core: rect('.bm-core'), margin: { t: field('t'), r: field('r'), b: field('b'), l: field('l') }, padding: Object.fromEntries(['t', 'r', 'b', 'l'].map(side => [side, rect(`.bm-sq.bm-padding .bm-cell.bm-${side} .bm-field`)])) };
  });
  const inside = (child, parent) => child.x > parent.x && child.y > parent.y && child.x + child.w < parent.x + parent.w && child.y + child.h < parent.y + parent.h;
  assert.ok(inside(model.outer, model.position), 'margin sits inside position');
  assert.ok(inside(model.border, model.outer), 'border sits inside margin');
  assert.ok(inside(model.inner, model.border), 'padding sits inside border');
  assert.ok(inside(model.core, model.inner), 'and the content inside the padding');
  for (const side of ['t', 'r', 'b', 'l']) {
    assert.ok(inside(model.padding[side], model.inner), `padding ${side} is on the inner square's edge`);
    assert.ok(!inside(model.margin[side], model.inner), `margin ${side} is on the outer square, outside the padding`);
  }
  assert.ok(model.margin.t.y < model.inner.y && model.margin.b.y > model.inner.y + model.inner.h, 'margin top above, margin bottom below');
  assert.ok(model.margin.l.x < model.inner.x && model.margin.r.x > model.inner.x + model.inner.w, 'margin left before, margin right after');
  checks.push('the spacing section is one nested box model: four margin fields around four padding fields around the content');

  await page.locator('#inspector [data-key="m-t"]').fill('16'); await page.keyboard.press('Enter');
  await waitUntil(() => classes().includes('mt-4'), 'margin top 16px');
  await page.locator('#inspector [data-key="p-l"]').fill('24'); await page.keyboard.press('Enter');
  await waitUntil(() => classes().includes('pl-6'), 'padding left 24px');
  const overlay = frame.locator('#divlet-boxes');
  await waitUntil(async () => (await overlay.locator('> div').count()) >= 2, 'the overlay shows the margin and padding bands');
  const style = await overlay.evaluate(node => { const c = getComputedStyle(node); return { position: c.position, events: c.pointerEvents, parent: node.parentElement === document.documentElement, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }; });
  assert.deepEqual([style.position, style.events, style.parent], ['fixed', 'none', true], 'a fixed, non-interactive layer outside the page body');
  const kinds = await overlay.locator('> div').evaluateAll(nodes => nodes.map(node => /255,\s*153,\s*51/.test(node.style.background) ? 'margin' : 'padding'));
  assert.ok(kinds.includes('margin') && kinds.includes('padding'));
  checks.push('the selected element shows margin and padding bands on the canvas without joining the page layout');

  const dim = await frame.locator('body').evaluate(() => document.documentElement.scrollHeight);
  await page.locator('#inspector [data-key="m-t"]').hover();
  await waitUntil(async () => (await overlay.locator('> div').evaluateAll(nodes => nodes.filter(node => /rgba\(255,153,51,0\.46\)/.test(node.style.background.replace(/\s/g, ''))).length)) === 1, 'hovering the margin-top number lights exactly that band');
  await page.mouse.move(5, 5);
  await waitUntil(async () => (await overlay.locator('> div').evaluateAll(nodes => nodes.filter(node => /0\.46/.test(node.style.background)).length)) === 0, 'leaving restores the quiet overlay');
  assert.equal(await frame.locator('body').evaluate(() => document.documentElement.scrollHeight), dim, 'the overlay never changes the page size');
  checks.push('pointing at a number lights its band and leaving restores the quiet default');

  // The reference uses full layer names in the bands, not a separate legend or eight repeated side captions.
  const sized = await page.evaluate(() => {
    const box = document.querySelector('#inspector .boxmodel');
    const widths = [...new Set([...box.querySelectorAll('.bm-field')].map(field => Math.round(field.getBoundingClientRect().width)))];
    return {
      widths,
      keys: box.querySelectorAll('.bm-field .vf-k').length,
      tips: [...box.querySelectorAll('.bm-field')].filter(field => field.querySelector('.vf-k')?.dataset.tip || field.dataset.tip).length,
      labels: [...box.querySelectorAll('.bm-field')].map(field => field.getAttribute('aria-label')),
      captions: [...box.querySelectorAll('.bm-caption')].map(node => node.textContent),
      border: box.querySelectorAll('.bm-border > .bm-cell .bm-readout').length,
      switches: box.querySelectorAll('button, .bm-legend').length,
      height: box.getBoundingClientRect().height,
    };
  });
  assert.equal(sized.widths.length, 1, `one field size for all eight numbers (${sized.widths})`);
  assert.equal(sized.keys, 0, 'no letter keys: the square a number sits on says which side it is');
  assert.equal(sized.tips, 0, 'side captions do not add tooltip noise');
  assert.deepEqual(sized.captions, ['position', 'margin', 'border', 'padding']);
  assert.equal(sized.border, 4, 'computed per-side borders are read-only, not a duplicate width editor');
  assert.equal(sized.switches, 0, 'no linking switches or separate legend');
  assert.ok(sized.height <= 225, `the four-layer widget stays compact (${sized.height})`);
  assert.deepEqual(sized.labels, ['Margin top, px', 'Margin right, px', 'Margin bottom, px', 'Margin left, px', 'Padding top, px', 'Padding right, px', 'Padding bottom, px', 'Padding left, px'], 'the accessible name still says which side and unit');

  // A tight panel keeps the shape and the sizes: the model narrows as a whole rather than one square into the other.
  await page.evaluate(() => { document.querySelector('#inspector').style.width = '240px'; });
  await sleep(400);
  const tight = await page.evaluate(() => {
    const box = document.querySelector('#inspector .boxmodel');
    const outer = box.querySelector('.bm-sq.bm-margin').getBoundingClientRect();
    const inner = box.querySelector('.bm-sq.bm-padding').getBoundingClientRect();
    const fields = [...box.querySelectorAll('.bm-field')].map(field => Math.round(field.getBoundingClientRect().width));
    const clipped = [...box.querySelectorAll('.bm-field input')].filter(input => input.value && input.scrollWidth > input.clientWidth + 1).map(input => input.value);
    return { overflow: box.scrollWidth - box.clientWidth, nested: inner.width < outer.width && inner.left > outer.left, sizes: [...new Set(fields)], clipped };
  });
  assert.ok(tight.overflow <= 1, `the widget never overflows a 240px panel (${tight.overflow})`);
  assert.ok(tight.nested, 'and stays nested');
  assert.equal(tight.sizes.length, 1, `every number keeps the same size (${tight.sizes})`);
  assert.deepEqual(tight.clipped, [], 'and no value is cut off, even a word like auto');
  await page.evaluate(() => { document.querySelector('#inspector').style.width = ''; });
  await sleep(300);
  checks.push('four named bands retain eight independent spacing editors without linking modes or duplicate border editors');

  const paddingValues = () => frame.locator('[data-divlet-id="nav"]').evaluate(node => {
    const style = getComputedStyle(node);
    return ['Top', 'Right', 'Bottom', 'Left'].map(side => parseFloat(style[`padding${side}`]));
  });
  const expectedPadding = await paddingValues();
  for (const [index, side] of ['t', 'r', 'b', 'l'].entries()) {
    expectedPadding[index] = 8;
    await page.locator(`#inspector [data-key="p-${side}"]`).fill('8');
    await page.keyboard.press('Enter');
    await waitUntil(async () => JSON.stringify(await paddingValues()) === JSON.stringify(expectedPadding), `padding ${side} changes only its own side`);
  }
  await waitUntil(() => classes().includes('p-2') && !classes().some(name => /^p[trbl]-/.test(name)), 'independent equal values still normalize to the shortest class');
  checks.push('each spacing input changes only its own side; equal values still normalize without any linking mode');
  await page.locator('#inspector label[aria-label="Margin top, px"]').click({ position: { x: 12, y: 5 } });
  assert.equal(await page.locator('#inspector [data-key="m-t"]').evaluate(node => document.activeElement === node), true, 'the side caption is part of the native input target');
  await page.keyboard.press('Escape');


  // Direct manipulation: drag a side's pill on the canvas.
  const drag = async (kind, side, dx, dy, modifiers = [], during = null) => {
    // The page reports where each pill is; the board turns a press there into a drag of that side.
    const read = () => page.evaluate(async id => { const c = await import('./lib/canvas.js'); const e = c.entries.get('welcome'); const h = e.handles?.find(item => item.id === id); if (!h) return null; const f = e.iframe.getBoundingClientRect(); return { x: f.left + (h.x + h.w / 2) * c.camera.k, y: f.top + (h.y + h.h / 2) * c.camera.k }; }, side ? `${kind}-${side}` : kind);
    // Take the pill's position only once it has stopped moving (the page repaints after every edit).
    const point = await waitUntil(async () => { const a = await read(); if (!a) return null; await sleep(250); const b = await read(); return b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 ? b : null; }, `the ${kind} ${side} pill is reported and settled`);
    for (const key of modifiers) await page.keyboard.down(key);
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + dx / 2, point.y + dy / 2, { steps: 4 }); await page.mouse.move(point.x + dx, point.y + dy, { steps: 4 }); if (during) await during(); await page.mouse.up();
    for (const key of modifiers) await page.keyboard.up(key);
  };
  const scale = await page.evaluate(async () => (await import('./lib/canvas.js')).camera.k);
  // A drag commits while it runs; wait for its queue to drain (and the last render to land) before undoing it as one step.
  const settle = async () => {
    await page.evaluate(async () => (await import('./lib/store.js')).idle('welcome'));
    await sleep(250);
    let version = runtime.read({ view: 'document', documentId: 'welcome' }).version;
    for (let i = 0; i < 40; i++) { await sleep(120); const next = runtime.read({ view: 'document', documentId: 'welcome' }).version; if (next === version) return; version = next; }
  };

  // Typing into a field commits without Enter, and the whole typing session is one undo step.
  await page.locator('#inspector [data-key="m-t"]').click();
  await page.locator('#inspector [data-key="m-t"]').fill('20');
  await waitUntil(() => classes().includes('mt-5'), `typing a margin commits without Enter (${classes().join(' ')})`);
  await page.locator('#inspector [data-key="m-t"]').fill('24');
  await waitUntil(() => classes().includes('mt-6'), 'the next value commits too');
  await page.keyboard.press('Escape');
  await settle();
  await page.keyboard.press('Control+z');
  await sleep(600);
  const typingProbe = `classes ${classes().join(' ')} | top ${JSON.stringify(runtime.undoStack.at(-1)?.label)} items ${runtime.undoStack.at(-1)?.items.length} | toast ${await page.locator('#toast').innerText().catch(() => '')}`;
  await waitUntil(() => classes().includes('mt-4') && !classes().some(name => /^mt-/.test(name) && name !== 'mt-4'), `one undo reverts the whole typing session (${typingProbe})`);
  checks.push('typing a number commits live and the whole typing session is one undo step');
  await drag('margin', 'b', 0, 12 * scale);
  await waitUntil(() => classes().includes('mb-17') && !classes().includes('mb-14'), 'dragging the bottom margin pill by 12px (56 → 68px) sets mb-17');
  checks.push('dragging a margin pill on the canvas sets that side\'s margin as a class (4px steps)');

  // The drag is live: the project and the inspector follow the pointer, not only the release.
  await drag('margin', 'b', 0, 8 * scale, [], async () => {
    await waitUntil(() => classes().some(name => /^mb-(?:18|19)$/.test(name)), `the model updates while the pointer is still down (${classes().join(' ')})`);
    await waitUntil(async () => /^7[26]$/.test((await page.locator('#inspector [data-key="m-b"]').inputValue().catch(() => '')).trim()) || (await page.locator('#inspector [data-key="m-b"]').inputValue().catch(() => '')) === '76', 'the inspector shows the dragged margin before the release');
  });
  await waitUntil(() => classes().includes('mb-19'), 'the release settles on the final value');
  { let version = runtime.read({ view: 'document', documentId: 'welcome' }).version; for (let i = 0; i < 40; i++) { await sleep(120); const next = runtime.read({ view: 'document', documentId: 'welcome' }).version; if (next === version) break; version = next; } }
  await page.keyboard.press('Control+z');
  await waitUntil(() => classes().includes('mb-17') && !classes().includes('mb-19'), 'the whole live drag is one undo step');
  checks.push('a pill drag commits live (model and inspector follow) and is still one undo step');
  assert.ok(!runtime.readHistory().changes.some(change => change.summary === 'no change'), 'a drag release does not add a no-change row to History');
  // Resting the pointer on a pill explains it (the browser's own tooltip on the canvas).
  {
    const read = () => page.evaluate(async () => { const c = await import('./lib/canvas.js'); const e = c.entries.get('welcome'); const h = e.handles?.find(item => item.id === 'padding-l'); if (!h) return null; const f = e.iframe.getBoundingClientRect(); return { x: f.left + (h.x + h.w / 2) * c.camera.k, y: f.top + (h.y + h.h / 2) * c.camera.k }; });
    const point = await waitUntil(read, 'the padding pill is reported');
    await page.mouse.move(point.x, point.y);
    await waitUntil(async () => /left padding/.test(await page.evaluate(() => document.querySelector('#viewport').title)), 'the pill explains itself in a tooltip');
    await page.mouse.move(point.x + 300, point.y + 200);
    await waitUntil(async () => (await page.evaluate(() => document.querySelector('#viewport').title)) === '', 'the tooltip goes away');
  }
  checks.push('the pills explain themselves in a tooltip');
  await drag('padding', 'l', 8 * scale, 0);
  await waitUntil(() => classes().includes('pl-4'), 'dragging the left padding pill by 8px (8 → 16px) sets pl-4');
  const history = runtime.readHistory().changes;
  assert.match(history.at(-1).label || history.at(-1).summary || '', /padding left 16px/, 'one history entry names the edit');
  await page.keyboard.press('Control+z');
  await waitUntil(() => !classes().includes('pl-4') && classes().includes('p-2'), 'one undo reverts the drag');
  checks.push('dragging a padding pill is one undo step with a readable history entry');
  // The gap of a flex container: one pill after the first child.
  await drag('gap', 'x', 12 * scale, 0, [], async () => {
    await waitUntil(async () => (await frame.locator('#divlet-boxes').innerText()).includes('12px'), 'a live gap label shows 12px while dragging');
  });
  await waitUntil(() => classes().includes('gap-3'), 'dragging the gap pill by 12px (0 → 12px) sets gap-3');
  await page.keyboard.press('Control+z');
  await waitUntil(() => !classes().includes('gap-3'), 'one undo reverts the gap drag');
  checks.push('dragging the gap pill of a flex container sets gap-N in one undo step');

  // The same pills work with a finger: a touch drag on a pill (pointer events) changes the side like the mouse does.
  {
    const touch = await (await browser.newContext({ viewport: { width: 1500, height: 900 }, hasTouch: true })).newPage();
    await touch.goto(runtime.info().url);
    await touch.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
    await touch.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['cta']); });
    const cdp = await touch.context().newCDPSession(touch);
    const pillAt = () => touch.evaluate(async () => { const c = await import('./lib/canvas.js'); const e = c.entries.get('welcome'); const h = e.handlesNode === 'cta' ? e.handles?.find(item => item.id === 'margin-b') : null; if (!h) return null; const f = e.iframe.getBoundingClientRect(); return { x: f.left + (h.x + h.w / 2) * c.camera.k, y: f.top + (h.y + h.h / 2) * c.camera.k, k: c.camera.k }; });
    const point = await waitUntil(async () => { const a = await pillAt(); if (!a) return null; await sleep(250); const b = await pillAt(); return b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 ? b : null; }, 'the margin pill is reported for the touch page');
    const ctaClasses = () => runtime.read({ view: 'document', documentId: 'welcome' }).nodes.cta.className;
    const before = ctaClasses();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
    for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + step * 3 * point.k }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitUntil(() => ctaClasses() !== before && /\bmb-\d+/.test(ctaClasses()), 'a touch drag on the pill sets a margin class');
    await touch.keyboard.press('Control+z');
    await touch.close();
  }
  checks.push('the pills also work with a finger (touch drag)');

  // Reordering: the grip of the selected element drops it before or after another element.
  const doc = runtime.read({ view: 'document', documentId: 'welcome' });
  const parentId = Object.keys(doc.nodes).find(id => doc.nodes[id].type === 'element' && doc.nodes[id].children.filter(child => doc.nodes[child].type === 'element').length >= 3 && id !== 'nav' && id !== doc.rootId);
  assert.ok(parentId, 'the fixture has a container with three or more element children');
  const kids = () => runtime.read({ view: 'document', documentId: 'welcome' }).nodes[parentId].children;
  const [first, , last] = kids().filter(child => doc.nodes[child].type === 'element');
  await page.evaluate(async id => { const m = await import('./lib/store.js'); m.selectNodes('welcome', [id]); }, first);
  const readGrip = () => page.evaluate(async id => { const c = await import('./lib/canvas.js'); const e = c.entries.get('welcome'); const h = e.handlesNode === id ? e.handles?.find(item => item.id === 'move') : null; if (!h) return null; const f = e.iframe.getBoundingClientRect(); return { x: f.left + (h.x + h.w / 2) * c.camera.k, y: f.top + (h.y + h.h / 2) * c.camera.k }; }, first);
  const grip = await waitUntil(async () => { const a = await readGrip(); if (!a) return null; await sleep(250); const b = await readGrip(); return b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 ? b : null; }, 'the grip of the selected element is reported and settled');
  const targetBox = await frame.locator(`[data-divlet-id="${last}"]`).boundingBox();
  const order = kids().join();
  await page.mouse.move(grip.x, grip.y); await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width * 0.9, targetBox.y + targetBox.height * 0.9, { steps: 8 });
  await waitUntil(() => kids().join() !== order, `the reorder reaches the project while the pointer is still down (${kids().join()})`);
  await page.mouse.up();
  await waitUntil(() => kids().join() !== order && kids().indexOf(first) > kids().indexOf(last), 'dropping the grip after the last sibling moves the element behind it');
  await settle();
  assert.match(runtime.readHistory().changes.at(-1).label || '', /^move .* after /, 'one history entry names the move');
  await page.keyboard.press('Control+z');
  await waitUntil(() => kids().join() === order, 'one undo restores the order');
  checks.push('dragging an element by its grip reorders live and is still one undo step');

  // Escape during a grip drag that already reordered: the order comes back and no extra undo step is left behind.
  {
    const orderNow = kids().join();
    const depth = runtime.undoStack.length;
    const spot = await waitUntil(async () => { const a = await readGrip(); if (!a) return null; await sleep(250); const b = await readGrip(); return b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 ? b : null; }, 'the grip is reported again');
    const target = await frame.locator(`[data-divlet-id="${last}"]`).boundingBox();
    await page.mouse.move(spot.x, spot.y); await page.mouse.down();
    await page.mouse.move(target.x + target.width * 0.9, target.y + target.height * 0.9, { steps: 8 });
    await waitUntil(() => kids().join() !== orderNow, `the live reorder lands before the escape (${kids().join()})`);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await waitUntil(() => kids().join() === orderNow, `Escape restores the order (${kids().join()})`);
    assert.equal(runtime.undoStack.length, depth, 'the cancelled drag leaves no undo step behind');
    assert.equal(kids().length, 4, 'and loses no child');
  }
  checks.push('Escape during a live reorder restores the order and leaves no step');

  // Alt while dropping: the grip drags a copy (one undo step for the duplicate and the move).
  const before = kids().length;
  await drag('move', '', targetBox.x + targetBox.width * 0.9 - grip.x, targetBox.y + targetBox.height * 0.9 - grip.y, ['Alt']);
  const known = kids();
  const copyId = () => kids().find(id => !known.includes(id));
  await waitUntil(() => kids().length === before + 1 && copyId() && kids().indexOf(copyId()) > kids().indexOf(last) && kids().indexOf(first) < kids().indexOf(last), 'Alt-dropping puts a copy behind the last sibling and keeps the original');
  { const toastText = await page.locator('#toast').innerText().catch(() => ''); const changes = runtime.readHistory().changes; assert.match(changes.at(-1).label || '', /^copy .* after /, `the history names the copy (${changes.slice(-3).map(item => item.label).join(' | ')}; order ${kids().join()}; toast ${toastText})`); }
  await settle();
  await page.keyboard.press('Control+z');
  await waitUntil(() => kids().length === before, 'one undo removes the copy again');
  checks.push('Alt-dragging the grip copies an element in one undo step');

  // A component instance has no styles of its own: it keeps its grip but shows no spacing, gap or size handles.
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['pricing']); });
  const pricing = runtime.read({ view: 'document', documentId: 'pricing' });
  const instance = Object.keys(pricing.nodes).find(id => pricing.nodes[id].type === 'ref');
  await page.evaluate(async id => { const m = await import('./lib/store.js'); m.selectNodes('pricing', [id]); }, instance);
  await waitUntil(() => page.evaluate(async id => (await import('./lib/canvas.js')).entries.get('pricing').handlesNode === id, instance), 'the instance reports its handles');
  const instanceHandles = await page.evaluate(async () => (await import('./lib/canvas.js')).entries.get('pricing').handles.map(item => item.id));
  assert.deepEqual(instanceHandles, ['move'], 'an instance offers only its grip');
  checks.push('a component instance offers only the grip (no spacing, gap or size handles)');
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); });

  // The handles are a preference in Settings: off hides them (the spacing bands stay), on brings them back.
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['cta']); });
  await waitUntil(() => page.evaluate(async () => (await import('./lib/canvas.js')).entries.get('welcome').handles?.length > 0), 'the handles are shown by default');
  await page.evaluate(async () => (await import('./lib/help.js')).toggle(true));
  await page.locator('#help [data-handles="off"]').click();
  await waitUntil(() => page.evaluate(async () => (await import('./lib/canvas.js')).entries.get('welcome').handles?.length === 0), 'switching the handles off hides them');
  assert.equal(await page.evaluate(() => localStorage.getItem('divlet:handles')), 'off', 'the preference is remembered');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.handles), 'off', 'the toggled switch keeps keyboard focus');
  const bandsWhileOff = await overlay.locator('> div').count();
  assert.ok(bandsWhileOff >= 2, `the margin and padding bands stay while the handles are off (${bandsWhileOff})`);
  await page.locator('#help [data-handles="on"]').click();
  await waitUntil(() => page.evaluate(async () => (await import('./lib/canvas.js')).entries.get('welcome').handles?.length > 0), 'switching them on brings them back');
  await page.keyboard.press('Escape');
  checks.push('canvas handles can be switched off and on in Settings, and the choice is remembered');

  // Resizing: the corner square sets width and height (4px steps, the Tailwind scale) in one undo step.
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectNodes('welcome', ['cta']); });
  await waitUntil(() => page.evaluate(async () => (await import('./lib/canvas.js')).entries.get('welcome').handlesNode === 'cta'), 'the corner handle of the button is reported');
  const ctaClasses = () => runtime.read({ view: 'document', documentId: 'welcome' }).nodes.cta.className.split(' ');
  await drag('size', '', 24 * scale, 12 * scale, [], async () => {
    await waitUntil(async () => /^\d+ × \d+$/.test((await frame.locator('#divlet-boxes').innerText()).trim().split('\n').pop()), 'a live width × height label follows the corner while dragging');
  });
  await waitUntil(() => ctaClasses().some(name => /^w-\d+$/.test(name)) && ctaClasses().some(name => /^h-\d+$/.test(name)), 'dragging the corner sets a width and a height class');
  await settle();
  assert.match(runtime.readHistory().changes.at(-1).label || '', /^size width \d+px, height \d+px on cta$/, 'one history entry names the resize');
  await page.keyboard.press('Control+z');
  await waitUntil(() => !ctaClasses().some(name => /^[wh]-(?:\d+|\[)/.test(name)), () => `one undo removes both (${ctaClasses().join(' ')})`);
  checks.push('dragging the corner square resizes an element in one undo step');

  // The size handle's modifiers: Alt moves in 1px steps, Shift changes only the width, Ctrl only the height.
  // A drag commits while it runs, so wait until the project stops changing before undoing it as one step.
  const plainUndo = async label => {
    await settle();
    await page.keyboard.press('Control+z');
    const probe = async () => `${label}: ${ctaClasses().join(' ')} | undo ${JSON.stringify(runtime.undoStack.at(-1)?.label)} items ${runtime.undoStack.at(-1)?.items.length} | toast ${await page.locator('#toast').innerText().catch(() => '')}`;
    await waitUntil(async () => !ctaClasses().some(name => /^[wh]-(?:\d+|\[)/.test(name)), await probe());
  };
  const sizeClasses = () => ctaClasses().filter(name => /^[wh]-(?:\d+|\[)/.test(name));
  {
    await drag('size', '', 6 * scale, 0, ['Alt']);
    await waitUntil(() => sizeClasses().some(name => /^w-\[/.test(name)), `Alt writes an arbitrary width (${sizeClasses().join(' ') || 'nothing'})`);
    const width = Number(/^w-\[(\d+(?:\.\d+)?)px\]$/.exec(sizeClasses().find(name => /^w-\[/.test(name)))?.[1]);
    assert.ok(Number.isFinite(width) && width % 4 !== 0, `Alt moves in 1px steps: ${width}px is not a multiple of 4`);
    await plainUndo('undo the Alt resize');

    await drag('size', '', 8 * scale, 8 * scale, ['Shift']);
    await waitUntil(() => sizeClasses().some(name => /^w-\d+$/.test(name)), `Shift writes a width (${sizeClasses().join(' ') || 'nothing'})`);
    assert.ok(!sizeClasses().some(name => /^h-(?:\d+|\[)/.test(name)), `Shift changes only the width: ${sizeClasses().join(' ')}`);
    await plainUndo('undo the Shift resize');

    await drag('size', '', 8 * scale, 8 * scale, ['Control']);
    await waitUntil(() => sizeClasses().some(name => /^h-\d+$/.test(name)), `Ctrl writes a height (${sizeClasses().join(' ') || 'nothing'})`);
    assert.ok(!sizeClasses().some(name => /^w-(?:\d+|\[)/.test(name)), `Ctrl changes only the height: ${sizeClasses().join(' ')}`);
    await plainUndo('undo the Ctrl resize');
  }
  checks.push('the size handle honours Alt (1px), Shift (width only) and Ctrl (height only)');

  // Zoomed out, a pill is a few screen pixels wide, so its hit area grows to 16 screen pixels.
  {
    await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectNodes('welcome', ['nav']); });
    await waitUntil(() => page.evaluate(async () => (await import('./lib/canvas.js')).entries.get('welcome').handlesNode === 'nav'), 'the nav handles are reported');
    await page.evaluate(async () => { (await import('./lib/canvas.js')).setCamera({ k: 0.5 }); });
    await sleep(300);
    const pill = await page.evaluate(async () => { const c = await import('./lib/canvas.js'); const e = c.entries.get('welcome'); const h = e.handles?.find(item => item.id === 'margin-b'); if (!h) return null; const f = e.iframe.getBoundingClientRect(); return { w: h.w, h: h.h, k: c.camera.k, x: f.left + (h.x + h.w / 2) * c.camera.k, y: f.top + (h.y + h.h / 2) * c.camera.k }; });
    assert.ok(pill, 'the margin pill is reported at the zoomed-out camera');
    assert.ok(Math.min(pill.w, pill.h) * pill.k < 16, `the pill itself is only ${(Math.min(pill.w, pill.h) * pill.k).toFixed(1)} screen px across`);
    const outside = pill.x + (pill.w / 2 + 1) * pill.k; // one page pixel past the pill's own edge
    await page.mouse.move(outside, pill.y); await page.mouse.down(); await page.mouse.move(outside, pill.y + 8 * pill.k); await page.mouse.up();
    await waitUntil(() => classes().includes('mb-19'), 'a press just outside the pill still grabs it (its hit area is at least 16 screen px)');
    await page.keyboard.press('Control+z');
    await waitUntil(() => !classes().includes('mb-19'), 'the zoomed-out drag is one undo step');
  }
  checks.push('zoomed out, the pill hit area stays at least 16 screen pixels');

  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); });
  await waitUntil(async () => (await overlay.locator('> div').count()) === 0, 'selecting an artboard clears the overlay');
  // The centre is the true CSS content box, not a transformed border-box rectangle or invented sample numbers.
  const probe = decodeHtml('<main id="probe-root"><div id="box-probe" class="relative inset-0" style="box-sizing:border-box;width:75.328125px;height:44px;padding:4px;border:1px solid black;margin:0"></div><div id="box-other" class="relative inset-0 mt-3">Other</div></main>', { fallbackId: 'box-reference' });
  await runtime.create({ document: probe });
  await page.evaluate(async id => { const m = await import('./lib/store.js'); m.selectArtboards([id]); m.selectNodes(id, ['box-probe']); }, probe.id);
  await page.mouse.move(5, 5);
  const probeFrame = page.locator(`iframe[data-document-id="${probe.id}"]`).contentFrame();
  await waitUntil(async () => /65\.328 by 34/.test(await page.locator('#inspector .bm-core').getAttribute('aria-label') ?? ''), 'actual fractional content dimensions');
  assert.equal(await page.locator('#inspector [data-key="inset-t"]').count(), 1, 'offset has one home in the outer position band');
  assert.equal(await page.locator('#inspector [data-section="layout"] [data-key="inset-t"]').count(), 0, 'no duplicate layout offset editor');
  assert.deepEqual(await page.locator('#inspector .bm-border > .bm-cell').allTextContents(), ['1', '1', '1', '1']);
  assert.equal(await page.locator('#inspector .bm-padding [data-key="p-t"]').getAttribute('placeholder'), '4');
  await page.locator('#inspector [data-key="inset-t"]').fill('8');
  await page.keyboard.press('Enter');
  await waitUntil(() => runtime.read({ view: 'document', documentId: probe.id }).nodes['box-probe'].className.includes('top-2'), 'position edge edits the existing inset class path');
  await page.mouse.move(5, 5);
  await page.keyboard.press('Control+z');
  await waitUntil(() => !runtime.read({ view: 'document', documentId: probe.id }).nodes['box-probe'].className.includes('top-2'), 'position edge edit remains undoable');
  const patchProbe = async style => {
    const current = runtime.read({ view: 'document', documentId: probe.id });
    await runtime.patch({ documentId: probe.id, expectedVersion: current.version, patch: { nodes: { 'box-probe': { style } } } });
  };
  await patchProbe({ 'box-sizing': 'content-box', width: '65.328125px', height: '34px', transform: 'scale(1.5)', 'margin-top': '-6.5px', 'border-right-width': '3px' });
  await waitUntil(async () => (await page.locator('#inspector .bm-border > .bm-r').innerText()) === '3', 'asymmetric computed border readback');
  assert.match(await page.locator('#inspector .bm-core').getAttribute('aria-label'), /65\.328 by 34/, 'content-box and transforms do not inflate the content measurement');
  assert.equal(await page.locator('#inspector [data-key="m-t"]').getAttribute('placeholder'), '-6.5', 'negative measured margins are not clamped to zero');
  assert.ok(await probeFrame.locator('[data-divlet-id="box-probe"]').evaluate(node => node.getBoundingClientRect().width > 100));
  await patchProbe({ display: 'none' });
  await waitUntil(async () => /— by —/.test(await page.locator('#inspector .bm-core').getAttribute('aria-label') ?? ''), 'a hidden element has no fabricated content size');
  await patchProbe({ display: null, 'box-sizing': 'border-box', width: '75.328125px', height: '44px', transform: null, 'margin-top': null, 'border-right-width': null });
  await waitUntil(async () => /65\.328 by 34/.test(await page.locator('#inspector .bm-core').getAttribute('aria-label') ?? ''), 'measurement recovers after showing the element');
  await mkdir('artifacts', { recursive: true });
  for (const [width, size, theme] of [[1280, 100, 'light'], [390, 100, 'dark'], [390, 200, 'light']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(async ({ size, theme }) => { (await import('./lib/help.js')).setUiSize(size); document.documentElement.dataset.theme = theme; }, { size, theme });
    await page.locator('#inspector .boxmodel').scrollIntoViewIfNeeded();
    await sleep(350);
    const collisions = await page.locator('#inspector .boxmodel').evaluate(model => {
      const fields = [...model.querySelectorAll('.bm-field, .bm-offset, .bm-readout, .bm-core')].map(node => node.getBoundingClientRect());
      const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      const bad = [];
      if (model.scrollWidth > model.clientWidth + 1) bad.push('widget overflows');
      for (let a = 0; a < fields.length; a++) for (let b = a + 1; b < fields.length; b++) if (overlap(fields[a], fields[b])) bad.push(`targets ${a}/${b} overlap`);
      for (const node of model.querySelectorAll('.bm-caption, .bm-dimension')) {
        if (node.scrollWidth > node.clientWidth + 1) bad.push(`${node.textContent} clips`);
        if (node.matches('.bm-caption') && fields.some(field => overlap(node.getBoundingClientRect(), field))) bad.push(`${node.textContent} covers a value`);
      }
      return bad;
    });
    assert.deepEqual(collisions, [], `box model at ${width}px/${size}%/${theme}`);
    assert.equal(await page.locator('#inspector .bm-margin input').first().evaluate(input => getComputedStyle(input, '::placeholder').opacity), '1', 'computed fallback numbers keep full contrast on the coloured bands');
    await page.mouse.move(width - 1, 1);
    await page.evaluate(() => document.activeElement?.blur());
    await sleep(250);
    await page.locator('#inspector .boxmodel').screenshot({ path: `artifacts/boxmodel-${width}-${size}-${theme}.png` });
  }
  await page.evaluate(async () => (await import('./lib/help.js')).setUiSize(100));
  await page.mouse.move(5, 5);
  await patchProbe({ 'margin-top': '-123.456px', left: '123.456px', padding: '16.25px' });
  const current = runtime.read({ view: 'document', documentId: probe.id });
  await runtime.patch({ documentId: probe.id, expectedVersion: current.version, patch: { nodes: { 'box-probe': { className: 'relative p-[16.25px] ml-[123.456px]' } } } });
  await waitUntil(async () => (await page.locator('#inspector [data-key="m-t"]').getAttribute('placeholder')) === '-123.456', 'long computed fallback');
  assert.equal(await page.locator('#inspector [data-key="inset-l"]').getAttribute('placeholder'), '123.456');
  for (const [width, size] of [[1280, 100], [390, 200]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(async size => (await import('./lib/help.js')).setUiSize(size), size);
    await page.locator('#inspector .boxmodel').scrollIntoViewIfNeeded();
    await sleep(350);
    const clipped = await page.locator('#inspector .boxmodel').evaluate(model => {
      const canvas = document.createElement('canvas').getContext('2d');
      return [...model.querySelectorAll('input')].flatMap(input => {
        const style = getComputedStyle(input);
        canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const shown = input.value || input.placeholder;
        return canvas.measureText(shown).width > input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 1 ? [`${input.dataset.key}: ${shown}`] : [];
      });
    });
    assert.deepEqual(clipped, [], `whole authored and computed fractional/signed values at ${width}px/${size}%`);
    const overflow = await page.locator('#inspector .boxmodel').evaluate(model => model.scrollWidth - model.clientWidth);
    assert.ok(overflow <= 1, 'expansion adds height, not horizontal overflow');
    await page.locator('#inspector .boxmodel').screenshot({ path: `artifacts/boxmodel-long-${width}-${size}.png` });
  }
  const boxTouch = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true });
  const touchPage = await boxTouch.newPage();
  await touchPage.goto(runtime.url);
  await touchPage.waitForSelector('.artboard');
  await touchPage.evaluate(async id => { (await import('./lib/help.js')).setUiSize(200); const m = await import('./lib/store.js'); m.selectArtboards([id]); m.selectNodes(id, ['box-probe']); }, probe.id);
  await touchPage.waitForSelector('#inspector [data-key="inset-l"]');
  await waitUntil(async () => (await touchPage.locator('#inspector [data-key="m-t"]').getAttribute('placeholder')) === '-123.456', 'coarse-pointer long measurements');
  const touchTargets = await touchPage.locator('#inspector .boxmodel').evaluate(model => {
    const bad = [], canvas = document.createElement('canvas').getContext('2d');
    const controls = [...model.querySelectorAll('.vf')];
    const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    for (const field of controls) {
      const rect = field.getBoundingClientRect(), input = field.querySelector('input'), style = getComputedStyle(input);
      if (rect.width < 24 || rect.height < 24) bad.push(`${input.dataset.key} has a small touch target`);
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      if (canvas.measureText(input.value || input.placeholder).width > input.clientWidth + 1) bad.push(`${input.dataset.key} clips`);
    }
    for (let a = 0; a < controls.length; a++) for (let b = a + 1; b < controls.length; b++) if (overlap(controls[a].getBoundingClientRect(), controls[b].getBoundingClientRect())) bad.push(`touch targets ${a}/${b} overlap`);
    if (model.scrollWidth > model.clientWidth + 1) bad.push('touch widget overflows');
    return bad;
  });
  assert.deepEqual(touchTargets, [], 'coarse-pointer phone/200% keeps full values and distinct 24px targets');
  await boxTouch.close();
  await page.evaluate(async id => { (await import('./lib/store.js')).selectNodes(id, ['box-probe', 'box-other']); }, probe.id);
  await waitUntil(async () => /— by —/.test(await page.locator('#inspector .bm-core').getAttribute('aria-label') ?? ''), 'multi-selection does not invent aggregate geometry');
  assert.deepEqual(await page.locator('#inspector .bm-border > .bm-cell').allTextContents(), ['—', '—', '—', '—']);
  assert.equal(await page.locator('#inspector [data-key="m-t"]').getAttribute('placeholder'), '—');
  checks.push('real per-edge borders, signed margins, fractional untransformed content size, hidden/visible recovery, one undoable offset editor, truthful mixed state and desktop/phone/200% geometry');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser?.close(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
