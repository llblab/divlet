import test from 'node:test';
import assert from 'node:assert/strict';
import { textOverride, textOverridePatch } from '../lib/component-text.js';

const slot = { id: 'label', parentId: 'button', content: 'Definition' };
test('instance text readback recognizes the parent shortcut and equal peers', () => {
  assert.equal(textOverride({ descendants: { button: { text: 'Existing' } } }, slot), 'Existing');
  assert.equal(textOverride({ descendants: { button: { text: 'Equal' }, label: { content: 'Equal' } } }, slot), 'Equal');
  assert.equal(textOverride({}, slot), undefined);
});

test('text editing and reset retire both peers without deleting unrelated overrides or mutating input', () => {
  const instance = { descendants: { button: { text: 'Equal', className: 'keep', metadata: { parent: true } }, label: { content: 'Equal', metadata: { child: true } } } };
  const before = structuredClone(instance);
  assert.deepEqual(textOverridePatch(instance, slot, 'Changed'), { button: { text: null }, label: { content: 'Changed' } });
  assert.deepEqual(textOverridePatch(instance, slot, null), { button: { text: null }, label: { content: null } });
  assert.deepEqual(instance, before);
});

test('reset removes lone text fields, while a slot without a parent shortcut changes only its own content', () => {
  const instance = { descendants: { button: { text: 'Equal' }, label: { content: 'Equal' } } };
  assert.deepEqual(textOverridePatch(instance, slot, null), { button: null, label: null });
  assert.deepEqual(textOverridePatch(instance, { id: 'label' }, 'Changed'), { label: { content: 'Changed' } });
});
