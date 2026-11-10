import test from 'node:test';
import assert from 'node:assert/strict';
import { registerExporter, exporterList, exportAs } from '../lib/plugins.ts';

test('exporter plugins register behind one contract and run through exportAs', async () => {
  assert.throws(() => registerExporter({ id: 'x' }), TypeError);
  registerExporter({ id: 'json', label: 'JSON', extension: '.json', mime: 'application/json', export: ({ frames }) => ({ name: 'a/b:c', bytes: JSON.stringify(frames) }) });
  assert.throws(() => registerExporter({ id: 'json', label: 'again', extension: '.json', mime: 'application/json', export: () => ({}) }), /already registered/);
  assert.deepEqual(exporterList(), [{ id: 'json', label: 'JSON', extension: '.json', mime: 'application/json' }]);
  const result = await exportAs('json', { project: {}, frames: [{ id: 'one' }] });
  assert.equal(result.name, 'a_b_c.json');
  assert.equal(result.mime, 'application/json');
  assert.equal(result.bytes.toString(), '[{"id":"one"}]');
  await assert.rejects(exportAs('nope', {}), { code: 'UNKNOWN_EXPORTER' });
  registerExporter({ id: 'empty', label: 'Empty', extension: '.x', mime: 'text/plain', export: () => ({ name: 'n' }) });
  await assert.rejects(exportAs('empty', {}), { code: 'EXPORT_FAILED' });
});
