import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryLine, validateHistoryNavigation, planHistoryNavigation } from '../lib/history.ts';
import { DivletError } from '../lib/validation.ts';
import type { HistoryNavigationPlan } from '../lib/history.ts';
import { historyNavigationCases, captureHistoryNavigation } from './fixtures/history-navigation.js';

const api = { HistoryLine, validateHistoryNavigation, planHistoryNavigation };
for (const { name, run, expected, error, message } of historyNavigationCases) test(name, () => {
  assert.deepEqual(captureHistoryNavigation(api, run), error ? { ok: false, code: error, message } : { ok: true, value: expected });
});

const request = validateHistoryNavigation('p0' as unknown, 'p1' as unknown);
const snapshot = { current: 'p1', index: 1, points: [{ id: 'p0' }, { id: 'p1' }] } as const;
const planned: HistoryNavigationPlan = planHistoryNavigation(snapshot, request);
if (false) {
  // @ts-expect-error Validated request fields are readonly.
  request.pointId = 'changed';
  // @ts-expect-error Target planning expects validated string fields, not raw numbers.
  planHistoryNavigation(snapshot, { pointId: 1, expectedPoint: 'p1' });
  if (!planned.changed) {
    // @ts-expect-error No-op decisions cannot accidentally authorize replay steps.
    const steps: number = planned.steps;
  } else {
    // @ts-expect-error Decisions are readonly; the writer selects stacks without rewriting the plan.
    planned.direction = 'redo';
  }
}

test('navigation decisions narrow replay versus no-op and retain shared error identity', () => {
  assert.deepEqual(planned, { changed: true, direction: 'undo', steps: 1 });
  assert.throws(() => validateHistoryNavigation(null, 'p1'), error => error instanceof DivletError && error.code === 'INVALID_QUERY');
  assert.throws(() => planHistoryNavigation(snapshot, validateHistoryNavigation('p0', 'old')), error => error instanceof DivletError && error.code === 'HISTORY_CONFLICT');
});
