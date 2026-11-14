import test from 'node:test';
import assert from 'node:assert/strict';
import * as validation from '../lib/validation.ts';
import { parseNativeJson } from '../lib/model.ts';
import { jsonTextLimits, nativeJsonCases, captureNativeJson } from './fixtures/native-json.js';

for (const { name, text, limits, expected } of nativeJsonCases) test(`native JSON: ${name}`, () => {
  assert.deepEqual(captureNativeJson(validation, text, limits), expected);
});

test('the model exposes the same opt-in native text decoder', () => {
  assert.equal(parseNativeJson, validation.parseNativeJson);
});

test('deep native JSON normalization is iterative, not a recursive reviver', () => {
  const nesting = 10000;
  const text = '['.repeat(nesting) + '-0' + ']'.repeat(nesting);
  let value = parseNativeJson(text, { bytes: text.length, nesting });
  for (let index = 0; index < nesting; index++) value = value[0];
  assert.ok(Object.is(value, 0));
  assert.throws(() => parseNativeJson(text, { bytes: text.length, nesting: nesting - 1 }), { code: 'INVALID_JSON' });
});

test('refusal diagnostics contain numeric offsets, never private source values', () => {
  const secret = 'PRIVATE-SOURCE-VALUE';
  for (const text of [`{"${secret}":1,"${secret}":2}`, `{"value":${secret}}`]) {
    assert.throws(() => parseNativeJson(text, jsonTextLimits), error => {
      assert.equal(error.code, 'INVALID_JSON');
      assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(secret), false);
      if (error.details) assert.equal(typeof error.details.offset, 'number');
      return true;
    });
  }
});

test('native text decoding does not grant schema or metadata admission', () => {
  const text = '{"__proto__":-0,"constructor":1}';
  const value = parseNativeJson(text, jsonTextLimits);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.ok(Object.is(value.__proto__, 0));
  assert.throws(() => validation.json(value), { code: 'INVALID_DOCUMENT' });
  assert.equal(text, '{"__proto__":-0,"constructor":1}');
});
