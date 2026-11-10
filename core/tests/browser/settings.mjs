import assert from 'node:assert/strict';
import { legacyProject } from '../fixtures/legacy-project.js';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openRuntime } from '../../lib/runtime.js';
import { decodeHtml } from '../../lib/codec.ts';

const { chromium } = await import('playwright');
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-settings-'));
await legacyProject(path.join(cwd, 'project.divlet'));
const runtime = await openRuntime({ cwd, watch: false, createDemo: false });
const options = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) options.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
let browser;
try {
  await runtime.create({ document: decodeHtml('<main><h1>Settings output</h1></main>', { fallbackId: 'sample' }) });
  browser = await chromium.launch(options);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(runtime.info().url);
  await page.waitForFunction(() => document.querySelectorAll('.artboard').length === 1);
  await page.keyboard.press('Control+,');
  const input = page.locator('#settings-output');
  const status = page.locator('#settings-output-status');
  const button = name => page.locator('#help').getByRole('button', { name, exact: true });
const waitUntil = async (check, label, timeout = 8000) => {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(`Timed out: ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
};
  const source = runtime.info().project.file;
  const disk = async () => JSON.parse(await readFile(source, 'utf8'));
  const save = async value => {
    await input.fill(value);
    await input.press('Enter');
    await status.filter({ hasText: 'Build output saved.' }).waitFor();
    await input.waitFor();
    assert.equal(await input.isDisabled(), false);
  };
  // The dialog's own layout: every block has the same space above and below the divider, and the actions sit in the bottom-right
  // corner above nothing but the reserved status line.
  {
    const layout = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll('#help .settings-block')].map(node => {
        const c = getComputedStyle(node);
        return { top: c.paddingTop, bottom: c.paddingBottom, border: c.borderTopWidth };
      });
      const actions = document.querySelector('#help .settings-actions').getBoundingClientRect();
      const dialog = document.querySelector('#help .dialog').getBoundingClientRect();
      const status = document.querySelector('#help .settings-status').getBoundingClientRect();
      const picker = document.querySelector('#help .settings-picker');
      return {
        blocks,
        rightGap: Math.round(dialog.right - actions.right),
        statusAbove: Math.round(actions.top - status.bottom),
        statusIsLastControl: status.bottom <= actions.top + 1,
        statusReserved: status.height > 0,
        browse: !!document.querySelector('#help .settings-field .tool'),
        pickerHidden: picker.hidden,
      };
    });
    assert.ok(layout.blocks.length >= 3, 'the dialog is made of blocks');
    for (const block of layout.blocks) {
      assert.equal(block.top, block.bottom, `every block has the same space above and below its divider (${block.top} / ${block.bottom})`);
      assert.equal(block.top, '12px');
    }
    assert.deepEqual(layout.blocks.map(block => block.border), ['0px', '1px', '1px', '1px'], 'the divider lives between blocks, never above the first');
    assert.ok(layout.rightGap <= 20, `the actions sit in the bottom-right corner (${layout.rightGap}px from the edge)`);
    assert.ok(layout.statusAbove >= 4 && layout.statusAbove <= 16, `and keep a small gap from the options above (${layout.statusAbove}px)`);
    assert.equal(layout.statusIsLastControl, true, 'the status line is the last control above the buttons, so its text cannot push them');
    assert.equal(layout.statusReserved, true);
    assert.equal(layout.browse, true, 'the path has a browse button');
    assert.equal(layout.pickerHidden, true, 'the folder picker starts folded');
  }

  await save('build/custom');
  assert.equal((await disk()).outputDir, 'build/custom');
  assert.equal(runtime.info().outputDir, path.join(cwd, 'build/custom'));
  assert.ok((await readdir(runtime.info().outputDir)).some(file => file.endsWith('.html')));
  assert.match(await readFile(runtime.info().documents[0].htmlPath, 'utf8'), /Settings output/);

  // Typed or picked: the browse button walks the folders and fills the same relative directory the field takes by hand.
  await mkdir(path.join(cwd, 'designs', 'tokens'), { recursive: true });
  await button('Choose the output folder').click();
  await page.locator('#help .settings-picker').waitFor();
  await page.locator('#help .settings-picker-list .dir', { hasText: 'designs' }).click();
  await page.locator('#help .settings-picker-list .dir', { hasText: 'tokens' }).click();
  await page.locator('#help .settings-picker button', { hasText: 'Use this folder' }).click();
  await waitUntil(async () => (await input.inputValue()) === 'designs/tokens', 'the picked folder arrives as a relative path');
  await input.press('Enter');
  await status.filter({ hasText: 'Build output saved.' }).waitFor();
  assert.equal((await disk()).outputDir, 'designs/tokens');
  assert.ok((await readdir(path.join(cwd, 'designs', 'tokens'))).some(file => file.endsWith('.html')));

  await save('');
  assert.equal((await disk()).outputDir, undefined);
  assert.equal(runtime.info().outputDir, path.join(cwd, '.divlet/project'));
  await save('build/again');
  await button('Reset to default').click();
  await status.filter({ hasText: 'Build output saved.' }).waitFor();
  assert.equal((await disk()).outputDir, undefined);
  assert.ok((await readdir(path.join(cwd, '.divlet/project'))).some(file => file.endsWith('.html')));

  const before = await readFile(source, 'utf8');
  await input.fill('/unsafe/absolute');
  await input.press('Enter');
  await status.filter({ hasText: 'Your draft is kept' }).waitFor();
  assert.equal(await readFile(source, 'utf8'), before);
  assert.equal(await input.inputValue(), '/unsafe/absolute');
  await mkdir(path.join(cwd, 'foreign'));
  const htmlName = path.basename(runtime.info().documents[0].htmlPath);
  await writeFile(path.join(cwd, 'foreign', htmlName), 'foreign content');
  await input.fill('foreign');
  await input.press('Enter');
  await status.filter({ hasText: 'Your draft is kept' }).waitFor();
  assert.equal(await readFile(source, 'utf8'), before);
  assert.equal(await readFile(path.join(cwd, 'foreign', htmlName), 'utf8'), 'foreign content');

  await input.fill('my-draft');
  await runtime.patchProject({ expectedVersion: runtime.info().project.version, patch: { outputDir: 'external' } });
  await status.filter({ hasText: 'Project changed' }).waitFor();
  assert.equal(await input.inputValue(), 'my-draft');
  await page.locator('#help [data-theme="dark"]').click();
  assert.equal(await input.inputValue(), 'my-draft');
  const external = await readFile(source, 'utf8');
  await input.press('Enter');
  await status.filter({ hasText: 'Your draft is kept' }).waitFor();
  assert.equal(await readFile(source, 'utf8'), external, 'stale version must not overwrite external settings');
  await button('Reload current settings').click();
  await page.waitForFunction(() => document.querySelector('#settings-output')?.value === 'external');
  await save('resolved');
  assert.equal((await disk()).outputDir, 'resolved');

  await page.keyboard.press('Escape');
  await runtime.patchProject({ expectedVersion: runtime.info().project.version, patch: { outputDir: 'closed-external' } });
  await page.waitForFunction(version => import(new URL('lib/store.js', location.href)).then(({ store }) => store.state.project.version === version), runtime.info().project.version);
  await page.keyboard.press('Control+,');
  assert.equal(await input.inputValue(), 'resolved');
  assert.match(await status.textContent(), /Project changed/, 'reopening a stale draft must not repeat an obsolete save success');
  assert.equal(await page.locator('.settings-path code').nth(1).textContent(), path.join(cwd, 'closed-external'));
  const closedExternal = await readFile(source, 'utf8');
  await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#settings-output').disabled);
  assert.equal(await readFile(source, 'utf8'), closedExternal);

  for (const method of ['GET', 'POST']) {
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const handler = async route => {
      if (route.request().method() === method) { entered(); await gate; }
      await route.continue();
    };
    await page.route('**/api/project', handler);
    try {
      if (method === 'GET') await button('Reload current settings').click();
      else { await input.fill('held-save'); await input.press('Enter'); }
      await started;
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('#help')), true, `${method} pending focus stays in the modal`);
      for (const key of ['Shift+Tab', 'Tab']) {
        await page.keyboard.press(key);
        assert.equal(await page.evaluate(() => !!document.activeElement.closest('#help')), true, `${method} pending ${key} stays contained`);
      }
      await page.keyboard.press('Escape');
      if (method === 'GET') {
        await page.keyboard.press('Control+,');
        assert.equal(await input.isDisabled(), true, 'reopening does not unlock a pending request');
      } else await page.locator('#open-layers').focus();
      release();
      await page.waitForFunction(() => !document.querySelector('#settings-output').disabled);
      if (method === 'GET') assert.equal(await input.inputValue(), 'closed-external');
      else {
        assert.equal(await page.locator('#help').isVisible(), false);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'open-layers', 'completion must not steal foreground focus');
        assert.equal((await disk()).outputDir, 'held-save');
        await page.keyboard.press('Control+,');
      }
    } finally { release(); await page.unroute('**/api/project', handler); }
  }
  await save('resolved');

  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.locator(`#help [data-theme="${theme}"]`).click();
      await page.locator('#help [data-ui="200"]').click();
      assert.equal(await page.locator('#help .dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true, `${width}/${theme}/200% horizontal overflow`);
      await input.focus();
      assert.equal(await input.evaluate(node => document.activeElement === node), true);
      const count = await page.locator('#help button:not(:disabled), #help input:not(:disabled)').count();
      for (let i = 0; i < count + 2; i++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement.closest('#help')), true);
      }
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('#help')), true);
    }
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await input.focus();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/settings-narrow.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('#help [data-ui="100"]').click();
  await page.locator('#help .dialog').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: 'artifacts/settings.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#help').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Settings: model/disk output, default/reset, unsafe/collision refusal, stale version/reopen warning, SSE draft preservation, held POST/GET focus containment, closed-dialog completion and responsive/theme/200% checks passed.');
} finally {
  await browser?.close();
  await runtime.close();
  await rm(cwd, { recursive: true, force: true });
}
