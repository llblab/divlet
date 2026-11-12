import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openRuntime } from '../lib/runtime.js';
import { decodeHtml } from '../lib/codec.ts';
import { readAssets } from '../lib/assets.ts';
import { fontFaceRules } from '../lib/font-css.ts';
import { readFont } from '../lib/font.ts';
import { fontBytes, fontFamily } from './fixtures/font.js';
import { legacyProject } from './fixtures/legacy-project.js';

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-font-upload-'));
  await legacyProject(path.join(directory, 'project.divlet'));
  const runtime = await openRuntime({ file: path.join(directory, 'project.divlet'), watch: false, createDemo: false });
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return runtime;
}
const upload = (runtime, extra = {}) => runtime.saveFont({ name: 'Device.ttf', data: fontBytes(), expectedVersion: runtime.settings.version, ...extra });
const snapshot = async runtime => ({ source: await fs.readFile(runtime.projectPath, 'utf8'), state: runtime.info(), history: runtime.readHistory() });

test('font registration is one ordinary CSS/common-byte project commit with payload-free reads and grouped Undo/Redo', async t => {
  const runtime = await setup(t), css = runtime.settings.css, assets = structuredClone(runtime.settings.assets), revision = runtime.revision;
  const bytes = fontBytes(600, { weight: 700, italic: true, width: 3 }), saved = await upload(runtime, { name: 'Wrong.woff2', data: bytes });
  assert.equal(saved.file, 'fonts/wrong.ttf'); assert.equal(saved.family, fontFamily); assert.equal(runtime.revision, revision + 1);
  assert.ok(runtime.settings.css.startsWith(css));
  assert.match(runtime.settings.css, /font-weight:700;font-style:italic;font-stretch:75%/);
  assert.ok(runtime.settings.css.includes(saved.path));
  const resource = readAssets(runtime.settings.assets).files.get(saved.file);
  assert.deepEqual(Buffer.from(resource.bytes), bytes); assert.equal(resource.mediaType, 'font/ttf');
  assert.ok(!JSON.stringify(runtime.info()).includes(';base64,'));
  assert.equal(runtime.info().project.capabilities.fontUpload.maxBytes, 20 * 1024 * 1024);
  const accepted = structuredClone(runtime.settings.assets), acceptedCss = runtime.settings.css;
  await runtime.undo(); assert.deepEqual(runtime.settings.assets, assets); assert.equal(runtime.settings.css, css);
  await runtime.redo(); assert.deepEqual(runtime.settings.assets, accepted); assert.equal(runtime.settings.css, acceptedCss);
  assert.deepEqual(JSON.parse(await fs.readFile(runtime.projectPath, 'utf8')).assets, accepted);
});

test('font allocation preserves directories, unused bytes and portable aliases; input bytes are copied before enqueue', async t => {
  const runtime = await setup(t), original = { 'device.ttf': { keep: 'data:font/ttf;base64,AQ==' }, 'device-2.ttf': {}, 'DEVICE-3.TTF': 'data:font/ttf;base64,Ag==' };
  await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { assets: { fonts: original } } });
  const bytes = fontBytes(), before = Buffer.from(bytes), pending = upload(runtime, { data: bytes }); bytes.fill(0);
  const result = await pending; assert.equal(result.file, 'fonts/device-4.ttf');
  for (const [name, value] of Object.entries(original)) assert.deepEqual(runtime.settings.assets.fonts[name], value);
  assert.deepEqual(Buffer.from(readAssets(runtime.settings.assets).files.get(result.file).bytes), before);
});

test('invalid/stale/concurrent font registrations retain the last accepted source and history', async t => {
  const runtime = await setup(t), before = await snapshot(runtime);
  for (const extra of [{ expectedVersion: undefined }, { expectedVersion: 0 }, { data: Buffer.from('bad font') }]) {
    await assert.rejects(upload(runtime, extra)); assert.deepEqual(await snapshot(runtime), before);
  }
  const version = runtime.settings.version;
  const results = await Promise.allSettled([upload(runtime, { expectedVersion: version }), upload(runtime, { expectedVersion: version, data: fontBytes(600, { family: 'Other' }) })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'REVISION_CONFLICT');
  assert.equal(readAssets(runtime.settings.assets).files.size, 1);
});

test('same-family declarations including escapes/case/conditional frames refuse without shadowing or partial bytes', async t => {
  const runtime = await setup(t);
  await runtime.create({ document: decodeHtml('<main>Font</main>', { fallbackId: 'type' }) });
  await runtime.patch({ documentId: 'type', expectedVersion: 1, patch: { css: '@media print{@font-face{font-family:"\\44 ivlet Test";src:local("Some Face")}}' } });
  const before = await snapshot(runtime);
  await assert.rejects(upload(runtime), { code: 'FONT_CONFLICT' }); assert.deepEqual(await snapshot(runtime), before);
  const result = await upload(runtime, { data: fontBytes(600, { family: 'Distinct Face' }) }); assert.equal(result.family, 'Distinct Face');
  const accepted = await snapshot(runtime); await assert.rejects(upload(runtime, { data: fontBytes(600, { family: 'distinct face', weight: 700 }) }), { code: 'FONT_CONFLICT' });
  assert.deepEqual(await snapshot(runtime), accepted, 'additional faces in an existing family need an explicit merge, not automatic shadowing');
});

test('unquoted CSS escape terminators cannot bypass the non-shadowing family boundary', async t => {
  const runtime = await setup(t);
  for (const family of ['\\44 ivlet Test', '\\44\tivlet Test', '\\000044ivlet Test']) {
    const css = `@font-face{font-family:${family};src:local("Original");font-weight:400}`;
    const face = readFont(fontBytes());
    assert.throws(() => fontFaceRules(face, 'asset:fonts/a.ttf', { files: new Map(), mediaTypes: new Map(), generated: new Set(), authored: [css] }), { code: 'FONT_CONFLICT' }, family);
    await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { css } });
    const before = await snapshot(runtime); await assert.rejects(upload(runtime), { code: 'FONT_CONFLICT' });
    assert.deepEqual(await snapshot(runtime), before, 'source, assets, revision and history remain unchanged');
  }
});

test('Unicode caseless family variants cannot shadow existing faces or rewrite authored identities', async t => {
  const runtime = await setup(t);
  for (const [existing, incoming] of [['ΟΣ', 'οσ'], ['STRASSE', 'Straße'], ['Kelvin', 'kelvin']]) {
    await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { css: `@font-face{font-family:"${existing}";src:local(Original)}` } });
    const before = await snapshot(runtime);
    await assert.rejects(upload(runtime, { data: fontBytes(600, { family: incoming }) }), { code: 'FONT_CONFLICT' });
    assert.deepEqual(await snapshot(runtime), before);
  }
  const before = await snapshot(runtime);
  await assert.rejects(upload(runtime, { data: fontBytes(600, { family: 'Unknown \u0378' }) }), { code: 'FONT_CONFLICT' });
  assert.deepEqual(await snapshot(runtime), before, 'unknown host Unicode mappings are refused, never guessed or rewritten');
});

test('registration scans authored sheets even without pages, actual public CSS and uninspectable imports/links', () => {
  const face = readFont(fontBytes()), rules = (files, media = new Map(), css = [], generated = new Set()) => fontFaceRules(face, 'asset:fonts/a.ttf', { files: new Map(files), mediaTypes: media, authored: css, generated });
  assert.throws(() => rules([], new Map(), ['@font-face{font-family:DIVLET TEST;src:local(Other)}']), { code: 'FONT_CONFLICT' });
  assert.throws(() => rules([['theme', '@font-face{font-family:"Divlet Test";src:local(Other)}']], new Map([['theme', 'text/css']])) , { code: 'FONT_CONFLICT' });
  assert.throws(() => rules([['index.html', '<link rel="stylesheet" href="https://example.test/fonts.css">']]), { code: 'FONT_CONFLICT' });
  assert.throws(() => rules([['main.css', '@IMPORT "other.css";']], new Map([['main.css', 'text/css']])), { code: 'FONT_CONFLICT' });
  assert.throws(() => rules([['main.css', '@font-face{font-family:var(--face);src:local(Other)}']], new Map([['main.css', 'text/css']])), { code: 'FONT_CONFLICT' });
  assert.match(rules([['index.html', '<link rel="stylesheet" href="main.css">'], ['main.css', 'main{color:red}']], new Map(), [], new Set(['main.css'])), /asset:fonts\/a.ttf/);
  assert.throws(() => rules([['mutable.css', 'body{color:red}']]), { code: 'FONT_CONFLICT' }, 'mutable legacy files cannot change between namespace inspection and candidate preparation');
  assert.match(rules([['binary.html', Buffer.from([255])]], new Map([['binary.html', 'font/ttf']])), /@font-face/, 'declared MIME precedes misleading filenames');
  const injected = readFont(fontBytes(600, { family: 'Family " </style><script>' }));
  assert.ok(!fontFaceRules(injected, 'asset:fonts/a.ttf', { files: new Map(), mediaTypes: new Map(), generated: new Set(), authored: [] }).includes('</style>'), 'CSS strings cannot close the HTML style element');
});

test('HTTP font endpoint enforces binary transport, metadata and expected project version', async t => {
  const runtime = await setup(t), before = await snapshot(runtime);
  const send = (type, suffix = '') => fetch(runtime.url + `api/fonts?name=font.ttf${suffix}`, { method: 'POST', headers: { 'Content-Type': type, Origin: new URL(runtime.url).origin }, body: fontBytes() });
  assert.equal((await send('font/ttf')).status, 400);
  assert.equal((await send('application/octet-stream')).status, 409);
  assert.deepEqual(await snapshot(runtime), before);
  const response = await send('application/octet-stream', `&expectedVersion=${runtime.settings.version}`);
  assert.equal(response.status, 200); assert.equal((await response.json()).family, fontFamily);
});

test('reopening the canonical project rebuilds uploaded font bytes and CSS after deleting the disposable cache', async t => {
  const runtime = await setup(t);
  await runtime.create({ document: decodeHtml('<main>AA</main>', { fallbackId: 'type' }) });
  const bytes = fontBytes(), result = await upload(runtime), file = runtime.projectPath, output = runtime.output.directory, css = runtime.settings.css;
  await runtime.close(); await fs.rm(output, { recursive: true });
  const rebuilt = await openRuntime({ file, watch: false, createDemo: false });
  try {
    assert.equal(rebuilt.settings.css, css);
    const response = await fetch(rebuilt.url + 'build/assets/' + result.file);
    assert.equal(response.headers.get('content-type'), 'font/ttf');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.deepEqual(Buffer.from(readAssets(rebuilt.settings.assets).files.get(result.file).bytes), bytes);
  } finally { await rebuilt.close(); }
});

test('unowned output collisions refuse the entire font candidate', async t => {
  const runtime = await setup(t);
  await runtime.create({ document: decodeHtml('<main>Font</main>', { fallbackId: 'type' }) });
  const output = path.join(runtime.output.directory, 'assets/fonts'); await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'device.ttf'), 'unowned');
  const before = await snapshot(runtime); await assert.rejects(upload(runtime));
  assert.deepEqual(await snapshot(runtime), before); assert.equal(await fs.readFile(path.join(output, 'device.ttf'), 'utf8'), 'unowned');
});
