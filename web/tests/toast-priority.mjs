// A timer-driven notice must not evict a toast the user can still act on. The Agent watchdog ("Pi has not started yet") fires nine
// seconds after a request nobody has started on; when an Undo toast is on screen at that moment it waits its turn.
import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openRuntime } from '@divlet/core/runtime';

const playwright = await import('playwright');
const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-toast-priority-'));
await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
const runtime = await openRuntime({ cwd, watch: false });
runtime.setAgent({ connected: true });
const asks = [];
runtime.on('ask', request => asks.push(request));
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const errors = [];
let browser;
try {
  browser = await playwright.chromium.launch(launch);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.goto(runtime.info().url);
  await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
  await page.evaluate(async () => (await import('./lib/sidebar.js')).show('agent'));
  await page.locator('#agent .ask-input').fill('Warm up the hero');
  await page.locator('#ask-send').click();
  await page.waitForFunction(() => document.querySelector('#agent .ask-input').value === ''); // the request is accepted and the watchdog armed
  assert.equal(asks.length, 1);

  const toastText = () => page.locator('#toast').innerText();
  const visible = () => page.evaluate(() => !document.querySelector('#toast').hidden);
  await page.clock.fastForward(8000);
  await page.evaluate(async () => { (await import('./lib/store.js')).toast('2 artboards deleted', { label: 'Undo', run() {} }); });
  assert.match(await toastText(), /2 artboards deleted/);
  await page.clock.fastForward(1500); // the watchdog's nine seconds have passed
  assert.equal(await visible(), true);
  assert.match(await toastText(), /2 artboards deleted/, 'the watchdog did not replace the toast that has an Undo');
  assert.equal(await page.locator('#toast .toast-action').count(), 1, 'the Undo is still there');

  await page.clock.fastForward(9000); // the Undo toast has expired; the notice may now say what it has to say
  await page.locator('#toast', { hasText: 'Pi has not started yet' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('toast priority passed');
} finally {
  await browser?.close();
  await runtime.close?.();
  await rm(cwd, { recursive: true, force: true });
}
process.exit(0);
