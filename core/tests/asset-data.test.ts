import test from 'node:test';
import assert from 'node:assert/strict';
import * as portable from '../lib/asset-data.ts';
import * as native from '../lib/assets.ts';
import * as browser from '../lib/browser-assets.ts';
import { SOURCE_LIMITS } from '../lib/model.ts';
import { SOURCE_LIMITS as SOURCE_BUDGET } from '../lib/source-budget.ts';
import { assetDataCases, browserAssetCases, captureAssetData, verifyAssetResult } from './fixtures/asset-data.js';

for (const { name, run, expected } of assetDataCases) test(`shared asset-data: ${name}`, () => {
  const actual = captureAssetData(portable, run), adapted = captureAssetData(native, run);
  assert.ok(verifyAssetResult(actual, expected), JSON.stringify({ actual, expected }));
  assert.deepEqual(adapted, actual);
});
for (const { name, run, expected } of browserAssetCases) test(`browser asset port: ${name}`, () => {
  const actual = captureAssetData(browser, run);
  assert.ok(verifyAssetResult(actual, expected), JSON.stringify({ actual, expected }));
});

test('native wrappers preserve Buffer API and public limits without leaking native bytes into portable results', () => {
  assert.equal(SOURCE_LIMITS, SOURCE_BUDGET);
  assert.equal(native.ASSET_LIMITS, portable.ASSET_LIMITS);
  assert.equal(browser.ASSET_LIMITS, portable.ASSET_LIMITS);
  assert.equal(portable.ASSET_LIMITS.encodedBytes, SOURCE_LIMITS.bytes);
  const input = { file: 'data:text/plain;base64,TQ==' };
  const plain = portable.readAssets(input), adapted = native.readAssets(input);
  assert.equal(Buffer.isBuffer(plain.files.get('file')!.bytes), false);
  assert.equal(Buffer.isBuffer(adapted.files.get('file')!.bytes), true);
  assert.deepEqual([...plain.files.get('file')!.bytes], [...adapted.files.get('file')!.bytes]);
});

test('trusted byte access can refuse at the legacy phase but cannot replace validation', () => {
  const denied = new Error('denied'), calls: string[] = [];
  const gate = () => { calls.push('bytes'); throw denied; };
  assert.deepEqual(portable.readAssets({ empty: {} }, gate).tree, { empty: {} });
  assert.deepEqual(calls, []);
  assert.throws(() => portable.readAssets({ file: 'wrong-prefix' }, gate), { code: 'INVALID_ASSET' });
  assert.deepEqual(calls, []);
  assert.throws(() => portable.readAssets({ file: 'data:INVALID;base64,!' }, gate), error => error === denied);
  assert.deepEqual(calls, ['bytes']);
  assert.throws(() => portable.readAssets({ file: 'data:INVALID;base64,!' }, () => true), { code: 'INVALID_ASSET' });
});
