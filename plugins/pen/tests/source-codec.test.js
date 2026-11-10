import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceFrame } from '../lib/projection.js';
import { encodeHtml, decodeHtml, renderFile, exportHtml } from '../../../core/lib/codec.ts';
import { readProject, writeProject } from '../lib/source.js';

import { fixture } from '../../../core/tests/fixtures/source-project.js';

const bySource = (frame, id) => [...frame.provenance].filter(([, value]) => value.sourceId === id && !value.part).map(([key]) => key);

test('intrinsic height hints are projection-only and distinguish omission/hug from fixed, variable and container heights', () => {
  for (const [height, intrinsic] of [[undefined, true], ['fit_content', true], ['fit_content(420)', true], [1, false], [16384, false], ['$height', false], ['fill_container', false]]) {
    const input = { version: '2.21', variables: { height: { type: 'number', value: 400 } }, children: [{ id: 'screen', type: 'frame', width: 300, ...(height === undefined ? {} : { height }) }] }, before = structuredClone(input);
    const frame = sourceFrame(readProject(input), 'screen');
    assert.equal(frame.document.metadata.pen.intrinsicHeight, intrinsic, String(height));
    assert.deepEqual(input, before); assert.deepEqual(JSON.parse(writeProject(input)), before);
  }
});

test('source codec produces a safe round-trippable DOM projection with provenance, not a converted source', () => {
  const input = fixture();
  input.variables.canvasX = { type: 'number', value: 9000 };
  input.variables.viewportWidth = { type: 'number', value: 390 };
  input.children[1].x = '$canvasX'; input.children[1].width = '$viewportWidth';
  const before = structuredClone(input);
  const frame = sourceFrame(readProject(input), '7 / screen');
  const doc = frame.document;
  assert.match(doc.id, /^pen-[a-f0-9]+$/);
  assert.equal(doc.artboard.x, 9000);
  assert.equal(doc.artboard.width, 390);
  assert.ok(!Object.hasOwn(doc.nodes[doc.rootId].style, 'left'), 'canvas coordinates do not become page margins');
  assert.equal(frame.provenance.get(bySource(frame, 'label')[0]).instancePath[0], 'instance');
  assert.equal(doc.nodes[doc.rootId].metadata.pen.nodeType, 'frame');
  assert.equal(doc.nodes[bySource(frame, 'label')[0]].metadata.pen.nodeType, 'text');
  assert.equal(doc.nodes[bySource(frame, 'fixed')[0]].metadata.pen.nodeType, 'rectangle');
  const icon = doc.nodes[bySource(frame, 'icon')[0]];
  assert.equal(icon.tag, 'svg'); assert.equal(icon.metadata.pen.nodeType, 'icon');
  assert.ok(!frame.provenance.get(icon.id).part);
  assert.ok(icon.children.every(id => frame.provenance.get(id).part === 'glyph' && frame.provenance.get(id).readOnly));
  const vector = doc.nodes[bySource(frame, 'vector')[0]];
  assert.equal(vector.tag, 'svg'); assert.equal(vector.metadata.pen.nodeType, 'path');
  assert.equal(doc.nodes[vector.children[0]].attrs.d, input.children[1].children[4].geometry);
  assert.equal(frame.provenance.get(vector.children[0]).part, 'geometry');
  assert.equal(frame.provenance.get(vector.children[0]).readOnly, true);
  assert.ok(!frame.provenance.get(vector.id).part);
  const html = encodeHtml(doc);
  assert.deepEqual(decodeHtml(html, { previous: doc }), doc);
  assert.ok(!html.includes('DO-NOT-EMIT'));
  assert.ok(!renderFile(doc).includes('divlet-metadata'));
  assert.match(doc.css, /Permission to use, copy, modify/);
  assert.match(exportHtml(doc), /data-pen-style=/, 'clean export retains native CSS anchors');
  assert.ok(!Object.values(doc.nodes).some(node => node.tag === 'use'), 'inline glyphs work inside opaque previews');
  assert.ok(frame.diagnostics.some(item => item.code === 'ICON_LIBRARY_POLICY'));
  assert.throws(() => writeProject(frame), /projection cannot be serialized/);
  assert.deepEqual(input, before);
});

test('intrinsic dimensions, disabled nodes and ambiguous opacity are explicit render policies, not source edits', () => {
  const input = fixture();
  const root = input.children[1]; root.height = 'fit_content(0)'; root.opacity = 50;
  root.children.push({ id: 'disabled', type: 'text', enabled: false, content: 'Hidden alternative' });
  const before = structuredClone(input);
  const frame = sourceFrame(input, root.id);
  assert.equal(frame.document.artboard.height, 800);
  for (const code of ['AUTO_VIEWPORT', 'AMBIGUOUS_OPACITY', 'DISABLED_LAYOUT_POLICY', 'PARAMETERIZED_SIZING', 'FILL_ORDER_POLICY']) assert.ok(frame.diagnostics.some(item => item.code === code), code);
  assert.deepEqual(input, before);
  assert.equal(JSON.parse(writeProject(input)).children[1].height, 'fit_content(0)');
});

test('unsupported graphics and active extension data fail without mutating a valid source', () => {
  for (const mutate of [
    input => { input.children[1].children[2].icon = '../../private'; },
    input => { input.children[1].children[2].library = 'unknown'; },
    input => { input.children[1].children[2].type = 'unsupported-shape'; },
    input => { input.children[1].children[4].viewBox = [0, 0, 10]; },
    input => { input.children[1].children[5].fill[0].url = 'java\nscript:alert(1)'; },
    input => { input.children[1].divlet = { attrs: { 'data-pen-style': 'spoof' } }; },
  ]) {
    const input = fixture(); mutate(input);
    const before = structuredClone(input);
    assert.throws(() => sourceFrame(input, '7 / screen'));
    assert.deepEqual(input, before);
  }
});
