// Characterize the current emission boundary while the coherent format transition remains unactivated.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as codec from '../lib/codec.ts';
import { cssCascadeCases, cascadeFrame, cascadeDocuments } from './fixtures/css-cascade.js';

for (const row of cssCascadeCases) test(`CSS cascade transition: ${row.name}`, () => {
  const before = JSON.stringify(row), frame = cascadeFrame(row), documents = cascadeDocuments(codec, row);
  assert.equal(documents.length, 7);
  assert.equal(new Set(documents.map(item => item.mode)).size, 7);
  for (const { mode, html } of documents) {
    assert.ok(html.startsWith('<!doctype html>'), mode);
    assert.ok(html.includes('class="sample"'), mode);
  }
  assert.equal(codec.decodeHtml(documents[0].html).css, frame.css, 'current preview decodes one generated wrapper');
  assert.equal(codec.decodeHtml(documents[6].html).css, codec.layered(frame.css), 'explicit authored layers survive below the generated wrapper');
  assert.match(documents[0].html, /@layer theme, base, components, utilities;/);
  assert.equal(JSON.stringify(row), before, 'reference construction leaves the authored fixture unchanged');
});
