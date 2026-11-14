// Native text-profile witnesses shared by Node and native browser ESM. Budgets belong to the caller, not the source.
export const jsonTextLimits = Object.freeze({ bytes: 8192, nesting: 32 });
const accepted = (name, text, value, limits = jsonTextLimits) => ({ name, text, limits, expected: { ok: true, value } });
const refused = (name, text, limits = jsonTextLimits) => ({ name, text, limits, expected: { ok: false, code: 'INVALID_JSON', domainError: true } });

export const nativeJsonCases = [
  accepted('empty native data', '{}', {}),
  accepted('separate object scopes may reuse names', '{"a":{"id":1},"b":[{"id":2},{"id":3}]}', { a: { id: 1 }, b: [{ id: 2 }, { id: 3 }] }),
  accepted('arrays retain declaration order and repetitions', '[["color","red"],["color","blue"]]', [['color', 'red'], ['color', 'blue']]),
  accepted('object member order is not numeric or array order', '{"b":1,"a":2}', { b: 1, a: 2 }),
  accepted('JSON-looking metadata strings are opaque', String.raw`{"metadata":{"text":"{\"a\":1,\"a\":2}"}}`, { metadata: { text: '{"a":1,"a":2}' } }),
  accepted('opaque metadata retains UTF-16 and line endings', String.raw`{"metadata":{"text":"\r\n\u0000\ud800","version":"-0","schemaVersion":17}}`, { metadata: { text: '\r\n\0\ud800', version: '-0', schemaVersion: 17 } }),
  accepted('escaped backslashes and quotes in names', String.raw`{"slash\\":1,"quote\"":2}`, { 'slash\\': 1, 'quote"': 2 }),
  accepted('Unicode normalization is not implicit', String.raw`{"é":1,"e\u0301":2}`, { 'é': 1, 'e\u0301': 2 }),
  accepted('signed and underflowed zeros normalize at every level', '{"x":-0,"values":[0,-0.0,{"zero":-1e-400}]}', { x: 0, values: [0, 0, { zero: 0 }] }),
  accepted('primitive zero with no container budget', '-0', 0, { bytes: 2, nesting: 0 }),
  accepted('finite binary64 and precision strings', '[9007199254740993,"9007199254740993",1.7976931348623157e308]', [9007199254740992, '9007199254740993', Number.MAX_VALUE]),
  accepted('multibyte UTF-8 exact capacity', '{"é":0}', { 'é': 0 }, { bytes: 8, nesting: 1 }),
  accepted('container-depth exact capacity', '[[]]', [[]], { bytes: 4, nesting: 2 }),
  accepted('punctuation in strings is not nesting', '"[[[{}]]]"', '[[[{}]]]', { bytes: 10, nesting: 0 }),
  ...[
    ['literal names', '{"a":1,"a":2}'],
    ['escape-equivalent names', String.raw`{"a":1,"\u0061":2}`],
    ['nested metadata names', String.raw`{"metadata":{"key":1,"k\u0065y":2}}`],
    ['astral names', String.raw`{"𝄞":1,"\ud834\udd1e":2}`],
    ['backslash names', String.raw`{"\\":1,"\u005c":2}`],
    ['solidus names', String.raw`{"/":1,"\/":2}`],
    ['empty names', '{"":1,"":2}'],
    ['integer-looking names', String.raw`{"1":1,"\u0031":2}`],
  ].map(([name, text]) => refused(`duplicate ${name}`, text)),
  ...['1e400', '-1e400', '{"metadata":{"number":1e400}}'].map((text, index) => refused(`non-finite binary64 ${index + 1}`, text)),
  ...['-00', '{}{}', String.raw`{"a\q":1}`, '"tail\\', '{"a":[1}}', '{"text":"line\nbreak"}', '\u00a00'].map((text, index) => refused(`invalid platform JSON syntax ${index + 1}`, text)),
  refused('non-text inputs are not coerced', 0),
  refused('multibyte UTF-8 over capacity', '{"é":0}', { bytes: 7, nesting: 1 }),
  refused('container depth over capacity', '[[[]]]', { bytes: 6, nesting: 2 }),
  refused('source fields cannot raise caller budgets', '{"nesting":999,"value":{}}', { bytes: 128, nesting: 1 }),
  ...[{ bytes: -1, nesting: 1 }, { bytes: Infinity, nesting: 1 }, { bytes: 128, nesting: 0.5 }].map((limits, index) => refused(`invalid caller capacity ${index + 1}`, '0', limits)),
];

export function captureNativeJson(api, text, limits) {
  try { return { ok: true, value: api.parseNativeJson(text, limits) }; }
  catch (error) { return { ok: false, code: error.code, domainError: error instanceof api.DivletError }; }
}
