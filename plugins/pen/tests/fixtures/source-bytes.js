// Byte-window and UTF-8 partitions for the PEN descriptor, independent of native JSON reader adoption.
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';

const encode = text => new TextEncoder().encode(text);
const source = name => ({ version: '2.21', children: [{ id: 'page', type: 'frame', name, width: 80, height: 60, fill: '#123456', children: [{ id: 'text', type: 'text', content: '你好 café 🌿' }] }] });
const json = JSON.stringify(source('Карта 👋'));
const invalidName = bytes => {
  const text = JSON.stringify(source('A~B')), at = text.indexOf('~');
  return Uint8Array.from([...encode(text.slice(0, at)), ...bytes, ...encode(text.slice(at + 1))]);
};

export const sourceByteCases = [
  { name: 'Unicode JSON', bytes: encode(json), claims: true },
  { name: 'BOM inside a string', bytes: encode(JSON.stringify(source('A\ufeffB'))), claims: true },
  { name: 'invalid UTF-8 byte inside a string', bytes: invalidName([0xff]), claims: true },
  { name: 'UTF-8 surrogate encoding inside a string', bytes: invalidName([0xed, 0xa0, 0x80]), claims: true },
  { name: 'leading UTF-8 BOM', bytes: Uint8Array.from([0xef, 0xbb, 0xbf, ...encode(json)]), claims: false },
  { name: 'invalid UTF-8 outside JSON', bytes: Uint8Array.from([0xff, ...encode(json)]), claims: false },
  { name: 'truncated UTF-8/JSON', bytes: Uint8Array.from([0xe2, 0x82]), claims: false },
  { name: 'empty bytes', bytes: new Uint8Array(), claims: false },
  { name: 'null JSON', bytes: encode('null'), claims: false },
];

export const sourceByteViews = [
  { name: 'Buffer', make: bytes => { const buffer = Buffer.alloc(bytes.length); buffer.set(bytes); return buffer; } },
  { name: 'Uint8Array', make: bytes => new Uint8Array(bytes) },
  { name: 'offset subarray', make: bytes => { const buffer = new Uint8Array(bytes.length + 8).fill(0xff); buffer.set(bytes, 3); return buffer.subarray(3, 3 + bytes.length); } },
  { name: 'non-coercible Uint8Array', make: bytes => {
    const buffer = new Uint8Array(bytes);
    Object.defineProperty(buffer, 'toString', { value: () => { throw new Error('Byte input must not be string-coerced'); } });
    return buffer;
  } },
];

const capture = run => {
  try { return { ok: true, value: run() }; }
  catch (error) { return { ok: false, name: error.name, message: error.message, code: error.code ?? null }; }
};

/** The same public dispatch/call contract runs under source and compiled export conditions, without source-product imports. */
export async function checkPublicSourceBytes(importerFor) {
  const context = { name: 'byte project', provenance: { source: 'bytes.pen', format: 'pen' } };
  const importer = await importerFor('/probe.pen', async () => { throw new Error('extension shortcut must not read'); });
  assert.equal(importer?.id, 'pen');
  let checks = 0;
  for (const row of sourceByteCases) {
    const baseline = Buffer.from(row.bytes);
    const converted = capture(() => importer.convert(baseline, context)), summary = capture(() => importer.summarize(baseline));
    for (const view of sourceByteViews) {
      const bytes = view.make(row.bytes), before = [...new Uint8Array(bytes.buffer)];
      let reads = 0;
      const selected = await importerFor('/probe.divlet', async () => { reads++; return bytes; });
      assert.equal(reads, 1);
      assert.equal(selected?.id ?? null, row.claims ? 'pen' : null, `${row.name}/${view.name}`);
      if (selected) assert.equal(selected, importer, 'one selected descriptor');
      assert.deepEqual(capture(() => importer.convert(bytes, context)), converted, `${row.name}/${view.name} conversion`);
      assert.deepEqual(capture(() => importer.summarize(bytes)), summary, `${row.name}/${view.name} summary`);
      assert.deepEqual([...new Uint8Array(bytes.buffer)], before);
      checks++;
    }
  }
  return { cases: sourceByteCases.length, views: sourceByteViews.length, checks };
}
