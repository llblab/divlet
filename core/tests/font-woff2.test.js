import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { readFont, FONT_LIMITS } from '../lib/font.ts';
import { fontBytes } from './fixtures/font.js';
import { cffWoff2Bytes, nullWoff2Bytes, woff2Bytes } from './fixtures/font-woff2.js';
const reject = bytes => assert.throws(() => readFont(bytes), error => error.code === 'INVALID_FONT');
const known = { 0: 'cmap', 1: 'head', 2: 'hhea', 3: 'hmtx', 4: 'maxp', 5: 'name', 6: 'OS/2', 7: 'post', 10: 'glyf', 11: 'loca', 13: 'CFF ', 47: 'fvar', 48: 'gvar' };
// Locate records in trusted generated fixtures only, not a duplicate admission validator.
function layout(bytes) {
  let cursor = 48; const entries = [];
  for (let i = 0; i < bytes.readUInt16BE(12); i++) {
    const flagAt = cursor++, flags = bytes[flagAt], tagAt = cursor;
    const tag = (flags & 63) === 63 ? bytes.toString('ascii', cursor, cursor += 4) : known[flags & 63];
    const lengthAt = cursor; let length = 0, byte;
    do { byte = bytes[cursor++]; length = length * 128 + (byte & 127); } while (byte & 128);
    entries.push({ tag, tagAt, flagAt, lengthAt, length, lengthEnd: cursor });
  }
  return { entries, payload: cursor };
}
const base128 = value => { const bytes = []; do { bytes.unshift(value % 128); value = Math.floor(value / 128); } while (value); return Buffer.from(bytes.map((byte, i) => i < bytes.length - 1 ? byte | 128 : byte)); };
function replaceLength(bytes, record, value) {
  const output = Buffer.concat([bytes.subarray(0, record.lengthAt), value, bytes.subarray(record.lengthEnd)]); output.writeUInt32BE(output.length, 8); return output;
}
function replaceStream(bytes, stream) {
  const { payload } = layout(bytes), output = Buffer.alloc(Math.ceil((payload + stream.length) / 4) * 4);
  bytes.copy(output, 0, 0, payload); stream.copy(output, payload); output.writeUInt32BE(output.length, 8); output.writeUInt32BE(stream.length, 20); return output;
}

test('null-transform WOFF2 shares SFNT metadata for raw TrueType, static CFF and variable faces without changing input', () => {
  assert.deepEqual(readFont(cffWoff2Bytes()), { ...readFont(fontBytes(900, { family: 'Null Family', weight: 700, cff: true })), format: 'woff2', mediaType: 'font/woff2' });
  for (const options of [{}, { cff: true, family: 'CFF Δ Face', weight: 700, italic: true }, { axes: [['wght', 100, 400, 900], ['wdth', 75, 100, 125]] }]) {
    const raw = fontBytes(900, options), metadata = readFont(raw);
    for (const encoding of [{}, { explicit: true }, { reverse: true }, { reserved: 65535, declaredSize: 0 }, { declaredSize: 0xffffffff }]) {
      const bytes = nullWoff2Bytes(raw, encoding), before = Buffer.from(bytes);
      assert.deepEqual(readFont(bytes), { ...metadata, format: 'woff2', mediaType: 'font/woff2' }); assert.deepEqual(bytes, before);
    }
  }
});

test('WOFF2 header, tag uniqueness, optional blocks and paired glyph tables refuse malformed framing', () => {
  const original = nullWoff2Bytes(fontBytes(), { explicit: true }), { entries } = layout(original);
  for (const size of [4, 20, 47, 48, original.length - 1]) reject(original.subarray(0, size));
  for (const mutate of [
    bytes => bytes.writeUInt32BE(0x74746366, 4), bytes => bytes.writeUInt32BE(0x74727565, 4),
    bytes => bytes.writeUInt32BE(bytes.length - 1, 8), bytes => bytes.writeUInt16BE(0, 12), bytes => bytes.writeUInt16BE(4096, 12),
    ...[28, 32, 36, 40, 44].map(at => bytes => bytes.writeUInt32BE(1, at)),
    bytes => bytes.writeUInt32BE(0xffffffff, 20), bytes => bytes.writeUInt32BE(0, 20),
    bytes => bytes.fill(0, entries[0].tagAt, entries[0].tagAt + 4),
    bytes => bytes.copy(bytes, entries[1].tagAt, entries[0].tagAt, entries[0].tagAt + 4),
    bytes => bytes.write('ZZZZ', entries.find(entry => entry.tag === 'loca').tagAt),
  ]) { const bytes = Buffer.from(original); mutate(bytes); reject(bytes); }
});

test('WOFF2 Base128 integers and aggregate reconstruction budgets are checked before decoding', () => {
  const bytes = nullWoff2Bytes(), record = layout(bytes).entries[0];
  for (const value of [Buffer.from([128, 0]), Buffer.from([144, 128, 128, 128, 0]), Buffer.from([129, 128, 128, 128, 128, 0]), base128(FONT_LIMITS.bytes)]) reject(replaceLength(bytes, record, value));
  const truncated = bytes.subarray(0, record.lengthAt + 1); truncated[record.lengthAt] = 128; truncated.writeUInt32BE(truncated.length, 8); reject(truncated);
});

test('WOFF2 exact Brotli lengths, consumed bytes, standard window and trailing padding are enforced', () => {
  const original = nullWoff2Bytes(), { payload, entries } = layout(original), stream = original.subarray(payload, payload + original.readUInt32BE(20));
  const raw = brotliDecompressSync(stream);
  for (const delta of [-1, 1]) reject(replaceLength(original, entries[0], base128(entries[0].length + delta)));
  for (const suffix of [Buffer.from([0]), brotliCompressSync(Buffer.from('extra'))]) reject(replaceStream(original, Buffer.concat([stream, suffix])));
  const wide = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_LARGE_WINDOW]: 1, [constants.BROTLI_PARAM_LGWIN]: 25 } }); reject(replaceStream(original, wide));
  const broken = Buffer.from(original); broken[payload] ^= 255; reject(broken);
  const trailing = Buffer.concat([original, Buffer.alloc(4)]); trailing.writeUInt32BE(trailing.length, 8); reject(trailing);
  const padding = original.length - payload - stream.length;
  if (padding) { const bytes = Buffer.from(original); bytes[bytes.length - 1] = 1; reject(bytes); }
});

test('WOFF2 never enables transformed glyph/metrics tables or bypasses shared SFNT metadata refusal', () => {
  reject(woff2Bytes());
  const original = nullWoff2Bytes(), { entries } = layout(original);
  for (const [tag, version] of [['glyf', 0], ['loca', 0], ['hmtx', 1], ['name', 2]]) {
    const bytes = Buffer.from(original), at = entries.find(entry => entry.tag === tag).flagAt; bytes[at] = version << 6 | bytes[at] & 63; reject(bytes);
  }
  for (const options of [{ family: '' }, { restricted: true }, { weight: 0 }, { axes: [['ital', 0, 0, 1], ['slnt', -20, 0, 0]] }]) reject(nullWoff2Bytes(fontBytes(600, options)));
  const otf = fontBytes(); otf.write('OTTO'); reject(nullWoff2Bytes(otf));
});
