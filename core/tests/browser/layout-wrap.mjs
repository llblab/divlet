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
    const fields = document.createElement('section');
    fields.id = 'fields-fixture';
    fields.style.cssText = host.style.cssText;
    fields.style.top = '340px';
    const className = 'absolute top-[123456px] right-[654321px] bottom-[123456px] left-[654321px] opacity-100 z-[999999] blur-[12px] text-[length:24px]';
    for (const [name, , content] of layoutSections([{ id: 'positioned', className }], { parent: null, apply() {} })) {
      if (name !== 'spacing') fields.append(content);
    }
    document.querySelector('#ui').append(fields);
  });
  let wrapped = 0, together = 0;
  for (const viewport of [390, 768, 1280]) {
    await page.setViewportSize({ width: viewport, height: 800 });
    for (const width of [170, 220, 260, 280, 300, 320]) {
      await page.locator('#wrap-fixture, #fields-fixture').evaluateAll((hosts, width) => { for (const host of hosts) host.style.width = width + 'px'; }, width);
      const clipped = await page.locator('#fields-fixture').evaluate(host => {
        const context = document.createElement('canvas').getContext('2d');
        const bad = [];
        for (const input of host.querySelectorAll('.vf-input:not(.color-hex)')) {
          const style = getComputedStyle(input);
          context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const text = input.value || input.placeholder;
          const available = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          if (context.measureText(text).width > available + 1) bad.push(`${input.dataset.key}: ${text} clips at ${available}px`);
        }
        for (const grid of host.querySelectorAll('.grid2')) {
          const box = grid.getBoundingClientRect(), last = grid.lastElementChild.getBoundingClientRect();
          if (Math.abs(box.right - last.right) > 1) bad.push('paired controls leave unused columns');
        }
        if (host.scrollWidth > host.clientWidth + 1) bad.push('numeric controls overflow the host');
        return bad;
      });
      assert.deepEqual(clipped, [], `readable numeric grids at viewport ${viewport}, container ${width}`);
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
  console.log(JSON.stringify({ status: 'passed', checks: ['Text/Self labels wrap with their own buttons', '170–320px rows at 390/768/1280px viewports', 'wide rows retain both groups on one line', '200% UI scale', 'keyboard self-alignment action', 'full numeric values and paired controls without unused tracks across viewport/container widths'], screenshot: 'artifacts/layout-wrap.png' }, null, 2));
} finally {
  await browser?.close(); await runtime?.close(); await fs.rm(cwd, { recursive: true, force: true });
}
