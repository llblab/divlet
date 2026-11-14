import test from 'node:test';
import assert from 'node:assert/strict';
import { planHistoryTraversal } from '../lib/history.ts';
import type { HistoryReplayItem } from '../lib/history-replay.ts';

const group = { group: 'owned', label: 'Rename', items: [{ type: 'patch', documentId: 'a', inverse: { name: 'Before' }, forward: { name: 'After' } }] } as const;
const plan = planHistoryTraversal([group] as const, 'undo', {}, 200);
const items: readonly HistoryReplayItem[] = plan.ordered.flatMap(entry => entry.items);
const name: 'After' = plan.entries[0]!.items[0]!.forward.name;
if (false) {
  // @ts-expect-error A plan cannot authorize source-stack index mutation through its typed output.
  plan.indexes.push(1);
  // @ts-expect-error Original entry payload/group qualifiers survive generic planning.
  plan.entries[0]!.group = 'changed';
  // @ts-expect-error Saved labels remain unknown rather than being claimed normalized strings.
  const label: string = plan.label;
  // @ts-expect-error Only actual history directions are supported.
  planHistoryTraversal([group], 'backward', {}, 200);
}

test('traversal planning preserves readonly entry types and replay payloads without widening them', () => {
  assert.equal(plan.entries[0], group);
  assert.equal(items[0], group.items[0]);
  assert.equal(name, 'After');
});
