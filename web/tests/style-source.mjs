// Actual Node source acceptance/history rendered in an opaque iframe, not board UI or a browser-hosted writer.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { openRuntime } from '@divlet/core/native';
import { componentTextProject } from '../../core/tests/fixtures/component-text.js';

const initial = { 'padding-left': '20px', padding: '10px' }, reordered = { padding: '10px', 'padding-left': '20px' };
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.PI_DIVLET_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE } : {}) });
const endpoints = [];
try {
  for (const kind of ['literal', 'override']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-source-cssom-'));
    const file = path.join(directory, 'project.divlet');
    const source = componentTextProject('button', kind === 'override' ? { button: { style: initial } } : {});
    source.frames[0].nodes.button.attrs = { title: 'Definition' };
    if (kind === 'literal') source.frames[0].nodes.button.style = initial;
    else source.frames[1].nodes.instance.descendants.button.attrs = { title: null };
    let runtime, page;
    try {
      await fs.writeFile(file, JSON.stringify(source));
      runtime = await openRuntime({ file, watch: false, createDemo: false });
      page = await browser.newPage();
      await page.setContent('<!doctype html><iframe id="preview" sandbox="allow-scripts"></iframe>');
      const painted = async () => {
        const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame.parentFrame() === page.mainFrame() && frame.url() === 'about:srcdoc', timeout: 10000 });
        await page.locator('#preview').evaluate((iframe, html) => { iframe.srcdoc = html; }, runtime.getEntry('consumer').html);
        const frame = await navigation;
        return frame.locator('[data-divlet-id="instance"]').evaluate(element => ({ padding: getComputedStyle(element).paddingLeft, title: element.getAttribute('title'), origin: location.origin }));
      };
      const observed = [await painted()];
      const edit = JSON.parse(await fs.readFile(file, 'utf8'));
      const target = kind === 'literal' ? edit.frames[0].nodes.button : edit.frames[1].nodes.instance.descendants.button;
      target.style = reordered;
      if (kind === 'override') target.attrs = { title: 'Changed' };
      await fs.writeFile(file, JSON.stringify(edit)); await runtime.scan();
      assert.equal(runtime.diagnostics.has(file), false);
      observed.push(await painted());
      await runtime.undo(); observed.push(await painted());
      await runtime.redo(); observed.push(await painted());
      assert.deepEqual(observed.map(value => value.padding), ['10px', '20px', '10px', '20px'], `${kind}: actual source/history cascade`);
      const titles = kind === 'override' ? [null, 'Changed', null, 'Changed'] : ['Definition', 'Definition', 'Definition', 'Definition'];
      assert.deepEqual(observed.map(value => value.title), titles, `${kind}: actual nullable attribute history`);
      assert.ok(observed.every(value => value.origin === 'null'), 'sandboxed render documents retain opaque origins');
      endpoints.push({ kind, padding: observed.map(value => value.padding), title: observed.map(value => value.title) });
    } finally {
      await page?.close(); await runtime?.close(); await fs.rm(directory, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ status: 'passed', mode: 'node-source-opaque-iframe', endpoints }));
} finally { await browser.close(); }
