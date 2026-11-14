import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInlineDeclarations } from '../lib/inline-css.ts';
import { parseInlineDeclarations as publicParser, decodeHtml, encodeHtml, htmlToSpecs } from '../lib/codec.ts';
import { serializeDeclarations } from '../lib/declarations.ts';
import { validDeclarations, DivletError, validateDocument } from '../lib/model.ts';
import { inlineCssCases, captureInlineCss } from './fixtures/inline-css.js';

for (const { name, input, expected } of inlineCssCases) test(`inline CSS syntax: ${name}`, () => {
  assert.deepEqual(captureInlineCss({ parseInlineDeclarations }, input), expected);
  if (!expected.ok) assert.throws(() => parseInlineDeclarations(input), DivletError);
});

test('the codec exposes one syntax parser without coercion or mutable aliases', () => {
  assert.equal(publicParser, parseInlineDeclarations);
  assert.throws(() => parseInlineDeclarations({ toString() { assert.fail('CSS text is never coerced'); } }), { code: 'INVALID_CSS' });
  const first = parseInlineDeclarations('color:red;color:blue'); first[0][1] = 'green';
  assert.deepEqual(parseInlineDeclarations('color:red;color:blue'), [['color', 'red'], ['color', 'blue']]);
});

test('supported ordered blocks survive syntax decoding, native declaration admission and serialization', () => {
  const inputs = [
    'display:-webkit-box;display:flex;padding-left:20px;padding:10px;color:red!important',
    'padding:10px;padding-left:20px;--Accent:gold;--accent:black',
    'content:"one;two:{three}";background:url("data:image/svg+xml;base64,PHN2Zy8+")',
  ];
  for (const text of inputs) {
    const parsed = validDeclarations(parseInlineDeclarations(text), 'root');
    assert.deepEqual(validDeclarations(parseInlineDeclarations(serializeDeclarations(parsed)), 'root'), parsed);
  }
});

test('syntax decoding does not grant value safety, field budgets or ordered wire admission', () => {
  assert.throws(() => validDeclarations(parseInlineDeclarations('color:expression(evil())'), 'root'), { code: 'UNSUPPORTED_CSS' });
  assert.throws(() => validDeclarations(parseInlineDeclarations('--value:' + 'x'.repeat(16385)), 'root'), { code: 'INVALID_DOCUMENT' });
  const frame = decodeHtml('<main style="color:red"></main>');
  const ordered = parseInlineDeclarations('color:red');
  assert.throws(() => validateDocument({ ...frame, nodes: { ...frame.nodes, [frame.rootId]: { ...frame.nodes[frame.rootId], style: ordered } } }), { code: 'INVALID_DOCUMENT' });
});

test('draft HTML decoding keeps its strict duplicate/structural refusal and safe dictionary adaptation', () => {
  for (const css of ['color:red;color:blue', 'color:red}body{display:none', '@media print{color:red}', '/*note*/color:red', '_color:red', '*color:red', '__proto__:red']) {
    assert.throws(() => decodeHtml(`<main style="${css}"></main>`), { code: 'INVALID_HTML' }, css);
  }
  assert.equal(htmlToSpecs('<main style="color:red;color:blue"></main>')[0].style, undefined, 'legacy paste still omits unsupported duplicate blocks until cutover');
  for (const css of ['constructor:one', 'prototype:two']) assert.throws(() => decodeHtml(`<main style="${css}"></main>`), { code: 'INVALID_DOCUMENT' });
  const document = decodeHtml('<main style="--accent:gold;color:red!important"></main>');
  assert.equal(Object.getPrototypeOf(document.nodes[document.rootId].style), Object.prototype);
  assert.equal(document.nodes[document.rootId].style['--accent'], 'gold');
  assert.deepEqual(decodeHtml(encodeHtml(document)), document);
});
