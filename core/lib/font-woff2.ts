// Owns bounded null-transform WOFF2 unpacking for metadata; not transformed glyphs, canonical bytes or font-program validity.
import { brotliDecompressSync, constants } from 'node:zlib';
import { DivletError } from './model.ts';
const TAGS = ['cmap','head','hhea','hmtx','maxp','name','OS/2','post','cvt ','fpgm','glyf','loca','prep','CFF ','VORG','EBDT','EBLC','gasp','hdmx','kern','LTSH','PCLT','VDMX','vhea','vmtx','BASE','GDEF','GPOS','GSUB','EBSC','JSTF','MATH','CBDT','CBLC','COLR','CPAL','SVG ','sbix','acnt','avar','bdat','bloc','bsln','cvar','fdsc','feat','fmtx','fvar','gvar','hsty','just','lcar','mort','morx','opbd','prop','trak','Zapf','Silf','Glat','Gloc','Feat','Sill'];
const padded = (length: number): number => Math.ceil(length / 4) * 4;
function fail(message: string): never { throw new DivletError('INVALID_FONT', message); }
function checksum(bytes: Uint8Array, head = false): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    let word = 0;
    for (let j = 0; j < 4; j++) word = word * 256 + (head && i + j >= 8 && i + j < 12 ? 0 : bytes[i + j] ?? 0);
    sum = (sum + word) >>> 0;
  }
  return sum;
}
/** Bounded copied input only. The returned SFNT is temporary metadata input; submitted WOFF2 bytes remain the resource. */
export function unpackWoff2(bytes: Uint8Array, limits: { readonly bytes: number; readonly tables: number }): Uint8Array<ArrayBuffer> {
  if (bytes.length < 48 || bytes.length > limits.bytes) fail('The WOFF2 header is truncated or exceeds the font byte budget.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), flavor = view.getUint32(4), count = view.getUint16(12), compressed = view.getUint32(20);
  if (view.getUint32(0) !== 0x774f4632 || ![0x00010000, 0x4f54544f].includes(flavor)) fail('Only single-face TrueType/OpenType null-transform WOFF2 is supported.');
  if (view.getUint32(8) !== bytes.length || !count || count > Math.min(limits.tables, 4095)) fail('The WOFF2 length or table count is invalid.');
  if ([28, 32, 36, 40, 44].some(at => view.getUint32(at) !== 0)) fail('WOFF2 extended metadata and private blocks are not supported.');
  // WOFF2 reserved and totalSfntSize fields are not rejection/allocation authority (Recommendation §3.2).
  let cursor = 48, rawSize = 0, size = 12 + count * 16;
  const base128 = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = bytes[cursor++];
      if (byte === undefined || i === 0 && byte === 128) fail('WOFF2 table lengths must use complete canonical Base128 integers.');
      value = value * 128 + (byte & 127);
      if (value > 0xffffffff) fail('WOFF2 table length overflows UInt32.');
      if (!(byte & 128)) return value;
    }
    fail('WOFF2 table length exceeds five Base128 bytes.');
  };
  const tables: { tag: string; length: number; offset: number }[] = [], tags = new Set<string>();
  for (let i = 0; i < count; i++) {
    const flags = bytes[cursor++]; if (flags === undefined) fail('The WOFF2 table directory is truncated.');
    const index = flags & 63, version = flags >>> 6;
    let tag = TAGS[index];
    if (index === 63) { if (cursor > bytes.length - 4) fail('The WOFF2 explicit table tag is truncated.'); tag = String.fromCharCode(...bytes.subarray(cursor, cursor + 4)); cursor += 4; }
    if (!tag || !/^[\x20-\x7e]{4}$/.test(tag) || tags.has(tag)) fail('WOFF2 table tags must be unique printable identifiers.');
    const length = base128();
    if (version !== (tag === 'glyf' || tag === 'loca' ? 3 : 0)) fail('WOFF2 transformed or unknown glyph/metrics tables are not supported. Use a null-transform font or TTF/OTF/WOFF 1.');
    size += padded(length);
    if (size > limits.bytes) fail('The reconstructed WOFF2 font exceeds the font byte budget.');
    tables.push({ tag, length, offset: rawSize }); tags.add(tag); rawSize += length;
  }
  if (tags.has('glyf') !== tags.has('loca')) fail('WOFF2 glyf and loca tables must be paired.');
  if (!rawSize || !compressed || compressed > bytes.length - cursor) fail('The WOFF2 compressed table stream is empty or out of range.');
  const end = cursor + compressed, padding = bytes.length - end;
  if (padding > 3 || padding && bytes.length % 4 !== 0 || bytes.subarray(end).some(byte => byte !== 0)) fail('WOFF2 has unsupported trailing bytes or nonzero padding.');
  let raw: Uint8Array;
  try {
    const result = brotliDecompressSync(bytes.subarray(cursor, end), { info: true, maxOutputLength: rawSize, params: { [constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 0 } }) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } };
    if (result.buffer.length !== rawSize || result.engine.bytesWritten !== compressed) fail('WOFF2 must contain exactly one complete standard-window Brotli stream of the declared table length.');
    raw = result.buffer;
  } catch { fail('WOFF2 could not be decompressed within its declared standard-window byte bound.'); }
  const sfnt = new Uint8Array(size), output = new DataView(sfnt.buffer), power = 2 ** Math.floor(Math.log2(count));
  output.setUint32(0, flavor); output.setUint16(4, count); output.setUint16(6, power * 16); output.setUint16(8, Math.log2(power)); output.setUint16(10, count * 16 - power * 16);
  const directory = new Map([...tables].sort((a, b) => a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0).map((table, index) => [table.tag, index]));
  let offset = 12 + count * 16, head = -1;
  for (const table of tables) {
    const data = raw.subarray(table.offset, table.offset + table.length), at = 12 + directory.get(table.tag)! * 16;
    for (let i = 0; i < 4; i++) sfnt[at + i] = table.tag.charCodeAt(i);
    output.setUint32(at + 4, checksum(data, table.tag === 'head')); output.setUint32(at + 8, offset); output.setUint32(at + 12, table.length);
    sfnt.set(data, offset);
    if (table.tag === 'head' && table.length >= 12) { head = offset; output.setUint32(head + 8, 0); }
    offset += padded(table.length);
  }
  if (head !== -1) output.setUint32(head + 8, (0xb1b0afba - checksum(sfnt)) >>> 0);
  return sfnt;
}
