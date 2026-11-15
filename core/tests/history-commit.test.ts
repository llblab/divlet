import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryLine, planHistoryTraversal } from '../lib/history.ts';
import type { HistoryCommitGroup, HistoryTraversalPlan } from '../lib/history.ts';
import { historyCommitCases, captureHistoryCommit } from './fixtures/history-commit.js';

const api = { HistoryLine, planHistoryTraversal };
for (const { name, run, expected } of historyCommitCases) test(name, () => assert.deepEqual(captureHistoryCommit(api, run), { ok: true, value: expected }, name));

function commitContracts(line: HistoryLine, entry: HistoryCommitGroup, plan: HistoryTraversalPlan<HistoryCommitGroup>) {
  const undo: HistoryCommitGroup[] = [], redo: HistoryCommitGroup[] = [];
  line.commitGroup(undo, redo, entry, { seq: 1 }, 200);
  line.commitTraversal(undo, redo, plan, 'undo', { seq: null, label: 'Undo' });
  const frozenItems: readonly unknown[] = [];
  // @ts-expect-error Coalescing requires mutable session-owned item arrays, not readonly records.
  line.commitGroup(undo, redo, { items: frozenItems }, { seq: 1 }, 200);
  // @ts-expect-error Existing stack arrays must be mutable, not copied readonly snapshots.
  line.commitGroup(undo as readonly HistoryCommitGroup[], redo, entry, { seq: 1 }, 200);
  // @ts-expect-error A traversal commit still requires the planner's indexes and original entries.
  line.commitTraversal(undo, redo, { indexes: [] }, 'undo', { seq: null, label: 'Undo' });
}
void commitContracts;
