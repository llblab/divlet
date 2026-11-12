import test from 'node:test';
import assert from 'node:assert/strict';
import { readAssets, ASSET_LIMITS } from '../lib/assets.ts';
import { assetReference, readAssetReference, validateAssetName } from '../lib/asset-reference.ts';
import { readProject } from '../lib/project.ts';

const url = (bytes, mediaType = 'application/octet-stream') => `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
const invalid = input => assert.throws(() => readAssets(input), { code: 'INVALID_ASSET' });

test('hierarchical assets preserve authored keys, exact bytes and canonical Data URLs without mutating input', () => {
  const data = url([0, 255, 8]), input = { brand: { 'логотип.svg': url('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml') }, unique: data, 'alias.bin': data, empty: {}, 'empty.bin': url([]) };
  const before = structuredClone(input), parsed = readAssets(input);
  assert.deepEqual(parsed.tree, input);
  assert.notEqual(parsed.tree, input);
  assert.notEqual(parsed.tree.brand, input.brand);
  assert.deepEqual([...parsed.files.keys()], ['brand/логотип.svg', 'unique', 'alias.bin', 'empty.bin']);
  for (const name of ['unique', 'alias.bin']) {
    assert.deepEqual([...parsed.files.get(name).bytes], [0, 255, 8]);
    assert.equal(parsed.files.get(name).mediaType, 'application/octet-stream');
  }
  assert.equal(parsed.files.get('brand/логотип.svg').mediaType, 'image/svg+xml');
  assert.equal(parsed.files.get('empty.bin').bytes.length, 0);
  assert.deepEqual(input, before, 'named duplicates are not renamed, collapsed or rewritten');
  assert.equal(parsed.tree.unique, data);
  assert.deepEqual(readAssets(Object.create(null)).tree, {});
});

test('declared keys and explicit references share exact identity without decoding literal percent names twice', () => {
  const parsed = readAssets({ fonts: { "O'Brien (Italic).woff2": url([1], 'font/woff2'), '雪.woff2': url([2], 'font/woff2') }, '%2F': { 'a#b': url([3]) } });
  for (const [path, file] of parsed.files) {
    const ref = readAssetReference(assetReference(path, '?v=1#mark'));
    assert.equal(parsed.files.get(ref.path), file);
    assert.equal(ref.suffix, '?v=1#mark');
  }
  assert.equal(parsed.files.get('%2F/a#b').bytes[0], 3);
});

test('portable component byte admission agrees with an independent Node UTF-8 oracle', () => {
  for (const char of ['a', 'é', '雪', '🎵']) for (let count = 60; count < 258; count++) {
    const name = char.repeat(count), fits = Buffer.byteLength(name) <= 255;
    if (fits) { validateAssetName(name); assert.ok(readAssets({ [name]: url([]) }).files.has(name)); }
    else { assert.throws(() => validateAssetName(name), { code: 'INVALID_ASSET' }); invalid({ [name]: url([]) }); }
  }
});

test('asset codecs do not silently activate an unsupported native project field', () => {
  const project = { schemaVersion: 1, frames: [] };
  assert.doesNotThrow(() => readProject(project));
  assert.throws(() => readProject({ ...project, assets: { font: url([1], 'font/woff2') } }), { code: 'INVALID_PROJECT', message: 'Unsupported project field: assets. Put application data under metadata.' });
});

test('asset keys cannot escape, alias or create private or nonportable output names', () => {
  for (const name of ['', '.', '..', '.private', '../x', 'a/b', 'a\\b', '/absolute', 'a\0b', 'a\nb', 'x:', 'x?', 'x*', 'x.', 'x ', 'CON', 'nul.png', 'COM1', 'LPT9.txt', 'COM¹', 'CONIN$', 'constructor', 'prototype', '__proto__', '\ud800', 'é'.repeat(128)]) invalid(Object.fromEntries([[name, url([1])]]));
  invalid({ A: {}, a: {} });
  invalid({ 'é.png': url([1]), 'e\u0301.png': url([2]) });
  invalid({ Media: { 'x.png': url([1]) }, media: { 'y.png': url([2]) } });
});

test('asset leaves admit only canonical base64 Data URLs with preserved MIME parameters', () => {
  const accepted = readAssets({ text: url('hello', 'text/plain;charset=utf-8') });
  assert.equal(accepted.files.get('text').mediaType, 'text/plain;charset=utf-8');
  for (const value of ['file:base64,AQ==', 'blob:base64,AQ==', 'data:base64,AQ==', 'data:,x', 'data:text/plain,hello', 'data:;base64,AQ==', 'data:text/plain;garbage;base64,AQ==', 'data:Text/Plain;base64,AQ==', 'data:text/plain\r\nX-Test:1;base64,AQ==', 'data:text/plain;base64,AQ', 'data:text/plain;base64,A===', 'data:text/plain;base64,AQ==\n', 'data:text/plain;base64,AB==', 'data:text/plain;base64,AA=A', 'data:text/plain;base64,____', 'data:text/plain;base64,====']) invalid({ file: value });
});

test('asset trees refuse non-JSON shapes, accessors and cycles before reading leaf data', () => {
  for (const value of [null, [], true, 1, new Date(), url([1])]) invalid(value);
  for (const value of [null, [], false, 2, undefined, () => {}, new Uint8Array([1])]) invalid({ file: value });
  let called = false;
  const accessor = Object.defineProperty({}, 'image', { enumerable: true, get() { called = true; return url([1]); } });
  invalid(accessor); assert.equal(called, false);
  invalid(Object.defineProperty({}, 'hidden', { value: url([1]) }));
  invalid({ [Symbol('image')]: url([1]) });
  const cycle = {}; cycle.loop = cycle; invalid(cycle);
  invalid(Object.create({ inherited: url([1]) }));
});

test('asset depth, path, entry and file counts are bounded independently of byte size', () => {
  const count = Object.fromEntries(Array.from({ length: ASSET_LIMITS.files }, (_, i) => [`file${i}`, url([1])]));
  assert.equal(readAssets(count).files.size, ASSET_LIMITS.files);
  invalid({ ...count, extra: url([1]) });
  invalid(Object.fromEntries(Array.from({ length: ASSET_LIMITS.nodes + 1 }, (_, i) => [`dir${i}`, {}])));
  let nested = { file: url([1]) };
  for (let i = 0; i < ASSET_LIMITS.depth; i++) nested = { dir: nested };
  assert.equal(readAssets(nested).files.size, 1);
  invalid({ dir: nested });
  let long = { file: url([1]) };
  for (let i = 0; i < 10; i++) long = { ['x'.repeat(220)]: long };
  invalid(long);
});

test('decoded and aggregate encoded byte limits are checked before over-budget leaf allocation', () => {
  const file = url(Buffer.alloc(ASSET_LIMITS.fileBytes));
  assert.equal(readAssets({ file }).files.get('file').bytes.byteLength, ASSET_LIMITS.fileBytes);
  invalid({ file: url(Buffer.alloc(ASSET_LIMITS.fileBytes + 1)) });
  invalid({ one: file, two: file });
});
