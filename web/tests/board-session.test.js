import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotReadSession } from '../lib/board-session.ts';
import { snapshotCases } from './fixtures/board-session.js';

for (const { name, run, expected } of snapshotCases) test(`snapshot session: ${name}`, async () => {
  assert.deepEqual(await run(createSnapshotReadSession), expected);
});
