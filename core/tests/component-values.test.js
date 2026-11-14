import test from 'node:test';
import assert from 'node:assert/strict';
import * as project from '../lib/project.ts';
import { componentValueCases } from './fixtures/component-values.js';

for (const witness of componentValueCases) test(witness.name, () => {
  if (witness.error) assert.throws(() => witness.run(project), { code: witness.error });
  else assert.deepEqual(witness.run(project), witness.expected);
});
