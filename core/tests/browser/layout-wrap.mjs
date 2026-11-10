import assert from 'node:assert/strict';
import { legacyProject } from '../fixtures/legacy-project.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { openRuntime } from '../../lib/runtime.js';

const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-layout-wrap-'));
let runtime, browser;
try {
  await legacyProject(path.join(cwd, 'project.divlet'));
  runtime = await openRuntime({ cwd, watch: false, createDemo: false });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(runtime.url);
  await page.evaluate(async () => {
    const { layoutSections } = await import('./plugins/tailwind/layout.js');
    const host = document.createElement('section');
    host.id = 'wrap-fixture';
    host.style.cssText = 'position:absolute;left:10px;top:80px;padding:12px;box-sizing:content-box;background:var(--panel);border:1px solid var(--hair);border-radius:12px';
    const [, , layout] = layoutSections([{ id: 'item', className: '' }], {
      parent: { className: 'flex' },
      apply: transform => { window.wrapClasses = transform(window.wrapClasses || ''); },
    })[0];
    host.append(layout);
    document.querySelector('#ui').append(host);
  });
  let wrapped = 0, together = 0;
  for (const viewport of [390, 768, 1280]) {
    await page.setViewportSize({ width: viewport, height: 800 });
    for (const width of [170, 220, 260, 280, 300, 320]) {
      await page.locator('#wrap-fixture').evaluate((host, width) => { host.style.width = width + 'px'; }, width);
      const groups = await page.locator('#wrap-fixture .align-controls').evaluate(row => ({
        width: row.clientWidth, scroll: row.scrollWidth,
        groups: [...row.children].map(group => {
          const caption = group.querySelector('.caption').getBoundingClientRect();
          const controls = group.querySelector('.segs').getBoundingClientRect();
          return { label: group.querySelector('.caption').textContent, captionY: caption.y + caption.height / 2, controlsY: controls.y + controls.height / 2, top: controls.top };
        }),
      }));
      assert.equal(groups.groups.length, 2);
      for (const group of groups.groups) assert.ok(Math.abs(group.captionY - group.controlsY) < 1, `${group.label} detached at viewport ${viewport}, row ${width}`);
      assert.ok(groups.scroll <= groups.width + 1, 'control groups do not overflow the row');
      if (Math.abs(groups.groups[0].top - groups.groups[1].top) < 1) together++;
      else wrapped++;
    }
  }
  assert.ok(wrapped && together, 'exercise both wrapped and single-line layouts');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('#wrap-fixture').evaluate(host => { host.style.width = '260px'; });
  await page.evaluate(() => { document.documentElement.style.setProperty('--ui', '2'); document.documentElement.dataset.theme = 'dark'; });
  const controls = page.getByRole('group', { name: 'Align self in the parent', exact: true });
  await controls.getByRole('button', { name: 'Self: center', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.wrapClasses), 'self-center');
  const aligned = await page.locator('#wrap-fixture .labeled-segs').evaluateAll(groups => groups.every(group => {
    const label = group.querySelector('.caption').getBoundingClientRect(), buttons = group.querySelector('.segs').getBoundingClientRect();
    return Math.abs(label.y + label.height / 2 - buttons.y - buttons.height / 2) < 1;
  }));
  assert.ok(aligned, 'labels remain attached at 200% UI size');
  await page.evaluate(() => document.documentElement.style.setProperty('--ui', '1'));
  await fs.mkdir('artifacts', { recursive: true });
  await page.locator('#wrap-fixture').screenshot({ path: 'artifacts/layout-wrap.png' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks: ['Text/Self labels wrap with their own buttons', '170–320px rows at 390/768/1280px viewports', 'wide rows retain both groups on one line', '200% UI scale', 'keyboard self-alignment action'], screenshot: 'artifacts/layout-wrap.png' }, null, 2));
} finally {
  await browser?.close(); await runtime?.close(); await fs.rm(cwd, { recursive: true, force: true });
}
