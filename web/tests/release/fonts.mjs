// Installed CLI/MCP font lifecycle. Only fixtures and Playwright come from the checkout; product code resolves from local tarballs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { rmSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fontBytes } from '../../../core/tests/fixtures/font.js';
import { cffWoff2Bytes } from '../../../core/tests/fixtures/font-woff2.js';

const consumer = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2], 'Usage: node web/tests/release/fonts.mjs <isolated installed consumer>');
const resolve = createRequire(path.join(consumer, 'package.json')).resolve;
for (const name of ['@divlet/core', '@divlet/core/codec', '@divlet/core/project', '@divlet/cli', '@divlet/mcp']) {
  const file = await realpath(resolve(name));
  assert.ok(file.startsWith(consumer + path.sep + 'node_modules' + path.sep) && file.includes(`${path.sep}dist${path.sep}`), `${name} must resolve to the isolated compiled installation: ${file}`);
}
assert.equal((await lstat(path.join(consumer, 'node_modules/@divlet/core'))).isSymbolicLink(), false, 'the product is an installed tarball, not a checkout link');
await assert.rejects(lstat(path.join(consumer, 'node_modules/@divlet/core/core')), { code: 'ENOENT' }, 'no checkout source can rescue installed imports');
await assert.rejects(lstat(path.join(consumer, 'node_modules/typebox')), { code: 'ENOENT' }, 'CLI/MCP fonts do not require Pi peers');
const { decodeHtml } = await import(pathToFileURL(resolve('@divlet/core/codec')));
const { validateSettings, writeProject } = await import(pathToFileURL(resolve('@divlet/core/project')));
const work = await mkdtemp(path.join(os.tmpdir(), 'divlet-installed-fonts-'));
const original = path.join(work, 'original'), copy = path.join(work, 'copy');
const file = path.join(original, 'project.divlet'), copyFile = path.join(copy, 'project.divlet');
const regular = fontBytes(600, { family: 'Null Family' }), bold = cffWoff2Bytes();
const env = { ...process.env, NODE_OPTIONS: '' };
const children = new Set();
let browser, server, cli, mcp, cleaning, aborting = false;
const deadline = setTimeout(() => abort('deadline'), 75000); deadline.unref();
async function cleanup() {
  if (!cleaning) cleaning = (async () => {
    const closeServer = async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
    const results = await Promise.allSettled([closeServer(), browser?.close(), ...[...children].map(stop)]);
    await rm(work, { recursive: true, force: true });
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Installed font cleanup failed');
  })();
  return cleaning;
}
function abort(reason) {
  if (aborting) return; aborting = true;
  const code = reason === 'SIGINT' ? 130 : 143;
  // Leave time before the parent's 90s deadline; escalation touches only this harness's children/workspace.
  const forced = setTimeout(() => {
    for (const state of children) if (!state.closed) state.child.kill('SIGKILL');
    try { rmSync(work, { recursive: true, force: true }); } catch (error) { console.error(error.message); }
    process.exit(code);
  }, 8000); forced.unref();
  cleanup().then(() => {
    clearTimeout(forced);
    console.log(JSON.stringify({ phase: 'abort-cleaned', reason, browserClosed: !browser?.isConnected(), childrenClosed: [...children].every(state => state.closed) }));
    process.exit(code);
  }, error => { console.error(error); process.exit(code); });
}
process.once('SIGTERM', () => abort('SIGTERM'));
process.once('SIGINT', () => abort('SIGINT'));

async function until(check, label) {
  let lastError;
  for (let i = 0; i < 150; i++) { try { if (await check()) return; } catch (error) { lastError = error; } await wait(40); }
  throw new Error('Timed out: ' + label + (lastError ? ': ' + lastError.message : ''));
}
function start(bin, args) {
  const child = spawn(process.execPath, [path.join(consumer, 'node_modules/.bin', bin), ...args], { cwd: consumer, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, stdout: '', stderr: '', error: null, closed: false };
  child.stdout.on('data', chunk => { state.stdout += chunk; }); child.stderr.on('data', chunk => { state.stderr += chunk; });
  child.on('error', error => { state.error = error; });
  state.done = new Promise(resolve => child.once('close', code => { state.closed = true; resolve(code); }));
  children.add(state); return state;
}
async function stop(state) {
  if (!state || state.closed) return;
  state.child.kill('SIGTERM');
  const timer = setTimeout(() => state.child.kill('SIGKILL'), 5000); timer.unref();
  try { await state.done; } finally { clearTimeout(timer); }
}
async function openCli(project) {
  const state = start('divlet', [project, '--no-demo', '--no-watch']);
  await until(() => {
    if (state.error || state.closed) throw state.error || new Error('CLI exited: ' + state.stderr);
    return /divlet (http:\/\/[^\s]+)/.test(state.stdout);
  }, 'installed CLI opens its own board');
  return { url: /divlet (http:\/\/[^\s]+)/.exec(state.stdout)[1], state };
}
function connectMcp() {
  const state = start('divlet-mcp', ['--cwd', original, '--no-demo']);
  const pending = new Map(); let next = 0;
  const lines = createInterface({ input: state.child.stdout });
  const rejectAll = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  lines.on('line', line => {
    try {
      const message = JSON.parse(line), item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
    } catch (error) { rejectAll(error); }
  });
  state.child.on('error', rejectAll);
  state.done.then(() => { lines.close(); rejectAll(new Error('MCP closed: ' + state.stderr)); });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timed out: ' + method + ' ' + state.stderr)); }, 10000);
    pending.set(id, { resolve, reject, timer }); state.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { state, call, tool: async (name, args = {}) => {
    const result = await call('tools/call', { name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  } };
}
async function get(url, route) { const response = await fetch(url + route); assert.equal(response.status, 200, route); return response.json(); }
async function post(url, route, body) {
  const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
}
try {
  await mkdir(original);
  const frame = decodeHtml('<main><span id="sample" style="display:inline-block">AA</span></main>', { fallbackId: 'proof' });
  frame.css = 'main{font-size:100px;line-height:1;color:rgb(220,0,220)}'; frame.artboard.width = 500; frame.artboard.height = 200;
  await writeFile(file, writeProject(validateSettings({ name: 'Installed font proof' }), [frame]));
  const initial = JSON.parse(await readFile(file, 'utf8'));
  cli = await openCli(file);
  mcp = connectMcp();
  await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'installed-font-proof', version: '1' } });
  const listed = await mcp.call('tools/list'); assert.equal(listed.tools.length, 7);
  const attached = await mcp.tool('divlet_open'); assert.equal(attached.url, cli.url, 'installed MCP attaches to the CLI owner, never a second writer');
  const stateBefore = await get(cli.url, 'api/project'), versionBefore = stateBefore.documents.find(frame => frame.id === 'proof').version;
  browser = await chromium.launch({ headless: true, handleSIGTERM: false, handleSIGINT: false, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.PI_DIVLET_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE } : {}) });
  if (process.argv.includes('--abort-after-start')) {
    console.log(JSON.stringify({ phase: 'abort-ready', work, pids: [...children].map(state => state.child.pid) }));
    process.kill(process.pid, 'SIGTERM'); await new Promise(() => {});
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(cli.url); await page.waitForFunction(() => document.querySelector('#loading')?.hidden);
  await page.evaluate(async () => {
    window.installedStore = await import('./lib/store.js'); window.installedCanvas = await import('./lib/canvas.js');
    window.installedStore.selectNodes('proof', ['sample']); window.installedCanvas.setCamera({ x: 40, y: 80, k: 1 });
  });
  const button = page.getByRole('button', { name: 'Upload font', exact: true }); await button.waitFor();
  const iframe = await page.locator('iframe[data-document-id="proof"]').elementHandle();
  const upload = async (bytes, name, mimeType) => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/fonts') && response.request().method() === 'POST');
    const chooser = page.waitForEvent('filechooser'); await button.click(); await (await chooser).setFiles({ name, mimeType, buffer: bytes });
    const reply = await response, body = await reply.json(); await until(() => button.isEnabled(), 'upload settles'); return { status: reply.status(), body };
  };
  assert.equal((await upload(regular, 'regular.ttf', 'font/ttf')).status, 200);
  assert.equal((await upload(bold, 'bold.woff2', 'font/woff2')).status, 200);
  const source = async () => JSON.parse(await readFile(file, 'utf8'));
  const registered = await source(); assert.equal(registered.schemaVersion, 1);
  assert.equal(registered.assets.fonts['regular.ttf'], 'data:font/ttf;base64,' + regular.toString('base64'));
  assert.equal(registered.assets.fonts['bold.woff2'], 'data:font/woff2;base64,' + bold.toString('base64'));
  assert.equal((await get(cli.url, 'api/project')).documents.find(frame => frame.id === 'proof').version, versionBefore, 'registration does not choose a family');
  for (const [name, bytes, mime] of [['regular.ttf', regular, 'font/ttf'], ['bold.woff2', bold, 'font/woff2']]) {
    const response = await fetch(cli.url + 'build/assets/fonts/' + name); assert.equal(response.headers.get('content-type'), mime); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  for (const privateName of ['proof.meta.json', '.divlet-build.json']) assert.equal((await fetch(cli.url + 'build/' + privateName)).status, 404, 'installed serving cannot expose editor sidecars');
  for (const view of ['project', 'frame']) {
    const read = await mcp.tool('divlet_read', { view, ...(view === 'frame' ? { frameId: 'proof' } : {}) });
    assert.ok(!JSON.stringify(read).includes(';base64,'), 'ordinary installed MCP ' + view + ' reads stay payload-free');
  }
  await page.locator('#inspector [data-key=font-family]').click();
  const choice = page.getByRole('menuitemradio', { name: '"Null Family"', exact: true }); assert.equal(await choice.count(), 1); await choice.click();
  const live = page.locator('iframe[data-document-id="proof"]').contentFrame().locator('#sample');
  await until(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 120), 'installed TTF glyphs render120px');
  const current = await mcp.tool('divlet_read', { view: 'frame', frameId: 'proof' });
  await mcp.tool('divlet_patch', { frameId: 'proof', expectedVersion: current.version, label: 'Use installed bold companion', patch: { nodes: { sample: { style: { 'font-weight': '700' } } } } });
  await until(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 180), 'installed CFF WOFF2 glyphs render180px');
  const accepted = await readFile(file, 'utf8'), history = await get(cli.url, 'api/history');
  const overlap = await upload(bold, 'overlap.woff2', 'font/woff2'); assert.equal(overlap.status, 400); assert.equal(overlap.body.error, 'FONT_CONFLICT');
  assert.equal(await readFile(file, 'utf8'), accepted); assert.deepEqual(await get(cli.url, 'api/history'), history);
  await mcp.tool('divlet_undo'); await until(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 120), 'MCP Undo shares the installed owner history');
  for (let i = 0; i < 3; i++) await mcp.tool('divlet_undo');
  const undone = await source();
  assert.deepEqual({ assets: undone.assets, css: undone.css }, { assets: initial.assets, css: initial.css }, 'both registrations undo independently, including canonical omission of empty wire fields');
  for (let i = 0; i < 4; i++) await mcp.tool('divlet_undo', { redo: true });
  await until(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 180), 'installed Redo restores exact font matching');
  assert.equal(await iframe.evaluate(node => node.isConnected && node === document.querySelector('iframe[data-document-id="proof"]')), true);
  await page.waitForFunction(() => { const entry = window.installedCanvas.entries.get('proof'); return entry.shot?.render === entry.doc.render; });
  const ink = await page.evaluate(async () => {
    const image = new Image(); image.src = window.installedCanvas.entries.get('proof').shot.url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let min = Infinity, max = -Infinity, count = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) { const i = (y * canvas.width + x) * 4; if (data[i] > 150 && data[i + 1] < 100 && data[i + 2] > 150) { min = Math.min(min, x); max = Math.max(max, x); count++; } }
    return { width: max - min + 1, count };
  });
  assert.ok(Math.abs(ink.width - 150) <= 2 && ink.count > 3500, JSON.stringify(ink));
  const exported = await get(cli.url, 'api/export/proof'); assert.ok(exported.html.includes(bold.toString('base64')));
  // Publish only this explicitly authored fixture's known public files, never runtime.info or a raw cache-directory copy.
  const publication = new Map();
  for (const [name, type] of [['proof.html', 'text/html;charset=utf-8'], ['assets/fonts/regular.ttf', 'font/ttf'], ['assets/fonts/bold.woff2', 'font/woff2']]) {
    const bytes = await readFile(path.join(original, '.divlet/project', name));
    if (name.endsWith('.html')) { assert.ok(!bytes.includes(Buffer.from(work))); assert.ok(!bytes.includes(Buffer.from(consumer)), 'curated prepared content has no private installation or workspace path'); }
    publication.set('/prefix/' + name, { bytes, type });
  }
  const originalSource = await readFile(file, 'utf8'), beforeCopy = await get(cli.url, 'api/project');
  const copied = await post(cli.url, 'api/save-project', { path: copy, expectedVersion: beforeCopy.project.version, expectedFormat: 'divlet' });
  const copyInfo = await get(copied.url, 'api/project'); assert.notEqual(copyInfo.projectId, beforeCopy.projectId);
  assert.deepEqual(JSON.parse(await readFile(copyFile, 'utf8')).assets, (await source()).assets);
  await post(copied.url, 'api/patch', { documentId: 'proof', expectedVersion: copyInfo.documents.find(frame => frame.id === 'proof').version, patch: { nodes: { sample: { style: { 'font-size': '120px' } } } } });
  assert.equal(await readFile(file, 'utf8'), originalSource, 'editing a copied owner never changes the original');
  mcp.state.child.stdin.end(); assert.equal(await Promise.race([mcp.state.done, wait(5000, undefined, { ref: false }).then(() => { throw new Error('installed MCP did not stop on EOF'); })]), 0);
  assert.equal((await fetch(cli.url)).status, 200, 'closing an attached MCP peer must not close the CLI owner');
  await stop(cli.state); cli = null;
  await rm(original, { recursive: true, force: true }); await rm(path.join(copy, '.divlet'), { recursive: true, force: true });
  cli = await openCli(copyFile); await page.goto(cli.url); await page.waitForFunction(() => document.querySelector('#loading')?.hidden);
  await until(() => live.evaluate(node => Math.round(node.getBoundingClientRect().width) === 216), 'independent copy rebuilds fonts without original project or cache');
  assert.deepEqual(Buffer.from((await readFile(path.join(copy, '.divlet/project/assets/fonts/bold.woff2')))), bold);
  await stop(cli.state); cli = null;
  publication.set('/prefix/portable.html', { bytes: Buffer.from(exported.html), type: 'text/html;charset=utf-8' });
  server = createServer((request, response) => {
    const item = publication.get(request.url); if (!item) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': item.type, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; font-src 'self' data:; img-src data:; script-src 'none'" }); response.end(item.bytes);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port, portable = await browser.newPage(), requested = [];
  portable.on('request', request => requested.push(request.url()));
  for (const name of ['proof.html', 'portable.html']) {
    await portable.goto(origin + '/prefix/' + name); await portable.evaluate(() => document.fonts.ready);
    assert.equal(await portable.locator('#sample').evaluate(node => Math.round(node.getBoundingClientRect().width)), 180, name + ' renders independently under a prefix after the installed board stops');
    if (name === 'proof.html') {
      await portable.locator('#sample').evaluate(async node => { node.style.fontWeight = '400'; await node.ownerDocument.fonts.load('100px "Null Family"', 'AA'); });
      assert.equal(await portable.locator('#sample').evaluate(node => Math.round(node.getBoundingClientRect().width)), 120, 'the prefixed host also decodes the conventionally named TTF face');
    }
  }
  assert.ok(requested.every(url => url.startsWith(origin + '/prefix/') || url.startsWith('data:')), 'no live board, checkout or foreign dependency rescues static rendering');
  assert.ok(requested.some(url => url.endsWith('/prefix/assets/fonts/bold.woff2')), 'the controlled static host actually serves the conventionally named compressed font');
  for (const privateName of ['proof.meta.json', '.divlet-build.json']) assert.equal((await fetch(origin + '/prefix/' + privateName)).status, 404);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', compiledInstallation: true, cliOwnerMcpAttachment: true, glyphAdvances: [120, 180, 216], snapshotInk: ink.width, independentCopyRebuild: true, prefixedStaticAndExport: true, piRequired: false }));
} catch (error) { if (!aborting) throw error; }
finally { try { await cleanup(); } finally { clearTimeout(deadline); } }

