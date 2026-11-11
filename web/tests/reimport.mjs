// A project imported from a .pen notices when the source changed and offers to import it again as a new sibling project.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveOpenFile } from '../../core/lib/import.ts';
import { openRuntime } from '../../core/lib/runtime.js';

const playwright = await import('playwright');
const dir = await mkdtemp(path.join(os.tmpdir(), 'divlet-reimport-'));
const source = path.join(dir, 'design.pen');
const pen = name => JSON.stringify({ version: '2.21', children: [{ id: 'page', type: 'frame', name, x: 0, y: 0, width: 320, height: 200, fill: '#ffffff', children: [{ id: 't', type: 'text', content: 'Hello', fontSize: 14 }] }] });
await writeFile(source, pen('Page'));
const { file } = await resolveOpenFile(source);
const runtime = await openRuntime({ file, watch: false, createDemo: false });
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const checks = [];
let browser;
try {
  browser = await playwright.chromium.launch(launch);
  const open = async () => { const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); await page.goto(runtime.info().url); await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0); return page; };

  let page = await open();
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#toast').getByText('changed after it was imported').count(), 0, 'no notice while the source is unchanged');
  await page.close();
  checks.push('an unchanged source shows no notice');

  await writeFile(source, pen('Page, edited'));
  page = await open();
  await page.locator('#toast').getByText('changed after it was imported').waitFor();
  await page.locator('#toast button', { hasText: 'Import again' }).click();
  await page.locator('#toast').getByText('Imported again as design-2.divlet').waitFor();
  assert.deepEqual((await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.divlet')).map(entry => entry.name).sort(), ['design-2.divlet', 'design.divlet'], 'a new sibling project, the old one stays');
  checks.push('a changed source offers Import again, which creates a new sibling project and leaves the current one alone');
  await page.close();
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser?.close(); await runtime.close(); await rm(dir, { recursive: true, force: true }); }
