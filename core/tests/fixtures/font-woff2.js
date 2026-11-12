// Synthetic CC0 fontBytes() encoded with wawoff2@2.0.1; encoder integrity sha512-r0CEmvpH63r4T15ebFqeOjGqU4+EgTx4I510NtK35EMciSdcTxCw3Byy3JnBonz7iyIFZ0AbVo0bbFpEVuhCYA==.
// A transformed WOFF2 refusal fixture, not a product decoder or a promise of full WOFF2 admission.
import { brotliCompressSync } from 'node:zlib';
import { fontBytes } from './font.js';
const known = { cmap: 0, head: 1, hhea: 2, hmtx: 3, maxp: 4, name: 5, 'OS/2': 6, post: 7, glyf: 10, loca: 11, 'CFF ': 13, fvar: 47, gvar: 48 };
const base128 = number => { const bytes = []; do { bytes.unshift(number % 128); number = Math.floor(number / 128); } while (number); return Buffer.from(bytes.map((byte, i) => i < bytes.length - 1 ? byte | 128 : byte)); };
// Independent synthetic encoder: ordinary raw tables, one Brotli stream and no transformations.
export function nullWoff2Bytes(sfnt = fontBytes(), { explicit = false, reverse = false, reserved = 0, declaredSize = sfnt.length } = {}) {
  const count = sfnt.readUInt16BE(4), tables = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16, tag = sfnt.toString('ascii', at, at + 4), offset = sfnt.readUInt32BE(at + 8), length = sfnt.readUInt32BE(at + 12);
    const code = !explicit && Object.hasOwn(known, tag) ? known[tag] : 63, version = ['glyf', 'loca'].includes(tag) ? 3 : 0;
    tables.push({ directory: Buffer.concat([Buffer.from([version << 6 | code]), ...(code === 63 ? [Buffer.from(tag)] : []), base128(length)]), data: sfnt.subarray(offset, offset + length) });
  }
  if (reverse) tables.reverse();
  const directory = Buffer.concat(tables.map(table => table.directory)), stream = brotliCompressSync(Buffer.concat(tables.map(table => table.data)));
  const result = Buffer.alloc(Math.ceil((48 + directory.length + stream.length) / 4) * 4);
  result.write('wOF2'); result.writeUInt32BE(sfnt.readUInt32BE(0), 4); result.writeUInt32BE(result.length, 8); result.writeUInt16BE(count, 12); result.writeUInt16BE(reserved, 14); result.writeUInt32BE(declaredSize, 16); result.writeUInt32BE(stream.length, 20); result.writeUInt16BE(1, 24);
  directory.copy(result, 48); stream.copy(result, 48 + directory.length); return result;
}
export const nullWoff2DataUrl = (advance = 600, options = {}) => `data:font/woff2;base64,${nullWoff2Bytes(fontBytes(advance, options)).toString('base64')}`;
// Genuine CC0 CFF program, independently encoded by the same pinned wawoff2: fontBytes(900, { family: 'Null Family', weight:700, cff:true }).
export const cffWoff2Bytes = () => Buffer.from('d09GMk9UVE8AAAGIAAkAAAAAAxAAAAFFAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAADV8GTgAsATYCJAMIBAYFggwHIBtsAsgeB9WN9cYx3gg3YX7pePhauvd390ItKulGUEqVGZw+aUHRnUIYJJzPN7c/ywv1QtmQRMSTSRKd+b97LDRKomUSgYj672/yH6u2wAPKZVmbOk8zyzNZ55MWUGQJBpresIVyOLxyOCiH3AuliIiZ00ilHg9eQ2gR7Q4gWhrPfK06YGMJkCKqUTvX8+hpQxvW2mkc5f8cv2r9VzW/87Uzi9vhEU6vTgsMjYxyv9mE3PdHyAKzij4oisBR05Cn+RTwWvAy+B7e7N1fOf9A9G0aJiUQXKV10wptXOUaOx8hYcITQ5QpbEJCWDeAZN49ZOvOqLAaVex7rGXVz14rRyEPRV4EX1FDcyOfP0WqeVzCxESXa0VKpYS5h0wk1drxBKTUQ+0toqQ85CBPgyt0amqN6PazhB5X11RESXnowNMgA2ie9Tk=', 'base64');
export const woff2Bytes = () => Buffer.from('d09GMgABAAAAAAFgAAoAAAAAAvgAAAEWAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABk4ALAoYNQsGAAE2AiQDCAQgBYIMByAbXALILg5sussSi16hZwjLhgPfjPwQD3377e/M7kMscch0sUTli1iIP/ROfoOn5lCpoAHps+LF0vlvB2xCMx7hGoQHkld+1e4W8L/ljg+ef7896HEKiQWBBJiVaCjNIwq0wEJIb9ietYPyOxySg9XkT6QhDUe4uHV0IJHJhVYEytwPoQiMVHNAVQWObX81ASBBRaCgAVRAFEgPvMVAINj+d0J76hX8BwCA/MnRkyB4WPMHQAiBlukBvCCQigAJAICuP1hUCnAAkmFGZJp4YjETocqBRj57HVNf794Wl07t0isRjbUms97r19uhxiJUKh5L03uY1C6EpXa6GGqt2yR3qHpnXCMrOP1w6m/nhIDFzzILFrE2ewAAAA==', 'base64');
