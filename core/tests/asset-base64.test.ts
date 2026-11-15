import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAssetBase64, encodeAssetBase64, ASSET_FILE_BYTES } from '../lib/asset-base64.ts';
import { DivletError } from '../lib/validation.ts';
import { readAssets, ASSET_LIMITS } from '../lib/assets.ts';
import { assetBase64Payloads, captureAssetBase64, checkAssetBase64Witnesses } from './fixtures/asset-base64.js';

import { nativeAssetBase64 as native } from './fixtures/asset-base64-oracle.ts';

test('portable asset base64 preserves authored bytes and exact native refusal partitions', () => {
  assert.equal(checkAssetBase64Witnesses({ decodeAssetBase64 }), 17);
  const inputs = assetBase64Payloads();
  for (const input of inputs) for (const maxBytes of [0, 1, 2, 3, 6]) assert.deepEqual(captureAssetBase64({ decodeAssetBase64 }, input, maxBytes), captureAssetBase64(native, input, maxBytes), JSON.stringify({ input, maxBytes }));
  assert.ok(inputs.length > 4900);
});

test('portable bytes cover all one/two-byte values, every tail remainder and independent fresh output', () => {
  for (let value = 0; value <= 65535; value++) {
    const bytes = Buffer.from([value >>> 8, value & 255]);
    assert.deepEqual([...decodeAssetBase64(bytes.toString('base64'), 2)], [...bytes]);
  }
  for (let size = 0; size <= 1024; size++) {
    const bytes = Buffer.from(Array.from({ length: size }, (_, i) => i & 255)), payload = bytes.toString('base64');
    assert.deepEqual([...decodeAssetBase64(payload, size)], [...bytes]);
  }
  const a = decodeAssetBase64('TQ=='), b = decodeAssetBase64('TQ==');
  assert.equal(Buffer.isBuffer(a), false);
  a[0] = 0;
  assert.deepEqual([...b], [77]);
  assert.notEqual(a.buffer, b.buffer);
});

test('asset payload bounds and noncoercion precede allocation and preserve domain errors', () => {
  assert.equal(ASSET_FILE_BYTES, 20 * 1024 * 1024);
  assert.equal(ASSET_LIMITS.fileBytes, ASSET_FILE_BYTES);
  for (const max of [-1, 0.5, NaN, Infinity, ASSET_FILE_BYTES + 1]) assert.throws(() => decodeAssetBase64('', max), { code: 'INVALID_ASSET' });
  let calls = 0;
  const foreign = { toString() { calls++; throw new Error('must not coerce'); } };
  for (const input of [foreign, new String('TQ=='), [], null, undefined, Symbol('base64'), 1]) assert.throws(() => decodeAssetBase64(input), error => error instanceof DivletError && error.code === 'INVALID_ASSET');
  assert.equal(calls, 0);
  const payload = Buffer.alloc(ASSET_FILE_BYTES).toString('base64');
  assert.equal(decodeAssetBase64(payload).byteLength, ASSET_FILE_BYTES);
  assert.throws(() => decodeAssetBase64(payload, ASSET_FILE_BYTES - 1, 'nested/file'), { code: 'INVALID_ASSET', message: `nested/file exceeds the ${ASSET_FILE_BYTES - 1} decoded-byte limit.` });
});

test('portable trusted encoding matches Buffer for tails, aligned blocks and offset byte views', () => {
  for (let value = 0; value <= 65535; value++) {
    const bytes = new Uint8Array([value >>> 8, value & 255]);
    assert.equal(encodeAssetBase64(bytes), Buffer.from(bytes).toString('base64'));
  }
  for (const size of [...Array.from({ length: 1025 }, (_, i) => i), 12285, 12286, 12287, 12288, 12289, 12290, 12291, 24575, 24576, 24577]) {
    const backing = Uint8Array.from({ length: size + 8 }, (_, i) => i & 255), bytes = backing.subarray(3, size + 3), before = bytes.slice();
    assert.equal(encodeAssetBase64(bytes), Buffer.from(bytes).toString('base64'));
    assert.deepEqual(bytes, before);
  }
});

test('encoding expanded output does not impose the source-file decoder ceiling', () => {
  const bytes = new Uint8Array(ASSET_FILE_BYTES + 1);
  assert.equal(encodeAssetBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('native tree admission retains Buffer results, aliases, input strings and refusal messages', () => {
  const uri = 'data:application/octet-stream;base64,TQ==', input = { a: uri, b: uri };
  const result = readAssets(input), a = result.files.get('a')!.bytes, b = result.files.get('b')!.bytes;
  assert.ok(Buffer.isBuffer(a) && Buffer.isBuffer(b));
  assert.equal(a.toString('base64'), 'TQ==');
  assert.deepEqual(result.tree, input);
  a[0] = 0;
  assert.deepEqual([...b], [77]);
  assert.throws(() => readAssets({ file: 'data:text/plain;base64,AB==' }), { code: 'INVALID_ASSET', message: 'file has noncanonical base64 data.' });
});
