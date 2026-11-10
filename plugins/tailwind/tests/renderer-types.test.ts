import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedStyleEngine } from '../../../core/lib/engine.ts';
import { createRenderer } from '../lib/renderer.ts';

const renderer: ResolvedStyleEngine = createRenderer();

test('the versioned descriptor satisfies the exact compiling provider contract', () => {
  assert.equal(renderer.id, 'tailwind');
  assert.match(renderer.version, /^divlet-tailwind-1-/);
  assert.equal(typeof renderer.compileClasses, 'function');
});
