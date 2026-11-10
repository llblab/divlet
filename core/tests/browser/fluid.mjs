// Fluid layout: at phone width and at 200% interface size nothing overflows sideways, and values (keys, counts, times, tags)
// keep the width of their text instead of being squashed or wrapped.
import assert from 'node:assert/strict';
import { legacyProject } from '../fixtures/legacy-project.js';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../lib/runtime.js';

const playwright = await import('playwright');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-fluid-'));
await cp(path.join(root, 'examples', 'studio'), cwd, { recursive: true });
await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
const runtime = await openRuntime({ cwd, watch: false });
const activityText = 'Adding orange accents and replacing the hero mockup with a real historical screenshot';
runtime.setAgent({ connected: true, busy: true, activity: activityText });
// The busy transition owns its initial timestamp; set the elapsed fixture only after that transition.
runtime.setAgent({ since: new Date(Date.now() - 113000).toISOString() });
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const errors = [], checks = [];
let browser;
try {
  browser = await playwright.chromium.launch(launch);
  for (const [width, size] of [[390, 100], [390, 200], [820, 100], [1500, 100]]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    if (width >= 820) await context.addInitScript(value => { if (window.top === window) localStorage.setItem('divlet:width:sidebar', String(value)); }, width === 820 ? 240 : 480);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(runtime.url); await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
    await page.evaluate(async size => { (await import('./lib/help.js')).setUiSize(size); const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['nav']); }, size);
    const readableNumbers = label => page.evaluate(label => {
      const context = document.createElement('canvas').getContext('2d');
      return [...document.querySelectorAll('#inspector .num-input, #inspector .vf-input:not(.color-hex)')].flatMap(input => {
        if (!input.getBoundingClientRect().width) return [];
        const text = input.value || input.placeholder;
        const style = getComputedStyle(input);
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const needed = context.measureText(text).width;
        const available = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return needed > available + 1 ? [`${label}: ${input.dataset.key} clips ${JSON.stringify(text)} (${needed.toFixed(1)}px > ${available.toFixed(1)}px)`] : [];
      });
    }, label);
    await page.locator('#inspector [data-key="opacity"]').waitFor();
    assert.deepEqual(await readableNumbers(`${width}px@${size}% element`), []);
    const compactShape = await page.evaluate(() => {
      const node = document.querySelector('#inspector .appearance-geometry');
      const radius = node.querySelector('[data-key="radius"]'), border = node.querySelector('[data-key="border-width"]');
      const a = radius.closest('.vf').getBoundingClientRect(), b = border.closest('.vf').getBoundingClientRect();
      const context = document.createElement('canvas').getContext('2d');
      const readable = [[radius, 'Full'], [border, '64']].every(([input, text]) => {
        const style = getComputedStyle(input);
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return context.measureText(text).width <= input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 1;
      });
      return { paired: Math.abs(a.top - b.top) < 1 && a.right < b.left, readable, diagnostic: { radius: { x: a.x, y: a.y, w: a.width }, border: { x: b.x, y: b.y, w: b.width }, columns: getComputedStyle(node).gridTemplateColumns, open: node.closest('details').open } };
    });
    assert.deepEqual({ paired: compactShape.paired, readable: compactShape.readable }, { paired: true, readable: true }, `compact radius/border pair at ${width}px/${size}%: ${JSON.stringify(compactShape.diagnostic)}`);
    const spacingCollisions = await page.locator('#inspector .boxmodel').evaluate(model => {
      const fields = [...model.querySelectorAll('.bm-field')].map(node => node.getBoundingClientRect());
      const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
      const bad = [];
      for (let a = 0; a < fields.length; a++) for (let b = a + 1; b < fields.length; b++) if (overlaps(fields[a], fields[b])) bad.push(`fields ${a}/${b} overlap`);
      for (const mark of model.querySelectorAll('.bm-mark')) {
        const box = mark.getBoundingClientRect(), band = mark.parentElement.getBoundingClientRect();
        if (box.left < band.left || box.right > band.right || box.top < band.top || box.bottom > band.bottom) bad.push(`${mark.textContent} leaves its band`);
        if (fields.some(field => overlaps(box, field))) bad.push(`${mark.textContent} covers a field`);
      }
      for (const hint of model.querySelectorAll('.bm-side')) if (hint.scrollWidth > hint.clientWidth + 1) bad.push(`${hint.textContent} clips`);
      return bad;
    });
    assert.deepEqual(spacingCollisions, [], `independent spacing targets and corner marks at ${width}px/${size}%`);
    await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('welcome', []));
    await page.locator('#inspector [data-key="width"]').waitFor();
    assert.deepEqual(await readableNumbers(`${width}px@${size}% artboard`), []);
    await page.evaluate(async () => (await import('./lib/store.js')).selectNodes('welcome', ['nav']));
    await page.locator('#inspector [data-key="opacity"]').waitFor();
    const audit = label => page.evaluate(label => {
      const bad = [];
      const roots = ['#sidebar', '#inspector', '#help', '#palette', '#project', '#brand', '#side-tabs', '#dock', '.menu'].map(selector => document.querySelector(selector)).filter(node => node && !node.hidden && node.getClientRects().length);
      for (const rootNode of roots) {
        const box = rootNode.getBoundingClientRect();
        if (rootNode.scrollWidth > rootNode.clientWidth + 1) bad.push(`${label}: ${rootNode.id || rootNode.className} scrolls sideways (${rootNode.scrollWidth} > ${rootNode.clientWidth})`);
        for (const node of rootNode.querySelectorAll('*')) {
          const r = node.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          if (r.right > box.right + 1.5 && getComputedStyle(node).position !== 'fixed') bad.push(`${label}: <${node.localName} class="${String(node.className).slice(0, 30)}"> sticks out of ${rootNode.id || rootNode.className} by ${Math.round(r.right - box.right)}px`);
          if (node.matches('kbd, .badge, .times, .dir-tag, .menu-keys, time') && node.scrollWidth > node.clientWidth + 1) bad.push(`${label}: value <${node.localName}> is clipped`);
        }
      }
      return bad.slice(0, 6);
    }, label);
    const surfaces = {
      inspector: async () => {},
      layers: async () => { await page.locator('#open-layers').click(); },
      history: async () => { await page.locator('#open-history').click(); },
      agent: async () => { await page.locator('#open-agent').click(); },
      shortcuts: async () => { await page.locator('#open-agent').click().catch(() => {}); await page.keyboard.press('Escape'); await page.evaluate(() => document.querySelector('#viewport').focus()); await page.keyboard.press('?'); },
      palette: async () => { await page.keyboard.press('Escape'); await page.keyboard.press('Control+k'); },
    };
    for (const [name, open] of Object.entries(surfaces)) {
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      await open(); await page.waitForTimeout(250);
      if (['layers', 'history', 'agent'].includes(name)) {
        const density = await page.evaluate(async size => { const sidebar = await import('./lib/sidebar.js'), width = document.querySelector('#sidebar').getBoundingClientRect().width / (size / 100); return { expected: width < 265 ? 'tiny' : width < 320 ? 'narrow' : 'wide', actual: document.documentElement.dataset.sidebar, helper: sidebar.widthSize() }; }, size);
        assert.equal(density.actual, density.expected, 'sidebar density uses interface pixels rather than scaled screen pixels');
        assert.equal(density.helper, density.expected);
      }
      const bad = await audit(`${width}px@${size}% ${name}`);
      assert.deepEqual(bad, [], bad.join('\n'));
      await page.evaluate(() => { for (const [id, count] of [['diag-count', '1234'], ['agent-count', '99+']]) { const n = document.getElementById(id); n.hidden = false; n.textContent = count; } });
      const tabIssues = await page.evaluate(() => [...document.querySelectorAll('#side-tabs .tab')].flatMap(tab => {
        const box = tab.getBoundingClientRect(), label = tab.querySelector('.tool-label');
        return [...tab.querySelectorAll('.icon, .tool-label, .badge:not([hidden])')].some(n => { const r = n.getBoundingClientRect(); return r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1; }) || label.scrollWidth > label.clientWidth + 1 ? [label.textContent] : [];
      }));
      assert.deepEqual(tabIssues, [], `whole tab labels at ${width}px/${size}% ${name}`);
      if (name === 'agent') {
        for (const mode of ['board', 'node']) {
          const contextGap = await page.evaluate(async mode => {
            const m = await import('./lib/store.js'); m.selectArtboards(mode === 'board' ? [] : ['welcome']); if (mode === 'node') m.selectNodes('welcome', ['nav']);
            const scope = document.querySelector('.ask-scope'), box = scope.getBoundingClientRect(), input = document.querySelector('.ask-input').getBoundingClientRect();
            const end = Math.max(...[...scope.querySelectorAll('span')].map(n => n.getBoundingClientRect().bottom));
            return { contained: end <= box.bottom + 1, gap: (input.top - end) / (box.width / scope.offsetWidth) };
          }, mode);
          assert.ok(contextGap.contained && contextGap.gap >= 4, `${mode} context stays above the input at ${width}px/${size}%: ${JSON.stringify(contextGap)}`);
        }
        const activity = await page.evaluate(() => {
          const card = document.querySelector('.agent-status'), stop = card.querySelector('.ask-stop'), time = card.querySelector('time'), text = card.querySelector('.agent-status-text');
          const grid = getComputedStyle(card), position = getComputedStyle(stop), b = card.getBoundingClientRect(), s = stop.getBoundingClientRect(), t = text.getBoundingClientRect(), clock = time.getBoundingClientRect();
          const scale = b.width / card.offsetWidth, panel = document.querySelector('#sidebar').getBoundingClientRect();
          return { grid: grid.display, columns: grid.gridTemplateColumns.split(' ').length, rows: grid.gridTemplateRows.split(' ').length, column: position.gridColumnStart, row: position.gridRowStart,
            corner: Math.abs(b.right - s.right - parseFloat(grid.paddingRight) * scale) < 1.5 && Math.abs(b.bottom - s.bottom - parseFloat(grid.paddingBottom) * scale) < 1.5,
            separate: t.bottom <= s.top + 1 && clock.right <= s.left + 1,
            reachable: s.top >= panel.top && s.bottom <= panel.bottom,
            clock: /^\d+:\d{2}$/.test(time.textContent) && time.scrollWidth <= time.clientWidth + 1 };
        });
        assert.deepEqual(activity, { grid: 'grid', columns: 5, rows: 3, column: '5', row: '3', corner: true, separate: true, reachable: true, clock: true }, `activity grid at ${width}px/${size}%`);
        const panelWidth = await page.locator('#sidebar').evaluate(node => node.getBoundingClientRect().width);
        await page.locator('#open-agent').click();
        await page.locator('#agent-status-dock > .agent-status').waitFor();
        const floating = async label => {
          await page.waitForFunction(() => {
            if (!document.documentElement.classList.contains('w720')) return true;
            return document.querySelector('#inspector').getBoundingClientRect().bottom <= document.querySelector('.agent-status').getBoundingClientRect().top + 1;
          });
          const result = await page.evaluate(panelWidth => {
            const card = document.querySelector('.agent-status'), tabs = document.querySelector('#side-tabs'), stop = card.querySelector('.ask-stop'), text = card.querySelector('.agent-status-text');
            const b = card.getBoundingClientRect(), t = tabs.getBoundingClientRect(), s = stop.getBoundingClientRect(), scale = Number.parseFloat(document.documentElement.style.getPropertyValue('--ui')) || 1;
            const hit = document.elementFromPoint(s.x + s.width / 2, s.y + s.height / 2);
            return {
              width: Math.abs(b.width - panelWidth) < 1 && Math.abs(b.width - t.width) < 1 && Math.abs(b.left - t.left) < 1,
              above: b.bottom <= t.top && t.top - b.bottom <= 10 * scale,
              viewport: b.top >= 0 && b.left >= 0 && b.right <= innerWidth + 1 && b.bottom <= innerHeight,
              stop: s.top >= b.top && s.bottom <= b.bottom && s.left >= b.left && s.right <= b.right && !!hit?.closest('.ask-stop'),
              one: document.querySelectorAll('.agent-status').length === 1 && document.querySelectorAll('.ask-stop').length === 1,
              wrap: text.scrollWidth <= text.clientWidth + 1,
            };
          }, panelWidth);
          assert.deepEqual(result, { width: true, above: true, viewport: true, stop: true, one: true, wrap: true }, `${label}: floating activity at ${width}px/${size}%`);
        };
        await floating('normal');
        await page.evaluate(async () => (await import('./lib/canvas.js')).openExpanded('welcome'));
        assert.equal(await page.locator('#sidebar-foot').isVisible(), false, 'expanded browsing hides the whole footer, including activity');
        await page.evaluate(async () => (await import('./lib/canvas.js')).closeExpanded());
        await floating('return from expanded');
        runtime.setAgent({ activity: 'processing_'.repeat(500) });
        await page.waitForFunction(() => document.querySelector('.agent-status-text').textContent.includes('processing_'));
        await floating('long unbroken status');
        const textOverflow = await page.locator('.agent-status-text').evaluate(node => ({ text: node.textContent.length, scroll: node.scrollHeight, client: node.clientHeight, card: node.parentElement.getBoundingClientRect().height, dock: node.parentElement.parentElement.getBoundingClientRect().height }));
        assert.ok(textOverflow.scroll > textOverflow.client, `long activity scrolls inside the bounded plaque, not over Stop or the tabs: ${JSON.stringify(textOverflow)}`);
        runtime.setAgent({ activity: activityText });
        await page.locator('#open-agent').click();
      }
    }
    await page.close();
  }
  checks.push('inspector, layers, history, agent, shortcuts and palette never overflow sideways at 390px, 390px/200% and 820px; keys, counts, times and tags are never clipped');
  checks.push('numeric fields show their whole current/default values for element and artboard inspection, including at 200% UI size');
  checks.push('long agent activity uses a 5×3 grid with a readable timer and Stop in the bottom-right corner, including phone/200%');
  checks.push('tab labels, icons and counters fit open/folded; whole-board and node context text stays separate from the prompt, including phone/200%');
  checks.push('folded activity matches the remembered sidebar width above unmoved tabs, with one reachable Stop, bounded long-text scrolling and phone inspector clearance at 100/200%');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser?.close(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
