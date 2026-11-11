// The default new project is an ordinary Divlet project: elements with Tailwind classes, editable like any other.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { openRuntime } from '../../lib/runtime.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-default-ui-')), runtimes = [], checks = [], errors = [];
let browser;
try {
  const options = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }; if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) options.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch(options);
  for (const createDemo of [false, true]) {
    const file = path.join(root, createDemo ? 'starter' : 'empty', 'project.divlet'), runtime = await openRuntime({ file, createDemo, watch: false }); runtimes.push(runtime);
    const seed = JSON.parse(await fs.readFile(file, 'utf8')), page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.on('pageerror', error => errors.push(error.message));
    assert.equal(seed.schemaVersion, 1); assert.equal(seed.frames.length, createDemo ? 1 : 0);
    await page.goto(runtime.url); await page.waitForFunction(() => document.querySelector('#loading')?.hidden);
    assert.equal(await page.locator('#source-mode').isVisible(), false, 'a Divlet project has no partial-editing badge');
    if (!createDemo) { await page.locator('#empty-new').click(); await page.locator('.artboard').waitFor(); }
    const frame = runtime.info().documents[0];
    await page.locator('.artboard').first().waitFor();
    await page.evaluate(async id => { const s = await import('./lib/store.js'); s.selectArtboards([id]); }, frame.id);
    await page.locator('#inspector').waitFor();
    // Reload keeps what was created, at phone width and 200% interface size too.
    await page.reload(); await page.waitForFunction(() => document.querySelector('#loading')?.hidden); await page.locator('.artboard').waitFor();
    await page.setViewportSize({ width: 390, height: 860 }); await page.evaluate(async () => (await import('./lib/help.js')).setUiSize(200));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (createDemo) { await fs.mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/native-default.png' }); }
    const saved = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(saved.schemaVersion, 1); assert.equal(saved.frames.length, 1);
    checks.push(`a new ${createDemo ? 'starter' : 'empty'} project is a Divlet project: no PEN badge, ${createDemo ? 'a starter frame' : 'New artboard creates the first frame'}, retained after reload at 390px/200%`);
    await page.close();
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ status: 'passed', checks, screenshot: 'artifacts/native-default.png' }, null, 2));
} finally { await browser?.close(); for (const runtime of runtimes) await runtime.close(); await fs.rm(root, { recursive: true, force: true }); }
