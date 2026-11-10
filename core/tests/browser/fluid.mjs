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
runtime.setAgent({ connected: true });
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const errors = [], checks = [];
let browser;
try {
  browser = await playwright.chromium.launch(launch);
  for (const [width, size] of [[390, 100], [390, 200], [820, 100]]) {
    const page = await (await browser.newContext({ viewport: { width, height: 800 } })).newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(runtime.url); await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
    await page.evaluate(async size => { (await import('./lib/help.js')).setUiSize(size); const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); m.selectNodes('welcome', ['nav']); }, size);
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
      const bad = await audit(`${width}px@${size}% ${name}`);
      assert.deepEqual(bad, [], bad.join('\n'));
    }
    await page.close();
  }
  checks.push('inspector, layers, history, agent, shortcuts and palette never overflow sideways at 390px, 390px/200% and 820px; keys, counts, times and tags are never clipped');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser?.close(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
