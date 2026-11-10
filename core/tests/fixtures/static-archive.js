import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';

/** Test-only ZIP32 reader; the browser additionally verifies with Python's independent zipfile implementation. */
export function readArchive(bytes) {
  const end = bytes.length - 22; assert.equal(bytes.readUInt32LE(end), 0x06054b50); const count = bytes.readUInt16LE(end + 10), files = new Map(); let at = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50); assert.equal(bytes.readUInt16LE(at + 8), 0x800); assert.equal(bytes.readUInt16LE(at + 10), 0); assert.equal(bytes.readUInt32LE(at + 38) >>> 16, 0o100644);
    const size = bytes.readUInt32LE(at + 24), length = bytes.readUInt16LE(at + 28), local = bytes.readUInt32LE(at + 42), name = bytes.subarray(at + 46, at + 46 + length).toString();
    assert.equal(bytes.readUInt32LE(local), 0x04034b50); assert.equal(bytes.readUInt32LE(local + 22), size); assert.equal(bytes.readUInt16LE(local + 26), length); assert.equal(bytes.subarray(local + 30, local + 30 + length).toString(), name);
    const content = bytes.subarray(local + 30 + length, local + 30 + length + size); assert.equal(crc32(content), bytes.readUInt32LE(at + 16)); assert.equal(crc32(content), bytes.readUInt32LE(local + 14)); assert.equal(files.has(name), false); files.set(name, content); at += 46 + length;
  }
  assert.equal(at, end); return files;
}
