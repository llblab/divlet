import test from 'node:test';
import assert from 'node:assert/strict';
import { readFont, FONT_LIMITS } from '../lib/font.ts';
import { fontBytes, fontFamily } from './fixtures/font.js';

function table(bytes, tag) {
  for (let i = 0; i < bytes.readUInt16BE(4); i++) { const at = 12 + i * 16; if (bytes.toString('ascii', at, at + 4) === tag) return { record: at, offset: bytes.readUInt32BE(at + 8), length: bytes.readUInt32BE(at + 12) }; }
  throw new Error(`Missing fixture table ${tag}`);
}
const reject = (bytes, message) => assert.throws(() => readFont(bytes), error => error.code === 'INVALID_FONT', message);

test('face metadata is derived from SFNT names/OS2, not a filename, without retaining or changing bytes', () => {
  const bytes = fontBytes(), before = Buffer.from(bytes), result = readFont(bytes);
  assert.deepEqual(result, { family: fontFamily, subfamily: 'Regular', format: 'truetype', mediaType: 'font/ttf', weight: '400', stretch: '100%', styles: ['normal'] });
  assert.deepEqual(bytes, before);
  assert.deepEqual(readFont(fontBytes(600, { nameFormat: 1 })), result, 'format-one names with a bounded empty language-tag list are supported');
  result.styles.push('changed'); assert.deepEqual(readFont(bytes).styles, ['normal'], 'returned metadata has no decoder state aliases');
  assert.deepEqual(readFont(new Uint8Array(bytes)), { ...result, styles: ['normal'] });
  for (const [options, expected] of [
    [{ weight: 700, italic: true, subfamily: 'Bold Italic' }, { weight: '700', styles: ['italic'] }],
    [{ width: 3, oblique: true, angle: -12 }, { stretch: '75%', styles: ['oblique 12deg'] }],
    [{ width: 9, oblique: true }, { stretch: '200%', styles: ['oblique 14deg'] }],
  ]) for (const [key, value] of Object.entries(expected)) assert.deepEqual(readFont(fontBytes(600, options))[key], value);
});

test('Unicode typographic names take precedence and remain exact text, not CSS or normalized identifiers', () => {
  const family = 'Δ Typeface, "Quoted" (Family)', subfamily = 'Semi Bold Italic';
  assert.equal(readFont(fontBytes(600, { family: 'Legacy', typographicFamily: family, typographicSubfamily: subfamily })).family, family);
  assert.equal(readFont(fontBytes(600, { typographicSubfamily: subfamily })).subfamily, subfamily);
  for (const name of ['', ' ', '\u0000', 'line\nbreak', '\ud800', 'x'.repeat(FONT_LIMITS.name + 1)]) reject(fontBytes(600, { family: name }));
  assert.equal(readFont(fontBytes(600, { family: 'x'.repeat(FONT_LIMITS.name) })).family.length, FONT_LIMITS.name);
});

test('variable ranges produce bounded ordinary CSS face descriptors and keep unrelated axes opaque in the original bytes', () => {
  const variable = readFont(fontBytes(600, { axes: [['wght', 100, 400, 900], ['wdth', 75, 100, 125], ['opsz', 8, 12, 72]] }));
  assert.equal(variable.weight, '100 900'); assert.equal(variable.stretch, '75% 125%'); assert.deepEqual(variable.styles, ['normal']);
  assert.deepEqual(readFont(fontBytes(600, { axes: [['ital', 0, 0, 1]] })).styles, ['normal', 'italic']);
  assert.deepEqual(readFont(fontBytes(600, { axes: [['ital', 1, 1, 1]] })).styles, ['italic']);
  assert.deepEqual(readFont(fontBytes(600, { axes: [['slnt', -20, 0, 0]] })).styles, ['normal', 'oblique 0deg 20deg']);
  assert.deepEqual(readFont(fontBytes(600, { axes: [['slnt', -20, -15, -10]] })).styles, ['oblique 10deg 20deg']);
  assert.deepEqual(readFont(fontBytes(600, { axes: [['slnt', 0, 0, 0]] })).styles, ['normal']);
  for (const axes of [
    [['wght', 0, 400, 900]], [['wght', 100, 400, 1001]], [['wdth', 0, 100, 200]],
    [['wght', 900, 400, 100]], [['wght', 100, 900, 800]], [['ital', 0.5, 0.5, 1]],
    [['slnt', -91, 0, 0]], [['ital', 0, 0, 1], ['slnt', -10, 0, 0]],
    [['wght', 100, 400, 900], ['wght', 100, 400, 900]],
  ]) reject(fontBytes(600, { axes }), JSON.stringify(axes));
});

test('unsupported containers, budgets, embedding restrictions and invalid static metadata refuse with bounded diagnostics', () => {
  const opaque = new Proxy(new Uint8Array(12), { get() { throw new Error('Must not inspect a foreign proxy'); } });
  for (const input of [undefined, null, '', {}, [], opaque, new DataView(new ArrayBuffer(12)), Buffer.alloc(0), Buffer.alloc(FONT_LIMITS.bytes + 1)]) reject(input);
  const shadowed = fontBytes(); Object.defineProperty(shadowed, 'byteLength', { get() { throw new Error('Must use byte-array internal length'); } });
  assert.equal(readFont(shadowed).family, fontFamily);
  const oversized = Buffer.alloc(FONT_LIMITS.bytes + 1); Object.defineProperty(oversized, 'byteLength', { value: 1 }); reject(oversized);
  for (const magic of ['wOFF', 'wOF2', 'ttcf', 'true', 'NOPE']) { const bytes = fontBytes(); bytes.write(magic); reject(bytes); }
  for (const options of [{ weight: 0 }, { weight: 1001 }, { width: 0 }, { width: 10 }, { restricted: true }, { oblique: true, angle: 91 }]) reject(fontBytes(600, options));
  const otf = fontBytes(); otf.write('OTTO'); reject(otf, 'OTF flavor is not permission to reinterpret glyf outlines as CFF');
});

test('name identities and versioned/contradictory OS2 flags cannot supply trusted metadata', () => {
  for (const identity of ['missing-language', 'undefined-unicode']) {
    const bytes = fontBytes(600, { nameFormat: 1 }), at = table(bytes, 'name').offset;
    for (let i = 0; i < bytes.readUInt16BE(at + 2); i++) {
      const record = at + 6 + 12 * i;
      if (identity === 'missing-language') bytes.writeUInt16BE(0x8000, record + 4);
      else { bytes.writeUInt16BE(0, record); bytes.writeUInt16BE(0xffff, record + 2); }
    }
    reject(bytes, identity);
  }
  for (const flags of [0x80, 0x100, 0x41, 0x60, 0x400, 0x8000]) {
    const bytes = fontBytes(); bytes.writeUInt16BE(flags, table(bytes, 'OS/2').offset + 62); reject(bytes, `version-zero flags ${flags}`);
  }
  // Remove the copyright record to make room for one actual format-one language record without rebuilding unrelated tables.
  const localized = fontBytes(600, { nameFormat: 1 }), names = table(localized, 'name').offset, count = localized.readUInt16BE(names + 2);
  const storage = names + localized.readUInt16BE(names + 4), languageRecord = names + 6 + (count - 1) * 12;
  localized.copy(localized, names + 6, names + 18, names + 6 + count * 12);
  localized.writeUInt16BE(count - 1, names + 2); localized.writeUInt16BE(1, languageRecord);
  localized.writeUInt16BE(4, languageRecord + 2); localized.writeUInt16BE(0, languageRecord + 4);
  localized.set([0, 101, 0, 110], storage); // UTF-16BE en
  for (let i = 0; i < count - 1; i++) { const at = names + 6 + i * 12; localized.writeUInt16BE(0, at); localized.writeUInt16BE(6, at + 2); localized.writeUInt16BE(0x8000, at + 4); }
  assert.equal(readFont(localized).family, fontFamily, 'supported Unicode encoding and actual language-tag reference remain readable');
  localized.writeUInt16BE(0x8001, names + 6 + 4); reject(localized, 'language reference at count is out of bounds');
  const current = fontBytes(600, { oblique: true }); current.writeUInt16BE(0x380, table(current, 'OS/2').offset + 62);
  assert.deepEqual(readFont(current).styles, ['oblique 14deg'], 'version-four metrics and WWS bits are supported, not removed');
});

test('all directory/name/axis offsets are checked before reading; malformed inputs never become state or leak payloads', () => {
  const original = fontBytes();
  for (const length of [0, 1, 4, 11, 12, 47, original.length - 1]) reject(original.subarray(0, length));
  const mutations = [
    bytes => bytes.writeUInt16BE(0, 4),
    bytes => bytes.writeUInt16BE(65535, 4),
    bytes => original.copy(bytes, 28, 12, 16),
    bytes => bytes.writeUInt32BE(12, 20),
    bytes => bytes.writeUInt32BE(0xfffffffc, 20),
    bytes => bytes.writeUInt32BE(0xffffffff, 24),
    bytes => bytes.writeUInt32BE(bytes.readUInt32BE(20), 36),
    bytes => bytes.writeUInt16BE(3, table(bytes, 'name').offset),
    bytes => bytes.writeUInt16BE(0, table(bytes, 'name').offset + 4),
    bytes => { const at = table(bytes, 'name').offset; bytes.writeUInt16BE(1, at + 6 + 12 + 8); },
    bytes => { const at = table(bytes, 'name').offset; bytes.writeUInt16BE(0xffff, at + 6 + 10); },
    bytes => { const at = table(bytes, 'OS/2').offset; bytes.writeUInt16BE(513, at + 62); },
    bytes => bytes.writeUInt16BE(6, table(bytes, 'OS/2').offset),
    bytes => bytes.writeUInt16BE(4, table(bytes, 'OS/2').offset),
    bytes => bytes.writeUInt16BE(512, table(bytes, 'OS/2').offset + 62),
  ];
  for (const [index, mutate] of mutations.entries()) { const bytes = Buffer.from(original); mutate(bytes); reject(bytes, `malformed table witness ${index}`); }
  for (const mutate of [
    (bytes, at) => bytes.writeUInt16BE(0, at + 6),
    (bytes, at) => bytes.writeUInt16BE(0, at + 10),
    (bytes, at) => bytes.writeUInt16BE(65535, at + 12),
    (bytes, at) => bytes.writeUInt16BE(0, at + 14),
    (bytes, at) => bytes.writeUInt16BE(0, at + 4),
  ]) { const bytes = fontBytes(600, { axes: [['wght', 100, 400, 900]] }); mutate(bytes, table(bytes, 'fvar').offset); reject(bytes); }
});
