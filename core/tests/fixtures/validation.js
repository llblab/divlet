// The same admission witnesses run against the Node compatibility entry and native browser ESM.
const accepted = value => ({ ok: true, value });
const rejected = (message, code = 'INVALID_DOCUMENT', details) => ({ ok: false, name: 'DivletError', code, message, domainError: true, hasDetails: true, detailsKind: details === null ? 'null' : typeof details, details: details ?? null });
const nested = depth => { let value = null; while (depth--) value = [value]; return value; };

export const validationCases = [
  { name: 'default domain refusal', run: api => api.fail('refused'), expected: rejected('refused') },
  { name: 'custom refusal code and details', run: api => api.fail('refused', { why: 'test' }, 'CUSTOM'), expected: rejected('refused', 'CUSTOM', { why: 'test' }) },
  { name: 'explicit null details survive', run: api => { throw new api.DivletError('CUSTOM', 'refused', null); }, expected: rejected('refused', 'CUSTOM', null) },
  { name: 'plain object identity', run: api => { const value = { a: 1 }; return api.object(value, 'input') === value; }, expected: accepted(true) },
  { name: 'null-prototype object identity', run: api => { const value = Object.create(null); return api.object(value, 'input') === value; }, expected: accepted(true) },
  ...[
    ['null', () => null], ['array', () => []], ['date', () => new Date(0)], ['custom prototype', () => Object.create({ inherited: true })],
  ].map(([name, value]) => ({ name: `object refuses ${name}`, run: api => api.object(value(), 'input'), expected: rejected('input must be an object') })),
  { name: 'rendered text normalizes only newlines', run: api => api.string('One\r\nTwo\rThree\n😀', 'input'), expected: accepted('One\nTwo\nThree\n😀') },
  { name: 'text refuses non-string', run: api => api.string(123, 'input'), expected: rejected('input must be a string of at most 65536 characters') },
  { name: 'text accepts exact UTF-16 limit', run: api => api.string('😀', 'input', 2), expected: accepted('😀') },
  { name: 'text refuses excess UTF-16 units', run: api => api.string('😀', 'input', 1), expected: rejected('input must be a string of at most 1 characters') },
  { name: 'default text limit is not a UTF-8 byte budget', run: api => api.string('é'.repeat(65536), 'input').length, expected: accepted(65536) },
  { name: 'default text limit refuses next unit', run: api => api.string('é'.repeat(65537), 'input'), expected: rejected('input must be a string of at most 65536 characters') },
  ...['\0', '\ud800', '\udfff'].map(value => ({ name: `text refuses unrepresentable ${JSON.stringify(value)}`, run: api => api.string(value, 'input'), expected: rejected('input contains an unrepresentable character') })),
  { name: 'allowed own keys', run: api => { api.keys({ a: 1 }, new Set(['a']), 'input'); return true; }, expected: accepted(true) },
  { name: 'unknown own key', run: api => api.keys({ b: 1 }, new Set(['a']), 'input'), expected: rejected('Unsupported input field: b') },
  { name: 'ordinary JSON and inert metadata markers', run: api => { api.json({ schemaVersion: 3, values: [null, true, 'text', { x: 1 }] }); return true; }, expected: accepted(true) },
  { name: 'all finite binary64 classes remain admitted', run: api => { api.json([Number.MIN_VALUE, Number.MAX_VALUE, -0, 0.5, Number.MAX_SAFE_INTEGER + 1]); return true; }, expected: accepted(true) },
  ...[NaN, Infinity, -Infinity].map(value => ({ name: `JSON refuses ${String(value)}`, run: api => api.json(value), expected: rejected('value contains a non-finite number') })),
  ...[
    ['undefined', () => undefined], ['bigint', () => 1n], ['function', () => () => {}],
  ].map(([name, value]) => ({ name: `JSON refuses ${name}`, run: api => api.json(value()), expected: rejected('value must be an object') })),
  ...['__proto__', 'constructor', 'prototype'].map(key => ({ name: `JSON refuses unsafe key ${key}`, run: api => api.json(JSON.parse(`{"${key}":1}`)), expected: rejected(`Unsafe property name: ${key}`) })),
  { name: 'caller-owned preserve-keys mode remains explicit', run: api => { api.json(JSON.parse('{"__proto__":1,"constructor":2,"prototype":3}'), 'input', 0, true); return true; }, expected: accepted(true) },
  { name: 'inert JSON text is not rendered-text normalization', run: api => { const value = ['One\rTwo', '\0', '\ud800']; api.json(value); return JSON.stringify(value); }, expected: accepted(JSON.stringify(['One\rTwo', '\0', '\ud800'])) },
  { name: 'JSON accepts default depth boundary', run: api => { api.json(nested(80)); return true; }, expected: accepted(true) },
  { name: 'JSON refuses next default depth', run: api => api.json(nested(81)), expected: rejected('value is too deeply nested') },
  { name: 'JSON accepts caller depth boundary', run: api => { api.json(nested(2), 'input', 0, false, 2); return true; }, expected: accepted(true) },
  { name: 'JSON refuses next caller depth', run: api => api.json(nested(3), 'input', 0, false, 2), expected: rejected('input is too deeply nested') },
  { name: 'cyclic input has bounded domain refusal', run: api => { const value = {}; value.self = value; api.json(value); }, expected: rejected('value is too deeply nested') },
];

export function captureValidation(api, run) {
  try { return accepted(run(api)); }
  catch (error) {
    return { ok: false, name: error.name, code: error.code, message: error.message, domainError: error instanceof api.DivletError, hasDetails: Object.hasOwn(error, 'details'), detailsKind: error.details === null ? 'null' : typeof error.details, details: error.details ?? null };
  }
}
