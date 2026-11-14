import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import pen from '../index.js';
import { convertPen, summarizePen } from '../lib/convert.js';
import { sourceByteCases, sourceByteViews, checkPublicSourceBytes } from './fixtures/source-bytes.js';

const context = { name: 'byte project', provenance: { source: 'bytes.pen', format: 'pen' } };
const capture = run => {
  try { return { ok: true, value: run() }; }
  catch (error) { return { ok: false, name: error.name, message: error.message, code: error.code ?? null }; }
};

for (const row of sourceByteCases) {
  // Independent compatibility oracle: Buffer's former UTF-8 decode followed by the unchanged JSON/converter APIs.
  const decoded = () => JSON.parse(Buffer.from(row.bytes).toString('utf8'));
  const expectedConvert = capture(() => convertPen(decoded(), context));
  const expectedSummary = capture(() => summarizePen(decoded()));
  for (const view of sourceByteViews) test(`${row.name} via ${view.name} preserves descriptor byte semantics`, async () => {
    const bytes = view.make(row.bytes), backing = new Uint8Array(bytes.buffer);
    const before = [...backing];
    let reads = 0;
    const claimed = await pen.claims('sample.divlet', async file => { assert.equal(file, 'sample.divlet'); reads++; return bytes; });
    assert.equal(reads, 1);
    assert.equal(claimed, row.claims);
    assert.deepEqual(capture(() => pen.convert(bytes, context)), expectedConvert);
    assert.deepEqual(capture(() => pen.summarize(bytes)), expectedSummary);
    assert.deepEqual([...backing], before, 'visible bytes and prefix/suffix storage remain untouched');
  });
}

test('descriptor routing keeps extension shortcuts, native-marker refusal and unreadable-source fallback', async () => {
  let reads = 0;
  const unreadable = async () => { reads++; throw new Error('unreadable'); };
  assert.equal(await pen.claims('source.PEN', unreadable), true);
  assert.equal(await pen.claims('source.html', unreadable), false);
  assert.equal(reads, 0, 'extension routes never read the source');
  assert.equal(await pen.claims('source.divlet', unreadable), false);
  assert.equal(reads, 1);
  const native = new TextEncoder().encode('{"schemaVersion":1,"version":"2.21","children":[]}');
  assert.equal(await pen.claims('source.divlet', async () => native), false);
});

test('the public registry passes plain byte views through legacy-source claims and descriptor calls', async () => {
  const { importerFor } = await import('@divlet/core/plugins');
  assert.deepEqual(await checkPublicSourceBytes(importerFor), { cases: sourceByteCases.length, views: sourceByteViews.length, checks: sourceByteCases.length * sourceByteViews.length });
  assert.equal(await importerFor('/probe.pen', async () => { throw new Error('unexpected read'); }), pen);
});

test('repeated descriptor calls do not carry BOM or truncated decoder state into another source', () => {
  const valid = sourceByteCases[0].bytes, bom = sourceByteCases.find(row => row.name === 'leading UTF-8 BOM').bytes;
  const truncated = sourceByteCases.find(row => row.name === 'truncated UTF-8/JSON').bytes;
  const expected = pen.summarize(Buffer.from(valid));
  for (let index = 0; index < 3; index++) {
    assert.throws(() => pen.summarize(bom), SyntaxError);
    assert.deepEqual(pen.summarize(valid), expected);
    assert.throws(() => pen.summarize(truncated), SyntaxError);
    assert.deepEqual(pen.summarize(valid), expected);
  }
});
