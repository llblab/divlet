import test from 'node:test';
import assert from 'node:assert/strict';
import { readFont, FONT_LIMITS } from '../lib/font.ts';
import { fontBytes } from './fixtures/font.js';
import { woffBytes } from './fixtures/font-woff.js';
import { referenceCffWoffBytes } from './fixtures/font-reference.js';
const pad = length => Math.ceil(length / 4) * 4;
const reject = bytes => assert.throws(() => readFont(bytes), error => error.code === 'INVALID_FONT');
function records(bytes) { return Array.from({ length: bytes.readUInt16BE(12) }, (_, i) => 44 + i * 20); }
function compressed(bytes) { return records(bytes).find(at => bytes.readUInt32BE(at + 8) < bytes.readUInt32BE(at + 12)); }
function resize(bytes, at, length) {
  bytes.writeUInt32BE(bytes.readUInt32BE(16) + pad(length) - pad(bytes.readUInt32BE(at + 12)), 16);
  bytes.writeUInt32BE(length, at + 12);
}

test('WOFF 1 metadata reuses SFNT semantics with compressed or raw tables and preserves original bytes', () => {
  const sfnt = fontBytes(900, { family: 'WOFF Δ Family', weight: 700, italic: true, axes: [['wdth', 75, 100, 125]] });
  const expected = { ...readFont(sfnt), format: 'woff', mediaType: 'font/woff' };
  for (const options of [{}, { compress: false }, { reverse: true }]) {
    const bytes = woffBytes(sfnt, options), before = Buffer.from(bytes);
    assert.deepEqual(readFont(bytes), expected); assert.deepEqual(bytes, before);
    bytes.writeUInt16BE(49, 20); bytes.writeUInt16BE(83, 22);
    assert.deepEqual(readFont(bytes), expected, 'container version fields are opaque and never rewritten as schema versions');
  }
});

test('independently built and encoded CFF1 WOFF has the same bounded metadata path without rewriting bytes', () => {
  const bytes = referenceCffWoffBytes(), before = Buffer.from(bytes);
  assert.equal(bytes.readUInt32BE(4), 0x4f54544f, 'genuine OTTO/CFF container, not a glyf flavor mutation');
  assert.deepEqual(readFont(bytes), { family: 'Reference Family', subfamily: 'Regular', format: 'woff', mediaType: 'font/woff', weight: '400', stretch: '100%', styles: ['normal'] });
  assert.deepEqual(bytes, before);
});

test('WOFF header, directory, aggregate expansion and unsupported-block bounds refuse without native exceptions', () => {
  const original = woffBytes();
  for (const length of [1, 4, 12, 43, 44, original.length - 1]) reject(original.subarray(0, length));
  for (const mutate of [
    bytes => bytes.writeUInt32BE(0x74746366, 4), bytes => bytes.writeUInt32BE(0x74727565, 4),
    bytes => bytes.writeUInt32BE(bytes.length - 1, 8), bytes => bytes.writeUInt16BE(1, 14),
    bytes => bytes.writeUInt16BE(0, 12), bytes => bytes.writeUInt16BE(4096, 12),
    ...[24, 28, 32, 36, 40].map(at => bytes => bytes.writeUInt32BE(1, at)),
    bytes => bytes.writeUInt32BE(FONT_LIMITS.bytes + 1, 16),
    bytes => bytes.writeUInt32BE(bytes.readUInt32BE(16) + 4, 16),
    bytes => bytes.writeUInt32BE(FONT_LIMITS.bytes, 44 + 12),
    bytes => bytes.writeUInt32BE(0xffffffff, 44 + 4), bytes => bytes.writeUInt32BE(45, 44 + 4),
    bytes => bytes.writeUInt32BE(bytes.readUInt32BE(48) + 4, 48),
    bytes => bytes.writeUInt32BE(bytes.readUInt32BE(44), 64),
    bytes => bytes.writeUInt32BE(bytes.readUInt32BE(48), 68),
    bytes => bytes.writeUInt32BE(bytes.readUInt32BE(56) + 1, 52),
  ]) { const bytes = Buffer.from(original); mutate(bytes); reject(bytes); }
});

test('WOFF inflation is output-bounded, consumes exactly one stream and verifies all table checksums and padding', () => {
  const original = woffBytes(), at = compressed(original);
  assert.notEqual(at, undefined);
  for (const delta of [-1, 1]) { const bytes = Buffer.from(original); resize(bytes, at, bytes.readUInt32BE(at + 12) + delta); reject(bytes); }
  const checksum = Buffer.from(original); checksum.writeUInt32BE(checksum.readUInt32BE(at + 16) ^ 1, at + 16); reject(checksum);
  const broken = Buffer.from(original); broken[broken.readUInt32BE(at + 4)] ^= 255; reject(broken);
  const withPadding = records(original).find(at => original.readUInt32BE(at + 8) % 4 !== 0);
  assert.notEqual(withPadding, undefined);
  const padding = Buffer.from(original); padding[padding.readUInt32BE(withPadding + 4) + padding.readUInt32BE(withPadding + 8)] = 1; reject(padding);
  const trailingStream = Buffer.from(original), compressedPadded = records(original).find(at => original.readUInt32BE(at + 8) < original.readUInt32BE(at + 12) && original.readUInt32BE(at + 8) % 4 !== 0);
  assert.notEqual(compressedPadded, undefined);
  trailingStream.writeUInt32BE(trailingStream.readUInt32BE(compressedPadded + 8) + 1, compressedPadded + 8); reject(trailingStream);
  const trailing = Buffer.concat([original, Buffer.alloc(4)]); trailing.writeUInt32BE(trailing.length, 8); reject(trailing);
  const raw = woffBytes(fontBytes(), { compress: false }); raw[raw.readUInt32BE(48)] ^= 1; reject(raw, 'uncompressed tables are checked too');
});

test('WOFF does not bypass SFNT names, embedding, axes or outline-flavor admission', () => {
  for (const options of [{ family: '' }, { restricted: true }, { weight: 0 }, { axes: [['ital', 0, 0, 1], ['slnt', -20, 0, 0]] }]) reject(woffBytes(fontBytes(600, options)));
  const otf = fontBytes(); otf.write('OTTO'); reject(woffBytes(otf), 'CFF outlines are still required for OTTO');
  const woff2 = woffBytes(); woff2.write('wOF2'); reject(woff2);
});
