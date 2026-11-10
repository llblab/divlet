import test from 'node:test';
import assert from 'node:assert/strict';
import { compileClasses } from '../lib/styling.js';

const base = process.cwd();

test('Tailwind output contains exactly the requested candidate set, not prior project URL utilities', async () => {
  const tokens = { '--color-isolation': '#123456' };
  const first = await compileClasses(tokens, ['p-4', 'bg-[url(assets/project-a.svg)]'], base);
  assert.ok(first.includes('assets/project-a.svg'));
  const next = await compileClasses(tokens, ['p-4'], base);
  assert.ok(!next.includes('assets/project-a.svg'));
  assert.ok(!next.includes('background-image: url('));
  const third = await compileClasses(tokens, ['bg-[url(assets/project-b.svg)]'], base);
  assert.ok(third.includes('assets/project-b.svg'));
  assert.ok(!third.includes('assets/project-a.svg'));
});

test('concurrent same-theme compiles stay independent and reordered/duplicate candidate requests reuse equal CSS', async () => {
  const tokens = { '--color-isolation': '#654321' };
  const [a, b] = await Promise.all([
    compileClasses(tokens, ['p-2', 'bg-[url(assets/concurrent-a.svg)]'], base),
    compileClasses(tokens, ['m-2', 'bg-[url(assets/concurrent-b.svg)]'], base),
  ]);
  assert.ok(a.includes('concurrent-a.svg') && !a.includes('concurrent-b.svg'));
  assert.ok(b.includes('concurrent-b.svg') && !b.includes('concurrent-a.svg'));
  assert.equal(await compileClasses(tokens, ['bg-[url(assets/concurrent-a.svg)]', 'p-2', 'p-2'], base), a);
});
