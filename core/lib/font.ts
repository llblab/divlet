// Owns bounded OpenType face metadata, not glyph-program validation, upload publication or a font-specific store.
import { ASSET_LIMITS } from './assets.ts';
import { DivletError } from './model.ts';
import { string } from './validation.ts';

export interface FontFaceMetadata {
  readonly family: string;
  readonly subfamily: string;
  readonly format: 'truetype' | 'opentype';
  readonly mediaType: 'font/ttf' | 'font/otf';
  readonly weight: string;
  readonly stretch: string;
  readonly styles: readonly string[];
}
export const FONT_LIMITS = Object.freeze({ bytes: ASSET_LIMITS.fileBytes, tables: ASSET_LIMITS.nodes, name: 512 });
interface Table { offset: number; length: number }
interface Axis { min: number; max: number; default: number }
function fail(message: string): never { throw new DivletError('INVALID_FONT', message); }
const byteLengthOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
const number = (value: number): string => String(value === 0 ? 0 : value);
const interval = (min: number, max: number, unit = ''): string => min === max ? number(min) + unit : `${number(min)}${unit} ${number(max)}${unit}`;

/** Inspect one SFNT face. Browser font decoding is still required before promising that its glyph program loads. */
export function readFont(input: unknown): FontFaceMetadata {
  if (!ArrayBuffer.isView(input) || !(input instanceof Uint8Array)) fail('A font must be a byte array.');
  const size = byteLengthOf.call(input) as number;
  if (!size || size > FONT_LIMITS.bytes) fail('A font must contain at most 20 MiB of bytes.');
  const bytes = new Uint8Array(input), view = new DataView(bytes.buffer);
  const range = (offset: number, length: number, end = bytes.length): void => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > end - length) fail('Font table data is truncated or out of range.');
  };
  range(0, 12);
  const signature = view.getUint32(0), format = signature === 0x00010000 ? 'truetype' : signature === 0x4f54544f ? 'opentype' : null;
  if (!format) fail('Upload an OpenType TTF or OTF face. Compressed fonts and collections are not supported by this reader.');
  const count = view.getUint16(4), directoryEnd = 12 + count * 16;
  if (!count || count > FONT_LIMITS.tables) fail('The font table count is unsupported.');
  range(0, directoryEnd);
  const tables = new Map<string, Table>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16, tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    if (!/^[\x20-\x7e]{4}$/.test(tag) || tables.has(tag)) fail('Font table tags must be unique printable identifiers.');
    const offset = view.getUint32(at + 8), length = view.getUint32(at + 12);
    if (offset % 4 || offset < directoryEnd) fail('Font tables must follow the directory on aligned boundaries.');
    range(offset, length);
    tables.set(tag, { offset, length });
  }
  let end = directoryEnd;
  for (const table of [...tables.values()].filter(table => table.length).sort((a, b) => a.offset - b.offset)) {
    if (table.offset < end) fail('Font tables must not overlap.');
    end = table.offset + table.length;
  }
  const table = (tag: string, minimum: number): Table => {
    const found = tables.get(tag);
    if (!found || found.length < minimum) fail(`The font requires a valid ${tag} table.`);
    return found;
  };
  table('head', 54);
  if (format === 'truetype') { table('glyf', 0); table('loca', 1); }
  else table(tables.has('CFF ') ? 'CFF ' : 'CFF2', 1);
  const names = table('name', 6), nameEnd = names.offset + names.length;
  const nameFormat = view.getUint16(names.offset), nameCount = view.getUint16(names.offset + 2), storage = names.offset + view.getUint16(names.offset + 4);
  if (nameFormat > 1 || storage < names.offset + 6 + nameCount * 12) fail('The font name table format is unsupported.');
  range(names.offset + 6, nameCount * 12, nameEnd);
  let languages = 0;
  if (nameFormat === 1) {
    const at = names.offset + 6 + nameCount * 12;
    range(at, 2, nameEnd);
    languages = view.getUint16(at);
    range(at + 2, languages * 4, nameEnd);
    if (storage < at + 2 + languages * 4) fail('Font language records overlap string storage.');
    for (let i = 0; i < languages; i++) range(storage + view.getUint16(at + 4 + i * 4), view.getUint16(at + 2 + i * 4), nameEnd);
  }
  const values = new Map<number, { value: string; score: number }>();
  for (let i = 0; i < nameCount; i++) {
    const at = names.offset + 6 + i * 12, platform = view.getUint16(at), encoding = view.getUint16(at + 2), language = view.getUint16(at + 4), id = view.getUint16(at + 6);
    const length = view.getUint16(at + 8), offset = storage + view.getUint16(at + 10);
    range(offset, length, nameEnd);
    if (nameFormat === 1 && language >= 0x8000 && language - 0x8000 >= languages) fail('A font name references a missing language tag.');
    if (![1, 2, 16, 17].includes(id) || !(platform === 0 && [0, 1, 2, 3, 4, 6].includes(encoding) || platform === 3 && [0, 1, 10].includes(encoding))) continue;
    if (length % 2) fail('Unicode font names must contain complete UTF-16 code units.');
    let value: string;
    try {
      value = new TextDecoder('utf-16be', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset, offset + length));
      string(value, 'Font name', FONT_LIMITS.name);
    } catch { fail('The font name is invalid or exceeds the 512-character profile.'); }
    if (!value.trim() || /[\x00-\x1f\x7f]/.test(value)) fail('Font names must be nonempty text without control characters.');
    const score = platform === 3 && language === 0x409 ? 3 : platform === 0 ? 2 : 1;
    if (score > (values.get(id)?.score ?? 0)) values.set(id, { value, score });
  }
  const family = (values.get(16) ?? values.get(1))?.value, subfamily = (values.get(17) ?? values.get(2))?.value;
  if (!family || !subfamily) fail('The font needs Unicode family and subfamily names.');
  const os2 = table('OS/2', 64), version = view.getUint16(os2.offset), staticWeight = view.getUint16(os2.offset + 4), width = view.getUint16(os2.offset + 6), flags = view.getUint16(os2.offset + 62);
  if (version > 5 || os2.length < [78, 86, 96, 96, 96, 100][version]!) fail('The OS/2 metadata version or length is unsupported.');
  if (flags & ~(version < 4 ? 0x7f : 0x3ff) || (flags & 64) && (flags & 33)) fail('The OS/2 style flags are reserved, version-incompatible or contradictory.');
  if (view.getUint16(os2.offset + 8) & 2) fail('The font marks embedding as restricted.');
  if (staticWeight < 1 || staticWeight > 1000 || width < 1 || width > 9 || (flags & 1) && (flags & 512)) fail('The font weight, width or style metadata is unsupported.');
  const axes = new Map<string, Axis>(), fvar = tables.get('fvar');
  if (fvar) {
    if (fvar.length < 16 || view.getUint32(fvar.offset) !== 0x00010000 || view.getUint16(fvar.offset + 6) !== 2) fail('The variable font axis header is unsupported.');
    const start = fvar.offset + view.getUint16(fvar.offset + 4), axisCount = view.getUint16(fvar.offset + 8), axisSize = view.getUint16(fvar.offset + 10), instances = view.getUint16(fvar.offset + 12), instanceSize = view.getUint16(fvar.offset + 14);
    if (start < fvar.offset + 16 || !axisCount || axisCount > FONT_LIMITS.tables || axisSize < 20 || ![4 + 4 * axisCount, 6 + 4 * axisCount].includes(instanceSize)) fail('The variable font record layout is unsupported.');
    range(start, axisCount * axisSize + instances * instanceSize, fvar.offset + fvar.length);
    for (let i = 0; i < axisCount; i++) {
      const at = start + i * axisSize, tag = String.fromCharCode(...bytes.subarray(at, at + 4));
      const min = view.getInt32(at + 4) / 65536, initial = view.getInt32(at + 8) / 65536, max = view.getInt32(at + 12) / 65536;
      if (!/^[\x20-\x7e]{4}$/.test(tag) || axes.has(tag) || min > initial || initial > max) fail('Variable font axes must have unique tags and ordered ranges.');
      axes.set(tag, { min, default: initial, max });
    }
  }
  const weight = axes.get('wght') ?? { min: staticWeight, max: staticWeight }, stretch = axes.get('wdth') ?? { min: [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200][width - 1]!, max: [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200][width - 1]! };
  if (weight.min < 1 || weight.max > 1000 || stretch.min <= 0 || stretch.max > 1000) fail('The variable font weight/width cannot be represented by this CSS profile.');
  const italic = axes.get('ital'), slant = axes.get('slnt');
  let styles: string[];
  if (italic && slant) fail('Combined italic/slant axes require explicit face selection.');
  if (italic) {
    if (![0, 1].includes(italic.min) || ![0, 1].includes(italic.max)) fail('The italic axis cannot be represented as normal/italic faces.');
    styles = [...(italic.min === 0 ? ['normal'] : []), ...(italic.max === 1 ? ['italic'] : [])];
  } else if (slant) {
    if (slant.min < -90 || slant.max > 90) fail('The slant axis exceeds CSS angle bounds.');
    styles = slant.min === 0 && slant.max === 0 ? ['normal'] : [...(slant.min <= 0 && slant.max >= 0 ? ['normal'] : []), `oblique ${interval(-slant.max, -slant.min, 'deg')}`];
  } else if (flags & 1) styles = ['italic'];
  else if (flags & 512) {
    const post = table('post', 8), angle = -view.getInt32(post.offset + 4) / 65536 || 14;
    if (angle < -90 || angle > 90) fail('The oblique angle exceeds CSS bounds.');
    styles = [`oblique ${number(angle)}deg`];
  } else styles = ['normal'];
  return { family, subfamily, format, mediaType: format === 'truetype' ? 'font/ttf' : 'font/otf', weight: interval(weight.min, weight.max), stretch: interval(stretch.min, stretch.max, '%'), styles };
}
