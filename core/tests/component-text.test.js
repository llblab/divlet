import test from 'node:test';
import assert from 'node:assert/strict';
import * as project from '../lib/project.ts';
import { componentTextCases } from './fixtures/component-text.js';

for (const witness of componentTextCases) test(witness.name, () => {
  if (witness.error) assert.throws(() => witness.run(project), { code: witness.error });
  else assert.deepEqual(witness.run(project), witness.expected);
});
