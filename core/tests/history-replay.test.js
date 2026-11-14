import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument, DivletError } from '../lib/model.ts';
import { readProject } from '../lib/project.ts';
import { replayHistory } from '../lib/history-replay.ts';
import { historyReplayCases, captureHistoryReplay } from './fixtures/history-replay.js';

const api = { validateDocument, readProject, replayHistory };
for (const { name, run, expected, error } of historyReplayCases) test(name, () => {
  const result = captureHistoryReplay(api, run);
  if (error) { assert.equal(result.ok, false, name); assert.equal(result.code, error, result.message); }
  else assert.deepEqual(result, { ok: true, value: expected }, name);
});

test('replay refusals retain the shared domain error identity', () => {
  assert.throws(() => replayHistory(new Map(), readProject({ schemaVersion: 1, frames: [] }).settings, [{ type: 'patch', documentId: 'missing', inverse: {}, forward: {} }], 'undo'), error => error instanceof DivletError && error.code === 'CANNOT_UNDO');
});
