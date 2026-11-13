// The folded-sidebar plaque keeps progress, elapsed time and Stop on one footer row without duplicating its live node.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import { chromium } from 'playwright';
import { openRuntime } from '../../core/lib/runtime.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'divlet-agent-status-'));
const runtime = await openRuntime({ file: path.join(dir, 'project.divlet'), watch: false, createDemo: true });
const activity = 'Adding orange accents and replacing the hero mockup with a real historical screenshot';
runtime.setAgent({ connected: true, busy: true, activity });
runtime.setAgent({ since: new Date(Date.now() - 113000).toISOString() });
let stops = 0, browser;
runtime.on('stop', () => { stops++; });
const checks = [], errors = [];
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.PI_DIVLET_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE } : {}) });
  await mkdir('artifacts', { recursive: true });
  for (const width of [390, 820, 1500]) for (const size of [100, 150, 200]) {
    const context = await browser.newContext({ viewport: { width, height: 850 }, hasTouch: width === 390, colorScheme: size === 200 ? 'dark' : 'light' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(runtime.url);
    await page.waitForFunction(() => document.querySelector('.artboard')?.dataset.status === 'live');
    await page.evaluate(async size => (await import('./lib/help.js')).setUiSize(size), size);
    if (!await page.locator('#agent').isVisible()) await page.locator('#open-agent').click();
    const plaque = await page.locator('.agent-status').elementHandle();
    assert.equal(await plaque.evaluate(node => node.parentElement.id), 'agent');
    assert.equal(await plaque.evaluate(node => getComputedStyle(node.querySelector('.spinner')).gridRowStart), '1', 'the open-panel indicator keeps its existing placement');
    await page.locator('#open-agent').click();
    await page.locator('#agent-status-dock > .agent-status').waitFor();
    // Closing the phone sheet reveals a wrapped dock; take the baseline only after its ResizeObserver publishes that height.
    await page.waitForFunction(() => {
      const root = document.documentElement, dock = document.querySelector('#dock');
      const scale = Number.parseFloat(root.style.getPropertyValue('--ui')) || 1;
      const measured = Number.parseFloat(root.style.getPropertyValue('--dock-h'));
      return measured > 0 && measured === Math.round(dock.getBoundingClientRect().height / scale);
    });
    const tabs = await page.locator('#side-tabs').boundingBox();
    const footer = async label => {
      const result = await plaque.evaluate(card => {
        const spinner = card.querySelector('.spinner'), time = card.querySelector('time'), stop = card.querySelector('.ask-stop'), text = card.querySelector('.agent-status-text');
        const spin = getComputedStyle(spinner), words = getComputedStyle(text);
        const a = spinner.getBoundingClientRect(), b = time.getBoundingClientRect(), c = stop.getBoundingClientRect(), t = text.getBoundingClientRect(), r = card.getBoundingClientRect();
        const center = box => (box.top + box.bottom) / 2;
        return {
          row: spin.gridRowStart, column: spin.gridColumnStart,
          aligned: Math.abs(center(a) - center(b)) < 1 && Math.abs(center(b) - center(c)) < 1,
          ordered: a.right <= b.left + 1 && b.right <= c.left + 1,
          below: t.bottom <= Math.min(a.top, b.top, c.top) + 1,
          fullTextWidth: words.gridColumnStart === '1' && words.gridColumnEnd === '-1',
          contained: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && c.bottom <= r.bottom,
          one: document.querySelectorAll('.agent-status').length === 1 && document.querySelectorAll('.ask-stop').length === 1,
          readable: /^\d+:\d{2}$/.test(time.textContent) && time.scrollWidth <= time.clientWidth + 1 && text.scrollWidth <= text.clientWidth + 1,
        };
      });
      assert.deepEqual(result, { row: '3', column: '1', aligned: true, ordered: true, below: true, fullTextWidth: true, contained: true, one: true, readable: true }, `${width}px/${size}% ${label}`);
    };
    await footer('wrapped activity');
    if (width === 390 && size === 200) await page.locator('#agent-status-dock > .agent-status').screenshot({ path: 'artifacts/agent-status-footer-390-200.png' });
    runtime.setAgent({ activity: 'processing_'.repeat(500) });
    await page.waitForFunction(() => document.querySelector('.agent-status-text').textContent.includes('processing_'));
    await footer('scrolling unbroken activity');
    assert.ok(await page.locator('.agent-status-text').evaluate(node => node.scrollHeight > node.clientHeight), 'long activity scrolls above the footer');
    assert.deepEqual(await page.locator('#side-tabs').boundingBox(), tabs, 'activity does not move the tabs');
    runtime.setAgent({ activity });
    await page.waitForFunction(() => document.querySelector('.agent-status-text').textContent.includes('Adding orange accents'));
    await page.locator('#open-agent').click();
    assert.equal(await plaque.evaluate(node => node.parentElement.id), 'agent', 'opening returns the same plaque');
    assert.equal(await plaque.evaluate(node => getComputedStyle(node.querySelector('.spinner')).gridRowStart), '1');
    await page.locator('#open-agent').click();
    if (width === 1500 && size === 200) {
      const stopped = once(runtime, 'stop');
      await page.getByRole('button', { name: 'Stop the agent', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.agent-status-text').textContent.includes('stopping'));
      await stopped;
      assert.equal(stops, 1);
      await footer('stopping');
    }
    checks.push(`${width}px/${size}%: aligned footer, full-width text, scroll, stable tabs and one movable plaque`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally {
  await browser?.close();
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
}
