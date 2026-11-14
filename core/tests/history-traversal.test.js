import test from 'node:test';
import assert from 'node:assert/strict';
import { planHistoryTraversal } from '../lib/history.ts';
import { DivletError } from '../lib/validation.ts';
import { replayHistory } from '../lib/history-replay.ts';
import { readProject } from '../lib/project.ts';
import { historyTraversalCases, captureHistoryTraversal } from './fixtures/history-traversal.js';

const api = { planHistoryTraversal, replayHistory, readProject };
for (const { name, run, expected, error, message } of historyTraversalCases) test(name, () => {
  assert.deepEqual(captureHistoryTraversal(api, run), error ? { ok: false, code: error, message } : { ok: true, value: expected });
});

test('planner refusals use the same domain error class as its callers', () => {
  assert.throws(() => planHistoryTraversal([], 'undo', { steps: 0 }, 200), error => error instanceof DivletError && error.code === 'INVALID_QUERY');
});
