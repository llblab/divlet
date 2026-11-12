// Host-independent witnesses shared by Node and actual browser module imports.
const accepted = [
  ['brand-font', '', 'asset:brand-font'],
  ['fonts/Regular.woff2', '', 'asset:fonts/Regular.woff2'],
  ['fonts/Regular.woff2', '?v=2#face', 'asset:fonts/Regular.woff2?v=2#face'],
  ['icons/logo.svg', '#viewBox(0,0,100,100)', 'asset:icons/logo.svg#viewBox(0,0,100,100)'],
  ['fonts/雪.woff2', '', 'asset:fonts/%E9%9B%AA.woff2'],
  ["fonts/O'Brien (Italic).woff2", '', 'asset:fonts/O%27Brien%20%28Italic%29.woff2'],
  ['font#name.woff2', '', 'asset:font%23name.woff2'],
  ['percent/%2F.woff2', '', 'asset:percent/%252F.woff2'],
  ['fonts/e\u0301.woff2', '', 'asset:fonts/e%CC%81.woff2'],
  ['fonts/é.woff2', '', 'asset:fonts/%C3%A9.woff2'],
  ['icons/logo.svg', '?theme=dark&x=%2f#%E9%9B%AA', 'asset:icons/logo.svg?theme=dark&x=%2f#%E9%9B%AA'],
  ['f', '?#', 'asset:f?#'],
];
const malformed = [
  'asset:', 'asset:/font', 'asset://host/font', 'ASSET:font', ' asset:font', 'asset:font ',
  'asset:fonts//font', 'asset:../font', 'asset:.private', 'asset:C:/font', 'asset:constructor/font',
  'asset:fonts/a%2Fb', 'asset:fonts/a%5Cb', 'asset:%2e%2e/font', 'asset:%2E%2E/font',
  'asset:%66ont', 'asset:fonts/%e9%9b%aa.woff2', 'asset:fonts/雪.woff2', 'asset:fonts/%FF',
  'asset:fonts/%C0%AF', 'asset:fonts/%', 'asset:fonts/%00', 'asset:fonts/%7F', 'asset:fonts/%3F',
  'asset:font#raw space', 'asset:font?x=%0G', 'asset:font#two#hash', 'asset:font#<script>',
  'asset:font#\n', 'asset:font?raw=雪', 'asset:font#%u1234',
];
const capture = (api, call) => {
  try { return call(); } catch (error) {
    return { code: error.code, domainError: error.name === 'DivletError' && error instanceof api.DivletError };
  }
};
const refused = { code: 'INVALID_ASSET', domainError: true };
const longestPath = [...Array(8).fill('a'.repeat(226)), 'b'.repeat(232)].join('/');
export const assetReferenceCases = [
  ...[
    ['styles/main.css', '../fonts/Foo Regular.woff2?#face', 'asset:fonts/Foo%20Regular.woff2?#face'],
    ['styles/main.css', './nested/a.css', 'asset:styles/nested/a.css'],
    ['styles/main.css', '../icons/雪.svg#mark', 'asset:icons/%E9%9B%AA.svg#mark'],
    ['styles/main.css', '../percent/%252F.bin', 'asset:percent/%252F.bin'],
    ['styles/main.css', '?v=1#mark', 'asset:styles/main.css?v=1#mark'],
    ['styles/main.css', 'asset:font#face', 'asset:font#face'],
  ].map(([base, input, expected], i) => ({ name: `declared dependency ${i + 1}`, expected, run: api => api.resolveAssetDependency(base, input) })),
  ...['../../escape.png', '/root.png', '//example.invalid/file', 'file:///private', 'https://example.invalid/file', '%2e%2e/file', '..%2ffile', 'a%5cb', 'a//b', 'a/', 'a\\\\b', 'a?x=%GG', 'a#raw space', 'a\\n', 'a%FF'].map((input, i) => ({ name: `dependency refusal ${i + 1}`, expected: refused, run: api => capture(api, () => api.resolveAssetDependency('styles/main.css', input)) })),
  { name: 'exact path limit', expected: longestPath, run: api => api.readAssetReference(api.assetReference(longestPath)).path },
  { name: 'over path limit', expected: refused, run: api => capture(api, () => api.assetReference(longestPath + 'c')) },
  { name: 'exact multibyte component limit', expected: 'é'.repeat(127) + 'a', run: api => api.readAssetReference(api.assetReference('é'.repeat(127) + 'a')).path },
  { name: 'exact directory-depth limit', expected: 'd/'.repeat(64) + 'font', run: api => api.readAssetReference(api.assetReference('d/'.repeat(64) + 'font')).path },
  { name: 'over directory-depth limit', expected: refused, run: api => capture(api, () => api.readAssetReference('asset:' + 'd/'.repeat(65) + 'font')) },
  { name: 'exact suffix limit', expected: '#' + 'x'.repeat(2047), run: api => api.readAssetReference(api.assetReference('font', '#' + 'x'.repeat(2047))).suffix },
  ...accepted.map(([path, suffix, url], i) => ({
    name: `reference round trip ${i + 1}`, expected: { url, parsed: { path, suffix } },
    run: api => ({ url: api.assetReference(path, suffix), parsed: api.readAssetReference(url) }),
  })),
  ...malformed.map((url, i) => ({ name: `reference refusal ${i + 1}`, expected: refused, run: api => capture(api, () => api.readAssetReference(url)) })),
  ...['data:font/woff2;base64,AQ==', 'DATA:image/png;base64,AQ==', 'fonts/Regular.woff2', '/assets/font.woff2', 'https://example.invalid/font.woff2', 'blob:example', '#mark', '', 'metadata asset:font'].map((url, i) => ({ name: `ordinary URL untouched ${i + 1}`, expected: null, run: api => api.readAssetReference(url) })),
  ...['', '.', '..', '.hidden', 'fonts/../x', '/absolute', 'a/', 'a//b', 'a\\b', 'x:', 'x?', 'x*', 'x.', 'x ', 'CON.woff', 'COM¹', '__proto__', 'a\u0000b', '\ud800', 'é'.repeat(128)].map((path, i) => ({ name: `decoded path refusal ${i + 1}`, expected: refused, run: api => capture(api, () => api.assetReference(path)) })),
  ...[null, 0, [], {}, { toString() { throw new Error('must not coerce input'); } }].map((value, i) => ({ name: `nontext refusal ${i + 1}`, expected: refused, run: api => capture(api, () => api.readAssetReference(value)) })),
  ...['not-a-suffix', '?a b', '#<script>', '#a\\b', '#\ud800', '#%GG', `#${'x'.repeat(2048)}`].map((suffix, i) => ({ name: `suffix refusal ${i + 1}`, expected: refused, run: api => capture(api, () => api.assetReference('font', suffix)) })),
];
