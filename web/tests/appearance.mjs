// Border, Appearance and Effects: linked border widths, line styles, colours, radius and numeric gestures.
import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { cp, mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../core/lib/runtime.js';

const playwright = await import('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-appearance-'));
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
const classesOf = id => runtime.read({ view: 'document', documentId: 'welcome' }).nodes[id].className.split(' ');
let browser;
try {
  browser = await playwright.chromium.launch(launch);
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(runtime.info().url);
  await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
  const select = id => page.evaluate(async id => { document.activeElement?.blur?.(); const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', [id]); }, id);
  const afterVersion = () => runtime.read({ view: 'document', documentId: 'welcome' }).version;

  // A project colour exists: it shows up as a swatch.
  await runtime.patch({ documentId: 'welcome', expectedVersion: afterVersion(), actor: 'user', patch: { tokens: { '--color-brand': '#5b5bf0' } } });
  await select('cta');
  await page.waitForSelector('#inspector [data-section="appearance"] [data-key="fill"]');
  assert.equal(await page.locator('#inspector [data-section="border"] [data-key="radius"]').count(), 1, 'radius belongs to Border');
  assert.equal(await page.locator('#inspector [data-section="border"] [data-key="stroke"]').count(), 1, 'border colour belongs to Border');
  assert.equal(await page.locator('#inspector [data-section="border"] [data-key^="border-width-"]').count(), 4, 'Border has four independent edge widths');
  assert.equal(await page.locator('#inspector [data-section="appearance"] [data-key="radius"], #inspector [data-section="appearance"] [data-key="stroke"]').count(), 0, 'no third home in Appearance');
  const sectionOrder = await page.locator('#inspector [data-section]').evaluateAll(nodes => nodes.map(node => node.dataset.section));
  assert.equal(sectionOrder.indexOf('border'), sectionOrder.indexOf('spacing') + 1, 'Border is a vertical disclosure directly after Spacing, not another tab');
  checks.push('Border owns four widths, line style, colour and radius; Appearance keeps fill and typography');

  const textAlign = page.locator('#inspector [data-section="appearance"]').getByRole('group', { name: 'Text align', exact: true });
  assert.equal(await textAlign.count(), 1, 'text alignment sits beside font and text colour');
  assert.equal(await page.locator('#inspector [data-section="layout"] [aria-label="Text align"]').count(), 0, 'there is no duplicate in Layout');
  assert.equal(await page.locator('#inspector [aria-label="Text align"]').count(), 1, 'one inspector home for text alignment');
  const beforeTextAlign = classesOf('cta').join(' '), alignment = classesOf('cta').includes('text-right') ? 'left' : 'right';
  await textAlign.getByRole('button', { name: `Align ${alignment}`, exact: true }).click();
  await waitUntil(() => classesOf('cta').includes(`text-${alignment}`), 'the moved text control edits the accepted model');
  await runtime.queue;
  await waitUntil(async () => await page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate((node, alignment) => getComputedStyle(node).textAlign === alignment, alignment), 'text alignment reaches the actual page');
  await page.locator('#viewport').focus(); await page.keyboard.press('Control+z');
  await waitUntil(() => classesOf('cta').join(' ') === beforeTextAlign, 'one Undo restores the previous text alignment and unrelated classes');
  await runtime.queue;
  checks.push('text alignment has one home in Appearance, edits the actual page and remains independently undoable');

  // Use the real resize control, not an artificial viewport breakpoint: the desktop floor is 280px.
  const handle = page.locator('.resize-handle[data-panel="inspector"]');
  const edge = await handle.boundingBox();
  await page.mouse.move(edge.x + 4, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + 240, edge.y + edge.height / 2, { steps: 6 });
  await page.mouse.up();
  await waitUntil(() => page.locator('#inspector').evaluate(node => Math.round(node.getBoundingClientRect().width) === 280), 'the inspector reaches its actual resize minimum');
  assert.equal(await page.locator('#inspector [data-section="appearance"] [data-key^="border-width"]').count(), 0, 'only Border and the box model edit widths');
  await page.locator('#inspector [data-key="radius"]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.radius-presets') !== null), true, 'Tab reaches radius presets after the radius field');
  // A compiler-lowered border width remains visible as the measured fallback, then one edge can override it.
  await runtime.patch({ documentId: 'welcome', expectedVersion: afterVersion(), actor: 'user', patch: { nodes: { cta: { styles: { 'border-width': '3px' } } } } });
  await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(5, 5);
  await waitUntil(async () => await page.locator('#inspector [data-key="border-t"]').getAttribute('placeholder') === '3', 'the box model reads a declarative width back from the actual page');
  await page.locator('#inspector [data-key="border-t"]').fill('2'); await page.keyboard.press('Tab');
  await waitUntil(async () => await page.locator('#inspector [data-key="border-width-t"]').inputValue() === '2', 'a box-model edit updates Border while keyboard focus stays in the diagram');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), 'border-r');
  const borderWidths = () => page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate(node => { const cs = getComputedStyle(node); return ['Top', 'Right', 'Bottom', 'Left'].map(side => cs[`border${side}Width`]); });
  await waitUntil(async () => JSON.stringify(await borderWidths()) === JSON.stringify(['2px', '3px', '3px', '3px']), 'one edge changes without rewriting its peers or the utility');
  await page.locator('#inspector [data-key="border-width-r"]').fill('4'); await page.keyboard.press('Tab');
  await waitUntil(async () => await page.locator('#inspector [data-key="border-r"]').inputValue() === '4', 'a Border edit updates the diagram while focus stays in Border');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), 'border-width-b');

  const beforeClear = afterVersion();
  for (const [key, other, next] of [['border-width-t', 'border-t', '2'], ['border-r', 'border-width-r', '4']]) {
    await page.locator(`#inspector [data-key="${key}"]`).fill(''); await page.keyboard.press('Tab');
    await waitUntil(async () => await page.locator(`#inspector [data-key="${key}"]`).inputValue() === '' && await page.locator(`#inspector [data-key="${other}"]`).inputValue() === '' && await page.locator(`#inspector [data-key="${key}"]`).getAttribute('placeholder') === '3' && await page.locator(`#inspector [data-key="${other}"]`).getAttribute('placeholder') === '3', 'clearing either copy synchronizes the fresh computed fallback without leaving the inspector');
    await page.locator(`#inspector [data-key="${other}"]`).fill(next); await page.keyboard.press('Tab');
    await waitUntil(async () => await page.locator(`#inspector [data-key="${key}"]`).inputValue() === next, 'the other copy restores the same authored value');
  }
  assert.equal(afterVersion() - beforeClear, 4, 'two clears and two restores make exactly four content commits');
  assert.deepEqual(await borderWidths(), ['2px', '4px', '3px', '3px'], 'clearing does not change unrelated border sides');

  // Two copies of one property share writer intent; an older completion cannot overwrite a later draft.
  let release, arrived;
  const blocked = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let firstWidth = true;
  await page.route('**/api/patch', async route => { if (firstWidth) { firstWidth = false; arrived(); await gate; } await route.continue(); });
  try {
    await page.locator('#inspector [data-key="border-l"]').fill('5'); await page.keyboard.press('Tab');
    await blocked;
    await page.locator('#inspector [data-key="border-width-l"]').fill('7'); await page.keyboard.press('Tab');
    release();
    await page.evaluate(async () => (await import('./lib/store.js')).idle('welcome'));
    await waitUntil(async () => await page.locator('#inspector [data-key="border-l"]').inputValue() === '7' && await page.locator('#inspector [data-key="border-width-l"]').inputValue() === '7', 'the latest accepted edit synchronizes both copies');
  } finally { release(); await page.unroute('**/api/patch'); }
  await page.locator('#viewport').focus(); await page.keyboard.press('Control+z');
  await waitUntil(async () => await page.locator('#inspector [data-key="border-l"]').inputValue() === '5' && await page.locator('#inspector [data-key="border-width-l"]').inputValue() === '5', 'one Undo restores both copies');
  await page.keyboard.press('Control+z');
  await waitUntil(async () => await page.locator('#inspector [data-key="border-l"]').getAttribute('placeholder') === '3' && await page.locator('#inspector [data-key="border-width-l"]').getAttribute('placeholder') === '3', 'Undo returns both copies to the same computed fallback');
  const beforeRefusal = afterVersion();
  await page.route('**/api/patch', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'REVISION_CONFLICT', message: 'Linked border write refused', details: { actualVersion: beforeRefusal } }) }));
  try {
    await page.locator('#inspector [data-key="border-l"]').fill('9'); await page.keyboard.press('Tab');
    await waitUntil(async () => /Linked border write refused/.test(await page.locator('#toast').innerText()), 'a refused linked edit reports the writer refusal');
    await waitUntil(async () => await page.locator('#inspector [data-key="border-l"]').inputValue() === '' && await page.locator('#inspector [data-key="border-width-l"]').inputValue() === '', 'a refused edit restores inactive copies from accepted state');
    assert.equal(afterVersion(), beforeRefusal, 'the refusal does not advance content');
  } finally { await page.unroute('**/api/patch'); }
  await page.locator('#viewport').focus(); await page.mouse.move(5, 5);
  checks.push('widths synchronize both ways without replacing focused fields; held writes, Undo and refusals preserve one shared property');

  for (const line of ['Dashed', 'Dotted', 'Double', 'Groove', 'Ridge', 'Inset', 'Outset', 'None', 'Hidden', 'Solid']) {
    await page.locator('#inspector [data-key="pick:Style"]').click();
    await page.locator('.menu .menu-item', { hasText: new RegExp(`^${line}$`) }).click();
    await waitUntil(async () => await page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate((node, line) => { const cs = getComputedStyle(node); return ['Top', 'Right', 'Bottom', 'Left'].every(side => cs[`border${side}Style`] === line.toLowerCase()); }, line), `${line} reaches every actual border side`);
  }
  assert.deepEqual(await borderWidths(), ['2px', '4px', '3px', '3px'], 'hiding and showing the border preserves authored widths');
  await page.locator('#inspector [data-key="stroke"]').fill('#cc3344'); await page.keyboard.press('Enter');
  await waitUntil(async () => await page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate(node => getComputedStyle(node).borderTopColor === 'rgb(204, 51, 68)'), 'Border colour reaches the actual page');
  checks.push('Border styles change all four sides without dropping widths; its colour field changes the actual border');
  await page.locator('#inspector [data-key="pick:Weight"]').click();
  await page.locator('.menu .menu-item', { hasText: 'Extra bold 800' }).click();
  await waitUntil(() => classesOf('cta').includes('font-extrabold'), 'a long weight option can still be selected');
  await page.waitForFunction(() => document.querySelector('#inspector [data-key="pick:Weight"] .pick-v')?.textContent === 'Extra bold 800');
  assert.equal(await page.locator('#inspector [data-key="pick:Weight"] .pick-v').evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.clientHeight <= parseFloat(getComputedStyle(node).lineHeight) + 1), true, 'long selector values stay whole on one line');
  await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('welcome', []));
  await page.locator('#inspector [data-key="width"]').waitFor();
  const dimensions = await page.locator('#inspector .geometry-grid').evaluate(node => {
    const boxes = [...node.querySelectorAll('.num')].map(field => field.getBoundingClientRect());
    const context = document.createElement('canvas').getContext('2d');
    const readable = [...node.querySelectorAll('input')].every(input => {
      const style = getComputedStyle(input);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const sample = ['x', 'y'].includes(input.dataset.key) ? '-10000000' : '16384';
      return context.measureText(sample).width <= input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 1;
    });
    return { paired: Math.abs(boxes[0].top - boxes[1].top) < 1 && Math.abs(boxes[2].top - boxes[3].top) < 1 && boxes[2].top > boxes[0].top, readable };
  });
  assert.deepEqual(dimensions, { paired: true, readable: true }, 'artboard dimensions use two readable columns at minimum panel width');
  await select('cta');
  await page.locator('#inspector [data-key="radius"]').waitFor();
  checks.push('minimum-width resizing keeps radius/presets and artboard dimensions readable, border widths are linked between Border and Spacing and long dropdown values remain on one line');

  // Fill and text colour by typing a hex value: the class that set the colour before is replaced.
  await page.locator('#inspector [data-key="fill"]').fill('#112233'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('bg-[#112233]') && !classesOf('cta').some(name => /^bg-(accent|surface)$/.test(name)), 'typing a fill colour sets one background class and replaces the old one');
  await page.locator('#inspector [data-key="ink"]').fill('#ffffff'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('text-[color:#ffffff]') && !classesOf('cta').some(name => /^text-(accent|surface)$/.test(name)), 'typing a text colour sets one text-colour class and replaces the old one');
  assert.ok(classesOf('cta').filter(name => name.startsWith('bg-')).length <= 1, 'a single background class');
  checks.push('fill and text colour: typing a colour writes one class and replaces the previous colour class');

  // A project colour swatch.
  await select('cta');
  await page.locator('#inspector [data-section="appearance"] .token-swatch').first().click();
  await waitUntil(() => classesOf('cta').some(name => /^(bg-\[var\(--color-brand\)\]|text-\[color:var\(--color-brand\)\])$/.test(name)), 'a project colour swatch sets a class that uses the token');
  // The panel may re-render right after the commit; wait for the swatch rather than reading a detached node (a real flake here).
  await waitUntil(() => page.locator('#inspector .token-swatch').first().evaluate(node => getComputedStyle(node).backgroundColor).catch(() => null).then(colour => colour === 'rgb(91, 91, 240)'), 'the swatch is painted with the colour itself');
  checks.push('project colours are swatches that set a class using the token');

  // Remove a colour.
  await select('cta');
  await page.locator('#inspector [data-section="appearance"] .color-clear:not([hidden])').first().click();
  await waitUntil(() => !classesOf('cta').some(name => /^bg-\[/.test(name)), 'the remove button drops the fill class');
  checks.push('a colour can be removed again');

  // Radius: presets, a number, Full, empty.
  await select('cta');
  await page.locator('#inspector .radius-presets .chip', { hasText: '12' }).click();
  await waitUntil(() => classesOf('cta').includes('rounded-xl'), 'the 12 preset sets rounded-xl');
  await page.locator('#inspector [data-key="radius"]').fill('10'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('rounded-[10px]') && !classesOf('cta').includes('rounded-xl'), 'a typed number sets an arbitrary radius and replaces the preset');
  assert.deepEqual(await borderWidths(), ['2px', '4px', '3px', '3px'], 'changing radius does not change border widths');
  await page.locator('#inspector [data-key="radius"]').fill('full'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('rounded-full'), 'typing Full sets rounded-full');
  await page.locator('#inspector [data-key="radius"]').fill(''); await page.keyboard.press('Enter');
  await waitUntil(() => !classesOf('cta').some(name => /^rounded/.test(name)), 'an empty radius removes the class');
  // The panel redraws after the commit: the field shows the new state a moment later, so wait for it instead of reading once.
  await waitUntil(async () => (await page.locator('#inspector [data-key="radius"]').inputValue()) === '', `the field is empty once no class sets the radius (${classesOf('cta').join(' ')})`);
  // The empty field quotes the radius the page really has now, not the pill's measurement from the render before the removal.
  const realRadius = await page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate(node => String(Math.round(parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0)));
  await waitUntil(async () => (await page.locator('#inspector [data-key="radius"]').getAttribute('placeholder')) === realRadius, `the placeholder is the radius the page has (${await page.locator('#inspector [data-key="radius"]').getAttribute('placeholder')} vs ${realRadius})`);
  checks.push('corner radius: presets, a typed number, Full and removal');
  checks.push('an empty radius field quotes the page\'s real number, not a stale measurement');

  // Effects scrub from implicit/explicit auto, keep integer z-order and honour gesture cancellation.
  const effect = key => page.locator(`#inspector [data-key="${key}"]`);
  const scrub = async (key, delta, { shift = false, cancel } = {}) => {
    const label = effect(key).locator('..').locator('.vf-k');
    const box = await waitUntil(async () => { await label.hover(); return await label.boundingBox(); }, `the ${key} scrub label is attached and visible`);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await label.evaluate(node => node.addEventListener('pointerdown', event => { node.dataset.testPointer = String(event.pointerId); }, { once: true }));
    await page.mouse.move(x, y); await page.mouse.down();
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.move(x + delta, y, { steps: 4 });
    if (key === 'z' && delta) assert.match(await effect(key).inputValue(), /^-?\d+$/, 'z-index scrubs in whole, unitless numbers');
    if (cancel === 'escape') await page.keyboard.press('Escape');
    if (cancel === 'pointer') await label.dispatchEvent('pointercancel', { pointerId: Number(await label.getAttribute('data-test-pointer')) });
    if (cancel === 'capture') await label.evaluate(node => node.releasePointerCapture(Number(node.dataset.testPointer)));
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
  };
  const typeZ = async text => {
    await effect('z').fill(text); await effect('z').press('Enter');
    await waitUntil(() => text === '' ? !classesOf('cta').some(name => /^-?z-/.test(name)) : classesOf('cta').includes(text === 'auto' ? 'z-auto' : Number(text) < 0 ? `-z-${-Number(text)}` : `z-${text}`), `z-index ${text || 'default'} reaches the model`);
  };
  await select('cta'); await effect('z').waitFor();
  const untouched = afterVersion();
  await scrub('z', 0);
  assert.equal(afterVersion(), untouched, 'a label click preserves implicit auto without an edit');
  await scrub('z', 30);
  await waitUntil(() => classesOf('cta').includes('z-10'), 'dragging implicit auto starts from zero');
  assert.equal(await effect('z').locator('..').locator('.vf-unit').count(), 0, 'z-index has no px or percentage unit');
  await page.locator('#viewport').focus(); await page.keyboard.press('Control+z');
  await waitUntil(() => !classesOf('cta').some(name => /^-?z-/.test(name)), 'one undo reverts the entire scrub');
  await typeZ('auto');
  await scrub('z', -30);
  await waitUntil(() => classesOf('cta').includes('-z-10') && !classesOf('cta').includes('z-auto'), 'explicit auto can be scrubbed into negative order');
  await scrub('z', 6, { shift: true });
  await waitUntil(() => classesOf('cta').includes('z-10'), 'Shift scrubs by tens');
  await typeZ('auto'); await effect('z').press('ArrowDown');
  await waitUntil(() => classesOf('cta').includes('-z-1'), 'the same integer origin works for keyboard stepping from auto');
  await typeZ('auto');
  for (const cancel of ['escape', 'pointer', 'capture']) {
    const before = afterVersion(); await scrub('z', 30, { cancel }); await sleep(180);
    assert.equal(afterVersion(), before, `${cancel} cancels without writing or adding an undo step`);
    assert.equal(await effect('z').inputValue(), 'auto');
    assert.ok(classesOf('cta').includes('z-auto'));
    assert.equal(await page.locator('#inspector .scrubbing').count(), 0, 'pointer/keyboard listeners finish the gesture');
  }
  await scrub('opacity', -30); await waitUntil(() => classesOf('cta').includes('opacity-90'), 'opacity still scrubs from its 100% default');
  await scrub('blur', 30); await waitUntil(() => classesOf('cta').includes('blur-[10px]'), 'blur still scrubs in px from zero');
  checks.push('z-index label scrubs integer positive/negative order from auto, Shift accelerates, arrows step, one undo reverts and Escape/pointer/capture cancellation writes nothing; opacity/blur retain their defaults');

  // Several selected elements share one Appearance edit.
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['nav', 'cta']); });
  await waitUntil(() => page.evaluate(async () => (await import('./lib/store.js')).store.node?.nodeIds?.length === 2), 'both elements are selected');
  await waitUntil(async () => /2\s*elements selected/.test(await page.locator('#inspector').innerText()), 'the inspector shows two selected elements');
  await page.locator('#inspector [data-key="radius"]').fill('9'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('nav').includes('rounded-[9px]') && classesOf('cta').includes('rounded-[9px]'), `one radius edit applies to every selected element (nav ${classesOf('nav').join(' ')}, cta ${classesOf('cta').join(' ')})`);
  checks.push('one Appearance edit applies to several selected elements');
  await scrub('z', 6);
  await waitUntil(() => classesOf('nav').includes('z-2') && classesOf('cta').includes('z-2'), 'a mixed z-index scrub applies one integer to every selected element');

  // Centring a container that is not flex yet.
  const doc = runtime.read({ view: 'document', documentId: 'welcome' });
  const plain = Object.keys(doc.nodes).find(id => doc.nodes[id].type === 'element' && !/\b(flex|grid)\b/.test(doc.nodes[id].className || '') && id !== doc.rootId && id !== 'cta' && (doc.nodes[id].children || []).length);
  await select(plain);
  await page.locator('#inspector [data-key="center-content"]').click();
  await waitUntil(() => ['flex', 'items-center', 'justify-center'].every(name => classesOf(plain).includes(name)), 'Center content makes the container flex-centred');
  await page.keyboard.press('Control+z');
  await select(plain);
  await page.locator('#inspector [data-key="center-element"]').click();
  await waitUntil(() => classesOf(plain).includes('mx-auto'), 'Center element adds auto side margins');
  checks.push('one-click centring of the content or of the element itself');

  await select('cta');
  await page.locator('#inspector [data-section="border"]').waitFor();
  await mkdir('artifacts', { recursive: true });
  for (const [width, size] of [[1280, 100], [390, 100], [390, 200]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(async size => (await import('./lib/help.js')).setUiSize(size), size);
    await waitUntil(() => page.evaluate(() => {
      const summary = document.querySelector('#inspector [data-section="border"] summary');
      if (!summary) return false;
      summary.scrollIntoView({ block: 'start', behavior: 'instant' });
      return true;
    }), 'the current Border section exists after resizing');
    await sleep(700);
    const layoutErrors = await page.locator('#inspector [data-section="border"]').evaluate(section => {
      const bad = [], context = document.createElement('canvas').getContext('2d');
      if (section.scrollWidth > section.clientWidth + 1) bad.push('horizontal overflow');
      if (getComputedStyle(section.querySelector('.border-widths')).gridTemplateColumns.split(' ').length > 2) bad.push('edge widths need at most two columns');
      for (const input of section.querySelectorAll('.vf-input')) {
        const style = getComputedStyle(input); context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        if (context.measureText(input.value || input.placeholder).width > input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 1) bad.push(`${input.dataset.key} clips`);
      }
      return bad;
    });
    assert.deepEqual(layoutErrors, [], `Border controls at ${width}px/${size}%`);
    assert.equal(await textAlign.evaluate(group => group.scrollWidth <= group.clientWidth + 1 && group.closest('.appearance-box') !== null), true, `typography alignment remains together at ${width}px/${size}%`);
    if (size === 200) {
      await textAlign.getByRole('button', { name: 'Justify', exact: true }).click({ trial: true });
      await page.locator('#inspector').screenshot({ path: 'artifacts/text-alignment-appearance-phone-200.png' });
    }
    if (size === 100) await page.locator('#inspector [data-section="border"]').screenshot({ path: `artifacts/border-section-${width}-${size}.png` });
  }
  checks.push('Border stays readable without horizontal overflow on desktop, phone and phone/200%');

  await page.evaluate(async () => (await import('./lib/help.js')).setUiSize(200));
  await select('cta'); await effect('z').waitFor();
  await typeZ('auto'); await scrub('z', 6);
  await waitUntil(() => classesOf('cta').includes('z-2'), 'z-index scrubbing works at 200% interface size');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser?.close(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
