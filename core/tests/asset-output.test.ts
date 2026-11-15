import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assetOutputUrl, assetReference } from '../lib/asset-reference.ts';
import { assetOutputCases, assetOutputRefusals, captureAssetOutput } from './fixtures/asset-output.js';

for (const row of assetOutputCases) test(`asset output URL: ${row.name}`, () => {
  assert.equal(assetOutputUrl(row.reference, row.output), row.expected);
  const up = path.posix.relative(path.posix.dirname(row.output), '.');
  assert.equal(row.expected, `${up ? up + '/' : ''}assets/${assetReference(row.reference.path).slice(6)}${row.reference.suffix}`, 'independent previous native formula');
});

test('canonical artifact paths and declared URI partitions match the prior Node formula', () => {
  const directories = ['folder', '字', 'a b', 'a#b', '%2e', 'a%2Fb', 'e\u0301'];
  const outputDirectories = [...directories, ...Array.from({ length: 31 }, (_, i) => `a${String.fromCharCode(i + 1)}b`), 'a\u007fb'];
  const outputs = ['frame.html', 'Frame:one.html', ...outputDirectories.map(dir => `${dir}/index.html`), ...outputDirectories.flatMap(a => outputDirectories.map(b => `${a}/${b}/style.css`))];
  const keys = ['image.bin', ...directories.map(dir => `${dir}/paint.svg`)];
  for (const output of outputs) for (const key of keys) for (const suffix of ['', '#paint', '?x=1#part', '?x=%aB&next=a/b#part%2f']) {
    const reference = { path: key, suffix }, up = path.posix.relative(path.posix.dirname(output), '.');
    assert.equal(assetOutputUrl(reference, output), `${up ? up + '/' : ''}assets/${assetReference(key).slice(6)}${suffix}`);
  }
});

test('native output control compatibility never loosens declared asset-name admission', () => {
  for (const code of [...Array.from({ length: 31 }, (_, index) => index + 1), 127]) {
    assert.throws(() => assetReference(`a${String.fromCharCode(code)}b`), { code: 'INVALID_ASSET' });
  }
});

test('private URL projection refuses noncanonical artifact bases without coercing them', () => {
  for (const output of assetOutputRefusals) assert.deepEqual(captureAssetOutput({ assetOutputUrl }, { path: 'image.bin', suffix: '' }, output), { error: 'INVALID_ASSET' });
  let calls = 0;
  assert.throws(() => assetOutputUrl({ path: 'image.bin', suffix: '' }, { toString() { calls++; return 'index.html'; } }));
  assert.equal(calls, 0);
  assert.throws(() => assetOutputUrl({ path: 'image.bin', suffix: '#bad space' }, 'index.html'), { code: 'INVALID_ASSET' });
});
