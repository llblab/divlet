import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attrs, Override, CssDeclaration, CssDeclarationOperation } from '../lib/model.ts';

const removal: Override = { attrs: { title: null, 'aria-label': 'Buy' } };
// @ts-expect-error Only override attributes admit null; persisted element attributes remain strings.
const invalidElementAttrs: Attrs = { title: null };

const declaration: CssDeclaration = ['display', 'flex'];
const operation: CssDeclarationOperation = ['display', null];
// @ts-expect-error Literal declaration values are strings, not deletion operations.
const invalidDeclaration: CssDeclaration = ['display', null];
// @ts-expect-error A declaration is exactly one property/value pair.
const invalidTuple: CssDeclaration = ['color', 'red', 'blue'];

test('ordered CSS types distinguish literal declarations from property operations', () => {
  assert.deepEqual(declaration, ['display', 'flex']);
  assert.deepEqual(operation, ['display', null]);
});

test('attribute types distinguish nullable override edits from literal element values', () => {
  assert.equal(removal.attrs?.title, null);
  assert.equal(removal.attrs?.['aria-label'], 'Buy');
});
