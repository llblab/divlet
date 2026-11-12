// Border, Appearance and Effects: linked border widths, line styles, colours, radius and numeric gestures.
import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { cp, mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../core/lib/runtime.js';
import { fontDataUrl, fontBytes } from '../../core/tests/fixtures/font.js';
import { setStyleEngines } from '../../core/lib/engine.ts';
import { decodeHtml } from '../../core/lib/codec.ts';

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
let browser, native;
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

  const family = page.locator('#inspector [data-key="font-family"]');
  const inlineFamily = () => runtime.getEntry('welcome').document.nodes.cta.style['font-family'];
  const chooseFamily = async name => { await family.click(); await page.getByRole('menuitemradio', { name, exact: true }).click(); await runtime.queue; };
  assert.equal(await family.count(), 1);
  assert.equal(await family.evaluate(node => node.closest('[data-inspector-slot="typography"]') !== null), true, 'native family is adjacent to size, weight and alignment, not another section');
  const classesBeforeFamily = classesOf('cta').join(' ');
  for (const name of ['system-ui', 'sans-serif', 'serif', 'monospace']) {
    await chooseFamily(name);
    await waitUntil(() => inlineFamily() === name, `native ${name} family`);
    await waitUntil(() => page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate((node, name) => getComputedStyle(node).fontFamily === name, name), 'chosen family reaches the real iframe');
    assert.equal(classesOf('cta').join(' '), classesBeforeFamily, 'family edits do not require utility normalization');
  }
  await chooseFamily('Default (stylesheet / inherited)');
  await waitUntil(() => inlineFamily() === undefined, 'Default clears the inline override');
  await runtime.undo(); await waitUntil(() => inlineFamily() === 'monospace', 'one Undo restores the prior native family');
  await runtime.redo(); await waitUntil(() => inlineFamily() === undefined, 'Redo restores inheritance');

  const deviceUpload = async (bytes, name = 'device.ttf') => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload font', exact: true }).click();
    await (await chooser).setFiles({ name, mimeType: 'font/ttf', buffer: bytes });
  };
  await deviceUpload(fontBytes(600, { family: 'Provider Upload' }));
  await waitUntil(() => runtime.settings.css.includes('Provider Upload'), 'device upload registers ordinary project CSS with the optional provider enabled');
  await chooseFamily('"Provider Upload"');
  await waitUntil(() => inlineFamily() === '"Provider Upload"', 'uploaded family becomes a real menu choice');
  const providerFont = await page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('body').evaluate(async node => {
    const fonts = await node.ownerDocument.fonts.load('100px "Provider Upload"', 'AA'); return fonts.map(face => face.status);
  });
  assert.deepEqual(providerFont, ['loaded']);
  await runtime.undo(); await runtime.undo();
  await waitUntil(() => !runtime.settings.css.includes('Provider Upload'), 'selection and registration are two explicit gestures; registration itself is one undoable asset/CSS change');
  await select('cta');
  checks.push('actual device chooser with provider, uploaded menu choice, real font loading and separate selection/registration Undo');

  await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { assets: { fonts: { 'proof.ttf': fontDataUrl() } }, css: runtime.settings.css + '\n@font-face{font-family:"Project Face";src:url(asset:fonts/proof.ttf)}' } });
  await runtime.patch({ documentId: 'welcome', expectedVersion: afterVersion(), patch: { css: runtime.getEntry('welcome').document.css + '\n@font-face{font-family:"Local (Variant)";src:url(asset:fonts/proof.ttf)}', nodes: { cta: { style: { 'font-family': '"Old Face", serif !important' } } } } });
  await select('cta');
  await waitUntil(() => family.getAttribute('aria-label').then(value => value.includes('Old Face')), 'the authored family is shown');
  await chooseFamily('"Project Face"');
  await waitUntil(() => inlineFamily() === '"Project Face", "Old Face", serif !important', 'declared family retains fallback spelling and importance');
  await chooseFamily('"Local (Variant)"');
  await waitUntil(() => inlineFamily() === '"Local (Variant)", "Old Face", serif !important', 'changing declared family replaces just its head, not the fallback stack');
  await waitUntil(() => page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('body').evaluate(async () => (await document.fonts.load('16px "Local (Variant)"', 'A')).length === 1), 'the declared stored face actually loads');
  await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('welcome', ['cta', 'hero']));
  await waitUntil(() => family.getAttribute('aria-label').then(value => value.includes('Mixed')), 'mixed selection is explicit');
  await chooseFamily('serif');
  await waitUntil(() => ['cta', 'hero'].every(id => runtime.getEntry('welcome').document.nodes[id].style['font-family']?.startsWith('serif')), 'one shared native write edits all selected elements');
  await runtime.undo();
  assert.equal(runtime.getEntry('welcome').document.nodes.hero.style['font-family'], undefined);
  assert.equal(inlineFamily(), '"Local (Variant)", "Old Face", serif !important');

  await select('cta');
  await runtime.patch({ documentId: 'welcome', expectedVersion: afterVersion(), patch: { nodes: { cta: { style: { 'font-family': null, font: 'italic 600 16px serif' } } } } });
  await waitUntil(() => family.getAttribute('aria-label').then(value => value.includes('Inline shorthand')), 'ambiguous shorthand is named instead of guessed');
  const shorthandVersion = afterVersion();
  await chooseFamily('monospace'); await sleep(150);
  assert.equal(afterVersion(), shorthandVersion, 'refused shorthand edit changes neither source content nor version');
  assert.equal(runtime.getEntry('welcome').document.nodes.cta.style.font, 'italic 600 16px serif');
  await runtime.patch({ documentId: 'welcome', expectedVersion: afterVersion(), patch: { nodes: { cta: { style: { font: null } } } } });
  await runtime.patch({ documentId: 'welcome', expectedVersion: afterVersion(), patch: { nodes: { cta: { style: { all: 'initial !important' } } } } });
  await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('welcome', ['hero', 'cta']));
  await waitUntil(() => page.locator('#inspector .count').innerText().then(value => value.includes('2')), 'both reset-conflict targets reach the inspector');
  const beforeReset = runtime.read({ view: 'frame', documentId: 'welcome' }), resetSource = await readFile(runtime.projectPath), resetHistory = runtime.readHistory();
  const actualFamily = () => page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate(node => getComputedStyle(node).fontFamily);
  const resetFamily = await actualFamily();
  await chooseFamily('monospace'); await sleep(150);
  assert.deepEqual(runtime.read({ view: 'frame', documentId: 'welcome' }), beforeReset, 'one shorthand conflict refuses every selected node, including the earlier safe prefix');
  assert.deepEqual(await readFile(runtime.projectPath), resetSource); assert.deepEqual(runtime.readHistory(), resetHistory);
  assert.equal(await actualFamily(), resetFamily, 'the all !important witness refuses without changing effective family');
  await select('cta');
  await runtime.patch({ documentId: 'welcome', expectedVersion: afterVersion(), patch: { css: runtime.getEntry('welcome').document.css + '\n.font-lock{font-family:serif!important}', nodes: { cta: { className: classesBeforeFamily + ' font-lock', style: { all: null } } } } });
  await waitUntil(() => actualFamily().then(value => value === 'serif'), 'important stylesheet family is effective');
  await chooseFamily('monospace'); await waitUntil(() => inlineFamily() === 'monospace', 'the authored inline value is saved without silent priority escalation');
  assert.equal(await actualFamily(), 'serif', 'the explicit important stylesheet still wins');
  assert.match(await page.locator('.font-family-note').innerText(), /inline CSS.*stylesheet priority/);
  assert.equal(await family.getAttribute('aria-describedby'), 'font-family-cascade-note', 'the always-visible cascade disclosure describes this authored-value control');
  await waitUntil(() => family.locator('.pick-v').innerText().then(text => text === 'monospace'), 'reader-driven family redraw settles before the keyboard menu gesture');
  await family.focus(); await page.keyboard.press('Space');
  await page.getByRole('menu', { name: 'Font family', exact: true }).waitFor();
  await page.keyboard.press('End'); await page.keyboard.press('Escape');
  assert.equal(await family.evaluate(node => node === document.activeElement), true, 'keyboard Escape restores focus to the font field');
  await page.keyboard.press('Space'); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  await waitUntil(() => inlineFamily() === undefined, 'keyboard Default clears only the inline value');
  assert.equal(await actualFamily(), 'serif');
  await runtime.patch({ documentId: 'welcome', expectedVersion: afterVersion(), patch: { nodes: { cta: { className: classesBeforeFamily } } } });
  const semanticChecks = await page.evaluate(async () => {
    const { familyPatch } = await import('./lib/typography.js');
    const named = '"Project Face"';
    const inherited = familyPatch({ style: { 'font-family': 'inherit !important' } }, named, [named]);
    let refused = false;
    try { familyPatch({ style: { 'font-family': 'var(--family, serif)' } }, named, [named]); } catch { refused = true; }
    return { inherited, refused, generic: familyPatch({ style: { 'font-family': 'var(--family, serif)' } }, 'serif', [named]) };
  });
  assert.deepEqual(semanticChecks, { inherited: { 'font-family': '"Project Face" !important' }, refused: true, generic: { 'font-family': 'serif' } });
  checks.push('native family generics/declared loading, fallback/priority retention, multi-selection history, font/all refusal and honest important-stylesheet disclosure with keyboard menu recovery');

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
  await runtime.close();
  setStyleEngines([]);
  native = await openRuntime({ file: path.join(cwd, 'no-engine.divlet'), watch: false, createDemo: false });
  await native.patchProject({ expectedVersion: 1, patch: { assets: { fonts: { 'plain.ttf': fontDataUrl() } }, css: '@font-face{font-family:"No Engine Face";src:url(asset:fonts/plain.ttf)}main{font-family:serif}p{font-size:100px;display:inline-block}' } });
  await native.create({ document: decodeHtml('<main><p id="first">AA</p><p id="second">BB</p></main>', { fallbackId: 'plain' }) });
  assert.deepEqual(native.info().clientPlugins, []);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(native.url);
  await page.evaluate(async () => { const store = await import('./lib/store.js'); store.selectArtboards(['plain']); store.selectNodes('plain', ['first']); });
  await family.waitFor();
  assert.equal(await page.locator('#inspector [data-section="appearance"]').count(), 1, 'core supplies one minimal Appearance without a provider');
  assert.equal(await page.locator('#inspector [data-section="classes"]').count(), 0);
  await family.click(); await page.getByRole('menuitemradio', { name: '"No Engine Face"', exact: true }).click();
  await waitUntil(() => native.getEntry('plain').document.nodes.first.style['font-family'] === '"No Engine Face"', 'family edits have no engine requirement');
  await waitUntil(() => page.locator('iframe[data-document-id="plain"]').contentFrame().locator('#first').evaluate(node => Math.round(node.getBoundingClientRect().width) === 120), 'stored face actually renders with no style engine');
  const nativeCss = native.settings.css, nativeVersion = native.getEntry('plain').document.version;
  await page.locator('iframe[data-document-id="plain"]').evaluate(node => { node.dataset.uploadLifetime = 'retained'; });
  await deviceUpload(fontBytes(900, { family: 'Device Font', axes: [['wght', 100, 400, 900]] }));
  await waitUntil(() => native.settings.css.includes('Device Font'), 'device font registers with no style engine');
  assert.match(native.settings.css, /font-weight:100 900/, 'variable weight range is registered, not flattened to its default');
  assert.equal(native.getEntry('plain').document.version, nativeVersion, 'upload registers a project face, not a hidden selected-node edit');
  await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('plain', ['first', 'second']));
  await family.click(); await page.getByRole('menuitemradio', { name: '"Device Font"', exact: true }).click();
  await waitUntil(() => ['first', 'second'].every(id => native.getEntry('plain').document.nodes[id].style['font-family'] === '"Device Font"'), 'one mixed selection shares one uploaded resource');
  await waitUntil(() => page.locator('iframe[data-document-id="plain"]').contentFrame().locator('#first').evaluate(node => Math.round(node.getBoundingClientRect().width) === 180), 'uploaded device bytes, not the previous face or fallback, render in the real preview');
  assert.equal(Object.keys(native.settings.assets.fonts).filter(name => name.startsWith('device')).length, 1);
  assert.equal(await page.locator('iframe[data-document-id="plain"]').getAttribute('data-upload-lifetime'), 'retained');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Upload font', exact: true }).click({ trial: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await native.undo(); await native.undo();
  await waitUntil(() => native.settings.css === nativeCss, 'one registration Undo removes its bytes and CSS together');
  assert.equal(native.settings.assets.fonts['device.ttf'], undefined);
  await native.redo(); await waitUntil(() => native.settings.css.includes('Device Font'), 'registration Redo restores the same shared bytes and face');
  await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('plain', ['first']));
  const beforeBad = { revision: native.revision, css: native.settings.css, assets: structuredClone(native.settings.assets) };
  let fontPosts = 0;
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/api/fonts')) fontPosts++; });
  await deviceUpload(Buffer.from('not a font'));
  await waitUntil(() => page.locator('#toast').innerText().then(text => text.includes('could not decode')), 'undecodable bytes fail visibly before an upload request');
  assert.equal(fontPosts, 0); assert.deepEqual({ revision: native.revision, css: native.settings.css, assets: native.settings.assets }, beforeBad);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = async function () { const face = await load.call(this); if (this.family === 'divlet-device-probe') { window.deviceProbeLoads = (window.deviceProbeLoads || 0) + 1; await new Promise(resolve => { window.releaseDeviceFont = resolve; }); } return face; };
  });
  const idleUpload = await page.getByRole('button', { name: 'Upload font', exact: true }).boundingBox();
  await deviceUpload(fontBytes(600, { family: 'Stale Device' }));
  await waitUntil(() => page.evaluate(() => !!window.releaseDeviceFont), 'hold a decoded device font before its accepted request');
  assert.equal(await page.getByRole('button', { name: 'Upload font', exact: true }).getAttribute('aria-busy'), 'true');
  assert.deepEqual(await page.getByRole('button', { name: 'Upload font', exact: true }).boundingBox(), idleUpload, 'decode progress stays on a stable-size button');
  const pendingButton = await page.getByRole('button', { name: 'Upload font', exact: true }).elementHandle();
  await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('plain', ['second']));
  await waitUntil(() => pendingButton.evaluate(node => !node.isConnected), 'selection changes recreate the inspector while decoding is held');
  assert.equal(await page.getByRole('button', { name: 'Upload font', exact: true }).isDisabled(), true, 'replacement control reflects the same pending project operation');
  assert.equal(await page.getByRole('button', { name: 'Upload font', exact: true }).getAttribute('aria-busy'), 'true');
  await page.locator('.font-family-control input[type="file"]').setInputFiles({ name: 'duplicate.ttf', mimeType: 'font/ttf', buffer: fontBytes(600, { family: 'Duplicate Device' }) });
  assert.equal(await page.evaluate(() => window.deviceProbeLoads), 1, 'even programmatic duplicate input cannot start another decode');
  await native.patchProject({ expectedVersion: native.settings.version, patch: { css: native.settings.css + '\n/* concurrent author edit */' } });
  const afterAuthor = { revision: native.revision, css: native.settings.css, assets: structuredClone(native.settings.assets) };
  await page.evaluate(() => window.releaseDeviceFont());
  await waitUntil(() => page.locator('#toast').innerText().then(text => text.includes('project changed')), 'stale upload refuses rather than rebasing or retrying');
  assert.equal(fontPosts, 1); assert.deepEqual({ revision: native.revision, css: native.settings.css, assets: native.settings.assets }, afterAuthor);
  await waitUntil(() => page.getByRole('button', { name: 'Upload font', exact: true }).isEnabled(), 'settlement clears the current replacement control, not only its detached predecessor');
  await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('plain', ['first']));
  checks.push('provider-free device decoding, one shared face across mixed selection, actual 180px glyphs, registration Undo/Redo, invalid-no-POST and stale-no-partial-state');

  const longFamily = '"A deliberately long declared family with spaces (and a comma, inside)"';
  await native.patchProject({ expectedVersion: native.settings.version, patch: { css: native.settings.css + `\n@font-face{font-family:${longFamily};src:url(asset:fonts/plain.ttf)}` } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => (await import('./lib/help.js')).setUiSize(200));
  await family.click(); await page.getByRole('menuitemradio', { name: longFamily, exact: true }).click();
  await waitUntil(() => native.getEntry('plain').document.nodes.first.style['font-family']?.startsWith(longFamily), 'a long comma-bearing family is one literal choice');
  await waitUntil(() => family.locator('.pick-v').innerText().then(text => text === longFamily), 'accepted family reaches the inspector before measuring its whole label');
  const geometry = await family.evaluate(button => { const box = button.parentElement; return { fieldWidth: box.clientWidth, contentsWidth: box.scrollWidth, inspectorWidth: document.querySelector('#inspector').clientWidth, text: button.querySelector('.pick-v').textContent, nowrap: getComputedStyle(button.querySelector('.pick-v')).whiteSpace }; });
  assert.equal(geometry.text, longFamily);
  assert.equal(geometry.nowrap, 'nowrap');
  assert.ok(geometry.fieldWidth <= geometry.inspectorWidth && geometry.contentsWidth > geometry.fieldWidth, 'only the overlong whole control pans, not the inspector');
  const beforePan = native.getEntry('plain').document.version;
  await page.locator('.font-family-scroll').evaluate(node => { node.scrollLeft = 0; });
  await page.locator('.font-family-scroll').focus(); await page.keyboard.press('ArrowRight');
  await waitUntil(() => page.locator('.font-family-scroll').evaluate(node => node.scrollLeft > 0), 'long values are keyboard-scrollable, not ellipsized or reduced');
  assert.equal(native.getEntry('plain').document.version, beforePan, 'panning a value never invokes canvas nudge shortcuts');
  await family.click({ trial: true });
  await mkdir('artifacts', { recursive: true });
  const uploadBox = await page.getByRole('button', { name: 'Upload font', exact: true }).boundingBox(), inspectorBox = await page.locator('#inspector').boundingBox();
  assert.ok(uploadBox.width >= 48 && uploadBox.height >= 48 && uploadBox.x >= inspectorBox.x && uploadBox.x + uploadBox.width <= inspectorBox.x + inspectorBox.width + 1, 'small upload target remains whole and usable at phone/200%');
  await page.getByRole('button', { name: 'Upload font', exact: true }).click({ trial: true });
  await page.locator('#inspector').screenshot({ path: 'artifacts/font-family-no-engine-phone-200.png' });
  checks.push('provider-free native family choice and real embedded face loading, narrow/200% whole-value keyboard panning');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser?.close(); await native?.close(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
