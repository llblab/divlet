import test from 'node:test';
import assert from 'node:assert/strict';
import * as references from '../lib/asset-reference.ts';
import { DivletError } from '../lib/validation.ts';
import { assetReferenceCases } from './fixtures/asset-references.js';
const api = { ...references, DivletError };

for (const witness of assetReferenceCases) test(witness.name, () => assert.deepEqual(witness.run(api), witness.expected));

test('asset reference limits preserve exact path, component-byte, depth and suffix boundaries', () => {
  const { assetReference, readAssetReference, ASSET_REFERENCE_LIMITS: limits } = references;
  const invalid = run => assert.throws(run, { code: 'INVALID_ASSET' });
  const path = [...Array(8).fill('a'.repeat(226)), 'b'.repeat(232)].join('/');
  assert.equal(path.length, limits.path);
  assert.equal(readAssetReference(assetReference(path)).path, path);
  invalid(() => assetReference(path + 'c'));
  for (const name of ['a'.repeat(limits.segmentBytes), 'é'.repeat(127) + 'a']) assert.equal(readAssetReference(assetReference(name)).path, name);
  invalid(() => assetReference('a'.repeat(limits.segmentBytes + 1)));
  const deep = 'd/'.repeat(limits.depth) + 'font';
  assert.equal(readAssetReference(assetReference(deep)).path, deep);
  invalid(() => assetReference('d/' + deep));
  invalid(() => readAssetReference('asset:' + 'd/' + deep));
  const suffix = '#' + 'x'.repeat(limits.suffix - 1);
  assert.equal(readAssetReference(assetReference('font', suffix)).suffix, suffix);
  invalid(() => readAssetReference('asset:font' + suffix + 'x'));
  invalid(() => readAssetReference('asset:' + 'a'.repeat(limits.encoded)));
});

test('invalid asset references do not echo arbitrary input payloads into diagnostics', () => {
  const payload = 'PRIVATE-FONT-BYTES'.repeat(10000);
  for (const call of [() => references.assetReference(payload), () => references.readAssetReference('asset:' + payload), () => references.assetReference('font', '#' + payload)]) {
    assert.throws(call, error => error instanceof DivletError && error.code === 'INVALID_ASSET' && error.message.length < 100 && !error.message.includes('PRIVATE-FONT-BYTES'));
  }
});
