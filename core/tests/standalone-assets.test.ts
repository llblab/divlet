import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineDeclaredAssets } from '../lib/standalone-assets.ts';
import { inlineDeclaredAssets as nativeFacade } from '../lib/static.js';
import { ASSET_FILE_BYTES } from '../lib/asset-base64.ts';
import { nativeInlineDeclaredAssets } from './fixtures/standalone-native-oracle.js';
import { standaloneAssetCases, captureStandalone } from './fixtures/standalone-assets.js';

for (const { name, run, expected } of standaloneAssetCases) test(`standalone assets: ${name}`, async () => {
  const actual = await captureStandalone({ inlineDeclaredAssets }, run);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual, await captureStandalone({ inlineDeclaredAssets: nativeInlineDeclaredAssets }, run), 'captured prior Buffer implementation');
});

test('native standalone export keeps the original static binding and does not mutate canonical assets', async () => {
  assert.equal(nativeFacade, inlineDeclaredAssets);
  const assets = { one: 'data:application/octet-stream;base64,AQID' }, before = structuredClone(assets);
  await inlineDeclaredAssets('<img src="asset:one">', assets);
  assert.deepEqual(assets, before);
});

test('transformed CSS may exceed the source-file byte ceiling within the separate export budget', async () => {
  const assets = {
    large: `data:application/octet-stream;base64,${Buffer.alloc(8 * 1024 * 1024).toString('base64')}`,
    css: `data:text/css;base64,${Buffer.from('.a{background:url(asset:large);mask:url(asset:large)}').toString('base64')}`,
  };
  const html = await inlineDeclaredAssets('<link href="asset:css">', assets, { fragment: true });
  const encoded = /href="data:text\/css;base64,([^"]+)"/.exec(html)![1]!;
  assert.ok(Buffer.from(encoded, 'base64').byteLength > ASSET_FILE_BYTES);
  assert.ok(Buffer.byteLength(html) < 64 * 1024 * 1024);
});
