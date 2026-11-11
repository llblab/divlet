// Native collection cards are wire metadata; selecting an exact file is a separate guarded open.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launch, makeHost } from '../../core/lib/launch.ts';
import { openRuntime } from '../../core/lib/runtime.js';
import { importedName } from '../../core/lib/import.ts';

const { chromium } = await import('playwright');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-native-collections-ui-'));
const collection = path.join(root, 'Designs'); await fs.mkdir(collection);
const secret = 'S3cr3t!', outside = path.join(root, 'photo.svg');
await fs.writeFile(outside, '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>');
const native = { version: '2.21', fileToken: secret, name: secret, frames: [{ name: 'Foreign legacy tree' }], children: [
  { id: 'definition', type: 'frame', name: 'Shared card', reusable: true, width: 200, height: 80, children: [{ id: 'label', type: 'text', content: 'Shared' }] },
  { id: 'screen', type: 'frame', name: 'Desktop', width: 390, height: 500, children: [{ id: 'instance', type: 'ref', ref: 'definition' }, { id: 'photo', type: 'rectangle', width: 160, height: 100, fill: [{ type: 'image', url: '../photo.svg' }] }] },
] };
const alpha = path.join(collection, 'alpha.pen'), empty = path.join(collection, 'empty.PEN'), future = path.join(collection, 'future.pen'), broken = path.join(collection, 'broken-' + 'b'.repeat(160) + '.pen');
const longFile = path.join(collection, 'long-' + 'n'.repeat(160) + '.pen');
const snapshots = new Map([[longFile, JSON.stringify({ version: '2.21', children: [{ id: 'long', type: 'frame', name: 'L'.repeat(2000) }], divlet: { schemaVersion: 1, name: 'N'.repeat(512) } })], [alpha, JSON.stringify(native)], [empty, JSON.stringify({ version: '2.21', children: [], name: secret })], [future, JSON.stringify({ version: '2.21', fileToken: secret, name: secret, children: [], divlet: { schemaVersion: 99, name: 'Authored marker label' } })], [broken, `{"fileToken":${secret},"version":"2.21","children":[]}`]]);
for (const [file, text] of snapshots) await fs.writeFile(file, text);
const boards = new Map(), hubs = new Map(), attempts = [];
const openBoard = async location => { attempts.push(location); if (!boards.has(location.file)) { const runtime = await openRuntime({ ...location, watch: false, createDemo: false }); runtime.host = host; boards.set(location.file, runtime); } return boards.get(location.file); };
const host = makeHost({ openBoard, hubs });
const listed = await launch(collection, { openBoard, hubs });
const options = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) options.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const checks = [], errors = [];
let browser;
try {
  browser = await chromium.launch(options);
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(listed.hub.url); await page.locator('.card').nth(3).waitFor();
  const card = name => page.locator('.card').filter({ has: page.locator('.path', { hasText: name }) });
  assert.match(await card('alpha.pen').locator('.meta').textContent(), /^2 frames/);
  assert.deepEqual(await card('alpha.pen').locator('.chips span').allTextContents(), ['Shared card', 'Desktop']);
  assert.equal(await card('alpha.pen').locator('b').textContent(), 'alpha');
  assert.match(await card('empty.PEN').locator('.meta').textContent(), /^0 frames/);
  assert.equal(await card('empty.PEN').locator('b').textContent(), 'empty');
  assert.equal(await card('future.pen').locator('b').textContent(), 'Authored marker label');
  assert.match(await card('future.pen').locator('.meta').textContent(), /^0 frames/);
  assert.equal(await card(path.basename(broken)).isDisabled(), true); assert.match(await card(path.basename(broken)).locator('.error').textContent(), /not valid JSON/);
  assert.equal((await page.content()).includes(secret), false); assert.equal(attempts.length, 0, 'listing performs no runtime/resource opening');
  const metadata = await (await fetch(listed.hub.url + 'api/projects')).json();
  assert.equal(JSON.stringify(metadata).includes(secret), false);
  assert.ok(metadata.projects.every(project => !project.capabilities && !project.externalFiles));
  checks.push('canonical native root counts/names, source-only foreign fields and authored labels independent of inert markers, with credential-safe broken-source cards and no runtime opening');

  for (const scheme of ['light', 'dark']) for (const width of [390, 768, 1280]) for (const zoom of [1, 2]) {
    await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width, height: 860 });
    await page.evaluate(zoom => { document.body.style.zoom = String(zoom); }, zoom);
    const geometry = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth, right: Math.max(...[...document.querySelectorAll('.card')].map(node => node.getBoundingClientRect().right)) }));
    assert.ok(geometry.scroll <= geometry.width + 1 && geometry.right <= geometry.width + 1, JSON.stringify({ scheme, width, zoom, ...geometry }));
    const overflow = await page.locator('.card').evaluateAll(cards => cards.flatMap(card => [...card.querySelectorAll('b, .path, .chips span, .error')].filter(node => node.getBoundingClientRect().right > card.getBoundingClientRect().right + 1 || node.matches('.error') && node.scrollWidth > node.clientWidth + 1).map(node => node.className || node.tagName)));
    assert.deepEqual(overflow, [], 'title/chip/path/error content stays inside each actual card, not only inside its outer rectangle');
    await card('alpha.pen').focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.tagName === 'BUTTON' || document.activeElement.tagName === 'INPUT'), true);
  }
  await page.evaluate(() => { document.body.style.zoom = '1'; });
  await page.locator('#q').fill('alpha'); assert.equal(await page.locator('.card').count(), 1);
  await page.locator('#q').fill('');
  await fs.mkdir(new URL('../../artifacts/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('../../artifacts/native-collections.png', import.meta.url).pathname });
  checks.push('existing name/path filter and chip semantics and keyboard operation survive light/dark 390/768/1280 layouts at 100/200% zoom with long labels');

  // Exact-file open is separate from advisory collection metadata; markers select no format track.
  await card('empty.PEN').focus(); await page.keyboard.press('Enter'); await page.waitForSelector('#viewport');
  await page.waitForFunction(() => document.querySelector('#loading').hidden); // Static HTML can precede module/shortcut installation.
  assert.equal((await page.request.get(page.url() + 'api/project')).ok(), true);
  assert.equal(boards.get(importedName(empty)).projectPath, importedName(empty), 'a .PEN opens through the Divlet project imported beside it'); assert.equal(boards.get(importedName(empty)).documents.size, 0);
  assert.deepEqual(boards.get(importedName(empty)).externalFiles, []); assert.equal(await fs.readFile(empty, 'utf8'), snapshots.get(empty));
  await page.keyboard.press('Control+o');
  await page.locator('#project .project-path input').fill(collection);
  await page.locator('#project .dir.is-project', { hasText: 'alpha.pen' }).waitFor();
  assert.equal(await page.locator('#project .dir.is-project').count(), 5);
  await page.keyboard.press('Escape');
  checks.push('empty native and picker sibling targets keep exact independent file identities without grants');

  await page.goto(listed.hub.url); await card('future.pen').click(); await page.waitForURL(url => url.href !== listed.hub.url); await page.waitForFunction(() => document.querySelector('#loading')?.hidden);
  const futureBoard = boards.get(importedName(future)); assert.equal(futureBoard.projectPath, importedName(future)); assert.equal(futureBoard.documents.size, 0); assert.equal(futureBoard.settings.name, 'Authored marker label'); assert.equal(await fs.readFile(future, 'utf8'), snapshots.get(future));
  checks.push('exact opening converts the PEN into its Divlet project, honoring the authored name and leaving the PEN untouched');

  await page.goto(listed.hub.url); await card('alpha.pen').click();
  await page.waitForURL(url => url.href !== listed.hub.url);
  await page.waitForFunction(() => document.querySelector('#loading')?.hidden);
  const opened = boards.get(importedName(alpha)); assert.ok(opened); assert.equal(opened.projectPath, importedName(alpha));
  assert.ok(opened.staticSources.has(outside)); assert.notEqual(opened.projectId, boards.get(importedName(empty)).projectId);
  assert.equal(await page.getByRole('region', { name: 'External file needs approval', exact: true }).count(), 0);
  for (const [file, text] of snapshots) assert.equal(await fs.readFile(file, 'utf8'), text);
  assert.deepEqual(errors, []);
  checks.push('collection opening resolves outside resources automatically while preserving every source and sibling identity');
  console.log(JSON.stringify({ status: 'passed', count: checks.length, checks, screenshot: 'artifacts/native-collections.png' }, null, 2));
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await browser?.close(); for (const hub of hubs.values()) await hub.close(); for (const runtime of boards.values()) await runtime.close();
  await fs.rm(root, { recursive: true, force: true });
}
