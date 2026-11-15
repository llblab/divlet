// Raw artifact filenames versus canonical encoded asset URIs; these are not filesystem grants.
export const assetOutputCases = [
  { name: 'native control-bearing site directory', reference: { path: 'image.bin', suffix: '' }, output: 'a\u007fb/index.html', expected: '../assets/image.bin' },
  { name: 'native newline-bearing site directory', reference: { path: 'image.bin', suffix: '' }, output: 'a\nb/index.html', expected: '../assets/image.bin' },
  { name: 'root frame', reference: { path: 'image.bin', suffix: '' }, output: 'frame.html', expected: 'assets/image.bin' },
  { name: 'colon in a valid frame identity', reference: { path: 'image.bin', suffix: '#part' }, output: 'Frame:one.html', expected: 'assets/image.bin#part' },
  { name: 'nested site output', reference: { path: 'fonts/Regular.woff2', suffix: '?v=1#face' }, output: 'guide/start/index.html', expected: '../../assets/fonts/Regular.woff2?v=1#face' },
  { name: 'same raw directory still goes via root', reference: { path: 'theme/paint.svg', suffix: '#paint' }, output: 'assets/theme/style.css', expected: '../../assets/theme/paint.svg#paint' },
  { name: 'literal percent directory cannot alias decoded separator', reference: { path: 'a%2Fb/paint.svg', suffix: '#paint' }, output: 'assets/a/b.svg', expected: '../../assets/a%252Fb/paint.svg#paint' },
  { name: 'encoded-looking source directory is counted raw', reference: { path: 'a/paint.svg', suffix: '' }, output: 'assets/a%2Fb/style.css', expected: '../../assets/a/paint.svg' },
  { name: 'percent dot stays a literal authored name', reference: { path: '%2e/paint.svg', suffix: '' }, output: 'assets/%2e/style.css', expected: '../../assets/%252e/paint.svg' },
  { name: 'Unicode name and source directory', reference: { path: '字/é.png', suffix: '' }, output: 'assets/字/style.css', expected: '../../assets/%E5%AD%97/%C3%A9.png' },
  { name: 'decomposed Unicode is not renamed', reference: { path: 'e\u0301.png', suffix: '' }, output: 'index.html', expected: 'assets/e%CC%81.png' },
  { name: 'spaces and fragment-like path names are encoded', reference: { path: 'a b/a#b.svg', suffix: '#shape' }, output: 'assets/source #1/style.css', expected: '../../assets/a%20b/a%23b.svg#shape' },
  { name: 'escaped punctuation and opaque suffix case', reference: { path: "a!'()+.svg", suffix: '?x=%aB&next=a/b#part%2f' }, output: 'page.html', expected: 'assets/a%21%27%28%29%2B.svg?x=%aB&next=a/b#part%2f' },
  { name: 'deep declared output', reference: { path: 'root.bin', suffix: '?' }, output: 'assets/a/b/c/style.css', expected: '../../../../assets/root.bin?' },
];
export const assetOutputRefusals = [null, undefined, 1, {}, '', '/index.html', 'a//b.css', 'a/./b.css', 'a/../b.css', 'a/', 'a\\b.css', 'a\0b.css'];
export function captureAssetOutput(api, reference, output) {
  try { return { value: api.assetOutputUrl(reference, output) }; }
  catch (error) { return { error: error.code }; }
}
