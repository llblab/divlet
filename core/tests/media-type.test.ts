import test from 'node:test';
import assert from 'node:assert/strict';
import { MIMEType } from 'node:util';
import { canonicalMediaType, MAX_MEDIA_TYPE } from '../lib/canonical-media-type.ts';
import * as facade from '../lib/media-type.ts';
import { checkMediaTypeWitnesses, mimeCandidates } from './fixtures/media-types.js';

function oracle(input: string): MIMEType | null {
  if (!input || input.length > 1024 || /[^\x20-\x7e]/.test(input)) return null;
  try { const parsed = new MIMEType(input); return parsed.toString() === input ? parsed : null; } catch { return null; }
}

test('portable canonical MIME reads preserve authored witnesses and native class compatibility', () => {
  assert.equal(MAX_MEDIA_TYPE, 1024);
  assert.equal(facade.MAX_MEDIA_TYPE, MAX_MEDIA_TYPE);
  assert.ok(facade.canonicalMediaType('text/plain') instanceof MIMEType);
  assert.ok(checkMediaTypeWitnesses({ canonicalMediaType }) > 30);
});

test('canonical MIME admission and ordered parameter reads match Node across ASCII/quote/duplicate/budget partitions', () => {
  const candidates = new Set<string>(mimeCandidates());
  // Also exercise Node-normalized results, not just rejected spellings of valid MIME values.
  for (const value of [...candidates]) { try { candidates.add(new MIMEType(value).toString()); } catch {} }
  for (const input of candidates) {
    const expected = oracle(input), actual = canonicalMediaType(input), native = facade.canonicalMediaType(input);
    assert.equal(Boolean(actual), Boolean(expected), JSON.stringify(input));
    assert.equal(Boolean(native), Boolean(expected), `native: ${JSON.stringify(input)}`);
    if (actual && expected) {
      assert.equal(actual.essence, expected.essence);
      assert.equal(actual.toString(), expected.toString());
      assert.deepEqual([...actual.params], [...expected.params]);
      for (const [name] of expected.params) for (const spelling of [name, name.toUpperCase()]) {
        // Node 22 get() is case-sensitive; Node 26 folds names. Portable reads use canonical-key lookup as the oracle.
        assert.equal(actual.params.get(spelling), expected.params.get(name));
        assert.equal(native!.params.get(spelling), expected.params.get(spelling), 'the native adapter retains its host API, not the portable read view');
      }
      assert.equal(actual.params.get('absent'), null);
    }
  }
  assert.ok(candidates.size > 900);
});

test('canonical MIME refuses foreign objects without coercion and exposes only a detached read view', () => {
  let calls = 0;
  const foreign = { toString() { calls++; throw new Error('must not coerce'); } };
  for (const input of [foreign, new String('text/plain'), null, undefined, 1, [], Symbol('mime')]) assert.equal(canonicalMediaType(input), null);
  assert.equal(calls, 0);
  const parsed = canonicalMediaType('text/plain;p="";k=value')!;
  assert.equal(Object.isFrozen(parsed) && Object.isFrozen(parsed.params), true);
  assert.equal('set' in parsed.params, false);
  const pair = [...parsed.params][0]!;
  (pair as [string, string])[1] = 'changed';
  assert.equal(parsed.params.get('p'), '');
  assert.equal(parsed.params.get('\u212a'), new MIMEType('text/plain;k=value').params.get('\u212a'));
  if (false) {
    // @ts-expect-error This private portable projection is not Node's mutable MIMEParams API.
    parsed.params.set('p', 'changed');
  }
});

test('extension defaults retain HTTP spelling and exact Node-serialized resource values', () => {
  const extensions = ['.css', '.js', '.html', '.json', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.avif', '.woff', '.woff2', '.ico', '.unknown', '.CSS', ''];
  for (const extension of extensions) {
    const header = facade.mediaTypeForExtension(extension);
    assert.equal(facade.resourceMediaTypeForExtension(extension), new MIMEType(header ?? 'application/octet-stream').toString());
  }
  assert.equal(facade.mediaTypeForExtension('.css'), 'text/css; charset=utf-8');
});
