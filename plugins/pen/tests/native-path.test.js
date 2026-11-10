import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePathViewBox } from '../lib/pen-path.js';
import { sourceFrame } from '../lib/projection.js';
import { encodeHtml, decodeHtml } from '../../../core/lib/codec.ts';
import { writeProject, materializeProject } from '../lib/source.js';

const source = (geometry, extra = {}) => ({ version: '2.21', fileToken: 'PATH-PRIVATE', children: [{ id: 'page', type: 'frame', layout: 'none', width: 300, height: 240, children: [{ id: 'vector', type: 'path', width: 180, height: 70, fill: '#123456', geometry, foreign: { keep: true }, ...extra }] }] });

test('implicit path bounds cover lines/closures/relative and repeated commands without unused moveto points', () => {
  for (const [geometry, expected] of [
    ['M10 20h40v30h-40z', [10, 20, 40, 30]],
    ['M1000 1000M-5 -10L15 -10 15 10z', [-5, -10, 20, 20]],
    ['m1e1 2e1l4e1 0 0 3e1-4e1 0z', [10, 20, 40, 30]],
  ]) assert.deepEqual(nativePathViewBox(geometry), expected);
});

test('tight cubic/quadratic bounds use interior curve extrema, including reflected smooth controls', () => {
  assert.deepEqual(nativePathViewBox('M0 0C0 100 100 100 100 0'), [0, 0, 100, 75]);
  assert.deepEqual(nativePathViewBox('M0 0Q50 100 100 0'), [0, 0, 100, 50]);
  assert.deepEqual(nativePathViewBox('M0 0q50 100 100 0t100 0'), [0, -50, 200, 100]);
  assert.deepEqual(nativePathViewBox('M0 0c0 100 100 100 100 0s100-100 100 0'), [0, -75, 200, 150]);
});

test('native rendering derives missing viewBox only in projection, stretches to the authored box and retains fill rule/command/source graph', () => {
  const input = source('M0 0C0 100 100 100 100 0', { fillRule: 'evenodd' }), before = structuredClone(input), frame = sourceFrame(input, 'page');
  const node = Object.values(frame.document.nodes).find(n => n.metadata?.pen?.sourceId === 'vector' && !n.metadata.pen.part), part = frame.document.nodes[node.children[0]];
  assert.equal(node.attrs.viewBox, '0 0 100 75'); assert.equal(node.attrs.preserveAspectRatio, 'none'); assert.equal(part.attrs.d, before.children[0].children[0].geometry); assert.equal(part.attrs['fill-rule'], 'evenodd'); assert.equal(frame.provenance.get(part.id).readOnly, true);
  assert.deepEqual(decodeHtml(encodeHtml(frame.document), { previous: frame.document }), frame.document); assert.deepEqual(input, before); assert.deepEqual(JSON.parse(writeProject(input)), before); assert.equal(materializeProject(input).roots.length, 1);
});

test('explicit viewBox stays authoritative instead of being replaced by inferred geometry or display dimensions', () => {
  const viewBox = [-20, -30, 400, 500], input = source('M0 0L10 20', { viewBox }), before = structuredClone(input), frame = sourceFrame(input, 'page');
  const node = Object.values(frame.document.nodes).find(n => n.metadata?.pen?.sourceId === 'vector' && !n.metadata.pen.part); assert.equal(node.attrs.viewBox, viewBox.join(' ')); assert.deepEqual(input, before);
});

test('malformed/nonfinite/degenerate/oversize implicit geometry refuses privately without source mutation', () => {
  for (const geometry of ['', 'M1000 1000', 'M0 0H10', 'M0 0L10 0 L10', 'M0 0 SECRET-PATH-EXCERPT', 'M0 0L1e309 5', 'M0 0L1e30 5', 'M0 0 '.repeat(50000)]) {
    const input = source(geometry), before = structuredClone(input); assert.throws(() => sourceFrame(input, 'page'), error => error.code === 'UNSUPPORTED_PEN_RENDER' && !error.message.includes('SECRET-PATH-EXCERPT')); assert.deepEqual(input, before);
  }
  assert.throws(() => sourceFrame(source('M0 0L10 20', { fillRule: 'unknown' }), 'page'), { code: 'UNSUPPORTED_PEN_RENDER' });
});
