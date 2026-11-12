// Synthetic CC0 TrueType fixture: one triangle at U+0041, generated here without third-party font bytes/tools.
const u16 = (buffer, offset, value) => buffer.writeUInt16BE(value & 0xffff, offset);
const i16 = (buffer, offset, value) => buffer.writeInt16BE(value, offset);
const u32 = (buffer, offset, value) => buffer.writeUInt32BE(value >>> 0, offset);
const checksum = buffer => { let sum = 0; for (let i = 0; i < buffer.length; i += 4) { let value = 0; for (let j = 0; j < 4; j++) value = value * 256 + (buffer[i + j] || 0); sum = (sum + value) >>> 0; } return sum; };
export const fontFamily = 'Divlet Test';
export function fontBytes(advance = 600, { family = fontFamily, subfamily = 'Regular', weight = 400, width = 5, italic = false, oblique = false, angle = 0, axes = [], typographicFamily, typographicSubfamily, restricted = false, nameFormat = 0 } = {}) {
  const tables = new Map();
  const head = Buffer.alloc(54); u32(head, 0, 0x10000); u32(head, 4, 0x10000); u32(head, 12, 0x5f0f3cf5); u16(head, 16, 3); u16(head, 18, 1000); i16(head, 40, 600); i16(head, 42, 700); u16(head, 46, 8); i16(head, 48, 2); tables.set('head', head);
  const hhea = Buffer.alloc(36); u32(hhea, 0, 0x10000); i16(hhea, 4, 800); i16(hhea, 6, -200); u16(hhea, 10, advance); i16(hhea, 16, 600); i16(hhea, 18, 1); u16(hhea, 34, 2); tables.set('hhea', hhea);
  const maxp = Buffer.alloc(32); u32(maxp, 0, 0x10000); u16(maxp, 4, 2); u16(maxp, 6, 3); u16(maxp, 8, 1); u16(maxp, 14, 2); tables.set('maxp', maxp);
  const metrics = Buffer.alloc(8); u16(metrics, 0, advance); u16(metrics, 4, advance); tables.set('hmtx', metrics);
  const glyph = Buffer.alloc(32); i16(glyph, 0, 1); i16(glyph, 6, 600); i16(glyph, 8, 700); u16(glyph, 10, 2); glyph.fill(1, 14, 17); i16(glyph, 17, 0); i16(glyph, 19, 600); i16(glyph, 21, -300); i16(glyph, 23, 0); i16(glyph, 25, 0); i16(glyph, 27, 700); tables.set('glyf', glyph);
  const loca = Buffer.alloc(6); u16(loca, 4, glyph.length / 2); tables.set('loca', loca);
  const cmap = Buffer.alloc(44); u16(cmap, 2, 1); u16(cmap, 4, 3); u16(cmap, 6, 1); u32(cmap, 8, 12); u16(cmap, 12, 4); u16(cmap, 14, 32); u16(cmap, 18, 4); u16(cmap, 20, 4); u16(cmap, 22, 1); u16(cmap, 26, 65); u16(cmap, 28, 0xffff); u16(cmap, 32, 65); u16(cmap, 34, 0xffff); i16(cmap, 36, -64); i16(cmap, 38, 1); tables.set('cmap', cmap);
  const names = [[0, 'Synthetic font fixture. CC0.'], [1, family], [2, subfamily], [3, 'divlet-test'], [4, family], [5, 'Version 1.0'], [6, 'DivletTest'], ...axes.map(([tag], i) => [256 + i, tag])];
  if (typographicFamily !== undefined) names.push([16, typographicFamily]);
  if (typographicSubfamily !== undefined) names.push([17, typographicSubfamily]);
  if (axes.length) {
    const fvar = Buffer.alloc(16 + axes.length * 20); u32(fvar, 0, 0x10000); u16(fvar, 4, 16); u16(fvar, 6, 2); u16(fvar, 8, axes.length); u16(fvar, 10, 20); u16(fvar, 14, 4 + axes.length * 4);
    axes.forEach(([tag, min, initial, max], i) => { const at = 16 + 20 * i; fvar.write(tag, at); fvar.writeInt32BE(Math.round(min * 65536), at + 4); fvar.writeInt32BE(Math.round(initial * 65536), at + 8); fvar.writeInt32BE(Math.round(max * 65536), at + 12); u16(fvar, at + 18, 256 + i); });
    tables.set('fvar', fvar);
  }
  const strings = names.map(([, text]) => Buffer.from(text, 'utf16le').swap16());
  const name = Buffer.alloc(6 + 12 * names.length + (nameFormat === 1 ? 2 : 0)); u16(name, 0, nameFormat); u16(name, 2, names.length); u16(name, 4, name.length); let start = 0;
  for (let i = 0; i < names.length; i++) { const at = 6 + 12 * i; u16(name, at, 3); u16(name, at + 2, 1); u16(name, at + 4, 0x409); u16(name, at + 6, names[i][0]); u16(name, at + 8, strings[i].length); u16(name, at + 10, start); start += strings[i].length; }
  tables.set('name', Buffer.concat([name, ...strings]));
  const post = Buffer.alloc(32); u32(post, 0, 0x30000); post.writeInt32BE(Math.round(angle * 65536), 4); i16(post, 8, -75); i16(post, 10, 50); tables.set('post', post);
  const os2 = Buffer.alloc(oblique ? 96 : 78); u16(os2, 0, oblique ? 4 : 0); i16(os2, 2, 600); u16(os2, 4, weight); u16(os2, 6, width); u16(os2, 8, restricted ? 2 : 0); u32(os2, 42, 1); os2.write('DIVL', 58); u16(os2, 62, italic ? 1 : oblique ? 512 : 64); u16(os2, 64, 65); u16(os2, 66, 65); i16(os2, 68, 800); i16(os2, 70, -200); u16(os2, 74, 800); u16(os2, 76, 200); tables.set('OS/2', os2);
  const sorted = [...tables].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), header = Buffer.alloc(12 + 16 * tables.size);
  u32(header, 0, 0x10000); u16(header, 4, tables.size); const power = 2 ** Math.floor(Math.log2(tables.size)); u16(header, 6, 16 * power); u16(header, 8, Math.log2(power)); u16(header, 10, tables.size * 16 - 16 * power);
  const chunks = [header]; let offset = header.length, headOffset;
  for (let i = 0; i < sorted.length; i++) { const [tag, bytes] = sorted[i], at = 12 + 16 * i; header.write(tag, at); u32(header, at + 4, checksum(bytes)); u32(header, at + 8, offset); u32(header, at + 12, bytes.length); if (tag === 'head') headOffset = offset; const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4); bytes.copy(padded); chunks.push(padded); offset += padded.length; }
  const result = Buffer.concat(chunks); u32(result, headOffset + 8, (0xb1b0afba - checksum(result)) >>> 0); return result;
}
export const fontDataUrl = (advance = 600) => `data:font/ttf;base64,${fontBytes(advance).toString('base64')}`;
