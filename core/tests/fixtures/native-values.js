// Object-only native JSON witnesses; factories preserve values that JSON text cannot represent or attest.
export const jsonValueLimits = Object.freeze({ nodes: 256, nesting: 32 });
const accepted = (name, input, value, limits = jsonValueLimits) => ({ name, input, limits, expected: { ok: true, value } });
const refused = (name, input, limits = jsonValueLimits) => ({ name, input, limits, expected: { ok: false, code: 'INVALID_JSON', domainError: true } });

export const nativeValueCases = [
  accepted('primitive signed zero', () => -0, 0, { nodes: 1, nesting: 0 }),
  accepted('primitive data needs no container budget', () => null, null, { nodes: 1, nesting: 0 }),
  accepted('opaque metadata and precision strings', () => ({ text: '\r\n\0\ud800', json: '{"x":-0,"x":1}', integer: '9007199254740993' }), { text: '\r\n\0\ud800', json: '{"x":-0,"x":1}', integer: '9007199254740993' }),
  accepted('finite binary64 and underflow', () => [Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 9007199254740993, -1e-400], [Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 9007199254740992, 0]),
  accepted('null-prototype records become ordinary JSON records', () => Object.assign(Object.create(null), { zero: -0 }), { zero: 0 }),
  accepted('frozen JSON data is copied', () => Object.freeze({ values: Object.freeze([-0]) }), { values: [0] }),
  accepted('unsafe schema keys remain data until schema admission', () => JSON.parse('{"__proto__":-0,"constructor":1,"toJSON":"opaque"}'), JSON.parse('{"__proto__":0,"constructor":1,"toJSON":"opaque"}')),
  accepted('shared branches expand independently', () => { const child = { zero: -0 }; return { a: child, b: child }; }, { a: { zero: 0 }, b: { zero: 0 } }, { nodes: 5, nesting: 2 }),
  accepted('exact expanded value and nesting capacities', () => [{ zero: -0 }], [{ zero: 0 }], { nodes: 3, nesting: 2 }),
  accepted('declaration order and repeated properties stay ordered', () => [['color', 'red'], ['color', 'blue']], [['color', 'red'], ['color', 'blue']]),
  refused('expanded values exceed capacity', () => [{ zero: -0 }], { nodes: 2, nesting: 2 }),
  refused('container nesting exceeds capacity', () => [{ zero: -0 }], { nodes: 3, nesting: 1 }),
  refused('a zero value budget admits no root', () => 0, { nodes: 0, nesting: 0 }),
  refused('data cannot raise caller capacities', () => ({ nodes: 999, nesting: 999, value: {} }), { nodes: 2, nesting: 1 }),
  ...[undefined, NaN, Infinity, -Infinity, 1n, Symbol('private-value'), () => 1].map((value, index) => refused(`non-JSON primitive ${index + 1}`, () => value)),
  ...[new Date(0), new Map(), new Set(), /value/, new Uint8Array([1]), Object.create({ inherited: true }), new (class extends Array {})()].map((value, index) => refused(`non-plain container ${index + 1}`, () => value)),
  refused('sparse arrays', () => new Array(1)),
  refused('extra array fields', () => Object.assign([1], { note: 2 })),
  refused('non-enumerable array items', () => Object.defineProperty([1], '0', { enumerable: false })),
  refused('hidden record members', () => Object.defineProperty({}, 'private-field', { value: 1 })),
  refused('symbol record members', () => ({ [Symbol('private-field')]: 1 })),
  refused('accessors are refused without reading them', () => ({ get privateField() { throw new Error('Accessor executed'); } })),
  refused('array accessors are refused without reading them', () => Object.defineProperty([1], '0', { get() { throw new Error('Accessor executed'); } })),
  refused('toJSON is data, never a coercion hook', () => ({ toJSON() { throw new Error('Coercion executed'); } })),
  refused('record cycles', () => { const value = {}; value.self = value; return value; }),
  refused('array cycles', () => { const value = []; value.push(value); return value; }),
  refused('shared expansion is bounded, not just unique source objects', () => { let value = 0; for (let i = 0; i < 7; i++) value = [value, value]; return value; }, { nodes: 64, nesting: 8 }),
  ...[{ nodes: -1, nesting: 1 }, { nodes: Infinity, nesting: 1 }, { nodes: 4, nesting: 0.5 }, { bytes: 1024, nesting: 1 }].map((limits, index) => refused(`invalid caller capacity ${index + 1}`, () => 0, limits)),
];

export const nativeEqualityCases = [
  { name: 'equivalent signed zeros', a: () => ({ x: [-0] }), b: () => ({ x: [0] }), expected: true },
  { name: 'unordered object members', a: () => ({ b: 1, a: { d: 2, c: 3 } }), b: () => ({ a: { c: 3, d: 2 }, b: 1 }), expected: true },
  { name: 'record prototypes are not JSON meaning', a: () => Object.assign(Object.create(null), { x: 1 }), b: () => ({ x: 1 }), expected: true },
  { name: 'array order remains meaning', a: () => [['padding-left', '20px'], ['padding', '10px']], b: () => [['padding', '10px'], ['padding-left', '20px']], expected: false },
  { name: 'array repetitions remain meaning', a: () => [1, 1], b: () => [1], expected: false },
  { name: 'numeric strings remain strings', a: () => 0, b: () => '0', expected: false },
  { name: 'opaque signed-zero strings remain distinct', a: () => '-0', b: () => '0', expected: false },
  { name: 'opaque line endings remain distinct', a: () => 'one\r\ntwo', b: () => 'one\ntwo', expected: false },
  { name: 'Unicode normalization is not implicit', a: () => ({ 'é': 1 }), b: () => ({ 'e\u0301': 1 }), expected: false },
  { name: 'null is not an empty object', a: () => null, b: () => ({}), expected: false },
  { name: 'arrays are not records', a: () => [], b: () => ({}), expected: false },
  { name: 'member presence remains meaning', a: () => ({ a: 1 }), b: () => ({ b: 1 }), expected: false },
];

export function captureNativeValue(api, input, limits) {
  try { return { ok: true, value: api.normalizeNativeJson(input, limits) }; }
  catch (error) { return { ok: false, code: error.code, domainError: error instanceof api.DivletError }; }
}
