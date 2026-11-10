import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { DivletRuntime, openRuntime } from '../lib/runtime.js';
import { SOURCE_LIMITS } from '../lib/model.ts';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-source-reads-')), runtimes = [];
  const file = path.join(root, 'project.divlet');
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, file, raw: () => { const runtime = new DivletRuntime({ file, watch: false }); runtimes.push(runtime); return runtime; }, open: async source => { await fs.writeFile(file, JSON.stringify(source)); const runtime = await openRuntime({ file, watch: false }); runtimes.push(runtime); return runtime; } };
}

// Test seam is the OS descriptor, not a production callback or a permissive read fallback.
function observe(t, file, hooks = {}) {
  const realOpen = fs.open.bind(fs);
  const events = { opened: 0, closed: 0, reads: 0, capacity: 0, requested: 0 };
  let beforeOpenDone = false, beforeReadDone = false, afterStatDone = false;
  t.mock.method(fs, 'open', async (target, flags, ...rest) => {
    if (target !== file) return realOpen(target, flags, ...rest);
    assert.ok(flags & constants.O_NOFOLLOW, 'no-follow is required before attempting the OS open');
    assert.ok(flags & constants.O_NONBLOCK, 'a FIFO replacement must never block');
    if (!beforeOpenDone) { beforeOpenDone = true; await hooks.beforeOpen?.(); }
    const handle = await realOpen(target, flags, ...rest); events.opened++;
    const read = handle.read.bind(handle), stat = handle.stat.bind(handle), close = handle.close.bind(handle);
    let stats = 0;
    handle.stat = async (...args) => {
      const value = await stat(...args); stats++;
      if (stats === 2 && !afterStatDone && hooks.afterStat) { afterStatDone = true; await hooks.afterStat(); }
      return value;
    };
    handle.read = async (buffer, offset, length, position) => {
      events.reads++; events.capacity = Math.max(events.capacity, buffer.length); events.requested += length;
      if (!beforeReadDone) { beforeReadDone = true; await hooks.beforeRead?.(); }
      return read(buffer, offset, length, position);
    };
    handle.close = async () => { try { return await close(); } finally { events.closed++; } };
    return handle;
  });
  return events;
}

const native = () => ({ version: '2.21', fileToken: 'source-only-read-token', children: [{ id: 'screen', type: 'frame', width: 390, height: 500, children: [{ id: 'label', type: 'text', content: 'Accepted' }] }] });
const state = runtime => ({ source: structuredClone(runtime.sourceProject?.source), settings: structuredClone(runtime.settings), render: runtime.renderSeq, frames: runtime.info().documents.map(({ id, version, render }) => ({ id, version, render })), history: runtime.history.length, selection: structuredClone(runtime.selection), grants: [...runtime.externalFiles] });

// Accepted/rejected byte regions include UTF-8 bytes, empty files and both existing caller budgets.
test('bounded source reads retain missing/UTF-8/empty semantics and exact byte-limit boundaries', async t => {
  const f = await setup(t), runtime = f.raw();
  assert.equal(await runtime.fileContents(f.file), null);
  assert.equal(await runtime.fileContents(path.join(f.root, 'missing/child.json')), null);
  await fs.writeFile(f.file, 'é猫');
  assert.equal(await runtime.fileContents(f.file, 5), 'é猫');
  await assert.rejects(runtime.fileContents(f.file, 4), { code: 'FILE_TOO_LARGE' });
  await fs.writeFile(f.file, ''); assert.equal(await runtime.fileContents(f.file, 0), '');
  for (const limit of [-1, 1.5, Infinity, SOURCE_LIMITS.bytes + 1]) await assert.rejects(runtime.fileContents(f.file, limit), { code: 'INVALID_OPERATION' });
  const events = observe(t, f.file);
  await fs.truncate(f.file, 4 * 1024 * 1024 + 1);
  await assert.rejects(runtime.fileContents(f.file), { code: 'FILE_TOO_LARGE' });
  assert.equal(events.reads, 0, 'default limit refuses before allocating/reading a source buffer');
  assert.equal((await runtime.fileContents(f.file, SOURCE_LIMITS.bytes)).length, 4 * 1024 * 1024 + 1);
  await fs.truncate(f.file, SOURCE_LIMITS.bytes + 1);
  const reads = events.reads;
  await assert.rejects(runtime.fileContents(f.file, SOURCE_LIMITS.bytes), { code: 'FILE_TOO_LARGE' });
  assert.equal(events.reads, reads); assert.equal(events.closed, events.opened);
});

test('initial symlink/nonregular/ancestor paths retain refusal codes without reading their contents', async t => {
  const f = await setup(t), runtime = f.raw(), foreign = path.join(f.root, 'foreign');
  await fs.writeFile(foreign, 'must not be read'); await fs.symlink(foreign, f.file);
  await assert.rejects(runtime.fileContents(f.file), { code: 'UNSAFE_PATH' });
  await fs.rm(f.file); await fs.mkdir(f.file);
  await assert.rejects(runtime.fileContents(f.file), { code: 'INVALID_FILE' });
  await fs.symlink(f.root, path.join(f.root, 'alias'));
  await assert.rejects(runtime.fileContents(path.join(f.root, 'alias/foreign')), { code: 'UNSAFE_PATH' });
  assert.equal(await fs.readFile(foreign, 'utf8'), 'must not be read');
});

for (const mutation of ['grow', 'shrink', 'same-size']) test(`${mutation} mutation during a descriptor read refuses without returning a partial string`, async t => {
  const f = await setup(t), runtime = f.raw(), text = 'original source'; await fs.writeFile(f.file, text);
  const events = observe(t, f.file, { beforeRead: async () => {
    if (mutation === 'grow') await fs.appendFile(f.file, ' '.repeat(10000));
    else if (mutation === 'shrink') await fs.truncate(f.file, 1);
    else { await fs.writeFile(f.file, 'changed! source'); await fs.utimes(f.file, new Date(), new Date(Date.now() + 5000)); }
  } });
  await assert.rejects(runtime.fileContents(f.file), { code: 'FILE_CONFLICT' });
  assert.equal(events.capacity, Buffer.byteLength(text) + 1); assert.equal(events.opened, 1); assert.equal(events.closed, 1);
});

for (const replacement of ['regular', 'symlink', 'directory', 'missing']) test(`${replacement} replacement between lstat and open cannot bypass descriptor policy`, async t => {
  const f = await setup(t), runtime = f.raw(), foreign = path.join(f.root, 'foreign');
  await fs.writeFile(f.file, 'original'); await fs.writeFile(foreign, 'foreign source');
  const events = observe(t, f.file, { beforeOpen: async () => {
    await fs.rename(f.file, path.join(f.root, 'retained-original'));
    if (replacement === 'regular') await fs.writeFile(f.file, 'new regular file');
    if (replacement === 'symlink') await fs.symlink(foreign, f.file);
    if (replacement === 'directory') await fs.mkdir(f.file);
  } });
  await assert.rejects(runtime.fileContents(f.file), { code: replacement === 'symlink' ? 'UNSAFE_PATH' : replacement === 'directory' ? 'INVALID_FILE' : 'FILE_CONFLICT' });
  assert.equal(events.reads, 0); assert.equal(events.closed, events.opened);
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign source');
  assert.equal(await fs.readFile(path.join(f.root, 'retained-original'), 'utf8'), 'original');
});

test('a FIFO replacing a listed regular file is opened nonblocking and rejected before reading', { skip: process.platform === 'win32' }, async t => {
  const f = await setup(t), runtime = f.raw(); await fs.writeFile(f.file, 'original');
  const events = observe(t, f.file, { beforeOpen: async () => { await fs.rm(f.file); await promisify(execFile)('mkfifo', [f.file]); } });
  await assert.rejects(runtime.fileContents(f.file), { code: 'INVALID_FILE' });
  assert.equal(events.reads, 0); assert.equal(events.opened, 1); assert.equal(events.closed, 1);
});

for (const replacement of ['regular', 'symlink', 'missing']) test(`${replacement} pathname change after the descriptor snapshot cannot return stale bytes`, async t => {
  const f = await setup(t), runtime = f.raw(), foreign = path.join(f.root, 'foreign');
  await fs.writeFile(f.file, 'original'); await fs.writeFile(foreign, 'foreign source');
  const events = observe(t, f.file, { afterStat: async () => {
    await fs.rename(f.file, path.join(f.root, 'retained-original'));
    if (replacement === 'regular') await fs.writeFile(f.file, 'replacement');
    if (replacement === 'symlink') await fs.symlink(foreign, f.file);
  } });
  await assert.rejects(runtime.fileContents(f.file), { code: replacement === 'symlink' ? 'UNSAFE_PATH' : 'FILE_CONFLICT' });
  assert.equal(events.opened, events.closed); assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign source');
});

test('parent path links appearing after a descriptor snapshot still fail the existing ancestor policy', async t => {
  const f = await setup(t), runtime = f.raw(), dir = path.join(f.root, 'source'); await fs.mkdir(dir);
  const file = path.join(dir, 'page.html'); await fs.writeFile(file, 'original');
  const events = observe(t, file, { afterStat: async () => { await fs.rename(dir, path.join(f.root, 'retained')); await fs.symlink(path.join(f.root, 'retained'), dir); } });
  await assert.rejects(runtime.fileContents(file), { code: 'UNSAFE_PATH' });
  assert.equal(events.opened, events.closed); assert.equal(await fs.readFile(path.join(f.root, 'retained/page.html'), 'utf8'), 'original');
});

for (const failure of ['read', 'final-stat']) test(`${failure} I/O errors close the descriptor without echoing file content`, async t => {
  const f = await setup(t), runtime = f.raw(); await fs.writeFile(f.file, 'private source body');
  const open = fs.open.bind(fs); let closed = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args), close = handle.close.bind(handle), stat = handle.stat.bind(handle);
    if (failure === 'read') handle.read = async () => { throw Object.assign(new Error('Synthetic I/O failure'), { code: 'EIO' }); };
    else { let calls = 0; handle.stat = async (...args) => { if (++calls === 2) throw Object.assign(new Error('Synthetic stat failure'), { code: 'EIO' }); return stat(...args); }; };
    handle.close = async () => { closed++; return close(); };
    return handle;
  });
  await assert.rejects(runtime.fileContents(f.file), { code: 'EIO' }); assert.equal(closed, 1);
});

for (const extension of ['.pen', '.divlet']) test(`an existing native ${extension} disappearing before the first read must not be recreated as legacy source`, async t => {
  const f = await setup(t), file = path.join(f.root, 'native' + extension);
  await fs.writeFile(file, JSON.stringify(native()));
  const lstat = fs.lstat.bind(fs); let removed = false, opened;
  t.mock.method(fs, 'lstat', async (target, ...args) => { if (target === file && !removed) { removed = true; await fs.rm(file); } return lstat(target, ...args); });
  try {
    await assert.rejects(async () => { opened = await openRuntime({ file, watch: false, createDemo: false, requireSource: false }); }, { code: 'NOT_FOUND' });
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  } finally { await opened?.close(); }
});

test('an existing source directory disappearing during startup is not silently recreated', async t => {
  const f = await setup(t), dir = path.join(f.root, 'design'), retained = path.join(f.root, 'retained');
  await fs.mkdir(dir); const file = path.join(dir, 'native.pen'), text = JSON.stringify(native()); await fs.writeFile(file, text);
  const lstat = fs.lstat.bind(fs); let moved = false, opened;
  t.mock.method(fs, 'lstat', async (target, ...args) => { if (target === dir && !moved) { moved = true; await fs.rename(dir, retained); } return lstat(target, ...args); });
  try { await assert.rejects(async () => { opened = await openRuntime({ file, watch: false }); }, { code: 'NOT_FOUND' }); }
  finally { await opened?.close(); }
  await assert.rejects(fs.stat(dir), { code: 'ENOENT' }); assert.equal(await fs.readFile(path.join(retained, 'native.pen'), 'utf8'), text);
});



