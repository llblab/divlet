import test from 'node:test';
import assert from 'node:assert/strict';
import * as project from '../lib/project.ts';
import { domIdCases, domReferenceProject } from './fixtures/dom-ids.js';
import { validateDocument } from '../lib/model.ts';
import { decodeHtml } from '../lib/codec.ts';

test('native model and strict HTML decoding share the nonempty DOM ID guard', () => {
  const source = domReferenceProject('for').frames[0];
  source.nodes.help.attrs.id = 'field';
  assert.throws(() => validateDocument(source), { code: 'INVALID_DOCUMENT' });
  assert.throws(() => decodeHtml('<main><label for="same">Name</label><input id="same"><span id="same">Help</span></main>'), /Duplicate nonempty DOM id/);
});

for (const witness of domIdCases) test(witness.name, () => {
  if (witness.error) assert.throws(() => witness.run(project), { code: witness.error });
  else assert.deepEqual(witness.run(project), witness.expected);
});
