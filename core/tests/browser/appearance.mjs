// Appearance in the inspector: corner radius, fill and text colour, and one-click centring.
import assert from 'node:assert/strict';
import { legacyProject } from '../fixtures/legacy-project.js';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../lib/runtime.js';

const playwright = await import('playwright');
const root = fileURLToPath(new URL('../../../', import.meta.url));
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
  const select = id => page.evaluate(async id => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', [id]); }, id);
  const afterVersion = () => runtime.read({ view: 'document', documentId: 'welcome' }).version;

  // A project colour exists: it shows up as a swatch.
  await runtime.patch({ documentId: 'welcome', expectedVersion: afterVersion(), actor: 'user', patch: { tokens: { '--color-brand': '#5b5bf0' } } });
  await select('cta');
  await page.waitForSelector('#inspector [data-section="appearance"] [data-key="fill"]');
  checks.push('the inspector has an Appearance fold with radius, fill and text colour');

  // Use the real resize control, not an artificial viewport breakpoint: the desktop floor is 280px.
  const handle = page.locator('.resize-handle[data-panel="inspector"]');
  const edge = await handle.boundingBox();
  await page.mouse.move(edge.x + 4, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + 240, edge.y + edge.height / 2, { steps: 6 });
  await page.mouse.up();
  await waitUntil(() => page.locator('#inspector').evaluate(node => Math.round(node.getBoundingClientRect().width) === 280), 'the inspector reaches its actual resize minimum');
  const shape = await page.locator('#inspector .appearance-geometry').evaluate(node => {
    const radius = node.querySelector('[data-key="radius"]').closest('.vf').getBoundingClientRect();
    const border = node.querySelector('[data-key="border-width"]').closest('.vf').getBoundingClientRect();
    return { sameRow: Math.abs(radius.top - border.top) < 1, sideBySide: radius.right < border.left, halfWidth: radius.width < node.clientWidth * 0.55 && border.width < node.clientWidth * 0.55 };
  });
  assert.deepEqual(shape, { sameRow: true, sideBySide: true, halfWidth: true }, 'radius and border width stay adjacent at the minimum');
  await page.locator('#inspector [data-key="radius"]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#inspector [data-key="border-width"]').evaluate(node => document.activeElement === node), true, 'Tab follows the paired fields before their optional presets');
  await page.locator('#inspector [data-key="border-width"]').fill('2'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('cta').includes('border-2'), 'the adjacent border field edits its own property');
  await page.locator('#inspector [data-key="pick:Weight"]').click();
  await page.locator('.menu .menu-item', { hasText: 'Extra bold 800' }).click();
  await waitUntil(() => classesOf('cta').includes('font-extrabold'), 'a long weight option can still be selected');
  assert.equal(await page.locator('#inspector [data-key="pick:Weight"] .pick-v').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'long selector values wrap inside their own control');
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
  checks.push('real minimum-width resizing keeps radius/border and artboard dimensions in readable pairs, including long dropdown values');

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
  assert.ok(classesOf('cta').includes('border-2'), 'changing radius does not change the adjacent border value');
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

  // Several selected elements share one Appearance edit.
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['nav', 'cta']); });
  await waitUntil(() => page.evaluate(async () => (await import('./lib/store.js')).store.node?.nodeIds?.length === 2), 'both elements are selected');
  await waitUntil(async () => /2\s*elements selected/.test(await page.locator('#inspector').innerText()), 'the inspector shows two selected elements');
  await page.locator('#inspector [data-key="radius"]').fill('9'); await page.keyboard.press('Enter');
  await waitUntil(() => classesOf('nav').includes('rounded-[9px]') && classesOf('cta').includes('rounded-[9px]'), `one radius edit applies to every selected element (nav ${classesOf('nav').join(' ')}, cta ${classesOf('cta').join(' ')})`);
  checks.push('one Appearance edit applies to several selected elements');

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

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser?.close(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
