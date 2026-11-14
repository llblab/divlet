import test from 'node:test';
import assert from 'node:assert/strict';
import * as project from '../lib/project.ts';
import { prepareFrameWith } from '../lib/prepare.ts';
import { componentScopeCases, componentScopeProject, consumerTokens, projectTokens, projectCss, consumerCss } from './fixtures/component-scope.js';

for (const witness of componentScopeCases) test(witness.name, () => assert.deepEqual(witness.run(project), witness.expected));

test('preparation supplies consumer tokens and cloned class candidates to the injected compiler', async () => {
  const input = componentScopeProject(), before = structuredClone(input);
  const admitted = project.readProject(input), lookup = new Map(admitted.frames.map(frame => [frame.id, frame]));
  const calls = [];
  const prepared = await prepareFrameWith(lookup.get('consumer'), { settings: admitted.settings, lookup: id => lookup.get(id), compiler: {
    compile: (tokens, candidates) => { calls.push({ tokens, candidates }); return ''; },
    unknown: () => ({}),
  } });
  assert.deepEqual(calls, [{ tokens: { ...projectTokens, ...consumerTokens }, candidates: ['scope', 'source-only', 'leaf'] }]);
  assert.match(prepared.fileHtml, /color:var\(--accent\)/);
  assert.ok(prepared.fileHtml.includes(projectCss + '\n' + consumerCss));
  assert.ok(!prepared.fileHtml.includes('--source-only:11px'));
  assert.equal(prepared.document.nodes.instance.type, 'ref', 'preparation returns the linked source, not flattened nodes');
  assert.deepEqual(input, before);
});
