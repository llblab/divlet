// Authored shared tree/Data-URL witnesses. No host code, source parser substitution or filesystem/resource projection.
const URI = 'data:application/octet-stream;base64,AAH/';
export function captureAssetData(api, run) {
  try { return { value: run(api) }; }
  catch (error) { return { error: error.code, message: error.message }; }
}
export const assetDataCases = [
  { name: 'detached tree, exact names/strings and separately owned aliases', run(api) {
    const input = { folder: { '雪.bin': URI }, alias: URI, empty: {}, zero: 'data:text/plain;base64,' }, before = JSON.stringify(input);
    const result = api.readAssets(input), files = [...result.files].map(([name, file]) => [name, file.mediaType, [...file.bytes]]);
    result.files.get('alias').bytes[0] = 9;
    return { sameInput: JSON.stringify(input) === before, detached: result.tree !== input && result.tree.folder !== input.folder, sameTree: JSON.stringify(result.tree) === before, files, independent: result.files.get('folder/雪.bin').bytes[0] === 0 };
  }, expected: { value: { sameInput: true, detached: true, sameTree: true, files: [['folder/雪.bin', 'application/octet-stream', [0, 1, 255]], ['alias', 'application/octet-stream', [0, 1, 255]], ['zero', 'text/plain', []]], independent: true } } },
  { name: 'empty ordinary and null-prototype directories', run(api) { return [api.readAssets({ nested: {} }).tree, api.readAssets(Object.create(null)).tree]; }, expected: { value: [{ nested: {} }, {}] } },
  { name: 'sparse null deletes and directories accepted only in patch mode', run(api) { api.validateAssetPatch({ gone: null, nested: { gone: null, keep: URI }, empty: {} }); return true; }, expected: { value: true } },
  { name: 'stored null is not a deletion', run: api => api.readAssets({ file: null }), expected: { error: 'INVALID_ASSET', message: 'file must be an asset directory object.' } },
  { name: 'deleted names still validated', run: api => api.validateAssetPatch({ '../bad': null }), expected: { error: 'INVALID_ASSET' } },
  { name: 'aliases are refused rather than renamed', run: api => api.readAssets({ A: {}, a: {} }), expected: { error: 'INVALID_ASSET', message: 'Asset paths alias on a portable filesystem: a.' } },
  { name: 'noncanonical MIME refused', run: api => api.readAssets({ file: 'data:Text/Plain;base64,TQ==' }), expected: { error: 'INVALID_ASSET', message: 'file must use a canonical Data-URL media type without discarded parameters or a fragment delimiter.' } },
  { name: 'MIME fragment delimiter refused independently of payload', run: api => api.readAssets({ file: 'data:text/plain;p=#;base64,TQ==' }), expected: { error: 'INVALID_ASSET', message: 'file must use a canonical Data-URL media type without discarded parameters or a fragment delimiter.' } },
  { name: 'Data URL prefix before MIME or byte decoding', run: api => api.readAssets({ file: 'file:base64,TQ==' }), expected: { error: 'INVALID_ASSET', message: 'file must be a canonical base64 Data URL.' } },
  { name: 'noncanonical payload preserved as refusal', run: api => api.readAssets({ file: 'data:text/plain;base64,AB==' }), expected: { error: 'INVALID_ASSET', message: 'file has noncanonical base64 data.' } },
  { name: 'tree accessors refused without invocation', run(api) { let calls = 0; const input = Object.defineProperty({}, 'file', { enumerable: true, get() { calls++; return URI; } }); let code; try { api.readAssets(input); } catch (error) { code = error.code; } return { calls, code }; }, expected: { value: { calls: 0, code: 'INVALID_ASSET' } } },
  { name: 'cycles refused', run(api) { const input = {}; input.loop = input; return api.readAssets(input); }, expected: { error: 'INVALID_ASSET', message: 'Asset directories must not contain cycles.' } },
  { name: 'file-count boundary', run(api) { const input = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`file${i}`, URI])); const count = api.readAssets(input).files.size; let code; try { api.readAssets({ ...input, extra: URI }); } catch (error) { code = error.code; } return { count, code }; }, expected: { value: { count: 400, code: 'INVALID_ASSET' } } },
  { name: 'source-entry boundary includes empty directories', run(api) { return api.readAssets(Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [`dir${i}`, {}]))); }, expected: { error: 'INVALID_ASSET', message: 'Asset directories exceed the entry limit.' } },
  { name: 'depth bound', run(api) { let input = { file: URI }; for (let i = 0; i < 64; i++) input = { dir: input }; const count = api.readAssets(input).files.size; let code; try { api.readAssets({ dir: input }); } catch (error) { code = error.code; } return { count, code }; }, expected: { value: { count: 1, code: 'INVALID_ASSET' } } },
  { name: 'aggregate encoded budget precedes malformed URL', run: api => api.readAssets({ file: 'x'.repeat(32 * 1024 * 1024) }), expected: { error: 'INVALID_ASSET', message: 'Assets exceed the encoded-byte limit.' } },
  { name: 'decoded budget precedes output allocation', run: api => api.readAssets({ file: `data:text/plain;base64,${'AAAA'.repeat(Math.floor(20 * 1024 * 1024 / 3) + 1)}` }), expected: { error: 'INVALID_ASSET', message: 'file exceeds the 20971520 decoded-byte limit.' } },
  { name: 'text interpretation preserves MIME/charset and fatal UTF-8 policy', run(api) {
    const parsed = api.readAssets({ css: 'data:text/css;charset=US-ASCII;base64,SGk=', svg: 'data:image/svg+xml;base64,PHN2Zy8+', binary: URI });
    return [...parsed.files.values()].map(file => api.readAssetText(file));
  }, expected: { value: [{ kind: 'css', text: 'Hi', ascii: true }, { kind: 'svg', text: '<svg/>', ascii: false }, null] } },
  { name: 'invalid declared text is not transcoded', run(api) { return api.readAssetText(api.readAssets({ file: 'data:text/css;base64,/w==' }).files.get('file')); }, expected: { error: 'INVALID_ASSET', message: 'Declared text assets contain invalid UTF-8.' } },
  { name: 'HTML closure remains refused', run(api) { return api.readAssetText(api.readAssets({ file: 'data:text/html;base64,SGk=' }).files.get('file')); }, expected: { error: 'INVALID_ASSET', message: 'Declared HTML asset closure is not supported.' } },
];
export const browserAssetCases = [
  { name: 'empty directories still admitted', run: api => api.readAssets({ empty: {} }).tree, expected: { value: { empty: {} } } },
  { name: 'null-only patches still admitted', run(api) { api.validateAssetPatch({ gone: null, dir: {} }); return true; }, expected: { value: true } },
  { name: 'valid byte leaf remains unavailable', run: api => api.readAssets({ file: URI }), expected: { error: 'ASSETS_UNAVAILABLE' } },
  { name: 'invalid MIME remains behind byte capability boundary', run: api => api.readAssets({ file: 'data:INVALID;base64,!' }), expected: { error: 'ASSETS_UNAVAILABLE' } },
  { name: 'valid Data URL byte patches remain unavailable', run: api => api.validateAssetPatch({ file: URI }), expected: { error: 'ASSETS_UNAVAILABLE' } },
  { name: 'URL prefix still refuses before capability', run: api => api.readAssets({ file: 'not-a-data-url' }), expected: { error: 'INVALID_ASSET', message: 'file must be a canonical base64 Data URL.' } },
  { name: 'text reads remain unavailable', run: api => api.readAssetText({ mediaType: 'text/css', bytes: new Uint8Array([65]) }), expected: { error: 'ASSETS_UNAVAILABLE' } },
];
export function verifyAssetResult(actual, expected) {
  return expected.error && !expected.message ? actual.error === expected.error : JSON.stringify(actual) === JSON.stringify(expected);
}
