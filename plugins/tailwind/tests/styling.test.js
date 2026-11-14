import test from 'node:test';
import assert from 'node:assert/strict';
import { compileClasses, customClasses, unknownClasses, explainClasses } from '../lib/styling.js';
import { cssAnnotationCases } from '../../../core/tests/fixtures/css-annotations.js';

const base = process.cwd();

test('class analysis preserves authored rules with inert source-map-looking CSS data', async () => {
  for (const { name, literal, comment } of cssAnnotationCases) {
    const css = `.annotated{content:${literal};color:#123456}${comment}`;
    assert.deepEqual(customClasses(css).get('annotated'), [{ context: [], selector: '.annotated', declarations: [`content: ${literal}`, 'color: #123456'] }], name);
    assert.deepEqual(await unknownClasses({ tokens: {}, css, byNode: { root: 'annotated' }, base }), {}, name);
    const explanation = await explainClasses({ tokens: {}, css, names: ['annotated'], base });
    assert.equal(explanation.annotated.kind, 'custom', name);
    assert.ok(explanation.annotated.lines.some(line => line.includes(literal)), name);
  }
});

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
