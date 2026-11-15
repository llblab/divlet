// Shared payload partitions and authored byte/refusal witnesses; Node's former Buffer round trip is the independent oracle.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const assetBase64Cases = [
  { input: '', maxBytes: 0, bytes: [] },
  { input: 'TQ==', maxBytes: 1, bytes: [77] },
  { input: 'TWE=', maxBytes: 2, bytes: [77, 97] },
  { input: 'TWFu', maxBytes: 3, bytes: [77, 97, 110] },
  { input: '+/8=', maxBytes: 2, bytes: [251, 255] },
  { input: '////', maxBytes: 3, bytes: [255, 255, 255] },
  { input: 'AA==', maxBytes: 1, bytes: [0] },
  { input: 'AB==', maxBytes: 1, error: 'noncanonical' },
  { input: 'AAB=', maxBytes: 2, error: 'noncanonical' },
  { input: 'A===', maxBytes: 2, error: 'invalid' },
  { input: '====', maxBytes: 2, error: 'invalid' },
  { input: 'AA=A', maxBytes: 3, error: 'invalid' },
  { input: '____', maxBytes: 3, error: 'invalid' },
  { input: 'TQ==\n', maxBytes: 6, error: 'invalid' },
  { input: '!!!!', maxBytes: 2, error: 'limit' },
  { input: '!!!!', maxBytes: 3, error: 'invalid' },
  { input: 'TWFu', maxBytes: 2, error: 'limit' },
];
export function assetBase64Payloads() {
  const values = new Set(assetBase64Cases.map(row => row.input));
  for (const a of alphabet) for (const b of alphabet) values.add(`${a}${b}==`);
  for (const prefix of ['AA', '//', '++', 'AZ']) for (const c of alphabet) values.add(`${prefix}${c}=`);
  for (let code = 0; code <= 127; code++) {
    const c = String.fromCharCode(code);
    for (const input of [c, `${c}AAA`, `A${c}AA`, `AA${c}A`, `AAA${c}`, `AA==${c}`]) values.add(input);
  }
  for (const input of ['=', '==', '===', 'A', 'AA', 'AAA', 'AAAA=', 'AAAA==', 'AAAA====', 'AAAA AAAA', 'AAAA\r\n', 'AAAA\u00a0', '\ud800AAA']) values.add(input);
  return [...values];
}
export function captureAssetBase64(api, input, maxBytes = 6, where = 'file') {
  try { return { bytes: [...api.decodeAssetBase64(input, maxBytes, where)] }; }
  catch (error) { return { error: error.code, message: error.message }; }
}
export function checkAssetBase64Witnesses(api) {
  for (const { input, maxBytes, bytes, error } of assetBase64Cases) {
    const expected = error ? { error: 'INVALID_ASSET', message: error === 'limit' ? `file exceeds the ${maxBytes} decoded-byte limit.` : `file has ${error} base64 data.` } : { bytes };
    if (JSON.stringify(captureAssetBase64(api, input, maxBytes)) !== JSON.stringify(expected)) throw new Error(`Asset base64 witness failed: ${input}`);
  }
  return assetBase64Cases.length;
}
