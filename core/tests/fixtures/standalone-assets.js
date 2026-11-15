// Authored single-file export witnesses. Literal Data URLs remain input; this fixture owns no resolver or storage.
const ascii = (text, mediaType = 'text/css') => `data:${mediaType};base64,${btoa(text)}`;
const fragment = { fragment: true };
const payload = html => /(?:href|src)="data:[^;]+(?:;[^,]+)*;base64,([^"#]+)(?:#[^"]*)?"/.exec(html)?.[1];
const decoded = html => new TextDecoder().decode(Uint8Array.from(atob(payload(html)), char => char.charCodeAt(0)));
export async function captureStandalone(api, run) {
  try { return { value: await run(api) }; } catch (error) { return { error: error.code }; }
}
export const standaloneAssetCases = [
  { name: 'nontext HTML is not coerced by the portable UTF-8 encoder', async run(api) {
    let calls = 0; const input = { toString() { calls++; return '<img>'; } };
    try { await api.inlineDeclaredAssets(input, { one: 'data:application/octet-stream;base64,AQID' }, fragment); }
    catch (error) { return { type: error.name, calls }; }
    return { type: null, calls };
  }, expected: { value: { type: 'TypeError', calls: 0 } } },
  { name: 'no declared files keeps exact original HTML bytes', run: api => api.inlineDeclaredAssets('<IMG  src="./legacy.png" >', {}, fragment), expected: { value: '<IMG  src="./legacy.png" >' } },
  { name: 'binary aliases, fragment suffix and literal inline URLs retain meaning', run: api => api.inlineDeclaredAssets('<img src="asset:one#part"><img src="asset:alias"><img src="data:image/png;base64,AQID">', { one: 'data:application/octet-stream;base64,AQID', alias: 'data:application/octet-stream;base64,AQID' }, fragment), expected: { value: '<img src="data:application/octet-stream;base64,AQID#part"><img src="data:application/octet-stream;base64,AQID"><img src="data:image/png;base64,AQID">' } },
  { name: 'multi-block binary encoding preserves the complete standard base64 spelling', async run(api) {
    const uri = ascii(String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i)).repeat(100), 'application/octet-stream');
    const result = await api.inlineDeclaredAssets('<img src="asset:one">', { one: uri }, fragment);
    return result === `<img src="${uri}">`;
  }, expected: { value: true } },
  { name: 'UTF-8 SVG serialization retains expanded supplementary characters', async run(api) {
    const uri = ascii('<svg xmlns="http://www.w3.org/2000/svg"><text>&#955;&#128512;</text></svg>', 'image/svg+xml');
    return decoded(await api.inlineDeclaredAssets('<img src="asset:one">', { one: uri }, fragment)).includes('λ😀');
  }, expected: { value: true } },
  { name: 'CSS dependency bases embed ordinary font bytes', async run(api) {
    return decoded(await api.inlineDeclaredAssets('<link rel="stylesheet" href="asset:styles/theme.css">', { styles: { 'theme.css': ascii('@font-face{font-family:Proof;src:url(../fonts/face.bin)}') }, fonts: { 'face.bin': 'data:font/woff2;base64,AQID' } }, fragment));
  }, expected: { value: '@font-face{font-family:Proof;src:url("data:font/woff2;base64,AQID")}' } },
  { name: 'SVG uses strict XML projection and retains inert metadata and same-document paint', async run(api) {
    const text = '<svg xmlns="http://www.w3.org/2000/svg"><metadata><note xmlns="urn:example" href="asset:inert"/></metadata><rect fill="url(#paint)"/></svg>';
    const result = decoded(await api.inlineDeclaredAssets('<img src="asset:icon">', { icon: ascii(text, 'image/svg+xml') }, fragment));
    return { metadata: result.includes('href="asset:inert"'), paint: result.includes('fill="url(&quot;#paint&quot;)') };
  }, expected: { value: { metadata: true, paint: true } } },
  { name: 'nondeclared HTML URLs and literal inline bytes are not extracted or fetched', run: api => api.inlineDeclaredAssets('<img src="./legacy.png"><img src="data:image/png;base64,AQID"><a href="https://unrequested.invalid/">Link</a>', { unused: 'data:application/octet-stream;base64,AQID' }, fragment), expected: { value: '<img src="./legacy.png"><img src="data:image/png;base64,AQID"><a href="https://unrequested.invalid/">Link</a>' } },
  { name: 'missing declaration never falls back to a filesystem file', run: api => api.inlineDeclaredAssets('<img src="asset:missing">', { unused: 'data:application/octet-stream;base64,AQID' }, fragment), expected: { error: 'INVALID_ASSET' } },
  { name: 'query semantics refuse before missing-file lookup', run: api => api.inlineDeclaredAssets('<img src="asset:missing?q=1">', { unused: 'data:application/octet-stream;base64,AQID' }, fragment), expected: { error: 'UNSUPPORTED_EXPORT' } },
  { name: 'external SVG use requires a project or bundle copy', run: api => api.inlineDeclaredAssets('<svg><use href="asset:one#shape"></use></svg>', { one: 'data:image/svg+xml;base64,PHN2Zy8+' }, fragment), expected: { error: 'UNSUPPORTED_EXPORT' } },
  { name: 'cyclic CSS dependencies refuse a lossy single-file export', run: api => api.inlineDeclaredAssets('<link href="asset:a.css">', { 'a.css': ascii('@import "b.css";'), 'b.css': ascii('@import "a.css";') }, fragment), expected: { error: 'UNSUPPORTED_EXPORT' } },
  { name: 'ASCII SVG character references cannot silently change declared encoding', run: api => api.inlineDeclaredAssets('<img src="asset:one">', { one: ascii('<svg xmlns="http://www.w3.org/2000/svg"><text>&#955;</text></svg>', 'image/svg+xml;charset=us-ascii') }, fragment), expected: { error: 'INVALID_ASSET' } },
  { name: 'invalid UTF-8 declared CSS refuses rather than replacing bytes', run: api => api.inlineDeclaredAssets('<link href="asset:bad">', { bad: 'data:text/css;base64,/w==' }, fragment), expected: { error: 'INVALID_ASSET' } },
  { name: 'unsupported declared HTML closure is refused', run: api => api.inlineDeclaredAssets('<img src="asset:one">', { one: ascii('<p>not an image</p>', 'text/html') }, fragment), expected: { error: 'INVALID_ASSET' } },
  { name: 'indirect closed CSS carriers keep their conservative refusal', run: api => api.inlineDeclaredAssets('<link href="asset:one">', { one: ascii('.a{background:var(--image)}') }, fragment), expected: { error: 'COPY_UNSUPPORTED_RESOURCE' } },
  { name: 'repeated references consume the expanded HTML work budget', run: api => api.inlineDeclaredAssets('<img src="asset:one">'.repeat(50), { one: ascii('x'.repeat(1024 * 1024), 'application/octet-stream') }, fragment), expected: { error: 'FILE_TOO_LARGE' } },
];
export const standalonePaintSource = '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"><rect width="7" height="9" fill="#123456"/></svg>';
export const standalonePaintAssets = () => ({ pixel: ascii(standalonePaintSource, 'image/svg+xml'), 'paint.css': ascii('.standalone-proof{padding-left:17px;background-image:url(asset:pixel)}') });
