import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DeclaredResourceGraph } from '../lib/declared-resources.ts';
import { assetReference, readAssetReference, resolveAssetDependency } from '../lib/asset-reference.ts';
import { buildStatic } from '../lib/static.js';
import { declaredResourceCases } from './fixtures/declared-resources.js';

const api = { DeclaredResourceGraph, assetReference, readAssetReference, resolveAssetDependency };
for (const { name, run, expected } of declaredResourceCases) test(`declared graph: ${name}`, async () => {
  assert.deepEqual(await run(api), expected);
});

test('native declared adapter preserves exact fingerprint recipe, bytes, MIME, suffixes and independent aliases', async () => {
  const assets = { one: 'data:application/octet-stream;base64,eA==', alias: 'data:application/octet-stream;base64,eA==' };
  const result = await buildStatic({ projectDir: '/no-original-resources', frameFiles: undefined, assetBase: undefined, siteBase: undefined, mapResources: undefined, previewBase: undefined, assets, frames: new Map([['proof', '<img src="asset:one?q=1#part"><img src="asset:alias">']]) });
  const digest = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
  const expected = digest(JSON.stringify(['application/octet-stream', digest(Buffer.from('x'))]));
  assert.ok(result.assetSources);
  assert.deepEqual([...result.assetSources], [['asset:one', expected], ['asset:alias', expected]]);
  assert.deepEqual([...result.mediaTypes], [['assets/one', 'application/octet-stream'], ['assets/alias', 'application/octet-stream']]);
  const one = result.files.get('assets/one'), alias = result.files.get('assets/alias');
  assert.equal(Buffer.isBuffer(one) && Buffer.isBuffer(alias), true);
  assert.equal(one.toString(), 'x'); one[0] = 0; assert.equal(alias.toString(), 'x');
  assert.ok(result.files.get('proof.html').includes('src="assets/one?q=1#part"'));
});
