// Border, Appearance and Effects: linked border widths, line styles, colours, radius and numeric gestures.
import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { cp, mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '@divlet/core/runtime';
import { fontDataUrl, fontBytes } from '../../core/tests/fixtures/font.js';
import { woffBytes } from '../../core/tests/fixtures/font-woff.js';
import { woff2Bytes } from '../../core/tests/fixtures/font-woff2.js';
import { setStyleEngines } from '../../core/lib/engine.ts';
import { decodeHtml } from '../../core/lib/codec.ts';
import { classView } from '../../plugins/tailwind/web/view.js';

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
// An accepted edit is followed by a burst of measurement-driven inspector redraws; measure and focus after they settle.
const settleInspector = page => page.evaluate(() => new Promise(resolve => { let timer; const done = () => { observer.disconnect(); resolve(); }; const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 500); }); observer.observe(document.querySelector('#inspector'), { childList: true, subtree: true }); timer = setTimeout(done, 500); }));
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
  // The board's own POSTs share this runtime's queue, so a version is only the current one once the queue has drained:
  // reading it in the middle of somebody else's accepted edit produced a patch that was refused as stale.
  const afterVersion = async () => { await runtime.queue; return runtime.read({ view: 'document', documentId: 'welcome' }).version; };
  const colorRow = async label => {
    // Resolve and measure in one browser task: a preview measurement may replace a previously resolved section.
    const layout = await page.evaluate(() => {
      const section = document.querySelector('#inspector [data-section="appearance"]');
      const fields = ['fill', 'ink'].map(key => section.querySelector(`[data-key="${key}"]`).closest('.color-field'));
      const [fill, ink] = fields.map(field => field.getBoundingClientRect());
      const bounds = section.getBoundingClientRect();
      return {
        rects: [fill.toJSON(), ink.toJSON()],
        bounds: bounds.toJSON(),
        // offsetWidth is the unscaled CSS width, which is what the grid lays out in (200% interface size zooms it).
        cssWidth: section.offsetWidth,
        paired: fill.width > 0 && ink.width > 0 && Math.abs(fill.top - ink.top) < 1 && fill.right < ink.left,
        stacked: ink.top >= fill.bottom - 1 && Math.abs(fill.left - ink.left) < 1,
        contained: fields.every(field => {
          const rect = field.getBoundingClientRect();
          return rect.left >= bounds.left && rect.right <= bounds.right + 1 && field.scrollWidth <= field.clientWidth + 1;
        }),
      };
    });
    const { rects, bounds, stacked, cssWidth, ...result } = layout;
    // Two fields of at least 148px plus their gap: below that the pair gives way, and each field keeps its own one row.
    const fits = cssWidth >= 2 * 148 + 8;
    assert.deepEqual({ ...result, arranged: fits ? result.paired : stacked }, { paired: fits, contained: true, arranged: true }, `Fill and Text share a row while two one-row fields fit and stack whole below that (${label}): ${JSON.stringify({ rects, bounds, cssWidth })}`);
  };
  // A colour control is one line: label, swatch, value and clear sit side by side, and only a value too long for what is
  // left takes a line of its own. Measured with the canonical seven-character value, whatever the element authors.
  const colorFieldRows = async label => {
    const audit = await page.evaluate(() => {
      const fields = [...document.querySelectorAll('#inspector [data-section="border"] .color-field, #inspector [data-section="appearance"] .color-field')];
      const row = field => {
        const box = field.getBoundingClientRect();
        const parts = [...field.children].filter(node => getComputedStyle(node).display !== 'none');
        const centres = parts.map(node => { const rect = node.getBoundingClientRect(); return Math.round(rect.top + rect.height / 2); });
        return {
          // The colour inside the ring carries its name on the field itself, because the ring's own narrow middle cannot spare
          // a separate label column: there the sides control above it names the side.
          label: field.querySelector('.vf-k')?.textContent ?? field.closest('.br-centre')?.querySelector('.br-sides')?.textContent ?? field.dataset.key,
          spread: Math.max(...centres) - Math.min(...centres),
          inside: parts.every(node => { const rect = node.getBoundingClientRect(); return rect.left >= box.left - 1 && rect.right <= box.right + 1; }),
          order: parts.map(node => Math.round(node.getBoundingClientRect().left)),
          authored: field.querySelector('.color-hex').value,
        };
      };
      const hexes = fields.map(field => field.querySelector('.color-hex'));
      const authored = hexes.map(hex => hex.value);
      hexes.forEach(hex => { hex.value = '#332460'; });
      const canonical = fields.map(row);
      hexes.forEach((hex, at) => { hex.value = authored[at]; });
      return { canonical, authored: fields.map(row) };
    });
    const problems = audit.canonical
      .filter(field => field.spread > 1 || !field.inside)
      .map(field => ({ kind: 'colour value left the one row', ...field }));
    // A long authored value may wrap whole onto its own line, but the label, swatch and clear stay together above it.
    problems.push(...audit.authored
      .filter(field => field.spread > 1 && field.authored.length <= 9)
      .map(field => ({ kind: 'short authored value left the one row', ...field })));
    assert.deepEqual(problems, [], `colour controls keep label, swatch, value and clear on one line (${label}): ${JSON.stringify(audit.canonical)}`);
  };

  // With a style engine, More CSS takes the common path: custom properties stay native declarations, other properties become
  // utilities; without one, everything is a native declaration.
  const inlineCase = async (owner, documentId, nodeId, { utilities = false } = {}) => {
    const current = () => owner.getEntry(documentId).document;
    const initial = structuredClone(current().nodes[nodeId].style), classes = current().nodes[nodeId].className;
    await owner.patch({ documentId, expectedVersion: current().version, patch: { nodes: { [nodeId]: { style: { '--Ink': '#ff0000', '--ink': '#0000ff', color: 'var(--Ink)', 'background-color': 'var(--ink)' } } } } });
    await page.evaluate(async ({ documentId, nodeId }) => {
      document.activeElement?.blur?.(); const store = await import('./lib/store.js');
      store.selectArtboards([documentId]); store.selectNodes(documentId, [nodeId]);
    }, { documentId, nodeId });
    const section = page.locator('#inspector [data-section="style"]');
    await section.waitFor();
    if (!await section.locator('details').evaluate(node => node.open)) await section.locator('summary').click();
    await waitUntil(() => section.locator('[data-key="style:--Ink"]').inputValue().then(value => value === '#ff0000'), 'prepared authored variables reach the real inspector');
    const rgb = hex => `rgb(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;
    const verify = async (expected, classed = {}, baseline = classes) => {
      await waitUntil(() => { assert.deepEqual(current().nodes[nodeId].style, expected); return true; }, 'accepted variable spelling and unrelated declarations');
      await waitUntil(() => Object.keys(classed).length ? Object.entries(classed).every(([property, value]) => current().nodes[nodeId].className.split(' ').includes(`[${property}:${value}]`)) : current().nodes[nodeId].className === baseline, 'non-variable declarations are utilities, and Undo restores the classes');
      await owner.queue;
      await waitUntil(async () => {
        const actual = await page.locator(`iframe[data-document-id="${documentId}"]`).contentFrame().locator(`[data-divlet-id="${nodeId}"]`).evaluate(node => {
          const css = getComputedStyle(node); return [css.color, css.backgroundColor];
        });
        return actual[0] === rgb(expected['--Ink']) && actual[1] === rgb(expected['--ink']);
      }, 'case-sensitive variables paint distinct foreground/background colours');
      const saved = JSON.parse(await readFile(owner.projectPath, 'utf8')).frames.find(frame => frame.id === documentId);
      assert.deepEqual(saved.nodes[nodeId].style, expected, 'the writer saves exact custom-property names');
    };
    for (const [name, value, patch] of [
      ['--Ink', '#008000', { '--Ink': '#008000' }],
      ['BoRdEr-ToP-CoLoR', '#123456', { 'border-top-color': '#123456' }],
      ['--Ink:#ff00ff;--ink:#ffff00;OuTlInE-CoLoR:#654321', '', { '--Ink': '#ff00ff', '--ink': '#ffff00', 'outline-color': '#654321' }],
    ]) {
      const before = structuredClone(current().nodes[nodeId].style), version = current().version, beforeClasses = current().nodes[nodeId].className;
      await section.locator('[data-key="style-new-key"]').fill(name);
      if (value) await section.locator('[data-key="style-new-value"]').fill(value);
      await page.keyboard.press('Enter');
      await page.locator('#viewport').focus();
      const native = utilities ? Object.fromEntries(Object.entries(patch).filter(([property]) => property.startsWith('--'))) : patch;
      const classed = utilities ? Object.fromEntries(Object.entries(patch).filter(([property]) => !property.startsWith('--'))) : {};
      const next = { ...before, ...native };
      await verify(next, classed);
      assert.equal(current().version, version + 1, 'one submission is one accepted change');
      await page.keyboard.press('Control+z'); await verify(before, {}, beforeClasses);
      await page.keyboard.press('Control+Shift+z'); await verify(next, classed);
    }
    // Restore the caller's authored inline data by undoing the three edits and the setup.
    for (let i = 0; i < 4; i++) await owner.undo();
    assert.deepEqual(current().nodes[nodeId].style, initial);
    checks.push(`core inline custom-property case, ordinary-name normalization, saved source, actual CSS and one-step Undo/Redo (${documentId})`);
  };

  // A project colour exists: it shows up as a swatch.
  await runtime.patch({ documentId: 'welcome', expectedVersion: await afterVersion(), actor: 'user', patch: { tokens: { '--color-brand': '#5b5bf0' } } });
  await select('cta');
  await page.waitForSelector('#inspector [data-section="appearance"] [data-key="fill"]');
  await colorRow('project color swatches');
  assert.equal(await page.locator('#inspector [data-section="spacing"] [data-key="radius"], #inspector [data-section="spacing"] .br-box').count(), 0, 'the box model keeps no radius field');
  assert.equal(await page.locator('#inspector [data-section="border"] [data-key="radius-tl"]').count(), 1, 'Border gives each corner its own radius field, in its ring');
  assert.equal(await page.locator('#inspector [data-section="border"] .br-corner').count(), 4, 'one radius in each corner of the ring');
  assert.equal(await page.locator('#inspector [data-section="border"] [data-key="stroke"]').count(), 1, 'border colour belongs to Border, in the middle of the ring');
  assert.equal(await page.locator('#inspector [data-section="border"] .br-edge').count(), 0, 'Border repeats no edge width in its ring');
  assert.equal(await page.locator('#inspector [data-section="border"] [data-key^="border-width-"]').count(), 0, 'a width has exactly one home, the box model band');
  assert.equal(await page.locator('#inspector [data-section="border"] [data-key="radius"]').count(), 1, 'one field gives every corner the same radius');
  assert.equal(await page.locator('#inspector .boxmodel .bm-border > .bm-cell input, #inspector .boxmodel .bm-border > .bm-top > .bm-cell input').count(), 4, 'and the band still edits all four widths');
  assert.equal(await page.locator('#inspector [data-section="border"] [data-key="border-side"]').count(), 1, 'one control says which side the colour belongs to');
  {
    // The band is copied: its own fill, its one-pixel frame, its square corners and its size, centred in the section — with the
    // middle cut out so the panel's own surface shows where the widget above puts its content band.
    const copy = await waitUntil(() => page.evaluate(() => {
      const ring = document.querySelector('#inspector .br-box'), band = document.querySelector('#inspector .boxmodel .bm-border');
      const section = document.querySelector('#inspector [data-section="border"]'), hole = ring.querySelector('.br-hole');
      const a = getComputedStyle(ring), c = getComputedStyle(band);
      const box = node => { const r = node.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) }; };
      const surface = style => [style.backgroundColor, style.borderTopWidth, style.borderTopStyle, style.borderTopColor, style.borderRadius].join(' ');
      const middle = box(ring), frame = box(section), cut = box(hole);
      const panel = getComputedStyle(document.body);
      const report = {
        size: middle, source: box(band), surface: surface(a), sourceSurface: surface(c),
        captions: ring.querySelectorAll(':scope > .bm-top > .bm-caption').length,
        hole: [Math.round(cut.left - middle.left), Math.round(cut.w), Math.round(cut.h)], holeColour: getComputedStyle(hole).backgroundColor,
        centred: Math.abs((middle.left + middle.right) / 2 - (frame.left + frame.right) / 2) <= 1,
        surfaceOfPanel: getComputedStyle(document.querySelector('#inspector')).backgroundColor,
        body: panel.backgroundColor,
      };
      return report.surface === report.sourceSurface && Math.abs(report.size.w - report.source.w) <= 1 ? report : null;
    }), 'the border band is copied into Border');
    assert.equal(copy.surface, copy.sourceSurface, 'the copy shares the band\'s fill, frame and square corners');
    assert.equal(copy.size.w, copy.source.w, `and its width (${copy.size.w} vs ${copy.source.w})`);
    assert.ok(Math.abs(copy.size.h - copy.source.h) <= 4, `and its height (${copy.size.h} vs ${copy.source.h})`);
    assert.equal(copy.captions, 0, 'and carries no caption of its own');
    assert.equal(copy.centred, true, 'it is centred in the section, on the same axis as the band it copies');
    assert.ok(copy.hole[0] > 20 && copy.hole[0] < 60, `the middle is cut out (${copy.hole[0]}px of rim)`);
    assert.equal(copy.holeColour, copy.surfaceOfPanel, 'showing the panel\'s own surface through the cut');
  }
  assert.equal(await page.locator('#inspector [data-section="appearance"] [data-key="radius"], #inspector [data-section="appearance"] [data-key="stroke"]').count(), 0, 'no third home in Appearance');
  const sectionOrder = await page.locator('#inspector [data-section]').evaluateAll(nodes => nodes.map(node => node.dataset.section));
  assert.equal(sectionOrder.indexOf('border'), sectionOrder.indexOf('spacing') + 1, 'Border is a vertical disclosure directly after Spacing, not another tab');
  checks.push('Border owns line style, colour, four edge widths and the corner radii in a copy of the box model\'s border band; Appearance keeps fill and typography');

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
  // The authored family wherever the common style path put it: a utility class with the Tailwind engine, an inline declaration without.
  const familyOf = id => { const node = runtime.getEntry('welcome').document.nodes[id]; return node.style['font-family'] ?? classView(node.className)['font-family']; };
  const inlineFamily = () => familyOf('cta');
  const chooseFamily = async name => { await family.click(); await page.getByRole('menuitemradio', { name, exact: true }).click(); await runtime.queue; };
  assert.equal(await family.count(), 1);
  assert.equal(await family.evaluate(node => node.closest('[data-inspector-slot="typography"]') !== null), true, 'native family is adjacent to size, weight and alignment, not another section');
  const classesBeforeFamily = classesOf('cta').join(' ');
  for (const name of ['system-ui', 'sans-serif', 'serif', 'monospace']) {
    await chooseFamily(name);
    await waitUntil(() => inlineFamily() === name, `native ${name} family`);
    await waitUntil(() => page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate((node, name) => getComputedStyle(node).fontFamily === name, name), 'chosen family reaches the real iframe');
    assert.equal(runtime.getEntry('welcome').document.nodes.cta.style['font-family'], undefined, 'with the Tailwind engine the family is a utility, not an inline declaration');
    assert.deepEqual(classesOf('cta').filter(name => !name.startsWith('[font-family:')), classesBeforeFamily.split(' ').filter(Boolean), 'and only the family utility changes');
  }
  await chooseFamily('Default (stylesheet / inherited)');
  await waitUntil(() => inlineFamily() === undefined, 'Default clears the inline override');
  await runtime.undo(); await waitUntil(() => inlineFamily() === 'monospace', 'one Undo restores the prior native family');
  await runtime.redo(); await waitUntil(() => inlineFamily() === undefined, 'Redo restores inheritance');

  const deviceUpload = async (bytes, name = 'device.ttf') => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload font', exact: true }).click();
    await (await chooser).setFiles({ name, mimeType: name.endsWith('.woff2') ? 'font/woff2' : name.endsWith('.woff') ? 'font/woff' : 'font/ttf', buffer: bytes });
  };
  await deviceUpload(fontBytes(600, { family: 'Provider Upload' }));
  await waitUntil(() => runtime.settings.css.includes('Provider Upload'), 'device upload registers ordinary project CSS with the optional provider enabled');
  await chooseFamily('"Provider Upload"');
  await waitUntil(() => inlineFamily() === '"Provider Upload"', 'uploaded family becomes a real menu choice');
  const providerFont = await page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('body').evaluate(async node => {
    const fonts = await node.ownerDocument.fonts.load('100px "Provider Upload"', 'AA'); return fonts.map(face => face.status);
  });
  assert.deepEqual(providerFont, ['loaded']);
  await deviceUpload(fontBytes(900, { family: 'Provider Upload', weight: 700, subfamily: 'Bold' }), 'provider-bold.ttf');
  await waitUntil(() => runtime.settings.css.includes('provider-bold.ttf'), 'bold companion registers without replacing the regular face');
  await deviceUpload(fontBytes(1200, { family: 'Provider Upload', italic: true, subfamily: 'Italic' }), 'provider-italic.ttf');
  await waitUntil(() => runtime.settings.css.includes('provider-italic.ttf'), 'italic companion joins the same family');
  const faceMetrics = () => page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('body').evaluate(async node => {
    const doc = node.ownerDocument, results = [];
    for (const [weight, style] of [[400, 'normal'], [700, 'normal'], [400, 'italic']]) {
      await doc.fonts.load(`${style} ${weight} 100px "Provider Upload"`, 'AA');
      const text = doc.createElement('span'); text.textContent = 'AA';
      text.style.cssText = `display:inline-block;font-family:"Provider Upload";font-size:100px;font-weight:${weight};font-style:${style};letter-spacing:0;font-synthesis:none`;
      doc.body.append(text); results.push(Math.round(text.getBoundingClientRect().width)); text.remove();
    }
    return results;
  });
  assert.deepEqual(await faceMetrics(), [120, 180, 240], 'the browser matches three different byte programs, not synthetic styling of one face');
  await family.click(); assert.equal(await page.getByRole('menuitemradio', { name: '"Provider Upload"', exact: true }).count(), 1); await page.keyboard.press('Escape');
  const collisionState = { revision: runtime.revision, css: runtime.settings.css, assets: structuredClone(runtime.settings.assets), history: runtime.readHistory() };
  await deviceUpload(fontBytes(1500, { family: 'Provider Upload', weight: 700 }), 'overlap.ttf');
  await waitUntil(() => page.locator('#toast').innerText().then(text => text.includes('overlapping face')), 'overlapping companion refuses visibly');
  assert.deepEqual({ revision: runtime.revision, css: runtime.settings.css, assets: runtime.settings.assets, history: runtime.readHistory() }, collisionState);
  assert.deepEqual(await faceMetrics(), [120, 180, 240], 'refusal leaves actual matching unchanged');
  for (let i = 0; i < 4; i++) await runtime.undo();
  await waitUntil(() => !runtime.settings.css.includes('Provider Upload'), 'selection and registration are two explicit gestures; registration itself is one undoable asset/CSS change');
  await select('cta');
  checks.push('actual device chooser with provider, one family for regular/bold/italic companions, 120/180/240px matching, overlap refusal and separate selection/registration Undo');

  await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { assets: { fonts: { 'proof.ttf': fontDataUrl() } }, css: runtime.settings.css + '\n@font-face{font-family:"Project Face";src:url(asset:fonts/proof.ttf)}' } });
  await runtime.patch({ documentId: 'welcome', expectedVersion: await afterVersion(), patch: { css: runtime.getEntry('welcome').document.css + '\n@font-face{font-family:"Local (Variant)";src:url(asset:fonts/proof.ttf)}', nodes: { cta: { style: { 'font-family': '"Old Face", serif !important' } } } } });
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
  await waitUntil(() => ['cta', 'hero'].every(id => familyOf(id)?.startsWith('serif')), 'one shared write edits all selected elements');
  await runtime.undo();
  assert.equal(familyOf('hero'), undefined);
  assert.equal(inlineFamily(), '"Local (Variant)", "Old Face", serif !important');

  await select('cta');
  await runtime.patch({ documentId: 'welcome', expectedVersion: await afterVersion(), patch: { nodes: { cta: { style: { 'font-family': null, font: 'italic 600 16px serif' } } } } });
  await waitUntil(() => family.getAttribute('aria-label').then(value => value.includes('Inline shorthand')), 'ambiguous shorthand is named instead of guessed');
  const shorthandVersion = await afterVersion();
  await chooseFamily('monospace'); await sleep(150);
  assert.equal(await afterVersion(), shorthandVersion, 'refused shorthand edit changes neither source content nor version');
  assert.equal(runtime.getEntry('welcome').document.nodes.cta.style.font, 'italic 600 16px serif');
  await runtime.patch({ documentId: 'welcome', expectedVersion: await afterVersion(), patch: { nodes: { cta: { style: { font: null } } } } });
  await runtime.patch({ documentId: 'welcome', expectedVersion: await afterVersion(), patch: { nodes: { cta: { style: { all: 'initial !important' } } } } });
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
  await runtime.patch({ documentId: 'welcome', expectedVersion: await afterVersion(), patch: { css: runtime.getEntry('welcome').document.css + '\n.font-lock{font-family:serif!important}', nodes: { cta: { className: classesBeforeFamily + ' font-lock', style: { all: null } } } } });
  await waitUntil(() => actualFamily().then(value => value === 'serif'), 'important stylesheet family is effective');
  await chooseFamily('monospace'); await waitUntil(() => inlineFamily() === 'monospace', 'the authored inline value is saved without silent priority escalation');
  assert.equal(await actualFamily(), 'serif', 'the explicit important stylesheet still wins');
  await waitUntil(() => family.locator('.pick-v').innerText().then(text => text === 'monospace'), 'reader-driven family redraw settles before the keyboard menu gesture');
  const acceptedContext = { version: await afterVersion(), render: runtime.getEntry('welcome').render };
  await waitUntil(() => page.evaluate(async expected => {
    const current = (await import('./lib/store.js')).descriptor('welcome');
    return current?.version === expected.version && current.render === expected.render && document.querySelector('.artboard[data-artboard-id="welcome"]')?.dataset.renderedVersion === String(expected.render);
  }, acceptedContext), 'the unchanged-context menu witness starts from the accepted model and preview render');
  await page.evaluate(async () => { const state = await import('./lib/store.js'); await state.idle('welcome'); await state.freshModel('welcome'); await (await import('./lib/inspector.js')).render({ force: true }); });
  await family.focus(); await page.keyboard.press('Space');
  await page.getByRole('menu', { name: 'Font family', exact: true }).waitFor();
  await page.evaluate(async () => (await import('./lib/inspector.js')).render({ force: true }));
  assert.equal(await page.getByRole('menu', { name: 'Font family', exact: true }).isVisible(), true, 'an unchanged-context forced measurement refresh does not retire an active menu');
  await page.keyboard.press('End'); await page.keyboard.press('Escape');
  const familyFocused = () => page.evaluate(() => {
    const node = document.querySelector('#inspector [data-key="font-family"]');
    return !!node?.isConnected && node === document.activeElement;
  });
  assert.equal(await familyFocused(), true, 'keyboard Escape restores focus to the font field');
  await page.keyboard.press('Space'); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  await waitUntil(() => inlineFamily() === undefined, 'keyboard Default clears only the inline value');
  assert.equal(await actualFamily(), 'serif');
  // Separate from the uninterrupted Escape/Default gesture: repaint may retain or replace identity, but not lose focus.
  await family.focus();
  const previousFamily = await family.elementHandle();
  await page.evaluate(async () => (await import('./lib/inspector.js')).render({ force: true }));
  const previousIdentity = await previousFamily.evaluate(node => ({ connected: node.isConnected, focused: node === document.activeElement }));
  assert.equal(previousIdentity.connected, previousIdentity.focused, 'a retained field stays focused; a retired handle is not active');
  assert.equal(await familyFocused(), true, 'inspector repaint preserves focus on the live font field');
  await previousFamily.dispose();
  await runtime.patch({ documentId: 'welcome', expectedVersion: await afterVersion(), patch: { nodes: { cta: { className: classesBeforeFamily } } } });
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
  assert.equal(await page.locator('#inspector .br-box').evaluate(node => node.closest('[data-section="border"]') !== null), true, 'the ring stays in Border at the resize minimum too');
  assert.equal(await page.locator('#inspector .br-shell.br-compact .br-centre').count(), 1, 'a ring too narrow for its middle steps the colour out under it');
  // The ring: a radius in each corner, a width at each edge's centre, the colour in the middle, and one control naming the side.
  {
    const diagram = page.locator('#inspector [data-section="border"] .br-shell');
    assert.equal(await diagram.locator('.br-corner').count(), 4, 'one field per corner');
    assert.equal(await diagram.locator('.br-edge').count(), 0, 'no edge widths in the ring');
    assert.equal(await diagram.locator('.br-below [data-key="radius"]').count(), 1, 'one radius for all four corners under the ring');
    assert.equal(await page.locator('#inspector [data-section="border"] .br-centre [data-key="stroke"]').count(), 1, 'and the colour in the middle of the ring');
    const corners = () => page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate(node => {
      const style = getComputedStyle(node);
      return ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map(side => style[`border${side}Radius`]);
    });
    const before = await corners();
    await page.locator('#inspector [data-key="radius-tr"]').fill('6'); await page.keyboard.press('Enter');
    await waitUntil(async () => JSON.stringify(await corners()) === JSON.stringify([before[0], '6px', before[2], before[3]]), `a corner writes its own radius and leaves the others on the page (${before.join(' ')})`);
    await page.keyboard.press('Control+z');
    await waitUntil(async () => JSON.stringify(await corners()) === JSON.stringify(before), 'one Undo restores the corner on the page');
    await waitUntil(async () => (await page.locator('#inspector [data-key="radius-tr"]').inputValue()) === String(parseFloat(before[1])), 'and the field follows it back');
    await sleep(200); // let the writer queue drain, so the next block patches the version it just read
    checks.push('the ring writes one corner radius and undoes it as one step');

    // One field gives all four corners the same radius: it reads as one value only while they agree, and writing it replaces
    // every corner at once, so a corner value cannot hide behind it and contradict what the field says.
    const allCorners = page.locator('#inspector [data-key="radius"]');
    await waitUntil(async () => (await allCorners.inputValue()) !== '', 'the whole-border radius reads the value its corners share');
    const shared = await allCorners.inputValue();
    // A corner of its own, written through the live field on each attempt: a re-render may replace it between focus and key.
    await waitUntil(async () => {
      await page.locator('#inspector [data-key="radius-tl"]').fill('3'); await page.keyboard.press('Enter');
      return (await allCorners.inputValue()) === '';
    }, 'one corner disagreeing empties the whole-border field');
    await waitUntil(async () => {
      await allCorners.fill('7'); await page.keyboard.press('Enter');
      return JSON.stringify(await corners()) === JSON.stringify(['7px', '7px', '7px', '7px']);
    }, 'the whole-border radius reaches all four corners on the page');
    await waitUntil(async () => (await allCorners.inputValue()) === '7', 'and the four corner fields agree with it');
    await page.locator('#viewport').focus(); await page.keyboard.press('Control+z');
    await waitUntil(async () => (await allCorners.inputValue()) === '', 'one Undo returns the corners to their own values');
    await page.keyboard.press('Control+z');
    await waitUntil(async () => JSON.stringify(await corners()) === JSON.stringify(before) && (await allCorners.inputValue()) === shared, 'and the next Undo restores what the corners shared');
    checks.push('one radius writes every corner at once, reads as one value only while they agree, and undoes as one step');
  }

  // One side can have a colour of its own: the centre edits the shared `border-color`, or the single side the Sides control
  // names, and the ring paints each side as it is.
  {
    const sideColours = () => page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate(node => {
      const style = getComputedStyle(node);
      return ['Top', 'Right', 'Bottom', 'Left'].map(side => style[`border${side}Color`]);
    });
    const sideControl = page.locator('#inspector [data-key="border-side"]');
    const chooseSide = async label => {
      await sideControl.click();
      await page.getByRole('menuitemradio', { name: label, exact: true }).click();
      await waitUntil(async () => (await sideControl.innerText()).includes(label === 'All sides' ? 'All sides' : label), `the centre edits ${label}`);
    };
    // The copy is the band's surface, not the element's painted border: an authored colour shows on the page and in the
    // centre field, and never repaints the block that edits it.
    const surface = () => page.locator('#inspector .br-box').evaluate(node => {
      const style = getComputedStyle(node);
      return [style.backgroundColor, style.borderTopColor, style.borderLeftColor];
    });
    await page.locator('#inspector [data-key="stroke"]').fill('#112233'); await page.keyboard.press('Enter');
    await waitUntil(async () => (await sideColours()).every(colour => colour === 'rgb(17, 34, 51)'), 'the shared colour paints every side');
    await chooseSide('Left');
    await page.locator('#inspector [data-key="stroke"]').fill('#ff0000'); await page.keyboard.press('Enter');
    await waitUntil(async () => JSON.stringify(await sideColours()) === JSON.stringify(['rgb(17, 34, 51)', 'rgb(17, 34, 51)', 'rgb(17, 34, 51)', 'rgb(255, 0, 0)']), `only the chosen side takes the new colour (${(await sideColours()).join(' ')})`);
    const bandSurface = ['rgb(227, 199, 143)', 'rgb(76, 75, 64)', 'rgb(76, 75, 64)'];
    // One read, repeated until the panel has settled: a re-render can hand back a detached block, whose computed style is empty.
    await waitUntil(async () => JSON.stringify(await surface()) === JSON.stringify(bandSurface), 'the block that edits the colour keeps the band surface');
    // The side remembers itself while it is selected, and returns to the shared colour on request.
    await page.evaluate(async () => { const st = await import('./lib/store.js'); st.selectNodes('welcome', ['hero']); st.selectNodes('welcome', ['cta']); });
    await waitUntil(async () => (await sideControl.innerText()).includes('Left'), 'the chosen side survives a reselect of the same element');
    await chooseSide('All sides');
    // The three remaining sides now carry their own colours, so no shared `border-color` is authored any more: the field says
    // so instead of inventing one, and the page's real colour stays as its placeholder.
    await waitUntil(async () => (await page.locator('#inspector [data-key="stroke"]').inputValue()) === '', 'the centre reports that no shared colour is authored');
    assert.match(await page.locator('#inspector [data-key="stroke"]').getAttribute('placeholder') ?? '', /^#/, 'while quoting the colour the page really paints');
    await page.locator('#inspector [data-key="stroke"]').fill('#004400'); await page.keyboard.press('Enter');
    await waitUntil(async () => JSON.stringify(await sideColours()) === JSON.stringify(['rgb(0, 68, 0)', 'rgb(0, 68, 0)', 'rgb(0, 68, 0)', 'rgb(0, 68, 0)']), 'the shared colour wins again on every side');
    for (let step = 0; step < 3; step++) await page.keyboard.press('Control+z');
    await waitUntil(async () => (await sideColours()).every(colour => colour !== 'rgb(0, 68, 0)'), 'each colour change is its own Undo step');
    checks.push('a border side takes its own colour on the page and in the centre field, the shared colour returns and each change undoes alone');
  }

  // A compiler-lowered border width remains visible as the measured fallback, and one side can override it — in the box model
  // band, which is the only place a width is written now that the Border ring carries radii and colour instead.
  await runtime.patch({ documentId: 'welcome', expectedVersion: await afterVersion(), actor: 'user', patch: { nodes: { cta: { styles: { 'border-width': '3px' } } } } });
  await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(5, 5);
  await waitUntil(async () => await page.locator('#inspector [data-key="border-t"]').getAttribute('placeholder') === '3', 'the box model reads a declarative width back from the actual page');
  const borderWidths = () => page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate(node => { const cs = getComputedStyle(node); return ['Top', 'Right', 'Bottom', 'Left'].map(side => cs[`border${side}Width`]); });
  await page.locator('#inspector [data-key="border-t"]').fill('2'); await page.keyboard.press('Tab');
  await waitUntil(async () => JSON.stringify(await borderWidths()) === JSON.stringify(['2px', '3px', '3px', '3px']), 'one side changes without changing its peers');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), 'border-r', 'Tab walks the box model edges');
  await page.locator('#inspector [data-key="border-r"]').fill('4'); await page.keyboard.press('Tab');
  await waitUntil(async () => JSON.stringify(await borderWidths()) === JSON.stringify(['2px', '4px', '3px', '3px']), 'a second side takes its own width');
  assert.equal(await page.locator('#inspector [data-key^="border-width-"]').count(), 0, 'no second copy of a width appeared while editing');
  // Inside the ring the reading order is geometry: one radius per corner, then the middle (the colour and its side), then the one
  // radius for all four — so the stop after the bottom-right corner is the colour, not a width.
  await page.locator('#inspector [data-key="radius-br"]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.br-centre') !== null), true, 'after the last corner comes the colour in the middle');
  const beforeClear = await afterVersion();
  // The side is its own utility, so clearing it removes that side's authored width; the measured width stays as the placeholder.
  // The first side edit expanded the declared shorthand into four sides, so clearing one side removes exactly that width.
  await waitUntil(async () => {
    await page.locator('#inspector [data-key="border-t"]').fill(''); await page.keyboard.press('Tab');
    return JSON.stringify(await borderWidths()) === JSON.stringify(['0px', '4px', '3px', '3px']);
  }, 'clearing the box model field removes that side\'s width and leaves its peers');
  await waitUntil(async () => {
    await page.locator('#inspector [data-key="border-t"]').fill('2'); await page.keyboard.press('Tab');
    return (await page.locator('#inspector [data-key="border-t"]').inputValue()) === '2';
  }, 'and the same single field restores it');
  assert.ok(await afterVersion() > beforeClear, 'the clear and the restore are real content commits');
  assert.deepEqual(await borderWidths(), ['2px', '4px', '3px', '3px'], 'clearing does not change unrelated border sides');
  checks.push('a border width is written in the box model band only: one home, one commit per edit, and the ring holds radii and colour');

  // Each line is chosen from whatever menu is open at that moment: a re-render can close the picker between opening and
  // choosing, so the open and the choice are retried together until the page really shows the style.
  const showsStyle = line => page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate((node, line) => { const cs = getComputedStyle(node); return ['Top', 'Right', 'Bottom', 'Left'].every(side => cs[`border${side}Style`] === line.toLowerCase()); }, line);
  for (const line of ['Dashed', 'Dotted', 'Double', 'Groove', 'Ridge', 'Inset', 'Outset', 'None', 'Hidden', 'Solid']) {
    await waitUntil(async () => {
      const item = page.locator('.menu .menu-item', { hasText: new RegExp(`^${line}$`) });
      if (!(await item.count())) await page.locator('#inspector [data-key="pick:Style"]').click().catch(() => {});
      await item.first().click({ timeout: 1200 }).catch(() => {});
      return showsStyle(line);
    }, `${line} reaches every actual border side`);
  }
  assert.deepEqual(await borderWidths(), ['2px', '4px', '3px', '3px'], 'hiding and showing the border preserves authored widths');
  await page.locator('#inspector [data-key="stroke"]').fill('#cc3344'); await page.keyboard.press('Enter');
  await waitUntil(async () => await page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate(node => getComputedStyle(node).borderTopColor === 'rgb(204, 51, 68)'), 'Border color reaches the actual page');
  checks.push('Border styles change all four sides without dropping widths; its colour field changes the actual border');
  await page.locator('#inspector [data-key="pick:Weight"]').click();
  await page.locator('.menu .menu-item', { hasText: 'Extra bold 800' }).click();
  await waitUntil(() => classesOf('cta').includes('font-extrabold'), 'a long weight option can still be selected');
  // Resolve and measure the live control in one browser task; an ElementHandle can detach during inspector repaint.
  const weightGeometry = await page.waitForFunction(() => {
    const node = document.querySelector('#inspector [data-key="pick:Weight"] .pick-v');
    if (!node?.isConnected || node.textContent !== 'Extra bold 800') return null;
    const lineHeight = parseFloat(getComputedStyle(node).lineHeight);
    if (!node.getClientRects().length || !Number.isFinite(lineHeight)) return null;
    return { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, clientHeight: node.clientHeight, lineHeight };
  });
  const weightSize = await weightGeometry.jsonValue(); await weightGeometry.dispose();
  assert.equal(weightSize.scrollWidth <= weightSize.clientWidth + 1 && weightSize.clientHeight <= weightSize.lineHeight + 1, true, 'long selector values stay whole on one line');
  await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('welcome', []));
  await page.locator('#inspector [data-key="width"]').waitFor();
  // The panel redraws from the node view to the artboard view: measure the grid once it has settled there.
  const dimensions = await waitUntil(() => page.locator('#inspector .geometry-grid').evaluate(node => {
    const boxes = [...node.querySelectorAll('.num')].map(field => field.getBoundingClientRect());
    if (boxes.length < 4) return null;
    const context = document.createElement('canvas').getContext('2d');
    const readable = [...node.querySelectorAll('input')].every(input => {
      const style = getComputedStyle(input);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const sample = ['x', 'y'].includes(input.dataset.key) ? '-10000000' : '16384';
      return context.measureText(sample).width <= input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 1;
    });
    const paired = Math.abs(boxes[0].top - boxes[1].top) < 1 && Math.abs(boxes[2].top - boxes[3].top) < 1 && boxes[2].top > boxes[0].top;
    return paired && readable ? { paired, readable } : null;
  }).catch(() => null), 'the artboard geometry grid settles into two readable columns');
  assert.deepEqual(dimensions, { paired: true, readable: true }, 'artboard dimensions use two readable columns at minimum panel width');
  await select('cta');
  await page.locator('#inspector [data-key="radius-tl"]').waitFor();
  checks.push('minimum-width resizing keeps the corner radius and artboard dimensions readable, border widths are linked between Border and Spacing and long dropdown values remain on one line');

  // A picker drag reaches the page while the dialog is still open, and the whole drag stays one Undo step.
  const beforeDrag = classesOf('cta');
  const swatch = page.locator('#inspector [data-key="fill-swatch"]');
  const pageFill = () => page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate(node => getComputedStyle(node).backgroundColor);
  const pick = value => swatch.evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await pick('#aa3322');
  await waitUntil(async () => await pageFill() === 'rgb(170, 51, 34)', 'the page follows the picker before the dialog closes');
  await pick('#aa5522');
  await waitUntil(async () => await pageFill() === 'rgb(170, 85, 34)', 'a second move reaches the page too');
  await swatch.evaluate(node => node.dispatchEvent(new Event('change', { bubbles: true })));
  await waitUntil(() => classesOf('cta').includes('bg-[#aa5522]'), 'closing the picker keeps the colour it left on');
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Control+z');
  await waitUntil(async () => JSON.stringify(classesOf('cta')) === JSON.stringify(beforeDrag) && await pageFill() !== 'rgb(170, 85, 34)', 'one Undo reverts the whole picker drag');
  checks.push('a colour picker drag paints the page before the dialog closes and stays one Undo step');

  // The colour name is the field's label, not a scrub handle: a drag on it writes nothing, a click opens the picker.
  const colourLabel = page.locator('#inspector .appearance-colors .color-field').first().locator('.vf-k');
  // A re-render can detach the label between resolution and read, where a detached node reports no computed style.
  await waitUntil(async () => await colourLabel.evaluate(node => getComputedStyle(node).cursor).catch(() => '') === 'pointer', 'the colour name advertises a click, not a scrub');
  const labelVersion = await afterVersion();
  const labelBox = await waitUntil(async () => await colourLabel.boundingBox(), 'the colour label is attached and visible');
  await page.mouse.move(labelBox.x + labelBox.width / 2, labelBox.y + labelBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(labelBox.x + labelBox.width / 2 + 60, labelBox.y + labelBox.height / 2, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
  assert.equal(await afterVersion(), labelVersion, 'dragging the colour name writes nothing');
  await page.evaluate(() => { document.querySelector('#inspector [data-key="fill-swatch"]').showPicker = () => { window.__pickerOpened = true; }; });
  await colourLabel.click();
  assert.equal(await page.evaluate(() => window.__pickerOpened === true), true, 'clicking the colour name opens the same picker as its swatch');
  const scrubCursor = await page.locator('#inspector [data-section="effects"] .vf-k').first().evaluate(node => getComputedStyle(node).cursor);
  assert.equal(scrubCursor, 'ew-resize', 'a numeric label still carries the scrub gesture');
  checks.push('a colour name opens the picker instead of scrubbing, while numeric labels keep their drag');

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

  // A hand-authored `text-[12.5px]` is a size, not a colour: the size field reads it and the colour field stays empty.
  await select('cta');
  await runtime.patch({ documentId: 'welcome', expectedVersion: await afterVersion(), actor: 'user', patch: { nodes: { cta: { className: `${classesOf('cta').filter(name => !/^text-/.test(name)).join(' ')} text-[12.5px]` } } } });
  await waitUntil(async () => (await page.locator('#inspector [data-key="font-size"]').inputValue()) === '12.5', 'an unhinted text bracket reads as the font size');
  assert.equal(await page.locator('#inspector [data-section="appearance"] [data-key="ink"]').inputValue(), '', 'and never as the text colour');
  checks.push('a size is chosen once: `text-[12.5px]` reads into the size control, not into the colour control');

  // Line height sits beside the size and the weight: a multiple, a px step, and one undo.
  await select('cta');
  await page.locator('#inspector [data-key="line-height"]').fill('24px'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('leading-6'), '24px writes the scale utility');
  await page.locator('#inspector [data-key="line-height"]').fill('1.4'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('leading-[1.4]') && !classesOf('cta').includes('leading-6'), 'a multiple replaces the step');
  await waitUntil(async () => (await page.locator('#inspector [data-key="line-height"]').inputValue()) === '1.4', 'the control reads the authored multiple back');
  await page.keyboard.press('Control+z');
  await waitUntil(() => classesOf('cta').includes('leading-6') && !classesOf('cta').includes('leading-[1.4]'), 'one undo returns the previous line height');
  await page.locator('#inspector [data-key="line-height"]').fill(''); await page.keyboard.press('Enter');
  await waitUntil(() => !classesOf('cta').some(name => /^leading-/.test(name)), 'an empty line height removes it');
  checks.push('line height: a multiple, a px step that lowers to the scale, readback, removal and one undo');

  // The unit beside the line height is a menu, not a caption: one value, spelled the way the author wants it. `%`, `em` and a
  // multiple all measure the element's own font size, so switching rewrites only the spelling — and px converts against it.
  const lhUnit = () => page.locator('#inspector [data-key="unit:line-height"]');
  await waitUntil(async () => (await lhUnit().innerText()) === '%', 'an unset line height opens on percent');
  await page.locator('#inspector [data-key="line-height"]').fill('1.5'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('leading-[1.5]'), 'a small bare number stays the multiple it reads as');
  await page.locator('#inspector [data-key="line-height"]').fill('150'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('leading-[150%]'), 'a bare 150 is a percent written without its sign');
  await waitUntil(async () => (await lhUnit().innerText()) === '%', 'the button names the written unit');
  await page.locator('#inspector [data-key="line-height"]').fill('24px'); await page.keyboard.press('Enter');
  await waitUntil(async () => (await lhUnit().innerText()) === 'px' && classesOf('cta').includes('leading-6'), 'the button follows a px step');
  await lhUnit().click();
  await page.waitForSelector('.menu[aria-label="Unit"] .menu-item');
  const unitChoices = await page.locator('.menu[aria-label="Unit"] .menu-item').allInnerTexts();
  assert.deepEqual(unitChoices, ['Percent %', 'Pixels px', 'Em em', 'Multiple ×'], 'every spelling is offered');
  await page.locator('.menu[aria-label="Unit"] .menu-item', { hasText: 'Percent %' }).click();
  // The cta author wrote `text-[12.5px]`, so its 24px line height is 192% of its own font size — the conversion is measured,
  // not a fixed ratio.
  await waitUntil(() => classesOf('cta').includes('leading-[192%]'), '24px rewrites as the percent it is for this font size');
  await waitUntil(async () => (await lhUnit().innerText()) === '%', 'and the button follows the rewrite');
  await waitUntil(async () => (await page.locator('#inspector [data-key="line-height"]').inputValue()) === '192', 'with the number converted, not the unit swapped on the same number');
  await page.keyboard.press('Control+z');
  await waitUntil(() => classesOf('cta').includes('leading-6') && !classesOf('cta').includes('leading-[192%]'), 'one undo returns the px spelling');
  checks.push('the line height unit is a menu that rewrites one value as %, px, em or a multiple, with one undo step');

  // Radius: a bare number, px/rem/em/%, full, and empty — all from one corner's own field in the ring. The element starts on
  // `rounded-xl` for all four corners, so editing one corner splits the shorthand and leaves the other three alone.
  await select('cta');
  await page.locator('#inspector [data-key="radius-tl"]').fill('8'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('rounded-tl-lg') && classesOf('cta').includes('rounded-tr-xl'), 'a bare number reads as px and leaves the other corners');
  await page.locator('#inspector [data-key="radius-tl"]').fill('1.5rem'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('rounded-tl-[1.5rem]') && !classesOf('cta').includes('rounded-tl-lg'), 'rem is kept as written and replaces the previous corner radius');
  await page.locator('#inspector [data-key="radius-tl"]').fill('50%'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('rounded-tl-full'), 'half a percent radius is the pill on that corner');
  await page.locator('#inspector [data-key="radius-tl"]').fill('25%'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('rounded-tl-[25%]'), 'another percentage is kept as written');
  await page.locator('#inspector [data-key="radius-tl"]').fill('2em'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('rounded-tl-[2em]'), 'em is kept as written');
  await page.locator('#inspector [data-key="radius-tl"]').fill('10'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('rounded-tl-[10px]') && !classesOf('cta').some(name => /^rounded-tl-\[/.test(name) && name !== 'rounded-tl-[10px]'), 'a typed number sets an arbitrary radius and replaces the previous one');
  assert.deepEqual(await borderWidths(), ['2px', '4px', '3px', '3px'], 'changing radius does not change border widths');
  await page.locator('#inspector [data-key="radius-tl"]').fill('full'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('rounded-tl-full'), 'typing Full sets the full corner');
  await page.locator('#inspector [data-key="radius-tl"]').fill(''); await page.keyboard.press('Enter');
  await waitUntil(() => !classesOf('cta').some(name => /^rounded-tl/.test(name)), 'an empty radius removes that corner');
  // The panel redraws after the commit: the field shows the new state a moment later, so wait for it instead of reading once.
  await waitUntil(async () => (await page.locator('#inspector [data-key="radius-tl"]').inputValue()) === '', `the field is empty once no class sets the corner (${classesOf('cta').join(' ')})`);
  // The empty field quotes the radius the page really has now, not the pill's measurement from the render before the removal.
  const realRadius = await page.locator('iframe[data-document-id="welcome"]').contentFrame().locator('[data-divlet-id="cta"]').evaluate(node => String(Math.round(parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0)));
  await waitUntil(async () => (await page.locator('#inspector [data-key="radius-tl"]').getAttribute('placeholder')) === realRadius, `the placeholder is the radius the page has (${await page.locator('#inspector [data-key="radius-tl"]').getAttribute('placeholder')} vs ${realRadius})`);
  checks.push('a corner radius: a bare number, px/rem/em/%, Full, its own corner only, and removal');
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
  const untouched = await afterVersion();
  await scrub('z', 0);
  assert.equal(await afterVersion(), untouched, 'a label click preserves implicit auto without an edit');
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
    const before = await afterVersion(); await scrub('z', 30, { cancel }); await sleep(180);
    assert.equal(await afterVersion(), before, `${cancel} cancels without writing or adding an undo step`);
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
  await page.locator('#inspector [data-key="radius-tr"]').fill('9'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('nav').includes('rounded-tr-[9px]') && classesOf('cta').includes('rounded-tr-[9px]'), `one corner edit applies to every selected element (nav ${classesOf('nav').join(' ')}, cta ${classesOf('cta').join(' ')})`);
  checks.push('one Appearance edit applies to several selected elements');
  await scrub('z', 6);
  await waitUntil(() => classesOf('nav').includes('z-2') && classesOf('cta').includes('z-2'), 'a mixed z-index scrub applies one integer to every selected element');

  // Centring a container that is not flex yet. Its row, and the Self row under it, share one label column: the two labels
  // end where the controls begin, and the centring choices fill the width the label leaves them.
  const doc = runtime.read({ view: 'document', documentId: 'welcome' });
  const plain = Object.keys(doc.nodes).find(id => doc.nodes[id].type === 'element' && !/\b(flex|grid)\b/.test(doc.nodes[id].className || '') && id !== doc.rootId && id !== 'cta' && (doc.nodes[id].children || []).length);
  await select(plain);
  {
    const labels = await waitUntil(() => page.evaluate(() => {
      const rows = [...document.querySelectorAll('#inspector .layout-box .row-labeled')];
      if (rows.length < 2) return null;
      const read = node => {
        const label = node.querySelector(':scope > .caption, :scope > .vf-k').getBoundingClientRect();
        const control = node.querySelector(':scope > :not(.caption):not(.vf-k)').getBoundingClientRect();
        return { label: node.textContent.trim().slice(0, 8), right: Math.round(label.right), left: Math.round(control.left), width: Math.round(control.width) };
      };
      const box = document.querySelector('#inspector .layout-box').getBoundingClientRect();
      return { rows: rows.map(read), box: { left: Math.round(box.left), right: Math.round(box.right) } };
    }), 'both labelled Layout rows are rendered');
    const [centre, self] = labels.rows;
    assert.deepEqual(new Set(labels.rows.map(row => row.left)).size, 1, `every labelled row starts its control on one line (${labels.rows.map(row => `${row.label}:${row.left}`).join(' ')})`);
    assert.ok(labels.rows.every(row => row.right <= row.left), 'a label column is never wider than the control that follows it');
    assert.ok(centre.width > labels.box.right - labels.box.left - 90, `the centring choices fill the width the label leaves (${centre.width} of ${labels.box.right - labels.box.left})`);
    assert.ok(self.width < centre.width, 'and a natural-width control is left at its own size beside it');
  }
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
      // The band copy keeps its eight values inside its own frame at every size, and its cut middle never swallows one of them.
      const ring = section.querySelector('.br-box');
      if (!ring) bad.push('the copy is missing');
      else {
        const frame = ring.getBoundingClientRect(), hole = ring.querySelector('.br-hole').getBoundingClientRect();
        for (const field of ring.querySelectorAll('.br-cell')) {
          const box = field.getBoundingClientRect();
          if (box.left < frame.left - 1 || box.right > frame.right + 1 || box.top < frame.top - 1 || box.bottom > frame.bottom + 1) bad.push(`${field.className.slice(-8)} leaves the copy`);
          const inside = box.left >= hole.left - 1 && box.right <= hole.right + 1 && box.top >= hole.top - 1 && box.bottom <= hole.bottom + 1;
          if (inside) bad.push(`${field.className.slice(-8)} sits in the cut middle`);
        }
      }
      for (const input of section.querySelectorAll('.vf-input')) {
        const style = getComputedStyle(input); context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        if (context.measureText(input.value || input.placeholder).width > input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 1) bad.push(`${input.dataset.key} clips`);
      }
      return bad;
    });
    assert.deepEqual(layoutErrors, [], `Border controls at ${width}px/${size}%`);
    await colorRow(`${width}px/${size}%, authored colors and project swatches`);
    await colorFieldRows(`${width}px/${size}%, border and appearance colours`);
    await page.locator('#inspector .appearance-colors').screenshot({ path: `artifacts/appearance-colors-${width}-${size}.png` });
    assert.equal(await textAlign.evaluate(group => group.scrollWidth <= group.clientWidth + 1 && group.closest('.appearance-box') !== null), true, `typography alignment remains together at ${width}px/${size}%`);
    if (size === 200) {
      await textAlign.getByRole('button', { name: 'Justify', exact: true }).click({ trial: true });
      await page.locator('#inspector').screenshot({ path: 'artifacts/text-alignment-appearance-phone-200.png' });
    }
    if (size === 100) await page.locator('#inspector [data-section="border"]').screenshot({ path: `artifacts/border-section-${width}-${size}.png` });
  }
  checks.push('Border stays readable; every colour control keeps label, swatch, value and clear on one line, Fill/Text pair while two such fields fit and no control overflows on desktop, phone and phone/200%');

  await page.evaluate(async () => (await import('./lib/help.js')).setUiSize(200));
  await select('cta'); await effect('z').waitFor();
  await typeZ('auto'); await scrub('z', 6);
  await waitUntil(() => classesOf('cta').includes('z-2'), 'z-index scrubbing works at 200% interface size');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(async () => (await import('./lib/help.js')).setUiSize(100));
  await inlineCase(runtime, 'welcome', 'cta', { utilities: true });
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
  await colorRow('no style engine or project swatches');
  assert.equal(await page.locator('#inspector [data-section="classes"]').count(), 0);
  await page.locator('#inspector [data-key="line-height"]').fill('1.6'); await page.keyboard.press('Enter');
  await waitUntil(() => native.getEntry('plain').document.nodes.first.style['line-height'] === '1.6', 'line height is a native declaration with no engine');
  await page.locator('#inspector [data-key="line-height"]').fill('150'); await page.keyboard.press('Enter');
  await waitUntil(() => native.getEntry('plain').document.nodes.first.style['line-height'] === '150%', 'a bare 150 is a percent in plain CSS too');
  await waitUntil(async () => (await page.locator('#inspector [data-key="unit:line-height"]').innerText()) === '%', 'and the unit button reads it back as the percent it wrote');
  await family.click(); await page.getByRole('menuitemradio', { name: '"No Engine Face"', exact: true }).click();
  await waitUntil(() => native.getEntry('plain').document.nodes.first.style['font-family'] === '"No Engine Face"', 'family edits have no engine requirement');
  await waitUntil(() => page.locator('iframe[data-document-id="plain"]').contentFrame().locator('#first').evaluate(node => Math.round(node.getBoundingClientRect().width) === 120), 'stored face actually renders with no style engine');
  const nativeCss = native.settings.css, nativeVersion = native.getEntry('plain').document.version;
  await page.locator('iframe[data-document-id="plain"]').evaluate(node => { node.dataset.uploadLifetime = 'retained'; });
  assert.ok((await page.locator('.font-family-control input[type="file"]').getAttribute('accept')).includes('.woff'));
  await deviceUpload(woffBytes(fontBytes(900, { family: 'Device Font', axes: [['wght', 100, 400, 900]] })), 'device.woff');
  await waitUntil(() => native.settings.css.includes('Device Font'), 'device font registers with no style engine');
  assert.match(native.settings.css, /font-weight:100 900/, 'variable weight range is registered, not flattened to its default');
  assert.equal(native.getEntry('plain').document.version, nativeVersion, 'upload registers a project face, not a hidden selected-node edit');
  await deviceUpload(woffBytes(fontBytes(1200, { family: 'Device Font', italic: true, subfamily: 'Italic' })), 'device-italic.woff');
  await waitUntil(() => native.settings.css.includes('device-italic.woff'), 'static italic and normal variable-range faces are disjoint companions without a provider');
  const italicMetric = await page.locator('iframe[data-document-id="plain"]').contentFrame().locator('body').evaluate(async node => {
    const doc = node.ownerDocument; await doc.fonts.load('italic 400 100px "Device Font"', 'AA');
    const text = doc.createElement('span'); text.textContent = 'AA'; text.style.cssText = 'display:inline-block;font-family:"Device Font";font-size:100px;font-weight:400;font-style:italic;font-synthesis:none';
    doc.body.append(text); const width = Math.round(text.getBoundingClientRect().width); text.remove(); return width;
  });
  assert.equal(italicMetric, 240);
  await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('plain', ['first', 'second']));
  await family.click(); await page.getByRole('menuitemradio', { name: '"Device Font"', exact: true }).click();
  await waitUntil(() => ['first', 'second'].every(id => native.getEntry('plain').document.nodes[id].style['font-family'] === '"Device Font"'), 'one mixed selection shares one uploaded resource');
  await waitUntil(() => page.locator('iframe[data-document-id="plain"]').contentFrame().locator('#first').evaluate(node => Math.round(node.getBoundingClientRect().width) === 180), 'uploaded device bytes, not the previous face or fallback, render in the real preview');
  assert.equal(Object.keys(native.settings.assets.fonts).filter(name => name.startsWith('device')).length, 2, 'two distinct faces are stored once each, not once per selected node');
  assert.equal(await page.locator('iframe[data-document-id="plain"]').getAttribute('data-upload-lifetime'), 'retained');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Upload font', exact: true }).click({ trial: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await native.undo(); await native.undo(); await native.undo();
  await waitUntil(() => native.settings.css === nativeCss, 'one registration Undo removes its bytes and CSS together');
  assert.equal(native.settings.assets.fonts['device.woff'], undefined);
  await native.redo(); await native.redo(); await waitUntil(() => native.settings.css.includes('Device Font'), 'registration Redo restores the same shared bytes and face');
  await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('plain', ['first']));
  const unsupportedState = { revision: native.revision, css: native.settings.css, assets: structuredClone(native.settings.assets), history: native.readHistory() };
  let unsupportedPosts = 0;
  const countUnsupported = request => { if (new URL(request.url()).pathname.endsWith('/api/fonts')) unsupportedPosts++; };
  page.on('request', countUnsupported);
  await deviceUpload(woff2Bytes(), 'unsupported.woff2');
  await waitUntil(() => page.locator('#toast').innerText().then(text => text.includes('WOFF2')), 'a real browser-decodable WOFF2 still refuses at metadata admission');
  page.off('request', countUnsupported);
  assert.equal(unsupportedPosts, 1, 'browser decoding succeeded before the writer refused the unsupported container');
  assert.deepEqual({ revision: native.revision, css: native.settings.css, assets: native.settings.assets, history: native.readHistory() }, unsupportedState);
  await waitUntil(() => page.getByRole('button', { name: 'Upload font', exact: true }).isEnabled(), 'unsupported container refusal releases the existing operation guard');
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
  await settleInspector(page);
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
  // A selected element's accepted edit is followed by a burst of measurement-driven inspector redraws; measure and focus after they settle.
  await settleInspector(page);
  const geometry = await page.evaluate(() => { const button = document.querySelector('#inspector [data-key="font-family"]'), box = button.parentElement; return { fieldWidth: box.clientWidth, contentsWidth: box.scrollWidth, inspectorWidth: document.querySelector('#inspector').clientWidth, text: button.querySelector('.pick-v').textContent, nowrap: getComputedStyle(button.querySelector('.pick-v')).whiteSpace }; });
  assert.equal(geometry.text, longFamily);
  assert.equal(geometry.nowrap, 'nowrap');
  assert.ok(geometry.fieldWidth <= geometry.inspectorWidth && geometry.contentsWidth > geometry.fieldWidth, 'only the overlong whole control pans, not the inspector');
  // A shared label column is a layout measurement in a painted, scaled interface: a rect would ask for twice the room
  // at 200% and squeeze every control beside it.
  const labels = await page.evaluate(() => {
    const group = document.querySelector('#inspector .label-group');
    const nodes = group ? [...group.querySelectorAll(':scope > .row-labeled > .caption, :scope > .row-labeled > .vf-k')] : [];
    return { column: group ? Number.parseFloat(getComputedStyle(group).getPropertyValue('--label-col')) : null, widths: nodes.map(node => ({ layout: node.offsetWidth, painted: Math.round(node.getBoundingClientRect().width) })) };
  });
  const widestLabel = Math.max(0, ...labels.widths.map(label => label.layout));
  assert.ok(widestLabel > 0, `the element inspector has a shared label column at phone/200%: ${JSON.stringify(labels)}`);
  assert.ok(labels.column >= widestLabel && labels.column <= widestLabel + 2, `the label column is measured in layout pixels: ${JSON.stringify(labels)}`);
  assert.ok(Math.max(...labels.widths.map(label => label.painted)) > widestLabel + 2, `at 200% the painted label is wider than the column it asked for: ${JSON.stringify(labels)}`);
  const beforePan = native.getEntry('plain').document.version;
  // A late measurement redraw may replace the control between focus and key; each attempt targets the live element.
  await waitUntil(async () => {
    await page.locator('.font-family-scroll').evaluate(node => { node.scrollLeft = 0; });
    await page.locator('.font-family-scroll').focus(); await page.keyboard.press('ArrowRight');
    return page.locator('.font-family-scroll').evaluate(node => node.scrollLeft > 0);
  }, 'long values are keyboard-scrollable, not ellipsized or reduced');
  assert.equal(native.getEntry('plain').document.version, beforePan, 'panning a value never invokes canvas nudge shortcuts');
  await family.click({ trial: true });
  await mkdir('artifacts', { recursive: true });
  const uploadBox = await page.getByRole('button', { name: 'Upload font', exact: true }).boundingBox(), inspectorBox = await page.locator('#inspector').boundingBox();
  assert.ok(uploadBox.width >= 48 && uploadBox.height >= 48 && uploadBox.x >= inspectorBox.x && uploadBox.x + uploadBox.width <= inspectorBox.x + inspectorBox.width + 1, 'small upload target remains whole and usable at phone/200%');
  await page.getByRole('button', { name: 'Upload font', exact: true }).click({ trial: true });
  await colorRow('no style engine, phone/200%');
  await page.locator('#inspector').screenshot({ path: 'artifacts/font-family-no-engine-phone-200.png' });
  checks.push('provider-free native family choice and real embedded face loading, narrow/200% whole-value keyboard panning');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(async () => (await import('./lib/help.js')).setUiSize(100));
  await inlineCase(native, 'plain', 'first');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser?.close(); await native?.close(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
