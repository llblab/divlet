import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OutputStore } from '../lib/output.ts';
import { buildStatic } from '../lib/static.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'divlet-output-mime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, output: new OutputStore(path.join(root, 'landing.divlet')) };
}

test('declared MIME is owned provenance, survives reopening and is portable with its output directory', async t => {
  const { root, output } = await fixture(t);
  const plan = await buildStatic({ projectDir: '/no-original-assets', assets: { font: 'data:font/woff2;base64,AQ==' }, frames: new Map([['index', '<style>@font-face{src:url(asset:font)}</style>']]) });
  await output.write(plan.files, { mediaTypes: plan.mediaTypes });
  const manifest = await output.manifest();
  assert.equal(manifest.mediaTypes['assets/font'], 'font/woff2');
  assert.equal(Object.getPrototypeOf(manifest.mediaTypes), null);
  assert.ok(!JSON.stringify(manifest).includes(root));
  assert.equal(manifest.files['assets/font'].length, 64);
  const moved = root + '-moved';
  await rename(root, moved); t.after(() => rm(moved, { recursive: true, force: true }));
  const reopened = new OutputStore(path.join(moved, 'landing.divlet'));
  assert.deepEqual(await reopened.manifest(), manifest);
  assert.deepEqual(await reopened.read('assets/font'), Buffer.from([1]));
});

test('partial writes retain MIME, explicit complete maps replace it, removals cannot leave dangling metadata', async t => {
  const { output } = await fixture(t);
  await output.write(new Map([['a.bin', 'a'], ['b.bin', 'b']]), { mediaTypes: new Map([['a.bin', 'font/woff2'], ['b.bin', 'image/png']]) });
  await output.write(new Map([['notes.txt', 'owned, not made public by MIME']]));
  assert.deepEqual(Object.keys((await output.manifest()).mediaTypes).sort(), ['a.bin', 'b.bin']);
  await output.write(new Map(), { mediaTypes: new Map([['a.bin', 'font/ttf']]) });
  assert.deepEqual({ ...(await output.manifest()).mediaTypes }, { 'a.bin': 'font/ttf' });
  await output.remove(['a.bin']);
  assert.equal(Object.hasOwn(await output.manifest(), 'mediaTypes'), false);
  await output.write(new Map(), { mediaTypes: new Map() });
  assert.equal(Object.hasOwn(await output.manifest(), 'mediaTypes'), false);
});

test('invalid MIME plans refuse before files or ownership metadata change', async t => {
  const { output } = await fixture(t);
  await output.write(new Map([['owned.bin', 'original']]));
  const before = await readFile(output.file('.divlet-build.json'));
  for (const mediaTypes of [new Map([['unowned.bin', 'font/woff2']]), new Map([['owned.bin', 'Font/Woff2']]), new Map([['owned.bin', 'font/woff2\r\nX-Test:1']]), new Map([['owned.bin', 'text/plain;garbage']]), new Map([['owned.bin', 'a'.repeat(1025)]]), {}]) {
    await assert.rejects(output.write(new Map([['owned.bin', 'changed'], ['next.bin', 'new']]), { mediaTypes }), { code: 'OUTPUT_CONFLICT' });
    assert.deepEqual(await readFile(output.file('.divlet-build.json')), before);
    assert.equal(String(await output.read('owned.bin')), 'original');
    assert.equal(await output.read('next.bin'), null);
    assert.equal(await output.read('.divlet-write.lock'), null);
  }
});

test('corrupt or dangling manifest MIME is not repaired by guessing an extension', async t => {
  const { output } = await fixture(t);
  await output.write(new Map([['owned.bin', 'original']]));
  const manifest = await output.manifest();
  for (const mediaTypes of [null, [], { 'owned.bin': 'FONT/WOFF2' }, { 'absent.bin': 'font/woff2' }, { 'owned.bin': 'data:font/woff2' }]) {
    const bytes = JSON.stringify({ ...manifest, mediaTypes });
    await writeFile(output.file('.divlet-build.json'), bytes);
    await assert.rejects(output.manifest(), { code: 'OUTPUT_CONFLICT' });
    await assert.rejects(output.write(new Map([['owned.bin', 'changed']])), { code: 'OUTPUT_CONFLICT' });
    assert.equal(String(await output.read('owned.bin')), 'original');
    assert.equal(String(await output.read('.divlet-build.json')), bytes);
  }
});

test('output MIME dictionaries do not inherit prototype-looking generated filenames', async t => {
  const { output } = await fixture(t);
  await output.write(new Map([['__proto__', 'bytes'], ['constructor', 'other']]), { mediaTypes: new Map([['__proto__', 'font/woff2'], ['constructor', 'image/png']]) });
  const manifest = await output.manifest();
  assert.equal(Object.getPrototypeOf(manifest.mediaTypes), null);
  assert.equal(manifest.mediaTypes.__proto__, 'font/woff2');
  assert.equal(manifest.mediaTypes.constructor, 'image/png');
  assert.equal({}.mediaType, undefined);
});
