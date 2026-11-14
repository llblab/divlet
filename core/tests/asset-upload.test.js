import test from 'node:test';
import { legacyProject } from './fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openRuntime } from '@divlet/core/runtime';
import { decodeHtml } from '../lib/codec.ts';
import { DivletError } from '../lib/model.ts';
import { readAssets } from '../lib/assets.ts';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-upload-')), runtimes = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const open = async (name = 'project.divlet') => { await legacyProject(path.join(root, name)); const runtime = await openRuntime({ file: path.join(root, name), watch: false, createDemo: false }); runtimes.push(runtime); return runtime; };
  return { root, directory: path.join(root, 'assets'), open };
}
const upload = (runtime, data = Buffer.from('image'), name = 'Photo.PNG', extra = {}) => runtime.saveAsset({ name, data, ...extra });
const stored = (runtime, key) => Buffer.from(readAssets(runtime.settings.assets).files.get(key).bytes);
const state = runtime => ({ info: runtime.info(), history: runtime.readHistory() });

test('retired reuse remains synchronous and does not inspect input or change state', async t => {
  const f = await setup(t), runtime = await f.open(), before = state(runtime), source = await fs.readFile(runtime.projectPath);
  const opaque = new Proxy({}, { get() { throw new Error('Retired input must not be read'); }, ownKeys() { throw new Error('Retired input must not be enumerated'); } });
  for (const input of [undefined, null, {}, opaque]) assert.throws(() => runtime.reuseImage(input), error => error instanceof DivletError && error.code === 'UNSUPPORTED_OPERATION');
  assert.deepEqual(state(runtime), before); assert.deepEqual(await fs.readFile(runtime.projectPath), source);
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
});

test('supported image uploads become exact shared project bytes, concise catalog entries and undoable content', async t => {
  const f = await setup(t), runtime = await f.open();
  for (const extension of ['PNG', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif']) {
    const bytes = extension === 'svg' ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') : Buffer.from([0, 255, 12, 34]);
    const version = runtime.settings.version, result = await upload(runtime, bytes, `My Photo.${extension}`);
    assert.equal(result.path, `asset:images/my-photo.${extension.toLowerCase()}`);
    assert.equal(result.version, version + 1);
    assert.deepEqual(stored(runtime, result.file), bytes);
    assert.deepEqual(Buffer.from(readAssets(JSON.parse(await fs.readFile(runtime.projectPath, 'utf8')).assets).files.get(result.file).bytes), bytes);
  }
  assert.equal((await runtime.listAssets()).assets.filter(item => item.path.startsWith('asset:')).length, 7);
  assert.ok(!JSON.stringify(runtime.info()).includes(';base64,'));
  await runtime.undo(); assert.ok(!readAssets(runtime.settings.assets).files.has('images/my-photo.avif'));
  await runtime.redo(); assert.deepEqual(stored(runtime, 'images/my-photo.avif'), Buffer.from([0, 255, 12, 34]));
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
});

test('declared upload MIME survives independently of the filename and controls SVG interpretation', async t => {
  const f = await setup(t), runtime = await f.open();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', mediaType = 'image/svg+xml;charset=utf-8';
  const response = await fetch(runtime.url + 'api/assets?name=vector.png', { method: 'POST', headers: { 'Content-Type': mediaType, Origin: new URL(runtime.url).origin }, body: svg });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(readAssets(runtime.settings.assets).files.get(result.file).mediaType, mediaType);
  await runtime.create({ document: decodeHtml(`<main><img src="${result.path}"></main>`, { fallbackId: 'image' }) });
  assert.equal((await fetch(runtime.url + 'build/assets/' + result.file)).headers.get('content-type'), mediaType);
  const before = state(runtime), source = await fs.readFile(runtime.projectPath);
  await assert.rejects(upload(runtime, Buffer.from('<svg><script/></svg>'), 'vector.png', { mediaType }), { code: 'INVALID_ASSET' });
  await assert.rejects(upload(runtime, Buffer.from('x'), 'other.png', { mediaType: 'text/html' }), { code: 'UNSUPPORTED_ASSET' });
  assert.deepEqual(state(runtime), before); assert.deepEqual(await fs.readFile(runtime.projectPath), source);
});

test('upload allocation reserves populated/empty directories and portable file aliases without deleting authored content', async t => {
  const f = await setup(t), runtime = await f.open();
  const original = { images: { 'photo.png': { keep: 'data:image/png;base64,a2VlcA==' }, 'photo-2.png': {}, 'Photo-3.PNG': 'data:image/png;base64,AQ==' } };
  await runtime.patchProject({ expectedVersion: 1, patch: { assets: original } });
  const result = await upload(runtime, Buffer.from('new'), 'photo.png');
  assert.equal(result.path, 'asset:images/photo-4.png');
  const accepted = { images: { ...original.images, 'photo-4.png': 'data:image/png;base64,bmV3' } };
  assert.deepEqual(runtime.settings.assets, accepted);
  assert.deepEqual(JSON.parse(await fs.readFile(runtime.projectPath, 'utf8')).assets, accepted);
  await runtime.undo();
  assert.deepEqual(runtime.settings.assets, original);
  assert.deepEqual(JSON.parse(await fs.readFile(runtime.projectPath, 'utf8')).assets, original);
  await runtime.redo();
  assert.deepEqual(runtime.settings.assets, accepted);
  assert.deepEqual(JSON.parse(await fs.readFile(runtime.projectPath, 'utf8')).assets, accepted);
});

test('same-name concurrent callers serialize append-only keys; sibling projects have independent namespaces', async t => {
  const f = await setup(t), a = await f.open(), b = await f.open('sibling.divlet');
  const data = Array.from({ length: 8 }, (_, i) => Buffer.from(`image-${i}`));
  const results = await Promise.all(data.map(bytes => upload(a, bytes)));
  assert.equal(new Set(results.map(result => result.file)).size, 8);
  for (let i = 0; i < results.length; i++) assert.deepEqual(stored(a, results[i].file), data[i]);
  const other = await upload(b, Buffer.from('sibling'));
  assert.equal(other.file, 'images/photo.png');
  assert.deepEqual(stored(a, other.file), data[0]); assert.deepEqual(stored(b, other.file), Buffer.from('sibling'));
});

test('12 MiB image admission is retained, while invalid bytes, stale versions and missing targets leave source/history unchanged', async t => {
  const f = await setup(t), runtime = await f.open();
  assert.equal((await upload(runtime, Buffer.alloc(12 * 1024 * 1024), 'large.png')).size, 12 * 1024 * 1024);
  const before = state(runtime), source = await fs.readFile(runtime.projectPath);
  for (const [data, name, code] of [[Buffer.alloc(0), 'empty.png', 'UNSUPPORTED_ASSET'], [Buffer.from('x'), 'run.js', 'UNSUPPORTED_ASSET'], [Buffer.alloc(12 * 1024 * 1024 + 1), 'large.png', 'BODY_TOO_LARGE'], [Buffer.from('<svg><script/></svg>'), 'bad.svg', 'INVALID_ASSET']]) await assert.rejects(upload(runtime, data, name), { code });
  await assert.rejects(upload(runtime, Buffer.from('x'), 'ok.png', { documentId: 'missing' }), { code: 'NOT_FOUND' });
  await assert.rejects(upload(runtime, Buffer.from('x'), 'ok.png', { expectedVersion: 1 }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(await fs.readFile(runtime.projectPath), source); assert.deepEqual(state(runtime), before);
});

test('caller mutation after upload admission cannot change queued bytes', async t => {
  const f = await setup(t), runtime = await f.open(), data = Buffer.from('original');
  let release; const gate = new Promise(resolve => { release = resolve; });
  const held = runtime.enqueue(() => gate);
  const pending = upload(runtime, data); data.fill(120); release(); await held;
  const result = await pending;
  assert.deepEqual(stored(runtime, result.file), Buffer.from('original'));
});

for (const kind of ['symlink', 'file', 'managed']) test(`a ${kind} sibling assets path is neither read nor used for publication`, async t => {
  const f = await setup(t), runtime = await f.open(), outside = path.join(f.root, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'foreign'), 'untouched');
  if (kind === 'symlink') await fs.symlink(outside, f.directory);
  else if (kind === 'file') await fs.writeFile(f.directory, 'foreign');
  else { await fs.mkdir(f.directory); await fs.writeFile(path.join(f.directory, '.divlet-build.json'), 'foreign'); }
  await upload(runtime);
  assert.equal(await fs.readFile(path.join(outside, 'foreign'), 'utf8'), 'untouched');
  if (kind === 'file') assert.equal(await fs.readFile(f.directory, 'utf8'), 'foreign');
  if (kind === 'symlink') assert.ok((await fs.lstat(f.directory)).isSymbolicLink());
  if (kind === 'managed') assert.deepEqual(await fs.readdir(f.directory), ['.divlet-build.json']);
});

test('a declared file cannot be silently replaced by the upload directory', async t => {
  const f = await setup(t), runtime = await f.open();
  await runtime.patchProject({ expectedVersion: 1, patch: { assets: { images: 'data:image/png;base64,AQ==' } } });
  const before = state(runtime), source = await fs.readFile(runtime.projectPath);
  await assert.rejects(upload(runtime), { code: 'INVALID_ASSET' });
  assert.deepEqual(state(runtime), before); assert.deepEqual(await fs.readFile(runtime.projectPath), source);
});

test('a pending invalid source or source replacement refuses upload without a second store or partial accepted state', async t => {
  const f = await setup(t), runtime = await f.open();
  await fs.writeFile(runtime.projectPath, '{invalid'); await runtime.scan();
  const before = state(runtime);
  await assert.rejects(upload(runtime), { code: 'EXTERNAL_PENDING' });
  assert.equal(await fs.readFile(runtime.projectPath, 'utf8'), '{invalid'); assert.deepEqual(state(runtime), before);
});

test('uploaded images materialize once, retain MIME, export inline and rebuild after deleting the cache', async t => {
  const f = await setup(t), runtime = await f.open(), bytes = Buffer.from([0, 255, 12, 34]);
  const result = await upload(runtime, bytes, 'Photo.png');
  await runtime.create({ document: decodeHtml(`<main><img src="${result.path}"><img src="${result.path}"></main>`, { fallbackId: 'screen' }) });
  const key = 'assets/images/photo.png';
  assert.deepEqual(Buffer.from(runtime.publicFiles.get(key)), bytes);
  assert.equal(runtime.publicMediaTypes.get(key), 'image/png');
  const exported = await runtime.exportDocument('screen'); assert.ok(exported.html.includes('data:image/png;base64,AP8MIg==')); assert.ok(!exported.html.includes('asset:'));
  await runtime.close(); await fs.rm(runtime.outputDir, { recursive: true });
  const reopened = await f.open();
  assert.deepEqual(Buffer.from(reopened.publicFiles.get(key)), bytes);
  assert.equal(JSON.parse(await fs.readFile(path.join(reopened.outputDir, '.divlet-build.json'), 'utf8')).mediaTypes[key], 'image/png');
});
