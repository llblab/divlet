// Open any project and save a copy from the board's project menu (the folders are chosen on the server).
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../core/lib/runtime.js';
import { launch, makeHost } from '../../core/lib/launch.ts';

const playwright = await import('playwright');
const root = await mkdtemp(path.join(os.tmpdir(), 'divlet-open-'));
const examples = fileURLToPath(new URL('../../examples/studio/', import.meta.url));
await cp(examples, path.join(root, 'work', 'first'), { recursive: true });
await mkdir(path.join(root, 'work', 'second'));
await writeFile(path.join(root, 'work', 'second', 'project.divlet'), JSON.stringify({ schemaVersion: 1, name: 'Second project', version: 1, tokens: {}, css: '', metadata: {}, frames: [] }));
await mkdir(path.join(root, 'empty-folder'));
await mkdir(path.join(root, 'busy'));
await writeFile(path.join(root, 'busy', 'notes.txt'), 'hello');
await mkdir(path.join(root, 'work', 'first', 'assets'), { recursive: true });
await writeFile(path.join(root, 'work', 'first', 'assets', 'logo.txt'), 'asset');

const boards = new Map();
const hubs = new Map();
const openBoard = async location => {
  const key = location.file || location.cwd;
  if (!boards.has(key)) { const runtime = await openRuntime({ ...location, createDemo: false, watch: false }); runtime.host = host; boards.set(key, runtime); }
  return boards.get(key);
};
const host = makeHost({ openBoard, hubs });
const first = await launch(path.join(root, 'work', 'first'), { openBoard, hubs });

const launchOptions = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launchOptions.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const errors = [];
const checks = [];
let browser;
try {
  browser = await playwright.chromium.launch(launchOptions);
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 860 }, permissions: ['clipboard-read', 'clipboard-write'] })).newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/409|400|404/.test(message.text())) errors.push(message.text()); });
  await page.goto(first.runtime.info().url);
  await page.waitForFunction(() => document.querySelectorAll('.artboard').length === 5);
  const menuItem = text => page.locator('.menu .menu-item', { hasText: text }).first();

  // Exercise the shared controller in a real DOM with a controlled read port, without replacing the board's host.
  const pickerChecks = await page.evaluate(async () => {
    const { filePicker, directoryPath } = await import('./lib/file-picker.js');
    const reads = [], snapshots = [], selected = [], folderSelected = [];
    const listing = path => ({ path, directory: '/new', parent: '/', kind: 'project', dirs: [{ name: 'folder' }], files: [{ name: 'one.divlet', file: '/new/one.divlet', project: true }] });
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const picker = filePicker({ label: 'Test path', read: path => new Promise((resolve, reject) => reads.push({ path, resolve, reject })), onChange: state => snapshots.push(state), onSubmit: info => selected.push(info.path) });
    const folders = filePicker({ label: 'Test folder', includeFiles: false, read: async () => listing('/new'), onSubmit: info => folderSelected.push(info.path) });
    document.body.append(picker.element, folders.element);
    try {
      const older = picker.load('/old'), newer = picker.load('/new');
      reads[1].resolve(listing('/new')); await newer;
      reads[0].resolve(listing('/old')); await older;
      check(picker.state.info.path === '/new', 'a late success cannot replace the current directory');
      const staleError = picker.load('/stale-error'), fresh = picker.load('/fresh');
      reads[3].resolve(listing('/fresh')); await fresh;
      reads[2].reject(new Error('Late refusal')); await staleError;
      check(picker.state.info.path === '/fresh' && !picker.state.error, 'a stale refusal cannot replace a newer success');
      const row = picker.element.querySelector('[data-name="one.divlet"]');
      row.click();
      check(picker.state.pending && !picker.state.info, 'navigation immediately invalidates the previous selection');
      reads[4].resolve(listing('/new/one.divlet')); await Promise.resolve(); await Promise.resolve();
      check(picker.element.querySelector('[data-name="one.divlet"]') === row, 'same-directory file selection keeps row identity');
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await Promise.resolve(); await Promise.resolve();
      check(selected.length === 1 && selected[0] === '/new/one.divlet', 'double-click activates the resolved file without another listing');
      const enter = () => picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const waiting = picker.load('/pending-enter'); enter();
      reads.at(-1).resolve(listing('/pending-enter')); await waiting; await Promise.resolve();
      check(selected.at(-1) === '/pending-enter', 'Enter waits for the current read before selecting');
      picker.input.value = '/debounced-enter'; picker.input.dispatchEvent(new Event('input', { bubbles: true })); enter();
      check(reads.at(-1).path === '/debounced-enter', 'Enter flushes the pending path debounce');
      reads.at(-1).resolve(listing('/debounced-enter')); await Promise.resolve(); await Promise.resolve();
      check(selected.at(-1) === '/debounced-enter', 'debounced Enter selects the resolved path');
      const cancelled = picker.load('/cancelled-enter'); enter();
      const choices = selected.length;
      picker.input.value = '/replacement'; picker.input.dispatchEvent(new Event('input', { bubbles: true }));
      reads.at(-1).resolve(listing('/cancelled-enter')); await cancelled; await Promise.resolve();
      check(selected.length === choices, 'new typing cancels an Enter waiting for an older read');
      const failure = picker.load('/refused'); reads.at(-1).reject(new Error('Listing refused')); await failure;
      check(picker.state.error === 'Listing refused' && !picker.state.info, 'a current refusal clears selection and exposes its message');
      const held = picker.load('/held');
      picker.input.value = '/typed'; picker.input.dispatchEvent(new Event('input', { bubbles: true }));
      reads.at(-1).resolve(listing('/held')); await held;
      check(picker.state.pending && !picker.state.info, 'typing invalidates an in-flight result before the debounce fires');
      const count = snapshots.length, requests = reads.length;
      picker.dispose(); await new Promise(resolve => setTimeout(resolve, 180));
      check(snapshots.length === count && reads.length === requests, 'disposal cancels the pending debounce');
      await folders.load('/new');
      check(folders.element.querySelectorAll('.dir').length === 1 && !folders.element.querySelector('[data-name="one.divlet"]'), 'folder mode excludes project files');
      const late = folders.load('/closing');
      folders.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      folders.dispose(); await late; await Promise.resolve();
      check(folders.state.info === null && folderSelected.length === 0, 'disposal cancels both the late read and its waiting Enter');
      check(directoryPath('/tmp') === '/tmp/' && directoryPath('C:\\work') === 'C:\\work\\' && directoryPath('/') === '/', 'shared joining preserves POSIX and Windows separators');
      return ['latest-success/refusal wins', 'stable file rows and double-click', 'pending/debounced Enter and cancellation', 'immediate input invalidation', 'disposal cancels debounce/late completion', 'folder-only filtering and path separators'];
    } finally { picker.dispose(); folders.dispose(); picker.element.remove(); folders.element.remove(); }
  });
  assert.equal(pickerChecks.length, 6);
  checks.push(`shared filesystem picker: ${pickerChecks.join('; ')}`);

  // The project menu on the indicator.
  await page.locator('#status').click();
  await menuItem('Open project…').waitFor();
  assert.ok(await menuItem('Save a copy as…').isVisible());
  await menuItem('Copy project folder path').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), path.join(root, 'work', 'first'));
  checks.push('the project indicator opens a menu with Open, Save a copy and Copy path');

  // Open starts in the source folder so sibling project files can be selected.
  await page.keyboard.press('Control+o');
  await page.locator('#project').waitFor();
  assert.equal(await page.locator('#project-title').textContent(), 'Open project');
  assert.equal(await page.locator('#project .file-picker').count(), 1);
  assert.equal(await page.locator('#project .file-picker-path input').inputValue(), path.join(root, 'work', 'first') + '/');
  await page.locator('#project .dir.is-project', { hasText: 'project.divlet' }).waitFor();
  await page.getByRole('button', { name: 'Parent folder', exact: true }).click();
  await page.locator('#project .dir.is-project', { hasText: 'second' }).waitFor();
  assert.equal(await page.locator('#project .dir.is-project').count(), 2);
  // Make the longest action exceed the old pixel floor on every host, not only the CI font stack.
  await page.locator('#project .project-go').evaluate(node => { node.style.font = '600 14px monospace'; });
  await page.locator('#project .file-picker-path input').fill(path.join(root, 'empty-folder'));
  await page.locator('#project').getByRole('button', { name: 'Create project here', exact: true }).waitFor();
  const stable = () => page.evaluate(() => ['.file-picker-path', '.dir-list', '.project-go'].map(q => { const r = document.querySelector('#project ' + q).getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), Math.round(r.height)]; }));
  const quiet = await stable();
  await page.locator('#project .file-picker-path input').fill(path.join(root, 'nope', 'missing'));
  await page.locator('#project .project-status', { hasText: 'does not exist' }).waitFor();
  assert.deepEqual(await stable(), quiet, 'an error message appears below the controls without moving the path field, list or action button');
  assert.equal(await page.evaluate(() => !!(document.querySelector('#project .project-go').compareDocumentPosition(document.querySelector('#project .project-status')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  assert.equal(await page.locator('#project .project-go').isDisabled(), true);
  await page.locator('#project .project-go').evaluate(node => { node.style.font = ''; });
  await page.locator('#project .file-picker-path input').fill(path.join(root, 'work') + '/');
  await page.locator('#project .dir', { hasText: 'second' }).click();
  await page.locator('#project .dir.is-project', { hasText: 'project.divlet' }).click();
  assert.equal(await page.locator('#project .file-picker-path input').inputValue(), path.join(root, 'work', 'second', 'project.divlet'));
  await page.locator('#project').getByRole('button', { name: 'Open project', exact: true }).waitFor();
  await Promise.all([page.waitForURL(url => url.href !== first.runtime.info().url), page.keyboard.press('Enter')]);
  await page.waitForFunction(() => document.title.startsWith('second ·'));
  assert.equal((await page.locator('#project-name').textContent()).trim(), 'DIVLET');
  assert.equal(await page.locator('#empty').isVisible(), true, 'the other project opened (it is empty)');
  checks.push('Open project lists folders, tags projects, validates the path and switches the board');

  // Create a project in an existing empty folder.
  await page.keyboard.press('Control+o');
  await page.locator('#project .file-picker-path input').fill(path.join(root, 'empty-folder'));
  await page.locator('#project').getByRole('button', { name: 'Create project here', exact: true }).click();
  await page.waitForFunction(() => document.title.startsWith('empty-folder ·'));
  assert.ok((await readdir(path.join(root, 'empty-folder'))).includes('project.divlet'));
  await page.waitForFunction(() => document.querySelector('#loading')?.hidden);
  const nativeFile = path.join(root, 'empty-folder/project.divlet'), nativeSeed = JSON.parse(await readFile(nativeFile, 'utf8'));
  assert.deepEqual(nativeSeed, { schemaVersion: 1, name: 'Untitled project', version: 1, tokens: {}, css: '', metadata: {}, frames: [] }); await page.locator('#empty-new').waitFor();
  await page.setViewportSize({ width: 390, height: 860 }); await page.evaluate(async () => (await import('./lib/help.js')).setUiSize(200));
  await page.locator('#empty-new').scrollIntoViewIfNeeded(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/native-created-empty.png' });
  await page.locator('#empty-new').click(); await page.locator('.artboard').waitFor();
  const firstNative = JSON.parse(await readFile(nativeFile, 'utf8')); assert.equal(firstNative.frames.length, 1); assert.equal(firstNative.schemaVersion, 1);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#loading')?.hidden); await page.locator('.artboard').waitFor();
  await page.setViewportSize({ width: 1300, height: 860 }); await page.evaluate(async () => (await import('./lib/help.js')).setUiSize(100));
  checks.push('Create here publishes an empty Divlet project; 390px/200% first-frame creation and reload retain it');

  // Save a copy: from the first project, to a new folder.
  await page.goto(first.runtime.info().url);
  await page.waitForFunction(() => document.querySelectorAll('.artboard').length === 5);
  await page.keyboard.press('Control+Shift+S');
  await page.locator('#project-title', { hasText: 'Save a copy' }).waitFor();
  assert.match(await page.locator('#project .file-picker-path input').inputValue(), /first-copy$|divlet-examples-copy$/);
  await page.locator('#project .file-picker-path input').fill(path.join(root, 'busy'));
  await page.locator('#project .project-go').click();
  await page.locator('#toast', { hasText: 'not empty' }).waitFor();
  assert.equal(path.basename(page.url()).length > 0, true, 'a refused save stays on this board');
  await page.locator('#project .file-picker-path input').fill(path.join(root, 'work', 'first', 'inside'));
  await page.locator('#toast').waitFor({ state: 'hidden' }).catch(() => {});
  await page.locator('#project .project-go').click();
  await page.locator('#toast', { hasText: 'outside this project' }).waitFor();
  const target = path.join(root, 'saved', 'copy-of-first');
  await page.locator('#project .file-picker-path input').fill(target);
  await page.locator('#project .project-status', { hasText: 'Will create' }).waitFor();
  await Promise.all([page.waitForURL(url => url.href !== first.runtime.info().url), page.locator('#project').getByRole('button', { name: 'Save here', exact: true }).click()]);
  await page.waitForFunction(() => document.querySelectorAll('.artboard').length === 5);
  const saved = await readdir(target);
  assert.ok(saved.includes('project.divlet') && saved.includes('assets') && saved.includes('.divlet'), `the copy holds the project, its assets and managed build (${saved})`);
  assert.ok(!saved.includes('welcome.html'), 'generated pages do not sit beside the source');
  assert.ok((await readdir(path.join(target, '.divlet', 'project'))).includes('welcome.html'));
  assert.equal(await readFile(path.join(target, 'assets', 'logo.txt'), 'utf8'), 'asset');
  assert.ok(!saved.includes('.trash'));
  assert.ok((await page.title()).startsWith('copy-of-first ·'));
  assert.equal(await page.locator('#status').getAttribute('data-project'), 'copy-of-first');
  assert.equal(first.runtime.info().documents.length, 5, 'the original is untouched');
  checks.push('Save a copy refuses busy and inner folders, then copies project, pages and assets and opens the copy');

  const pen = path.join(root, 'work', 'second', 'portable.pen');
  const penSource = JSON.stringify({ version: '2.21', children: [] });
  await writeFile(pen, penSource);
  await page.keyboard.press('Control+o');
  await page.locator('#project .file-picker-path input').fill(path.dirname(pen));
  await page.locator('#project .dir.is-project', { hasText: 'portable.pen' }).click();
  assert.equal(await page.locator('#project .file-picker-path input').inputValue(), pen);
  await page.locator('#project').getByRole('button', { name: 'Open project', exact: true }).waitFor();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.title === 'portable · divlet');
  assert.equal(await page.locator('#status').getAttribute('data-project'), 'portable');
  assert.equal(await page.locator('#empty').isVisible(), true);
  assert.equal(await readFile(pen, 'utf8'), penSource);
  assert.equal(JSON.parse(await readFile(path.join(root, 'work', 'second', 'portable.divlet'), 'utf8')).schemaVersion, 1, 'the converted project sits beside it');
  checks.push('Open project lists a .pen file, converts it into a sibling Divlet project and opens that, leaving the .pen unchanged');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', count: checks.length, checks }, null, 2));
} catch (error) {
  console.error(error);
  if (errors.length) console.error('browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const hub of hubs.values()) await hub.close();
  for (const runtime of boards.values()) await runtime.close();
  await rm(root, { recursive: true, force: true });
}
