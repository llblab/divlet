import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { openRuntime } from '@divlet/core/runtime';

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
    const sections = layoutSections([{ id: 'item', className: '' }], {
      parent: { className: 'flex' },
      apply: transform => { window.wrapClasses = transform(window.wrapClasses || ''); },
    });
    host.append(sections.find(([name]) => name === 'layout')[2], sections.find(([name]) => name === 'appearance')[2]);
    document.querySelector('#ui').append(host);
    const selectors = document.createElement('section');
    selectors.id = 'selectors-fixture';
    selectors.className = 'layout-box';
    selectors.style.cssText = 'position:absolute;left:8px;top:80px;background:var(--solid)';
    const pair = document.createElement('div'); pair.className = 'grid2';
    const defaults = layoutSections([{ id: 'default', className: '' }], { parent: null, apply() {} });
    for (const key of ['Display', 'Position']) {
      const pick = defaults.map(([, , content]) => content.querySelector(`[data-key="pick:${key}"]`)).find(Boolean);
      pair.append(pick);
    }
    selectors.append(pair); document.querySelector('#ui').append(selectors);
    const fields = document.createElement('section');
    fields.id = 'fields-fixture';
    fields.style.cssText = host.style.cssText;
    fields.style.top = '600px';
    const className = 'absolute top-[123456px] right-[654321px] bottom-[123456px] left-[654321px] opacity-100 z-[999999] blur-[12px] text-[length:24px] font-extrabold';
    for (const [name, , content] of layoutSections([{ id: 'positioned', className }], { parent: null, apply() {} })) {
      if (name !== 'spacing') fields.append(content);
    }
    document.querySelector('#ui').append(fields);
  });
  assert.equal(await page.locator('#wrap-fixture .layout-box [aria-label="Text align"]').count(), 0, 'Layout does not own text alignment');
  assert.equal(await page.locator('#wrap-fixture .appearance-box [aria-label="Text align"]').count(), 1, 'typography owns one text-alignment group');
  assert.equal(await page.locator('#wrap-fixture .layout-box [aria-label="Align self in the parent"]').count(), 1, 'item alignment stays in Layout');
  for (const viewport of [390, 768, 1280]) {
    await page.setViewportSize({ width: viewport, height: 800 });
    for (const width of [170, 220, 246, 260, 280, 300, 320]) {
      await page.locator('#wrap-fixture, #fields-fixture, #selectors-fixture').evaluateAll((hosts, width) => { for (const host of hosts) host.style.width = width + 'px'; }, width);
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
      const selectors = await page.locator('#selectors-fixture, #fields-fixture').evaluateAll(hosts => hosts.flatMap(host => [...host.querySelectorAll('.pick')].map(pick => {
        const value = pick.querySelector('.pick-v'), label = pick.querySelector('.pick-k'), caret = pick.querySelector('.pick-caret');
        const box = pick.getBoundingClientRect(), v = value.getBoundingClientRect(), k = label.getBoundingClientRect(), c = caret.getBoundingClientRect();
        return { key: pick.dataset.key, text: value.textContent, lines: value.clientHeight / parseFloat(getComputedStyle(value).lineHeight), whole: value.scrollWidth <= value.clientWidth + 1, accessible: pick.getAttribute('aria-label') === `${label.textContent}: ${value.textContent}`, inside: v.left >= box.left && v.right <= c.left - 1, separate: k.right <= v.left + 1 };
      })));
      for (const pick of selectors) {
        assert.equal(pick.lines, 1, `${pick.key}: ${pick.text} must not wrap at ${width}px`);
        assert.equal(pick.whole && pick.accessible && pick.inside && pick.separate, true, `${pick.key}: preserve the value before its caret without overlapping the label at ${width}px`);
      }
      const boxes = await page.locator('#selectors-fixture .pick').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
      if (width <= 246) assert.ok(boxes[1].top >= boxes[0].bottom, 'the reported Default pair stacks when its contents do not fit');
      if (width >= 300) assert.equal(boxes[0].top, boxes[1].top, 'the same pair stays side by side when both values fit');
      const groups = await page.locator('#wrap-fixture .labeled-segs').evaluateAll(nodes => nodes.map(group => {
        const caption = group.querySelector('.caption').getBoundingClientRect(), controls = group.querySelector('.segs').getBoundingClientRect();
        return { label: group.querySelector('.caption').textContent, captionY: caption.y + caption.height / 2, controlsY: controls.y + controls.height / 2, fits: group.parentElement.scrollWidth <= group.parentElement.clientWidth + 1 };
      }));
      assert.equal(groups.length, 2);
      for (const group of groups) {
        assert.ok(Math.abs(group.captionY - group.controlsY) < 1, `${group.label} detached at viewport ${viewport}, row ${width}`);
        assert.equal(group.fits, true, `${group.label} fits in its owning section`);
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('#selectors-fixture').evaluate(host => { host.style.width = '246px'; });
  await fs.mkdir('artifacts', { recursive: true });
  await page.locator('#selectors-fixture').screenshot({ path: 'artifacts/selectors-default-stacked.png' });
  await page.locator('#selectors-fixture').evaluate(host => { host.hidden = true; });
  await page.locator('#wrap-fixture').evaluate(host => { host.style.width = '260px'; });
  await page.evaluate(() => { document.documentElement.style.setProperty('--ui', '2'); document.documentElement.dataset.theme = 'dark'; });
  const controls = page.getByRole('group', { name: 'Align self in the parent', exact: true });
  await controls.getByRole('button', { name: 'Self: center', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.wrapClasses), 'self-center');
  const text = page.locator('#wrap-fixture .appearance-box').getByRole('group', { name: 'Text align', exact: true });
  await text.getByRole('button', { name: 'Align center', exact: true }).focus(); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.wrapClasses.split(' ')), ['self-center', 'text-center'], 'text and item alignment retain independent keyboard edits');
  const aligned = await page.locator('#wrap-fixture .labeled-segs').evaluateAll(groups => groups.every(group => {
    const label = group.querySelector('.caption').getBoundingClientRect(), buttons = group.querySelector('.segs').getBoundingClientRect();
    return Math.abs(label.y + label.height / 2 - buttons.y - buttons.height / 2) < 1;
  }));
  assert.ok(aligned, 'labels remain attached at 200% UI size');
  await page.evaluate(() => document.documentElement.style.setProperty('--ui', '1'));
  await fs.mkdir('artifacts', { recursive: true });
  await page.locator('#wrap-fixture').screenshot({ path: 'artifacts/layout-wrap.png' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks: ['text alignment belongs to Appearance; item alignment stays in Layout', '170–320px rows at 390/768/1280px viewports', 'Default and long selector values stay on one line; fields stack by content width', 'wide selector pairs stay on one line', '200% UI scale', 'keyboard self-alignment action', 'full numeric values and paired controls without unused tracks across viewport/container widths'], screenshot: 'artifacts/layout-wrap.png' }, null, 2));
} finally {
  await browser?.close(); await runtime?.close(); await fs.rm(cwd, { recursive: true, force: true });
}
