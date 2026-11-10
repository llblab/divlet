import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attrs, Override } from '../lib/model.ts';

const removal: Override = { attrs: { title: null, 'aria-label': 'Buy' } };
// @ts-expect-error Only override attributes admit null; persisted element attributes remain strings.
const invalidElementAttrs: Attrs = { title: null };

test('attribute types distinguish nullable override edits from literal element values', () => {
  assert.equal(removal.attrs?.title, null);
  assert.equal(removal.attrs?.['aria-label'], 'Buy');
});
