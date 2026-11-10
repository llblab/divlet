import test from 'node:test';
import { legacyProject } from './fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntime } from '../lib/runtime.js';
import { decodeHtml } from '../lib/codec.ts';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-upload-')), runtimes = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const open = async (name = 'project.divlet') => { await legacyProject(path.join(root, name)); const runtime = await openRuntime({ file: path.join(root, name), watch: false, createDemo: false }); runtimes.push(runtime); return runtime; };
  return { root, directory: path.join(root, 'assets'), open };
}
const state = runtime => ({ settings: structuredClone(runtime.settings), source: structuredClone(runtime.sourceProject?.source), revision: runtime.revision, render: runtime.renderSeq, history: runtime.history.length, documents: [...runtime.documents], hashes: new Map(runtime.knownHashes), files: new Map(runtime.staticFiles), grants: [...runtime.externalFiles] });
const upload = (runtime, data = Buffer.from('image'), name = 'Photo.PNG') => runtime.saveAsset({ name, data });
const noStages = async directory => assert.ok(!(await fs.readdir(directory)).some(name => name.startsWith('.divlet-upload-')));
const isPayload = file => path.basename(String(file)) === 'image' && String(file).includes('.divlet-upload-');

test('uploads retain supported names, exact bytes and the 12 MiB boundary without changing accepted project state', async t => {
  const f = await setup(t), runtime = await f.open(), before = state(runtime), source = await fs.readFile(runtime.projectPath);
  for (const extension of ['PNG', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif']) {
    const bytes = Buffer.from([0, 255, 12, 34]), result = await upload(runtime, bytes, `My Photo.${extension}`);
    assert.deepEqual(result, { path: `assets/my-photo.${extension.toLowerCase()}`, file: `assets/my-photo.${extension.toLowerCase()}`, size: 4 });
    assert.deepEqual(await fs.readFile(path.join(f.root, result.file)), bytes);
  }
  const full = await upload(runtime, Buffer.alloc(12 * 1024 * 1024), 'large.png'); assert.equal(full.size, 12 * 1024 * 1024);
  for (const [data, name, code] of [[Buffer.alloc(0), 'empty.png', 'UNSUPPORTED_ASSET'], [Buffer.from('x'), 'run.js', 'UNSUPPORTED_ASSET'], [Buffer.alloc(12 * 1024 * 1024 + 1), 'large.png', 'BODY_TOO_LARGE']]) await assert.rejects(upload(runtime, data, name), { code });
  await assert.rejects(runtime.saveAsset({ name: 'ok.png', data: Buffer.from('x'), documentId: 'missing' }), { code: 'NOT_FOUND' });
  assert.deepEqual(await fs.readFile(runtime.projectPath), source); assert.deepEqual(state(runtime), before); await noStages(f.directory);
});

test('same-name concurrent callers and sibling runtimes publish distinct complete files without overwriting', async t => {
  const f = await setup(t), a = await f.open(), b = await f.open('sibling.divlet'), states = [state(a), state(b)];
  const link = fs.link.bind(fs); let entered = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(fs, 'link', async (from, to) => { if (to === path.join(f.directory, 'photo.png')) { if (++entered === 8) release(); await gate; } return link(from, to); });
  const data = Array.from({ length: 8 }, (_, i) => Buffer.from(`image-${i}`));
  const results = await Promise.all(data.map((bytes, i) => upload(i % 2 ? a : b, bytes)));
  assert.equal(entered, 8); assert.equal(new Set(results.map(result => result.file)).size, 8);
  for (let i = 0; i < results.length; i++) assert.deepEqual(await fs.readFile(path.join(f.root, results[i].file)), data[i]);
  assert.deepEqual(state(a), states[0]); assert.deepEqual(state(b), states[1]); await noStages(f.directory);
});

test('occupied regular, directory, symlink and hardlink names are skipped without reading or replacing them', async t => {
  const f = await setup(t), runtime = await f.open(); await fs.mkdir(f.directory);
  const foreign = path.join(f.root, 'foreign'); await fs.writeFile(foreign, 'foreign');
  await fs.writeFile(path.join(f.directory, 'photo.png'), 'first'); await fs.mkdir(path.join(f.directory, 'photo-2.png'));
  await fs.symlink(foreign, path.join(f.directory, 'photo-3.png')); await fs.link(foreign, path.join(f.directory, 'photo-4.png'));
  const result = await upload(runtime); assert.equal(result.file, 'assets/photo-5.png');
  assert.equal(await fs.readFile(path.join(f.directory, 'photo.png'), 'utf8'), 'first');
  assert.ok((await fs.lstat(path.join(f.directory, 'photo-2.png'))).isDirectory());
  assert.ok((await fs.lstat(path.join(f.directory, 'photo-3.png'))).isSymbolicLink());
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign'); await noStages(f.directory);
});

test('a foreign target appearing at publication wins its name and upload allocates the next one', async t => {
  const f = await setup(t), runtime = await f.open(), link = fs.link.bind(fs); let appeared = false;
  t.mock.method(fs, 'link', async (from, to) => { if (!appeared) { appeared = true; await fs.writeFile(to, 'appeared', { flag: 'wx' }); } return link(from, to); });
  const result = await upload(runtime); assert.equal(result.file, 'assets/photo-2.png');
  assert.equal(await fs.readFile(path.join(f.directory, 'photo.png'), 'utf8'), 'appeared');
  assert.equal(await fs.readFile(path.join(f.root, result.file), 'utf8'), 'image'); await noStages(f.directory);
});

test('mutating the caller Buffer after admission cannot change prepared upload bytes', async t => {
  const f = await setup(t), runtime = await f.open(), data = Buffer.from('original'), mkdtemp = fs.mkdtemp.bind(fs);
  t.mock.method(fs, 'mkdtemp', async (...args) => { data.fill(120); return mkdtemp(...args); });
  const result = await upload(runtime, data); assert.equal(await fs.readFile(path.join(f.root, result.file), 'utf8'), 'original');
});

for (const kind of ['symlink', 'file', 'managed', 'output']) test(`${kind} upload directory refuses before staging or writes`, async t => {
  const f = await setup(t), runtime = await f.open(), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-upload-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  if (kind === 'symlink') await fs.symlink(outside, f.directory);
  else if (kind === 'file') await fs.writeFile(f.directory, 'foreign');
  else if (kind === 'managed') { await fs.mkdir(f.directory); await fs.writeFile(path.join(f.directory, '.divlet-build.json'), '{}'); }
  else await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { outputDir: 'assets' } });
  const contents = () => kind === 'file' ? fs.readFile(f.directory, 'utf8') : fs.readdir(kind === 'symlink' ? outside : f.directory);
  const before = state(runtime), names = await contents();
  await assert.rejects(upload(runtime), { code: kind === 'symlink' || kind === 'file' ? 'UNSAFE_PATH' : 'INVALID_ASSET_DIR' });
  assert.deepEqual(state(runtime), before); assert.deepEqual(await contents(), names);
});

for (const kind of ['changed-bytes', 'replaced-file', 'extra-file', 'replaced-stage']) test(`${kind} after a publication failure is retained, never broadly cleaned`, async t => {
  const f = await setup(t), runtime = await f.open(); let payload, stage, moved;
  t.mock.method(fs, 'link', async (from) => {
    payload = from; stage = path.dirname(from);
    if (kind === 'changed-bytes') await fs.writeFile(from, 'caller edit');
    if (kind === 'replaced-file') { await fs.rename(from, from + '-old'); await fs.writeFile(from, 'replacement'); }
    if (kind === 'extra-file') await fs.writeFile(path.join(stage, 'foreign.txt'), 'foreign');
    if (kind === 'replaced-stage') { moved = path.join(f.root, 'retained-stage'); await fs.rename(stage, moved); await fs.mkdir(stage); await fs.writeFile(path.join(stage, 'foreign.txt'), 'foreign'); }
    throw Object.assign(new Error('Synthetic link failure'), { code: 'EIO' });
  });
  let error; try { await upload(runtime); assert.fail('upload must fail'); } catch (failure) { error = failure; }
  assert.equal(error.code, 'EIO'); assert.equal(error.details.asset.published, false); assert.ok(error.details.asset.retained.includes(stage));
  if (kind === 'changed-bytes' || kind === 'replaced-file') assert.equal(await fs.readFile(payload, 'utf8'), kind === 'changed-bytes' ? 'caller edit' : 'replacement');
  if (kind === 'extra-file' || kind === 'replaced-stage') assert.equal(await fs.readFile(path.join(stage, 'foreign.txt'), 'utf8'), 'foreign');
  if (moved) assert.equal(await fs.readFile(path.join(moved, 'image'), 'utf8'), 'image');
  await assert.rejects(fs.stat(path.join(f.directory, 'photo.png')), { code: 'ENOENT' });
});

test('a partial descriptor write is closed and conservatively retained with a failed-publication receipt', async t => {
  const f = await setup(t), runtime = await f.open(), open = fs.open.bind(fs); let payload, closed = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args); if (!isPayload(file) || !(args[0] & constants.O_CREAT)) return handle;
    payload = file; const write = handle.writeFile.bind(handle), close = handle.close.bind(handle);
    handle.writeFile = async () => { await write(Buffer.from('part')); throw Object.assign(new Error('Synthetic short write'), { code: 'EIO' }); };
    handle.close = async () => { closed++; return close(); }; return handle;
  });
  await assert.rejects(upload(runtime, Buffer.from('complete-image')), error => error.code === 'EIO' && error.details.asset.published === false && error.details.asset.retained.includes(payload));
  assert.equal(closed, 1); assert.equal(await fs.readFile(payload, 'utf8'), 'part');
});

test('a generated-output marker appearing during the descriptor write revokes publication', async t => {
  const f = await setup(t), runtime = await f.open(), open = fs.open.bind(fs); let payload;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args); if (!isPayload(file) || !(args[0] & constants.O_CREAT)) return handle;
    payload = file; const write = handle.writeFile.bind(handle);
    handle.writeFile = async bytes => { await write(bytes); await fs.writeFile(path.join(f.directory, '.divlet-build.json'), '{}'); }; return handle;
  });
  await assert.rejects(upload(runtime), error => error.code === 'INVALID_ASSET_DIR' && error.details.asset.published === false && error.details.asset.retained.includes(path.dirname(payload)));
  await assert.rejects(fs.stat(path.join(f.directory, 'photo.png')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(payload, 'utf8'), 'image');
});

test('unsupported hardlinks fail rather than using overwrite-prone rename/copy fallbacks', async t => {
  const f = await setup(t), runtime = await f.open();
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('Unsupported links'), { code: 'ENOTSUP' }); });
  await assert.rejects(upload(runtime), error => error.code === 'ENOTSUP' && error.details.asset.published === false && error.details.asset.retained.length === 0);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('an error after an actual hardlink reports the saved file and never removes or republishes it', async t => {
  const f = await setup(t), runtime = await f.open(), link = fs.link.bind(fs); let attempts = 0;
  t.mock.method(fs, 'link', async (...args) => { attempts++; await link(...args); throw Object.assign(new Error('Lost publication acknowledgement'), { code: 'EIO' }); });
  await assert.rejects(upload(runtime), error => error.code === 'EIO' && error.details.asset.published === true && error.details.asset.file === 'assets/photo.png' && error.details.asset.retained.includes(path.join(f.directory, 'photo.png')));
  assert.equal(attempts, 1); assert.equal(await fs.readFile(path.join(f.directory, 'photo.png'), 'utf8'), 'image'); await noStages(f.directory);
});

test('a failed acknowledgement plus a replaced candidate remains outcome-unknown, never false unpublished', async t => {
  const f = await setup(t), runtime = await f.open(), link = fs.link.bind(fs);
  t.mock.method(fs, 'link', async (from, to) => { await link(from, to); await fs.unlink(to); await fs.writeFile(to, 'foreign'); throw Object.assign(new Error('Ambiguous acknowledgement'), { code: 'EIO' }); });
  await assert.rejects(upload(runtime), error => error.code === 'EIO' && error.details.asset.published === null && error.details.asset.retained.includes(path.join(f.directory, 'photo.png')));
  assert.equal(await fs.readFile(path.join(f.directory, 'photo.png'), 'utf8'), 'foreign'); await noStages(f.directory);
});

test('replacing the newly published file is diagnosed without deleting the replacement', async t => {
  const f = await setup(t), runtime = await f.open(), link = fs.link.bind(fs);
  t.mock.method(fs, 'link', async (from, to) => { await link(from, to); await fs.unlink(to); await fs.writeFile(to, 'foreign replacement'); });
  await assert.rejects(upload(runtime), error => error.code === 'ASSET_CONFLICT' && error.details.asset.published === true);
  assert.equal(await fs.readFile(path.join(f.directory, 'photo.png'), 'utf8'), 'foreign replacement'); await noStages(f.directory);
});

test('observed edits to the published inode during cleanup cannot return a false success receipt', async t => {
  const f = await setup(t), runtime = await f.open(), unlink = fs.unlink.bind(fs);
  t.mock.method(fs, 'unlink', async file => { if (isPayload(file)) await fs.writeFile(path.join(f.directory, 'photo.png'), 'edited during cleanup'); return unlink(file); });
  await assert.rejects(upload(runtime), error => error.code === 'ASSET_CONFLICT' && error.details.asset.published === true);
  assert.equal(await fs.readFile(path.join(f.directory, 'photo.png'), 'utf8'), 'edited during cleanup'); await noStages(f.directory);
});

test('successful publication reports private cleanup failures without discarding the durable asset', async t => {
  const f = await setup(t), runtime = await f.open(), unlink = fs.unlink.bind(fs);
  t.mock.method(fs, 'unlink', async file => { if (isPayload(file)) throw Object.assign(new Error('Cleanup denied'), { code: 'EACCES' }); return unlink(file); });
  const result = await upload(runtime); assert.equal(result.file, 'assets/photo.png'); assert.equal(result.retained.length, 2);
  assert.equal(await fs.readFile(path.join(f.root, result.file), 'utf8'), 'image');
});

test('a parent link introduced during staging cannot authorize cleanup or publication through that link', async t => {
  const f = await setup(t), runtime = await f.open(), outside = path.join(f.root, 'outside'), retained = path.join(f.root, 'retained-assets');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'foreign'), 'untouched');
  t.mock.method(fs, 'link', async () => { await fs.rename(f.directory, retained); await fs.symlink(outside, f.directory); throw Object.assign(new Error('Directory replaced'), { code: 'EIO' }); });
  await assert.rejects(upload(runtime), error => error.code === 'EIO' && error.details.asset.published === null && error.details.asset.retained.length > 0);
  assert.deepEqual(await fs.readdir(outside), ['foreign']); assert.equal(await fs.readFile(path.join(outside, 'foreign'), 'utf8'), 'untouched');
  assert.ok((await fs.readdir(retained)).some(name => name.startsWith('.divlet-upload-')));
});

test('published upload bytes enter ordinary portable static planning, not a staged or editor-only resource route', async t => {
  const f = await setup(t), runtime = await f.open(), bytes = Buffer.from([0, 255, 12, 34]);
  const result = await upload(runtime, bytes, 'Photo.png');
  await runtime.create({ document: decodeHtml(`<main><img src="${result.path}"></main>`, { fallbackId: 'screen' }) });
  const resource = [...runtime.staticFiles.keys()].find(name => name.startsWith('_assets/') && name.endsWith('-photo.png'));
  assert.ok(resource); assert.ok(runtime.staticFiles.get('screen.html').includes(resource));
  assert.ok(!runtime.staticFiles.get('screen.html').includes('.divlet-upload-'));
  assert.deepEqual(Buffer.from(runtime.staticFiles.get(resource)), bytes);
  const published = path.join(f.root, 'portable'); await fs.cp(runtime.outputDir, published, { recursive: true });
  await runtime.close(); await fs.rm(f.directory, { recursive: true }); await fs.rm(runtime.projectPath);
  assert.deepEqual(await fs.readFile(path.join(published, resource)), bytes);
});

