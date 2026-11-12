// Owns bounded WOFF 1 table unpacking for metadata inspection; not font admission, glyph validity or replacement source bytes.
import { inflateSync } from 'node:zlib';
import { DivletError } from './model.ts';

function fail(message: string): never { throw new DivletError('INVALID_FONT', message); }
const padded = (length: number): number => Math.ceil(length / 4) * 4;
interface Table { tag: number; offset: number; compressed: number; length: number; checksum: number; index: number }
function checksum(bytes: Uint8Array, head: boolean): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    let word = 0;
    for (let j = 0; j < 4; j++) word = word * 256 + (head && i + j >= 8 && i + j < 12 ? 0 : bytes[i + j] ?? 0);
    sum = (sum + word) >>> 0;
  }
  return sum;
}
/** The caller supplies a bounded, copied byte array. Only the returned temporary SFNT is inspected; WOFF source bytes stay canonical. */
export function unpackWoff(bytes: Uint8Array, limits: { readonly bytes: number; readonly tables: number }): Uint8Array<ArrayBuffer> {
  if (bytes.length < 44 || bytes.length > limits.bytes) fail('The WOFF header is truncated or exceeds the font byte budget.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flavor = view.getUint32(4), count = view.getUint16(12), directoryEnd = 44 + count * 20, declaredSize = view.getUint32(16);
  if (view.getUint32(0) !== 0x774f4646 || ![0x00010000, 0x4f54544f].includes(flavor)) fail('Only single-face TrueType/OpenType WOFF 1 containers are supported.');
  // 4095 keeps the reconstructed SFNT binary-search fields representable as UInt16.
  if (view.getUint32(8) !== bytes.length || view.getUint16(14) !== 0 || !count || count > Math.min(limits.tables, 4095) || directoryEnd > bytes.length) fail('The WOFF length, reserved field or table directory is invalid.');
  if ([24, 28, 32, 36, 40].some(at => view.getUint32(at) !== 0)) fail('WOFF extended metadata and private blocks are not supported by this admission profile.');
  if (declaredSize > limits.bytes) fail('The expanded WOFF font exceeds the font byte budget.');
  const tables: Table[] = [];
  let size = 12 + count * 16, previous = -1;
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20, tag = view.getUint32(at), offset = view.getUint32(at + 4), compressed = view.getUint32(at + 8), length = view.getUint32(at + 12);
    if (tag <= previous || !/^[\x20-\x7e]{4}$/.test(String.fromCharCode(...bytes.subarray(at, at + 4)))) fail('WOFF table tags must be unique, printable and sorted.');
    if (offset % 4 || offset < directoryEnd || offset > bytes.length - padded(compressed) || compressed > length || !compressed && length !== 0) fail('WOFF table bounds, alignment or lengths are invalid.');
    size += padded(length);
    if (size > limits.bytes) fail('The expanded WOFF font exceeds the font byte budget.');
    tables.push({ tag, offset, compressed, length, checksum: view.getUint32(at + 16), index: i }); previous = tag;
  }
  if (size !== declaredSize) fail('The WOFF expanded-size declaration does not match its tables.');
  let end = directoryEnd;
  const physical = [...tables].sort((a, b) => a.offset - b.offset);
  for (const table of physical.filter(table => table.compressed)) {
    if (table.offset !== end) fail('WOFF table blocks must not overlap or contain hidden gaps.');
    end = table.offset + padded(table.compressed);
    for (let i = table.offset + table.compressed; i < end; i++) if (bytes[i] !== 0) fail('WOFF table padding must be zero.');
  }
  if (end !== bytes.length) fail('WOFF trailing data is outside the supported container profile.');
  const sfnt = new Uint8Array(size), output = new DataView(sfnt.buffer), power = 2 ** Math.floor(Math.log2(count));
  output.setUint32(0, flavor); output.setUint16(4, count); output.setUint16(6, power * 16); output.setUint16(8, Math.log2(power)); output.setUint16(10, count * 16 - power * 16);
  let offset = 12 + count * 16;
  for (const table of physical) {
    let decoded = bytes.subarray(table.offset, table.offset + table.compressed);
    if (table.compressed < table.length) {
      try {
        // Node's types still declare Buffer for info:true; the runtime returns the buffer plus consumed-input evidence.
        const result = inflateSync(decoded, { info: true, maxOutputLength: table.length }) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } };
        if (result.engine.bytesWritten !== table.compressed) fail('WOFF compressed tables must contain exactly one complete zlib stream.');
        decoded = result.buffer;
      } catch { fail('A WOFF table could not be decompressed within its declared byte bound.'); }
    }
    if (decoded.length !== table.length || checksum(decoded, table.tag === 0x68656164) !== table.checksum) fail('WOFF decoded table length or checksum is invalid.');
    const at = 12 + table.index * 16;
    output.setUint32(at, table.tag); output.setUint32(at + 4, table.checksum); output.setUint32(at + 8, offset); output.setUint32(at + 12, table.length);
    sfnt.set(decoded, offset); offset += padded(table.length);
  }
  return sfnt;
}
