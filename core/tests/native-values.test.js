import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import * as validation from '../lib/validation.ts';
import { normalizeNativeJson, sameNativeJson, validateDocument } from '../lib/model.ts';
import { jsonValueLimits, nativeValueCases, nativeEqualityCases, captureNativeValue } from './fixtures/native-values.js';
import { nativeJsonCases } from './fixtures/native-json.js';
import { sampleFrame } from './fixtures/frame-portability.js';

for (const { name, input, limits, expected } of nativeValueCases) test(`native object value: ${name}`, () => {
  assert.deepEqual(captureNativeValue(validation, input(), limits), expected);
});
for (const { name, a, b, expected } of nativeEqualityCases) test(`native equality: ${name}`, () => {
  assert.equal(sameNativeJson(a(), b()), expected);
  assert.equal(sameNativeJson(b(), a()), expected, 'native equality is symmetric');
});

test('model exports the same opt-in portable value helpers', () => {
  assert.equal(normalizeNativeJson, validation.normalizeNativeJson);
  assert.equal(sameNativeJson, validation.sameNativeJson);
});

test('normalization copies aliases, preserves source zeros and does not invoke accessors/coercions', () => {
  const shared = { zero: -0 }, source = { a: shared, b: shared };
  const result = normalizeNativeJson(source, { nodes: 5, nesting: 2 });
  assert.notEqual(result, source); assert.notEqual(result.a, source.a); assert.notEqual(result.a, result.b);
  result.a.zero = 7;
  assert.ok(Object.is(shared.zero, -0)); assert.ok(Object.is(result.b.zero, 0));
  let invoked = 0;
  for (const input of [{ get value() { invoked++; return 1; } }, { toJSON() { invoked++; return {}; } }]) {
    assert.throws(() => normalizeNativeJson(input, jsonValueLimits), { code: 'INVALID_JSON' });
  }
  assert.equal(invoked, 0);
});

test('object-only normalization and comparison are iterative at the caller-selected nesting boundary', () => {
  const nesting = 10000;
  let source = -0;
  for (let i = 0; i < nesting; i++) source = [source];
  let normalized = normalizeNativeJson(source, { nodes: nesting + 1, nesting });
  assert.equal(sameNativeJson(source, normalized), true);
  for (let i = 0; i < nesting; i++) normalized = normalized[0];
  assert.ok(Object.is(normalized, 0));
  assert.throws(() => normalizeNativeJson(source, { nodes: nesting + 1, nesting: nesting - 1 }), { code: 'INVALID_JSON' });
});

test('text and object routes share numeric normalization without conflating their capacity units', () => {
  for (const { text, limits, expected } of nativeJsonCases.filter(witness => witness.expected.ok)) {
    const value = validation.parseNativeJson(text, limits);
    assert.deepEqual(normalizeNativeJson(value, { nodes: 256, nesting: limits.nesting }), expected.value);
  }
  assert.equal(validation.parseNativeJson('1e20', { bytes: 4, nesting: 0 }), 1e20, 'text bytes are not expanded serialization bytes');
});

test('object-only refusal diagnostics never expose member names, values or reflection failures', () => {
  const secret = 'PRIVATE-JSON-VALUE';
  for (const value of [Object.defineProperty({}, secret, { value: 1 }), { value: Symbol(secret) }, new Proxy({}, { ownKeys() { throw new Error(secret); } })]) {
    assert.throws(() => normalizeNativeJson(value, jsonValueLimits), error => {
      assert.equal(error.code, 'INVALID_JSON');
      assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(secret), false);
      return true;
    });
  }
});

test('finite JSON data agrees with the platform serialization/equality oracle', () => {
  let seed = 29;
  const pick = length => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % length; };
  const atoms = [null, true, false, -0, 1.5, Number.MAX_VALUE, Number.MIN_VALUE, 'one\r\n\ud800', '9007199254740993'];
  const value = depth => {
    if (!depth || pick(3) === 0) return atoms[pick(atoms.length)];
    if (pick(2)) return Array.from({ length: pick(4) }, () => value(depth - 1));
    return Object.fromEntries(['__proto__', 'constructor', 'toJSON', 'é', ''].slice(0, pick(6)).map(key => [key, value(depth - 1)]));
  };
  const limits = { nodes: 4096, nesting: 8 };
  for (let index = 0; index < 64; index++) {
    const source = value(4), other = value(4);
    // A literal toJSON member is legal JSON data, but callable values never enter this generator.
    const expected = JSON.parse(JSON.stringify(source)), expectedOther = JSON.parse(JSON.stringify(other));
    assert.deepEqual(normalizeNativeJson(source, limits), expected);
    assert.equal(sameNativeJson(source, expected), true);
    assert.equal(sameNativeJson(source, other), isDeepStrictEqual(expected, expectedOther));
  }
});

test('object-only admission cannot recover duplicate-name evidence already erased by a caller', () => {
  const text = '{"a":1,"a":2}', input = JSON.parse(text);
  assert.deepEqual(normalizeNativeJson(input, jsonValueLimits), { a: 2 });
  assert.throws(() => validation.parseNativeJson(text, { bytes: 64, nesting: 1 }), { code: 'INVALID_JSON' });
});

test('native value helpers do not activate schema admission or replace draft equality/normalization', () => {
  const value = normalizeNativeJson(JSON.parse('{"__proto__":-0}'), jsonValueLimits);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.hasOwn(value, '__proto__'), true); assert.ok(Object.is(value.__proto__, 0));
  assert.throws(() => validation.json(value), { code: 'INVALID_DOCUMENT' });
  assert.equal(validation.sameJson(-0, 0), false);
  const frame = sampleFrame(); frame.artboard.x = -0;
  assert.ok(Object.is(validateDocument(frame).artboard.x, -0), 'existing readers retain draft normalization until coherent cutover');
});
