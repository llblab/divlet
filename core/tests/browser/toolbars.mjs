// Smart toolbars and units: the inspector is as wide as the toolbar until resized (double-click resets), its action bar
// fits itself with a dynamic dropdown, values show their units, and chrome text is shown whole.
import assert from 'node:assert/strict';
import { legacyProject } from '../fixtures/legacy-project.js';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../lib/runtime.js';
import { decodeHtml } from '../../lib/codec.ts';

const playwright = await import('playwright');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-toolbars-'));
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
let browser;
try {
  browser = await playwright.chromium.launch(launch);
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })).newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(runtime.info().url);
  await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
  const select = ids => page.evaluate(async ids => { const m = await import('./lib/store.js'); m.selectArtboards(ids); }, ids);
  const width = selector => page.locator(selector).evaluate(node => node.getBoundingClientRect().width);

  // Default width: the toolbar's.
  await select(['welcome']);
  await page.waitForSelector('#inspector:not([hidden]) .smart-bar');
  const dock = await width('#dock');
  await waitUntil(async () => Math.abs(await width('#inspector') - Math.max(dock, 280)) <= 1.5, 'the inspector is as wide as the toolbar');
  checks.push('the inspector is as wide as the toolbar by default');

  // Drag the edge wider, then double-click it: back to the default.
  const handle = page.locator('.resize-handle[data-panel="inspector"]');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + 4, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
  await waitUntil(async () => await width('#inspector') > dock + 80, 'dragging widens the inspector');
  await handle.dblclick();
  await waitUntil(async () => Math.abs(await width('#inspector') - Math.max(dock, 280)) <= 1.5, 'double-clicking the edge restores the toolbar width');
  checks.push('dragging the edge resizes; a double-click on it returns to the toolbar width');

  // A plain click on the edge is not a user-set width: the default keeps following the toolbar.
  await handle.click({ position: { x: 4, y: 40 } });
  assert.equal(await page.evaluate(() => localStorage.getItem('divlet:width:inspector')), null, 'a click without a drag stores nothing');
  checks.push('only a real drag makes the inspector width the user\'s own');

  // Explicit panel preferences outrank auto sizing; constraints change rendering, never the saved choice.
  {
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
    const memory = await context.newPage();
    memory.on('pageerror', error => errors.push(error.message));
    const prepare = async () => {
      await memory.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
      await memory.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); (await import('./lib/sidebar.js')).show('layers'); });
      await memory.locator('.resize-handle[data-panel="sidebar"]').waitFor();
      await memory.locator('.resize-handle[data-panel="inspector"]').waitFor();
    };
    const saved = key => memory.evaluate(key => localStorage.getItem(`divlet:width:${key}`), key);
    const size = key => memory.locator(key === 'sidebar' ? '#sidebar' : '#inspector').evaluate(node => node.getBoundingClientRect().width);
    const drag = async (key, target, cancel = false) => {
      const grip = memory.locator(`.resize-handle[data-panel="${key}"]`), box = await grip.boundingBox();
      const from = Number(await grip.getAttribute('aria-valuenow')), x = box.x + 4, y = box.y + box.height / 2;
      await grip.evaluate(node => node.addEventListener('pointerdown', event => { node.dataset.testPointer = String(event.pointerId); }, { once: true }));
      await memory.mouse.move(x, y); await memory.mouse.down();
      await memory.mouse.move(x + (target - from) * (key === 'sidebar' ? 1 : -1), y, { steps: 6 });
      if (cancel === 'pointercancel') {
        const before = await saved(key);
        await grip.press('ArrowRight');
        assert.equal(await saved(key), before, 'keys cannot persist an unfinished pointer preview');
      }
      if (cancel) {
        const other = Number(await grip.getAttribute('data-test-pointer')) + 100;
        await grip.dispatchEvent('pointerup', { pointerId: other, isPrimary: false });
        assert.equal(await grip.evaluate(node => node.classList.contains('dragging')), true, 'another pointer cannot complete the primary resize');
      }
      if (cancel === 'Escape') await memory.keyboard.press('Escape');
      else if (cancel === 'blur') await memory.evaluate(() => window.dispatchEvent(new Event('blur')));
      else if (cancel) await grip.dispatchEvent(cancel, { pointerId: Number(await grip.getAttribute('data-test-pointer')) });
      await memory.mouse.up();
    };
    await memory.goto(runtime.info().url); await prepare();
    const revision = runtime.revision;
    for (const [key, wanted] of [['sidebar', 432], ['inspector', 608]]) {
      await drag(key, wanted);
      assert.equal(await saved(key), String(wanted), `${key} records the chosen logical width`);
      for (const cancel of ['pointercancel', 'lostpointercapture', 'Escape', 'blur']) {
        await drag(key, wanted + 16, cancel);
        assert.equal(await saved(key), String(wanted), `${cancel} cannot overwrite primary preference`);
        await waitUntil(async () => Math.abs(await size(key) - wanted) < 1, 'cancellation restores preferred width');
      }
    }
    await memory.reload(); await prepare();
    for (const [key, wanted] of [['sidebar', 432], ['inspector', 608]]) await waitUntil(async () => Math.abs(await size(key) - wanted) < 1, `${key} survives reload (stored ${await saved(key)})`);
    await memory.evaluate(async () => (await import('./lib/store.js')).selectNodes('welcome', ['nav']));
    for (const [key, wanted] of [['sidebar', 432], ['inspector', 608]]) assert.ok(Math.abs(await size(key) - wanted) < 1, 'selection/toolbar changes never replace a chosen width');
    for (const [viewport, ui] of [[725, 100], [390, 100], [1280, 200], [1500, 125], [1500, 100]]) {
      await memory.setViewportSize({ width: viewport, height: 900 });
      await memory.evaluate(async ui => (await import('./lib/help.js')).setUiSize(ui), ui);
      await memory.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (viewport !== 1500) assert.ok(await memory.evaluate(() => Number.parseFloat(document.documentElement.style.getPropertyValue('--inspector-w')) < 608), 'narrow rendering really constrains the inspector');
      assert.equal(await saved('sidebar'), '432'); assert.equal(await saved('inspector'), '608');
      if (ui === 125) for (const [key, wanted] of [['sidebar', 432], ['inspector', 608]]) {
        await waitUntil(async () => Math.abs(await size(key) / 1.25 - wanted) < 1, 'stored widths are logical interface pixels');
        await waitUntil(async () => await memory.locator(`.resize-handle[data-panel="${key}"]`).getAttribute('aria-valuenow') === String(wanted), 'separator values use the same logical units as their bounds');
      }
    }
    for (const [key, wanted] of [['sidebar', 432], ['inspector', 608]]) await waitUntil(async () => Math.abs(await size(key) - wanted) < 1, `${key}: wide/100% restores the original choice after clamping/sheet layout`);
    const sibling = await context.newPage(); await sibling.goto(runtime.info().url);
    await sibling.evaluate(() => localStorage.setItem('divlet:width:sidebar', '448'));
    await waitUntil(async () => Math.abs(await size('sidebar') - 448) < 1, 'same-origin storage updates are authoritative in an already open tab');
    for (const invalid of ['Infinity', '-1', 'not a number']) {
      await sibling.evaluate(value => localStorage.setItem('divlet:width:sidebar', value), invalid);
      await waitUntil(async () => Math.abs(await size('sidebar') - 300) < 1, 'invalid stored values cannot mask the default');
    }
    await sibling.close();
    for (const key of ['sidebar', 'inspector']) { await memory.locator(`.resize-handle[data-panel="${key}"]`).dblclick(); assert.equal(await saved(key), null, 'explicit reset clears the preference'); }
    // An unavailable persistence layer must not also lose the current session's explicit width on resize.
    await memory.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Storage disabled', 'QuotaExceededError'); }; });
    const keyboard = memory.locator('.resize-handle[data-panel="inspector"]');
    await keyboard.focus(); await keyboard.press('Shift+ArrowLeft');
    const sessionWidth = await size('inspector');
    await memory.setViewportSize({ width: 1400, height: 900 });
    await waitUntil(async () => Math.abs(await size('inspector') - sessionWidth) < 1, 'blocked writes still retain the preference for this session');
    assert.equal(await saved('inspector'), null, 'blocked storage cannot be presented as a durable save');
    assert.equal(runtime.revision, revision, 'panel preferences never become project content');
    await context.close();
    await select(['welcome']);
  }
  checks.push('both panel widths persist independently across reload, selection, viewport/zoom constraints and same-origin tabs; cancelled drags preserve the choice and explicit reset alone clears it');

  // The action bar: every action in one row, the rest in a dynamic dropdown.
  const total = await page.locator('#inspector .smart-bar .tool:not(.more)').count();
  assert.ok(total >= 8, 'every artboard action has a button');
  const visible = () => page.locator('#inspector .smart-bar .tool:not(.more):not([hidden])').count();
  const moreShown = () => page.locator('#inspector .smart-bar .more:not([hidden])').count();
  assert.ok(await visible() >= 6, 'many actions fit in the row');
  assert.equal(await page.evaluate(() => { const bar = document.querySelector('#inspector .smart-bar'); return bar.scrollWidth <= bar.clientWidth + 1; }), true, 'the row never overflows');
  await handle.dblclick();
  await page.evaluate(() => { document.documentElement.style.setProperty('--inspector-w', '280px'); });
  await waitUntil(async () => await moreShown() === 1, 'a narrow inspector moves actions into the dropdown');
  const hiddenCount = total - await visible();
  assert.ok(hiddenCount >= 1);
  await page.locator('#inspector .smart-bar .more').click();
  const labels = await page.locator('.menu [role="menuitem"]').allInnerTexts();
  assert.ok(labels.length >= hiddenCount, `the dropdown lists the hidden actions (${labels.length} >= ${hiddenCount})`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.documentElement.style.setProperty('--inspector-w', '640px'); });
  await waitUntil(async () => await moreShown() === 0, 'a wide inspector shows every action and no dropdown');
  assert.equal(await visible(), total);
  await page.evaluate(() => { document.documentElement.style.removeProperty('--inspector-w'); });
  checks.push('the inspector action bar shows every action in a row and moves what does not fit into a dynamic dropdown');

  // Units.
  assert.equal(await page.locator('#inspector .num-unit').first().innerText(), 'px', 'artboard X/Y/W/H say px');
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectNodes('welcome', ['nav']); });
  await page.waitForSelector('#inspector .boxmodel');
  assert.equal((await page.locator('#inspector .bm-unit').first().innerText()), 'px', 'the spacing layers say px');
  const gap = page.locator('#inspector [data-key="gap"]');
  if (await gap.count()) {
    const unit = gap.locator('xpath=..').locator('.vf-unit');
    assert.equal(await unit.innerText(), 'px');
    await gap.fill('auto'); await gap.dispatchEvent('input');
    assert.equal(await unit.isHidden(), true, 'words carry no unit');
  }
  checks.push('values show their units (px) beside plain numbers');

  // Chrome text is shown whole: long names wrap instead of ending in an ellipsis.
  const truncated = await page.evaluate(() => [...document.querySelectorAll('.status .project, .crumb.home span, .panel-head .caption, .agent-status-text, .expanded-back #expanded-title, .bubble-about, .hover-badge span')]
    .filter(node => getComputedStyle(node).textOverflow === 'ellipsis').map(node => node.className || node.id));
  assert.deepEqual(truncated, [], 'chrome toolbars never truncate their text with an ellipsis');
  checks.push('toolbar text wraps instead of ending in an ellipsis');

  // Every control has an accessible name and a target of at least 20px, in the inspector, sidebar and dock.
  await select(['welcome']);
  await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('welcome', ['nav']));
  await page.waitForSelector('#inspector .boxmodel');
  const weak = await page.evaluate(() => [...document.querySelectorAll('#inspector, #sidebar, #dock, .brand, .side-tabs')].flatMap(area => [...area.querySelectorAll('button, input, select, textarea, [role=button], [role=tab]')]).filter(node => {
    const style = getComputedStyle(node), r = node.getBoundingClientRect();
    if (node.closest('[hidden]') || style.display === 'none' || style.visibility === 'hidden' || !r.width) return false;
    const named = (node.getAttribute('aria-label') || node.title || node.textContent || node.getAttribute('placeholder') || node.closest('label')?.textContent || '').trim();
    return !named || (node.tagName === 'BUTTON' && (r.width < 20 || r.height < 20));
  }).map(node => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)}`));
  assert.deepEqual(weak, [], 'every control is named and at least 20px');
  checks.push('every inspector, sidebar and toolbar control has a name and a target of at least 20px');

  // One chrome language: every outer pill carries the same frame and the same radius, and the search pill is one of them
  // (a `.tool` reset used to leave it borderless and squarer than the DIVLET button and the tabs).
  {
    await page.evaluate(async () => (await import('./lib/sidebar.js')).close());
    const chrome = await page.evaluate(() => {
      const read = selector => { const node = document.querySelector(selector); const c = getComputedStyle(node); return { radius: c.borderRadius, border: parseFloat(c.borderTopWidth) || 0, visible: node.getBoundingClientRect().width > 0 }; };
      return { status: read('#status'), search: read('#palette-open'), tab: read('#side-tabs .tab'), dock: read('#dock') };
    });
    for (const [name, value] of Object.entries(chrome)) {
      assert.equal(value.visible, true, `${name} is on screen`);
      assert.equal(value.radius, '14px', `${name} uses the chrome radius (${value.radius})`);
      assert.ok(value.border >= 1, `${name} carries the chrome frame (${value.border}px)`);
    }
    // Inside the dock the buttons are one step smaller, as the pill around them.
    const inner = await page.locator('#dock .tool').first().evaluate(node => getComputedStyle(node).borderRadius);
    assert.equal(inner, '9px', `inner chrome controls use the inner radius (${inner})`);
  }
  checks.push('the chrome shares one frame and one radius (search pill included)');

  // One chrome language, chosen by the panels: folded panels leave the pinned chrome frosted over the canvas; an open panel
  // makes the same pills part of one solid body. The search pill used to be fully transparent (a `.tool` reset).
  {
    const pills = ['#status', '#palette-open', '#side-tabs .tab', '#dock'];
    const readPills = async () => {
      // A hovered pill turns solid on its own: move the pointer onto the canvas so only the panel state is measured.
      await page.mouse.move(760, 320);
      await sleep(150);
      return page.evaluate(selectors => selectors.map(selector => {
        const node = document.querySelector(selector), c = getComputedStyle(node);
        const alpha = (c.backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1] || '').split(',').map(part => part.trim())[3];
        return { selector, hovered: node.matches(':hover'), alpha: alpha === undefined ? 1 : Number(alpha), blur: c.backdropFilter };
      }), pills);
    };
    await page.evaluate(async () => { (await import('./lib/sidebar.js')).close(); const m = await import('./lib/store.js'); m.selectArtboards([]); });
    await waitUntil(async () => (await page.evaluate(() => ({ panels: document.documentElement.dataset.panels, sidebar: document.querySelector('#sidebar').hidden, inspector: document.querySelector('#inspector').hidden, selected: document.querySelectorAll('.artboard.selected').length }))).panels === 'none', 'no panel is open');
    const frosted = await readPills();
    for (const pill of frosted) {
      assert.equal(pill.hovered, false, `${pill.selector} is not hovered while measured`);
      assert.ok(pill.alpha < 1 && pill.alpha > 0.5, `${pill.selector} is translucent while no panel is open (${pill.alpha})`);
      assert.match(pill.blur, /blur/, `${pill.selector} is frosted (${pill.blur})`);
    }
    await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); });
    await waitUntil(() => page.evaluate(() => !document.querySelector('#inspector').hidden), 'the inspector is open for the selected artboard');
    await page.evaluate(async () => (await import('./lib/sidebar.js')).show('layers'));
    await waitUntil(async () => (await page.evaluate(() => ({ panels: document.documentElement.dataset.panels, sidebar: document.querySelector('#sidebar').hidden, inspector: document.querySelector('#inspector').hidden }))).panels === 'both',
      async () => `both panels are open (${JSON.stringify(await page.evaluate(() => ({ panels: document.documentElement.dataset.panels, sidebar: document.querySelector('#sidebar').hidden, inspector: document.querySelector('#inspector').hidden })))})`);
    const solid = await readPills();
    for (const pill of solid.filter(item => item.selector !== '#side-tabs .tab')) {
      assert.equal(pill.hovered, false, `${pill.selector} is not hovered while measured`);
      assert.equal(pill.alpha, 1, `${pill.selector} is opaque while a panel is open (${pill.alpha})`);
      assert.equal(pill.blur, 'none', `${pill.selector} drops the blur (${pill.blur})`);
    }
    // The tabs belong to the open panel: they sit on its solid bar instead of carrying a surface of their own.
    const belonging = await page.evaluate(() => {
      const bar = document.querySelector('#side-tabs'), tab = bar.querySelector('.tab');
      const alpha = node => { const value = getComputedStyle(node).backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1] || ''; const parts = value.split(',').map(part => part.trim()); return parts[3] === undefined ? 1 : Number(parts[3]); };
      return { bar: alpha(bar), tab: alpha(tab) };
    });
    assert.equal(belonging.bar, 1, 'the tab row is a solid surface while the sidebar is open');
    assert.equal(belonging.tab, 0, 'a tab has no surface of its own there');
    await page.evaluate(async () => { (await import('./lib/sidebar.js')).close(); const m = await import('./lib/store.js'); m.selectArtboards([]); });
    await waitUntil(async () => {
      const state = await page.evaluate(() => ({ panels: document.documentElement.dataset.panels, sidebar: document.querySelector('#sidebar').hidden, inspector: document.querySelector('#inspector').hidden }));
      return state.panels === 'none';
    }, 'folding both panels restores the frosted chrome');
    const again = await readPills();
    for (const pill of again) assert.ok(pill.alpha < 1, `${pill.selector} is frosted again (${pill.alpha})`);
  }
  checks.push('the pinned chrome is frosted while panels are folded and solid while one is open');

  // One design contract: two inner radii plus the outer pill radius, one focus ring, one disabled step, and one height per
  // control family. The same element used differently in two places is the drift this guards against.
  {
    await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['nav']); (await import('./lib/sidebar.js')).show('layers'); });
    await page.waitForSelector('#inspector .pick');

    // Radii: the outer surfaces use --radius, controls inside them --radius-inner or --radius-small, and a pill is exactly
    // half its own height. Anything else is drift.
    const design = await page.evaluate(() => {
      const visible = node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !node.closest('iframe'); };
      const controls = [...document.querySelectorAll('#inspector button, #inspector input, #inspector select, #sidebar button, #dock button, #side-tabs button, #status, .search-pill, .palette-item')].filter(visible);
      const radii = [...new Set(controls.map(node => getComputedStyle(node).borderRadius))].sort();
      const pills = controls.filter(node => getComputedStyle(node).borderRadius === '11px').map(node => Math.round(node.getBoundingClientRect().height));
      const family = selector => [...new Set([...document.querySelectorAll(selector)].filter(visible).map(node => Math.round(node.getBoundingClientRect().height)))].sort();
      return {
        radii, pills,
        family: {
          dockTools: family('#dock .tool'), picks: family('#inspector .pick'), chips: family('#inspector .chip'),
          fields: family('#inspector .vf:not(.bm-field)'), boxFields: family('#inspector .bm-field'),
          nums: family('#inspector .num'), segs: family('#inspector .seg'),
        },
        disabled: [...new Set([...document.querySelectorAll('button:disabled')].map(node => getComputedStyle(node).opacity))],
      };
    });
    assert.deepEqual(design.radii.filter(radius => radius !== '0px'), ['11px', '14px', '6px', '9px'], `controls use three radii (${design.radii.join(', ')})`);
    assert.ok(design.pills.every(height => height <= 24), `the only 11px radius is a pill (${design.pills.join(', ')})`);
    for (const [name, heights] of Object.entries(design.family)) assert.ok(heights.length <= 1, `${name} share one height (${heights.join(', ')})`);
    assert.deepEqual(design.disabled, ['0.4'], `disabled controls share one step (${design.disabled.join(', ')})`);

    // One ring, declared once: every focus rule reads the same token, and a field wrapper rings instead of its input (which
    // would draw a second one). `:focus-visible` follows the browser's modality heuristic, so the browser check measures the
    // wrapper's `:focus-within`, which is deterministic.
    const css = await readFile(path.join(root, 'web/board.css'), 'utf8');
    assert.match(css, /--focus-ring: 2px;/, 'one focus ring width is shared');
    // Forced colours replace author colours with system ones, so that block is checked on its own.
    const [plain, forced = ''] = css.split('@media (forced-colors: active)');
    const focusRules = plain.split('\n').filter(line => /:focus(?:-visible|-within)?[^{]*\{[^}]*outline/.test(line) && !/outline: none/.test(line));
    for (const line of focusRules) assert.ok(/var\(--focus-ring\)/.test(line), `every focus outline uses the token: ${line.slice(0, 90)}`);
    assert.equal(/outline: (?:1\.5|2)px solid var\(--accent\)/.test(plain), false, 'no focus rule hard-codes its own width');
    assert.match(forced, /:focus-visible[^{]*\{[^}]*outline: 2px solid Highlight/, 'forced colours keep one system-colour ring');
    const ring = await page.evaluate(() => {
      const input = document.querySelector('#inspector .vf input');
      input.focus();
      const inner = getComputedStyle(input), wrapper = getComputedStyle(input.closest('.vf'));
      return { focused: document.activeElement === input, inner: inner.outlineStyle, wrapper: wrapper.outlineStyle, width: wrapper.outlineWidth, colour: wrapper.outlineColor };
    });
    assert.equal(ring.focused, true, 'the field input takes focus');
    assert.equal(ring.inner, 'none', 'an input inside a field does not draw a second ring');
    assert.deepEqual({ style: ring.wrapper, width: ring.width, colour: ring.colour }, { style: 'solid', width: '2px', colour: 'rgb(91, 91, 240)' }, 'its wrapper draws the shared ring');
  }
  checks.push('one design contract: three radii, one focus ring, one disabled step, one height per control family');

  // One vertical inspector: native disclosures are the only section controls. Old tab-order preferences are inert.
  {
    const inspectorContext = await browser.newContext({ viewport: { width: 1400, height: 900 }, hasTouch: true });
    const inspectorPage = await inspectorContext.newPage();
    inspectorPage.on('pageerror', error => errors.push(error.message));
    await inspectorPage.addInitScript(() => { if (window === window.top) localStorage.setItem('divlet:inspector-order', '["appearance","effects","spacing","layout"]'); });
    await inspectorPage.goto(runtime.info().url);
    const selectSubject = async () => {
      await inspectorPage.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
      await inspectorPage.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['nav']); });
      await inspectorPage.waitForSelector('#inspector [data-section="layout"] details.fold > summary');
      await inspectorPage.waitForSelector('#inspector [data-section="measured"]');
      assert.equal(await inspectorPage.locator('#inspector').evaluate(node => node.lastElementChild?.dataset.section), 'measured', 'read-only geometry/overflow follows every editing section, including metadata');
    };
    await selectSubject();
    const inspector = inspectorPage.locator('#inspector');
    const layout = inspector.locator('[data-section="layout"] details.fold');
    const order = () => inspectorPage.evaluate(() => [...document.querySelectorAll('#inspector section.group')].map(node => node.dataset.section));
    assert.equal(await inspector.locator('.fold-tabs, .fold-tab, [role="tablist"], [role="tab"]').count(), 0, 'no duplicate section-navigation strip');
    assert.deepEqual((await order()).filter(name => ['layout', 'spacing', 'effects', 'appearance'].includes(name)), ['layout', 'spacing', 'effects', 'appearance'], 'stable plugin order ignores a stale drag-order preference');
    assert.deepEqual((await order()).slice(0, 2), ['head', 'classes'], 'identity and direct class editing stay first');
    const version = runtime.info().project.version;

    await layout.locator('summary').focus();
    await inspectorPage.keyboard.press('Space');
    await waitUntil(() => layout.evaluate(node => !node.open), 'Space collapses the native disclosure');
    assert.equal(await inspectorPage.locator('#viewport').evaluate(node => node.classList.contains('space-ready')), false, 'disclosure activation does not arm canvas panning');
    await waitUntil(() => inspectorPage.evaluate(() => JSON.parse(localStorage.getItem('divlet:folds')).Layout === false), 'the collapsed preference is remembered');
    await inspectorPage.reload();
    await selectSubject();
    assert.equal(await layout.evaluate(node => node.open), false, 'the disclosure state survives reload without a tab bar');
    await layout.locator('summary').focus();
    await inspectorPage.keyboard.press('Enter');
    await waitUntil(() => layout.evaluate(node => node.open), 'Enter expands the native disclosure');
    await inspector.locator('button.tag').focus();
    await inspectorPage.keyboard.press('Space');
    await inspectorPage.locator('.menu [role="menuitemradio"]').first().waitFor();
    assert.equal(await inspectorPage.locator('#viewport').evaluate(node => node.classList.contains('space-ready')), false, 'Space activates the native button rather than canvas pan');
    await inspectorPage.keyboard.press('Escape');
    await inspectorPage.locator('#viewport').focus();
    await inspectorPage.keyboard.down('Space');
    assert.equal(await inspectorPage.locator('#viewport').evaluate(node => node.classList.contains('space-ready')), true, 'Space still arms panning on the canvas');
    await inspectorPage.keyboard.up('Space');

    for (const [width, size] of [[1400, 100], [820, 100], [390, 100], [390, 200]]) {
      await inspectorPage.setViewportSize({ width, height: 900 });
      await inspectorPage.evaluate(async size => (await import('./lib/help.js')).setUiSize(size), size);
      const last = inspector.locator('[data-section="node-meta"] summary');
      await last.focus();
      await last.scrollIntoViewIfNeeded();
      const geometry = await inspector.evaluate(node => {
        const box = node.getBoundingClientRect();
        const summary = node.querySelector('[data-section="node-meta"] summary').getBoundingClientRect();
        return {
          fits: node.scrollWidth <= node.clientWidth + 1,
          inside: box.left >= -1 && box.right <= innerWidth + 1,
          reachable: summary.top >= box.top - 1 && summary.bottom <= box.bottom + 1,
          focused: document.activeElement === node.querySelector('[data-section="node-meta"] summary'),
          tabs: node.querySelectorAll('[role="tab"], [role="tablist"]').length,
        };
      });
      assert.deepEqual(geometry, { fits: true, inside: true, reachable: true, focused: true, tabs: 0 }, `vertical inspector at ${width}px/${size}%`);
      await inspector.locator('[data-section="measured"]').scrollIntoViewIfNeeded();
      const footer = await inspector.evaluate(node => { const measured = node.querySelector('[data-section="measured"]'), box = node.getBoundingClientRect(), rect = measured.getBoundingClientRect(); return { last: node.lastElementChild === measured, visible: rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1, labels: [...measured.querySelectorAll('.value > i')].map(n => n.textContent) }; });
      assert.deepEqual(footer, { last: true, visible: true, labels: ['X', 'Y', 'W', 'H'] }, `measured footer at ${width}px/${size}%`);
    }
    assert.equal(runtime.info().project.version, version, 'disclosures, scrolling and UI size are not project edits');
    await inspectorContext.close();
  }
  checks.push('the inspector has one stable vertical flow, no section tabs, remembered native keyboard disclosures and reachable content at desktop, tablet, phone and 200% size');

  // Opening a sidebar over the selected artboard brings it back into the clear part of the canvas.
  await page.evaluate(async () => { (await import('./lib/sidebar.js')).close(); (await import('./lib/store.js')).selectArtboards(['welcome']); const c = await import('./lib/canvas.js'); c.setCamera({ x: 30, y: 120, k: 0.5 }); });
  await page.waitForTimeout(300);
  await page.evaluate(async () => (await import('./lib/sidebar.js')).show('layers'));
  await waitUntil(async () => {
    const [art, side] = await page.evaluate(() => [document.querySelector('.artboard[data-artboard-id="welcome"]').getBoundingClientRect().left, document.querySelector('#sidebar').getBoundingClientRect().right]);
    return art >= side;
  }, 'the selected artboard is brought out from under the sidebar');
  checks.push('opening a sidebar over the selected artboard pans it into the clear');

  // …and once it is in the clear, a second reveal moves nothing.
  await sleep(500);
  const settled = await page.evaluate(async () => ({ ...(await import('./lib/canvas.js')).camera }));
  await page.evaluate(async () => (await import('./lib/canvas.js')).revealSelection());
  await sleep(400);
  assert.deepEqual(await page.evaluate(async () => ({ ...(await import('./lib/canvas.js')).camera })), settled, 'nothing moves when the selection is already in the clear');
  checks.push('a reveal moves nothing when the selection is already clear');

  // Errors and statuses never move controls: a toast (any length) leaves the brand, search, tabs and toolbar exactly where they are.
  await page.evaluate(async () => (await import('./lib/sidebar.js')).show('layers'));
  await page.waitForTimeout(300);
  const places = () => page.evaluate(() => ['#status', '.search-pill', '#side-tabs', '#dock', '#inspector', '#sidebar'].map(selector => { const node = document.querySelector(selector); const r = node && !node.hidden ? node.getBoundingClientRect() : null; return r ? [selector, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : [selector]; }));
  const still = await places();
  await page.evaluate(async () => { const { toast } = await import('./lib/store.js'); toast('Something went wrong while saving. '.repeat(6), { label: 'Retry', run() {} }, { sticky: true, id: 'audit' }); });
  await page.waitForTimeout(500);
  assert.ok(await page.locator('#toast').innerText().then(text => text.includes('Something went wrong')), 'the toast is shown');
  assert.deepEqual(await places(), still, 'a long error toast moves no control');
  await page.evaluate(async () => (await import('./lib/store.js')).toast.clear?.('audit'));
  checks.push('a long error toast moves no control');

  // Many issues of one kind (missing images) read as one line in History.
  await runtime.create({ document: decodeHtml('<main id="root"><img src="gone/1.png" alt=""><img src="gone/2.png" alt=""><img src="gone/3.png" alt=""><img src="gone/4.png" alt=""></main>', { fallbackId: 'missing-images' }) });
  await waitUntil(() => page.evaluate(() => (document.querySelector('#history-badge, #open-history .badge')?.textContent || '') !== ''), 'the issues are counted');
  await page.evaluate(async () => (await import('./lib/sidebar.js')).show('activity'));
  await page.waitForTimeout(500);
  const rows = await page.locator('#activity .diag').count();
  assert.equal(rows, 1, `four missing images are one row, not ${rows}`);
  assert.match(await page.locator('#activity .diag .msg').innerText(), /and 3 more/);
  // The row shows a shortened path; the hover must name every expected path, and the guidance must not promise what is absent.
  const row = page.locator('#activity .diag').first();
  assert.match(await row.locator('.sub').last().innerText(), /path shown on hover/);
  const tipCode = await row.getAttribute('data-tip-code');
  for (const name of ['1.png', '2.png', '3.png', '4.png']) assert.ok(tipCode?.includes(`gone/${name}`), `the hover names ${name}: ${tipCode}`);
  assert.match(await row.getAttribute('data-tip'), /4 issues of this kind/);
  checks.push('repeated issues of one kind are one line in History');

  // Text contrast (WCAG AA, 4.5:1; 3:1 for large text) of the chrome text in both colour schemes.
  for (const scheme of ['light', 'dark']) {
    const themed = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme })).newPage();
    await themed.goto(runtime.info().url);
    await themed.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
    await themed.evaluate(async () => { (await import('./lib/store.js')).selectArtboards(['welcome']); (await import('./lib/sidebar.js')).show('layers'); });
    await themed.waitForTimeout(700);
    const low = await themed.evaluate(scheme => {
      const parse = c => { const m = c.match(/[\d.]+/g)?.map(Number); return m ? { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 } : null; };
      const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
      const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
      const backdrop = node => { const layers = []; for (let n = node; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let base = scheme === 'dark' ? { r: 20, g: 20, b: 24, a: 1 } : { r: 243, g: 242, b: 239, a: 1 }; for (const layer of layers.reverse()) base = blend(layer, base); return base; };
      const out = [];
      for (const node of document.querySelectorAll('#inspector *, #sidebar *, #dock *, .brand *, .side-tabs *, #crumbs *')) {
        const text = [...node.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        if (!text) continue;
        const style = getComputedStyle(node); if (style.visibility === 'hidden' || style.display === 'none' || node.closest('[hidden], :disabled')) continue;
        const r = node.getBoundingClientRect(); if (!r.width || !r.height) continue;
        const fg = parse(style.color); if (!fg) continue;
        const bg = backdrop(node), shown = blend({ ...fg, a: fg.a * (parseFloat(style.opacity) || 1) }, bg);
        const l1 = lum(shown), l2 = lum(bg), ratio = (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
        const size = parseFloat(style.fontSize), need = size >= 24 || (size >= 18.66 && parseInt(style.fontWeight) >= 700) ? 3 : 4.5;
        if (ratio < need) out.push(`${ratio.toFixed(2)} "${text.slice(0, 22)}" .${String(node.className).slice(0, 24)}`);
      }
      return [...new Set(out)];
    }, scheme);
    assert.deepEqual(low, [], `chrome text meets 4.5:1 contrast in the ${scheme} scheme`);
    await themed.close();
  }
  checks.push('chrome text meets WCAG AA contrast in the light and dark schemes');

  // The overlays (palette, shortcuts, settings, open dialog), a context menu and a toast also meet 4.5:1 in both schemes.
  for (const scheme of ['light', 'dark']) {
    const themed = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme })).newPage();
    await themed.goto(runtime.info().url);
    await themed.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
    const scan = async label => {
      await themed.waitForTimeout(400);
      const low = await themed.evaluate(scheme => {
        const parse = c => { const m = c.match(/[\d.]+/g)?.map(Number); return m ? { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 } : null; };
        const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
        const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
        const backdrop = node => { const layers = []; for (let n = node; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let base = scheme === 'dark' ? { r: 19, g: 19, b: 18, a: 1 } : { r: 243, g: 242, b: 239, a: 1 }; for (const layer of layers.reverse()) base = blend(layer, base); return base; };
        const out = [];
        for (const node of document.querySelectorAll('.scrim:not([hidden]) *, .menu *, #toast *')) {
          const text = [...node.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
          if (!text) continue;
          const style = getComputedStyle(node); if (style.visibility === 'hidden' || style.display === 'none' || node.closest('[hidden], :disabled')) continue;
          const fg = parse(style.color); if (!fg) continue;
          const bg = backdrop(node), shown = blend({ ...fg, a: fg.a * (parseFloat(style.opacity) || 1) }, bg);
          const l1 = lum(shown), l2 = lum(bg), ratio = (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
          if (ratio < 4.5) out.push(`${ratio.toFixed(2)} "${text.slice(0, 22)}" .${String(node.className).slice(0, 22)}`);
        }
        return [...new Set(out)];
      }, scheme);
      assert.deepEqual(low, [], `${label} text meets 4.5:1 contrast in the ${scheme} scheme`);
    };
    await themed.evaluate(async () => (await import('./lib/palette.js')).toggle(true)); await scan('palette'); await themed.keyboard.press('Escape');
    await themed.evaluate(async () => (await import('./lib/shortcuts.js')).toggle(true)); await scan('shortcuts'); await themed.keyboard.press('Escape');
    await themed.evaluate(async () => (await import('./lib/help.js')).toggle(true)); await scan('settings'); await themed.keyboard.press('Escape');
    await themed.evaluate(async () => (await import('./lib/project.js')).toggle(true)); await scan('open dialog'); await themed.keyboard.press('Escape');
    await themed.evaluate(async () => { (await import('./lib/store.js')).selectArtboards(['welcome']); (await import('./lib/actions.js')).artboardMenu('welcome', { x: 400, y: 300 }); }); await scan('context menu'); await themed.keyboard.press('Escape');
    await themed.evaluate(async () => (await import('./lib/store.js')).toast('A message with an action', { label: 'Undo', run() {} }, { sticky: true, id: 'contrast' })); await scan('toast');
    await themed.close();
  }
  checks.push('overlays, menus and toasts meet WCAG AA contrast in both schemes');

  // Forced colours (Windows high contrast): fields and pickers keep a visible outline once backgrounds are dropped.
  const forced = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, forcedColors: 'active' })).newPage();
  await forced.goto(runtime.info().url);
  await forced.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
  await forced.evaluate(async () => { (await import('./lib/store.js')).selectArtboards(['welcome']); (await import('./lib/store.js')).selectNodes('welcome', ['nav']); });
  await forced.waitForSelector('#inspector .vf, #inspector .pick');
  const unbordered = await forced.evaluate(() => [...document.querySelectorAll('#inspector .vf, #inspector .num, #inspector .pick, #inspector .field')].filter(node => parseFloat(getComputedStyle(node).borderTopWidth) < 1).length);
  assert.equal(unbordered, 0, 'every field and picker has a border in forced-colors mode');
  await forced.close();
  checks.push('fields and pickers keep an outline in forced-colors mode');

  // Touch: every control in the inspector, sidebar and toolbar is at least 24px in both directions (WCAG 2.5.8).
  const touch = await (await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true })).newPage();
  await touch.goto(runtime.info().url);
  await touch.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
  for (const view of ['artboard', 'node']) {
    await touch.evaluate(async view => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); if (view === 'node') m.selectNodes('welcome', ['nav']); }, view);
    await touch.waitForTimeout(500);
    const small = await touch.evaluate(() => [...document.querySelectorAll('#inspector button, #inspector input:not(.vf-input):not(.num-input):not(.cls-input):not(.ident-input), #dock button, #side-tabs button')].filter(node => {
      const r = node.getBoundingClientRect(), style = getComputedStyle(node);
      return r.width && r.height && style.visibility !== 'hidden' && style.display !== 'none' && !node.closest('[hidden]') && (r.width < 24 || r.height < 24);
    }).map(node => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 24)} ${Math.round(node.getBoundingClientRect().width)}x${Math.round(node.getBoundingClientRect().height)}`));
    assert.deepEqual(small, [], `no touch target below 24px (${view})`);
  }
  await touch.close();
  checks.push('on touch screens every inspector, sidebar and toolbar control is at least 24px');

  // The browser tab names the project, so several open boards can be told apart.
  const expectedName = path.basename(path.dirname(runtime.info().project.file)).replace(/\.divlet$/, '');
  assert.equal(await page.title(), `${expectedName} · divlet`, 'the tab title carries the project name');
  checks.push('the browser tab title carries the project name');

  // After adding a class the field stays focused; Ctrl+Z with nothing typed undoes the board's last change, Ctrl+Shift+Z redoes it.
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['nav']); });
  await page.waitForSelector('#inspector .cls-input');
  const chip = name => page.locator('#inspector .cls-name', { hasText: new RegExp(`^${name}$`) }).count();
  await page.locator('#inspector .cls-input').fill('ring-2');
  await page.keyboard.press('Enter');
  await waitUntil(async () => await chip('ring-2') === 1, 'the class is added');
  await page.locator('#inspector .cls-input').focus();
  await page.keyboard.press('Control+z');
  await waitUntil(async () => await chip('ring-2') === 0, 'Ctrl+Z in the class field undoes the board change');
  await page.locator('#inspector .cls-input').focus();
  await page.keyboard.press('Control+Shift+z');
  await waitUntil(async () => await chip('ring-2') === 1, 'Ctrl+Shift+Z redoes it');
  checks.push('Ctrl+Z / Ctrl+Shift+Z in the empty class field undo / redo the board change');

  // Without Pi the Agent tab offers the exact command that connects this project.
  await page.evaluate(async () => (await import('./lib/sidebar.js')).show('agent'));
  await page.locator('#agent .ask-copy').waitFor();
  await page.locator('#agent .ask-copy').click();
  await waitUntil(async () => /\/divlet /.test(await page.locator('#toast').innerText()), 'copying the command says what to run in Pi');
  checks.push('the not-connected Agent tab offers a copy of the /divlet command for this project');

  // With Pi connected the Agent tab says what a request is about and offers starting points that only fill the box.
  runtime.setAgent({ connected: true });
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards([]); (await import('./lib/sidebar.js')).show('agent'); });
  await waitUntil(async () => /whole board/.test(await page.locator('#agent .ask-scope').innerText()), 'with nothing selected the scope says the whole board');
  await page.evaluate(async () => (await import('./lib/store.js')).selectArtboards(['welcome']));
  await waitUntil(async () => /A space for ideas/.test(await page.locator('#agent .ask-scope').innerText()), 'the scope names the selected artboard');
  await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('welcome', ['nav']));
  await waitUntil(async () => /#nav/.test(await page.locator('#agent .ask-scope').innerText()), 'the scope names the selected element');

  // A frame name can be long and the Agent panel is narrow: the name is cut, the selector after it is not, and the whole
  // name stays reachable as a tooltip.
  {
    const long = 'A space for ideas — a much longer artboard name than any narrow panel could hold whole';
    const before = runtime.read({ view: 'frame', documentId: 'welcome' }).version;
    await runtime.patch({ documentId: 'welcome', expectedVersion: before, actor: 'user', patch: { name: long } });
    await waitUntil(async () => (await page.locator('#agent .ask-scope-frame').innerText()) === long, 'the scope shows the renamed frame');
    const scope = await page.locator('#agent .ask-scope').evaluate(node => {
      const frame = node.querySelector('.ask-scope-frame'), tail = node.querySelector('.ask-scope-tail'), box = node.getBoundingClientRect();
      const fr = frame.getBoundingClientRect(), tr = tail.getBoundingClientRect();
      return {
        cut: frame.scrollWidth > frame.clientWidth + 1,
        ellipsis: getComputedStyle(frame).textOverflow,
        tip: frame.title,
        tailWhole: tail.scrollWidth <= tail.clientWidth + 1,
        tailVisible: tr.right <= box.right + 1 && tr.width > 0,
        frameVisible: fr.width >= 20,
      };
    });
    assert.equal(scope.cut, true, 'a long frame name is truncated');
    assert.equal(scope.ellipsis, 'ellipsis');
    assert.equal(scope.tip, long, 'the whole name is still available on hover');
    assert.equal(scope.tailWhole, true, 'the selector after the name is shown whole');
    assert.equal(scope.tailVisible, true, 'and stays inside the panel');
    assert.ok(scope.frameVisible, 'the name keeps a readable minimum width');
    await runtime.patch({ documentId: 'welcome', expectedVersion: runtime.read({ view: 'frame', documentId: 'welcome' }).version, actor: 'user', patch: { name: 'A space for ideas' } });
  }
  const ideas = await page.locator('#agent .ask-suggest .ask-idea').allInnerTexts();
  assert.ok(ideas.length >= 3 && ideas.includes('Tighten the spacing'), `element-specific starting points (${ideas.join(' | ')})`);
  await page.locator('#agent .ask-suggest .ask-idea', { hasText: 'Tighten the spacing' }).click();
  assert.equal(await page.locator('#agent .ask-input').inputValue(), 'Tighten the spacing', 'a starting point only fills the box');
  assert.equal(runtime.readHistory().changes.filter(change => change.kind === 'ask').length, 0, 'nothing was sent');
  await page.locator('#agent .ask-input').fill('');
  runtime.say({ text: '**Done.** Tightened the `nav` spacing.' });
  await page.locator('#agent .bubble.from-agent .bubble-copy').first().waitFor();
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.locator('#agent .bubble.from-agent .bubble-copy').first().click();
  await waitUntil(async () => /Reply copied/.test(await page.locator('#toast').innerText()), 'copying a reply is acknowledged');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, '**Done.** Tightened the `nav` spacing.', 'the reply text, markup characters included, is what reached the clipboard');
  checks.push('a reply from Pi can be copied');
  runtime.setAgent({ connected: false });
  checks.push('the Agent tab names what a request is about (a long frame name is cut, the selector is not) and offers starting points that only fill the box');

  // A dragged-narrow sidebar: the panes are told the panel's own width, so nothing is pushed off the edge and the texts fit.
  {
    const long = 'A space for ideas — a much longer artboard name than any narrow panel could hold whole';
    await runtime.patch({ documentId: 'welcome', expectedVersion: runtime.read({ view: 'frame', documentId: 'welcome' }).version, actor: 'user', patch: { name: long } });
    runtime.setAgent({ connected: true });
    runtime.on('ask', () => {});
    runtime.ask({ text: 'make it calmer', ids: ['welcome'], nodes: { documentId: 'welcome', nodeIds: ['nav'] } });
    await page.evaluate(() => localStorage.setItem('divlet:width:sidebar', '240'));
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
    await page.evaluate(async () => (await import('./lib/sidebar.js')).show('agent'));
    await waitUntil(async () => (await page.evaluate(() => document.documentElement.dataset.sidebar)) === 'tiny', 'a narrow panel reports itself');
    const narrow = await page.evaluate(() => {
      const panel = document.querySelector('#sidebar');
      const about = [...document.querySelectorAll('.bubble-about')].at(-1);
      const input = document.querySelector('#agent .ask-input');
      const hints = [...document.querySelectorAll('#agent .ask-hint .hint-unit')].map(node => node.textContent);
      const label = document.querySelector('#open-history .tool-label'), badge = document.querySelector('#diag-count');
      const bubbles = [...document.querySelectorAll('.bubble')];
      const labelRect = label?.getBoundingClientRect(), badgeRect = badge?.getBoundingClientRect();
      return {
        width: Math.round(panel.getBoundingClientRect().width),
        overflow: panel.scrollWidth - panel.clientWidth,
        bubbleOverflow: bubbles.map(node => node.scrollWidth - node.clientWidth),
        aboutHeight: about ? Math.round(about.getBoundingClientRect().height) : null,
        aboutTitle: about?.title || '',
        placeholder: input?.placeholder || '',
        hints,
        badgeVisible: !!badge && !badge.hidden && badge.getBoundingClientRect().width > 0,
        badgeOverlap: badge && !badge.hidden && labelRect ? Math.min(labelRect.right, badgeRect.right) - Math.max(labelRect.left, badgeRect.left) > 1 && Math.min(labelRect.bottom, badgeRect.bottom) - Math.max(labelRect.top, badgeRect.top) > 1 : false,
        labelClipped: label ? label.scrollWidth > label.clientWidth + 1 : false,
      };
    });
    assert.ok(narrow.width <= 260, `the panel really is narrow (${narrow.width})`);
    assert.equal(narrow.overflow, 0, 'the panel does not overflow sideways');
    assert.deepEqual(narrow.bubbleOverflow, narrow.bubbleOverflow.map(() => 0), 'no bubble overflows');
    assert.ok(narrow.aboutHeight <= 22, `the context label stays one line (${narrow.aboutHeight}px)`);
    assert.equal(narrow.aboutTitle, `${long} › #nav`, 'the whole label is on hover');
    assert.equal(narrow.placeholder, 'Ask the agent…', 'the placeholder fits the panel');
    assert.deepEqual(narrow.hints, ['↵ send'], `one key hint, not three (${narrow.hints.join(' | ')})`);
    assert.equal(narrow.labelClipped, false, 'the whole tab label stays readable');
    if (narrow.badgeVisible) assert.equal(narrow.badgeOverlap, false, 'the count never covers the label');
    await page.evaluate(() => localStorage.removeItem('divlet:width:sidebar'));
    await runtime.patch({ documentId: 'welcome', expectedVersion: runtime.read({ view: 'frame', documentId: 'welcome' }).version, actor: 'user', patch: { name: 'A space for ideas' } });
    runtime.setAgent({ connected: false });
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
    await page.evaluate(async () => { (await import('./lib/sidebar.js')).show('agent'); });
  }
  checks.push('a dragged-narrow sidebar adapts: no overflow, one-line context, short placeholder and hints');

  // Warm user bubbles are independent of the work/error accents in automatic and explicitly selected themes.
  const originalTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  for (const [theme, system, expected] of [[null, 'light', 'rgb(243, 232, 213)'], [null, 'dark', 'rgb(60, 51, 36)'], ['light', 'dark', 'rgb(243, 232, 213)'], ['dark', 'light', 'rgb(60, 51, 36)']]) {
    await page.emulateMedia({ colorScheme: system });
    await page.evaluate(theme => { if (theme) document.documentElement.dataset.theme = theme; else document.documentElement.removeAttribute('data-theme'); }, theme);
    const palette = await page.locator('#agent .bubble.from-user').first().evaluate(bubble => {
      const rgb = color => color.match(/[\d.]+/g).map(Number);
      const lum = color => { const [r, g, b] = rgb(color).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
      const background = getComputedStyle(bubble).backgroundColor, bg = lum(background);
      const ratios = ['.rich', '.bubble-head b', 'time'].map(selector => { const fg = lum(getComputedStyle(bubble.querySelector(selector)).color); return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05); });
      return { background, ratios, agent: getComputedStyle(document.querySelector('.bubble.from-agent')).backgroundColor };
    });
    assert.equal(palette.background, expected, `warm user bubble for ${theme || 'auto'}/${system}`);
    assert.notEqual(palette.agent, palette.background, 'agent replies retain their distinct neutral surface');
    assert.ok(palette.ratios.every(ratio => ratio >= 4.5), `body, author and timestamp meet AA: ${JSON.stringify(palette.ratios)}`);
  }
  await page.emulateMedia({ colorScheme: null });
  await page.evaluate(theme => { if (theme) document.documentElement.dataset.theme = theme; else document.documentElement.removeAttribute('data-theme'); }, originalTheme);
  checks.push('user chat bubbles are warm sand/amber, distinct from replies, with AA text contrast in automatic and explicit light/dark themes');

  // A long arbitrary class is shown whole: it wraps inside its chip.
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['nav']); });
  await page.waitForSelector('#inspector .cls-input');
  const long = '[box-shadow:0_1px_2px_rgba(0,0,0,.2),0_8px_24px_rgba(0,0,0,.15),inset_0_0_0_1px_rgba(255,255,255,.4)]';
  await page.locator('#inspector .cls-input').fill(long);
  await page.keyboard.press('Enter');
  const chipBox = await waitUntil(() => page.evaluate(name => { const chip = [...document.querySelectorAll('#inspector .cls-name')].find(node => node.textContent.trim() === name); return chip ? { clipped: chip.scrollWidth > chip.clientWidth + 1, height: chip.getBoundingClientRect().height, inside: chip.getBoundingClientRect().right <= document.querySelector('#inspector').getBoundingClientRect().right + 1 } : null; }, long), 'the long class chip is shown');
  assert.equal(chipBox.clipped, false, 'a long class is not cut');
  assert.ok(chipBox.height > 22, 'it wraps onto more than one line');
  assert.equal(chipBox.inside, true, 'and stays inside the inspector');
  await page.locator('#inspector .cls-input').focus();
  await page.keyboard.press('Control+z');
  checks.push('a long arbitrary class wraps inside its chip and is shown whole');

  // Spacing the panel cannot read from a class (a custom property class) still shows the page's real numbers.
  await sleep(600);
  const navClass = runtime.read({ view: 'document', documentId: 'welcome' }).nodes.nav.className;
  await runtime.patch({ documentId: 'welcome', expectedVersion: runtime.read({ view: 'document', documentId: 'welcome' }).version, actor: 'user', patch: { nodes: { nav: { className: `${navClass} [padding:12px_6px]` } } } });
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['nav']); });
  await waitUntil(async () => (await page.locator('#inspector [data-key="p-t"]').getAttribute('placeholder')) === '12', 'the padding fields show the measured 12px from an unreadable class');
  assert.equal(await page.locator('#inspector [data-key="p-l"]').getAttribute('placeholder'), '6');
  assert.equal(await page.locator('#inspector [data-key="p-t"]').inputValue(), '', 'the field itself stays empty: no class of its own');
  // The arrow keys step from the number the page reports, not from zero.
  const startVersion = runtime.read({ view: 'document', documentId: 'welcome' }).version;
  const pTop = page.locator('#inspector [data-key="p-t"]');
  await pTop.focus();
  await page.keyboard.press('ArrowUp');
  const stepOne = Number(await pTop.inputValue());
  await page.keyboard.press('ArrowUp');
  const stepTwo = Number(await pTop.inputValue());
  assert.ok(stepOne > 12, `an arrow press starts from the measured 12px, not from 0 (got ${stepOne})`);
  assert.equal(stepTwo - stepOne, stepOne - 12, `every arrow press is one step (${stepOne}, ${stepTwo})`);
  assert.equal(await page.locator('#inspector [data-key="m-t"]').inputValue(), '', 'the sides nobody touched keep their empty fields');
  await page.keyboard.press('Escape'); // like Enter, this hands focus back to the panel so it may redraw
  await waitUntil(() => runtime.read({ view: 'document', documentId: 'welcome' }).version >= startVersion + 2, 'both arrow presses reach the project');
  checks.push('the arrow keys step from the measured placeholder rather than from zero');
  const current = runtime.read({ view: 'document', documentId: 'welcome' });
  await runtime.patch({ documentId: 'welcome', expectedVersion: current.version, actor: 'user', patch: { nodes: { nav: { className: navClass } } } });
  checks.push('padding and margin the panel cannot read from a class still show the page\'s real numbers');

  // A named layer shows its name in the inspector (imported designs name their layers; the ids are hashes).
  await sleep(400);
  const named = runtime.read({ view: 'document', documentId: 'welcome' });
  await runtime.patch({ documentId: 'welcome', expectedVersion: named.version, actor: 'user', patch: { nodes: { nav: { metadata: { name: 'Main navigation' } } } } });
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['nav']); });
  await waitUntil(async () => (await page.locator('#inspector .node-name').count()) === 1 && /Main navigation/.test(await page.locator('#inspector .node-name').innerText()), 'the layer name is shown');
  const unnamed = runtime.read({ view: 'document', documentId: 'welcome' });
  await runtime.patch({ documentId: 'welcome', expectedVersion: unnamed.version, actor: 'user', patch: { nodes: { nav: { metadata: { name: null } } } } });
  checks.push('a named layer shows its name in the inspector');

  // A hovered or selected artboard label shows its whole name; only the idle label is clipped to the artboard's width.
  await select(['welcome']);
  const label = page.locator('.artboard[data-artboard-id="welcome"] .ab-label');
  await label.locator('.ab-name').evaluate(node => { node.textContent = 'A rather long artboard name that no narrow frame could ever hold whole'; });
  const clipped = await label.locator('.ab-name').evaluate(node => node.scrollWidth > node.clientWidth + 1);
  assert.equal(clipped, false, 'the selected artboard label shows its whole name');
  checks.push('the selected or hovered artboard label shows its whole name');

  // Nothing in the chrome is clipped at phone width, at 100% and 200% interface size, for an artboard and for an element.
  for (const [w, size] of [[1280, 100], [390, 100], [390, 200]]) {
    const narrow = await (await browser.newContext({ viewport: { width: w, height: 800 } })).newPage();
    await narrow.goto(runtime.info().url);
    await narrow.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
    await narrow.evaluate(async size => { (await import('./lib/help.js')).setUiSize(size); (await import('./lib/store.js')).selectArtboards(['welcome']); }, size);
    for (const state of ['artboard', 'node']) {
      if (state === 'node') await narrow.evaluate(async () => (await import('./lib/store.js')).selectNodes('welcome', ['nav']));
      await narrow.waitForTimeout(500);
      const clipped = await narrow.evaluate(() => [...document.querySelectorAll('#inspector *, #sidebar *, #dock *, .brand *, .crumbs-bar *, .side-tabs *')].filter(node => {
        const style = getComputedStyle(node);
        return !node.hidden && style.display !== 'none' && style.visibility !== 'hidden' && node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1
          && (style.textOverflow === 'ellipsis' || style.overflowX === 'hidden') && node.textContent.trim();
      }).map(node => `${node.tagName.toLowerCase()}.${String(node.className)} "${node.textContent.trim().slice(0, 30)}"`));
      assert.deepEqual(clipped, [], `no clipped text at ${w}px, ${size}%, ${state}`);
      const overlap = await narrow.evaluate(() => { const i = document.querySelector('#inspector'), d = document.querySelector('#dock'); if (i.hidden || d.offsetParent === null) return 0; return i.getBoundingClientRect().bottom - d.getBoundingClientRect().top; });
      assert.ok(overlap <= 1, `the inspector never sits under the toolbar at ${w}px, ${size}%, ${state} (${overlap}px)`);
    }
    // Long tooltip copy must wrap whole, including unbroken references, and stay inside the physical viewport.
    const tooltipCopy = 'Centre the children horizontally and vertically (flex, items-center, justify-center). ' + 'unbroken_reference_'.repeat(21);
    await narrow.evaluate(copy => { const target = document.createElement('button'); target.id = 'tooltip-check'; target.textContent = '?'; target.dataset.tip = copy; Object.assign(target.style, { position: 'fixed', left: '6px', top: '6px', width: '26px', height: '26px', zIndex: '80' }); document.body.append(target); }, tooltipCopy);
    for (const [left, top] of [[6, 6], [w - 32, 6], [w - 32, 768], [w / 2, 390]]) {
      await narrow.mouse.move(w / 2, 780);
      await narrow.locator('#tooltip-check').evaluate((node, pos) => { node.style.left = `${pos[0]}px`; node.style.top = `${pos[1]}px`; }, [left, top]);
      await narrow.locator('#tooltip-check').hover();
      await narrow.locator('.tip.show').waitFor();
      await narrow.waitForTimeout(150);
      const tooltip = await narrow.locator('.tip').evaluate(node => { const box = node.getBoundingClientRect(), style = getComputedStyle(node); return { text: node.textContent, wrapped: node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) > parseFloat(style.lineHeight) * 1.5, clipped: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1, inside: box.left >= 5 && box.top >= 5 && box.right <= innerWidth - 5 && box.bottom <= innerHeight - 5 }; });
      assert.deepEqual(tooltip, { text: tooltipCopy, wrapped: true, clipped: false, inside: true }, `whole tooltip at ${w}px/${size}% near ${left},${top}`);
    }
    await narrow.locator('#tooltip-check').evaluate(node => { node.dataset.tipCode = '/assets/example.svg\n/assets/another-example.png'; });
    await narrow.keyboard.press('Escape');
    await narrow.locator('#tooltip-check').focus();
    await narrow.locator('.tip.code.show').waitFor();
    assert.equal(await narrow.locator('.tip-title').textContent(), tooltipCopy, 'keyboard tooltips retain their whole diagnostic heading');
    assert.ok(await narrow.locator('.tip-title').evaluate(node => node.scrollWidth <= node.clientWidth + 1 && getComputedStyle(node).textOverflow !== 'ellipsis'), 'diagnostic headings wrap as well');
    await narrow.keyboard.press('Escape');
    await narrow.locator('#tooltip-check').evaluate(node => node.remove());
    await narrow.mouse.move(w / 2, 780);
    // The command palette lists whole labels too.
    await narrow.evaluate(async () => (await import('./lib/palette.js')).toggle(true));
    await narrow.waitForTimeout(400);
    const palette = await narrow.evaluate(() => [...document.querySelectorAll('.palette-label, .palette-hint')].filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent.trim()));
    assert.deepEqual(palette, [], `no clipped palette labels at ${w}px, ${size}%`);
    await narrow.close();
  }
  checks.push('no chrome text is clipped at 1280 and 390px wide, at 100% and 200% interface size');
  checks.push('tooltip copy and diagnostic headings wrap whole, including unbroken references, with hover/keyboard activation and viewport-safe placement at edges and 200% size');

  // A collapsed selector: the label sits on the left and the current value is right-aligned, on the label's own baseline.
  {
    await select(['welcome']);
    await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('welcome', ['nav']));
    await page.waitForSelector('#inspector [data-section="layout"] .pick .pick-v');
    for (const width of [1280, 900, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await waitUntil(async () => (await page.locator('#inspector .pick').count()) > 0, 'the inspector keeps a selector');
      const pick = page.locator('#inspector [data-section="layout"] .pick').first();
      // The inspector may replace the panel between two reads: wait for an attached selector, then measure it.
      const geom = await waitUntil(async () => {
        const measured = await pick.evaluate(node => {
          const label = node.querySelector('.pick-k'), value = node.querySelector('.pick-v');
          if (!label || !value || !node.isConnected) return null;
          const b = node.getBoundingClientRect(), l = label.getBoundingClientRect(), v = value.getBoundingClientRect();
          return {
            centred: Math.abs(l.top + l.height / 2 - b.top - b.height / 2) < 1 && Math.abs(v.top + v.height / 2 - b.top - b.height / 2) < 1,
            hierarchy: getComputedStyle(label).color !== getComputedStyle(value).color && Number(getComputedStyle(label).fontWeight) > Number(getComputedStyle(value).fontWeight),
            sameLine: Math.abs(l.top - v.top) < 4, gap: Math.round(b.right - v.right), alignment: getComputedStyle(value).textAlign,
            clipped: value.scrollWidth > value.clientWidth + 1, labelLeft: Math.round(l.left - b.left),
          };
        }).catch(() => null);
        return measured && measured.alignment === 'right' ? measured : null;
      }, `the Layout selector is measured at ${width}px`);
      assert.equal(geom.alignment, 'right', `the value is right-aligned at ${width}px`);
      assert.equal(geom.centred, true, `selector text is vertically centred at ${width}px`);
      assert.equal(geom.hierarchy, true, 'the label has stronger colour and weight than the value');
      // Where the panel is wide enough to be read, the value stops before the caret; on a phone sheet only "does not stick out" is required.
      if (width >= 900) assert.ok(geom.gap >= 8 && geom.gap <= 26, `the value ends at the right edge, before the caret, at ${width}px (gap ${geom.gap})`);
      else assert.ok(geom.gap >= 0, `the value does not stick out of the selector at ${width}px (gap ${geom.gap})`);
      assert.ok(geom.labelLeft <= 12, `the label sits at the left edge at ${width}px (${geom.labelLeft})`);
      assert.equal(geom.clipped, false, `the value is shown whole at ${width}px`);
      if (width >= 900) assert.equal(geom.sameLine, true, `the value stays on the label's line at ${width}px`);
    }
    await page.setViewportSize({ width: 1500, height: 900 });
  }
  checks.push('selector labels are visually stronger and both label/value are vertically centred, with right-aligned whole values');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser?.close(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
