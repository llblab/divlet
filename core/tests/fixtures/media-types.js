// Shared authored admission/read witnesses; generated partitions are independently checked against Node's MIMEType in the unit gate.
/** @type {Array<[string, string, Array<[string, string]>]>} */
export const mediaTypes = [
  ['text/plain', 'text/plain', []],
  ['*/*', '*/*', []],
  ['image/svg+xml', 'image/svg+xml', []],
  ['application/vnd.example+json;version=1', 'application/vnd.example+json', [['version', '1']]],
  ['text/css;charset=UTF-8', 'text/css', [['charset', 'UTF-8']]],
  ['text/plain;p=""', 'text/plain', [['p', '']]],
  ['text/plain;p=" "', 'text/plain', [['p', ' ']]],
  ['text/plain;p="a;b";q=UPPER', 'text/plain', [['p', 'a;b'], ['q', 'UPPER']]],
  ['text/plain;p="a\\\\b"', 'text/plain', [['p', 'a\\b']]],
  ['text/plain;p="a\\\"b"', 'text/plain', [['p', 'a"b']]],
  ['text/plain;__proto__=x;constructor=y', 'text/plain', [['__proto__', 'x'], ['constructor', 'y']]],
];
export const invalidMediaTypes = [
  '', 'text', '/plain', 'text/', 'text/plain/extra', 'Text/plain', 'text/PLAIN', ' text/plain', 'text/plain ',
  'text/plain; charset=utf-8', 'text/plain;P=x', 'text/plain;p="x"', 'text/plain;p=', 'text/plain;p=x;p=y',
  'text/plain;p=x;', 'text/plain;p="unterminated', 'text/plain;p="a\\b"', 'text/plain;p="a"trailing',
  'text/plain;p=x\t', 'text/pláin', 'text/plain;p="\u007f"', 'text/plain;p="\n"',
];
export const mimeCandidates = () => {
  const values = new Set([...mediaTypes.map(([input]) => input), ...invalidMediaTypes]);
  for (let code = 0; code <= 127; code++) {
    const char = String.fromCharCode(code);
    for (const value of [`tex${char}t/plain`, `text/pla${char}in`, `text/plain;na${char}me=x`, `text/plain;p=a${char}b`, `text/plain;p="${char}"`, `text/plain;p="a\\${char}b"`]) values.add(value);
  }
  const parts = ['p=x', 'P=x', 'p=', 'p=""', 'p="x"', 'p=" "', 'p="a;b"', 'p="a\\b"', 'q=y', '__proto__=value'];
  for (const left of parts) for (const right of parts) values.add(`text/plain;${left};${right}`);
  for (const value of ['a'.repeat(1022) + '/b', 'a'.repeat(1021) + '/b', 'text/plain;p=' + 'x'.repeat(1011), 'text/plain;p=' + 'x'.repeat(1012)]) values.add(value);
  return [...values];
};
export function checkMediaTypeWitnesses(api) {
  for (const [input, essence, params] of mediaTypes) {
    const actual = api.canonicalMediaType(input);
    if (!actual || actual.essence !== essence || actual.toString() !== input || JSON.stringify([...actual.params]) !== JSON.stringify(params)) throw new Error(`MIME witness failed: ${input}`);
    for (const [name, value] of params) if (actual.params.get(name.toUpperCase()) !== value) throw new Error('MIME parameter lookup lost ASCII case folding.');
    if (actual.params.get('absent') !== null) throw new Error('An absent MIME parameter must be null.');
  }
  for (const input of invalidMediaTypes) if (api.canonicalMediaType(input) !== null) throw new Error(`Noncanonical MIME accepted: ${input}`);
  return mediaTypes.length + invalidMediaTypes.length;
}
