import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceFrame } from '../lib/projection.js';
import { encodeHtml, decodeHtml, renderFile } from '../../../core/lib/codec.ts';
import { readProject, writeProject } from '../lib/source.js';

const source = () => ({ version: '2.21', fileToken: 'ELLIPSE-SOURCE-ONLY', variables: { ink: { type: 'color', value: '#123456' }, width: { type: 'number', value: 80 } }, children: [{ id: 'screen', type: 'frame', width: 320, height: 240, layout: 'none', children: [{ id: 'oval', type: 'ellipse', x: 12.5, y: 20, width: '$width', height: 40, fill: '$ink', stroke: '#abcdef', strokeWidth: 2, strokeAlignment: 'inner', foreign: { keep: true } }] }] });
const node = frame => Object.values(frame.document.nodes).find(n => n.metadata?.pen?.sourceId === 'oval' && !n.metadata.pen.part);

test('native ellipses retain real oval geometry, numeric/color refs, inner stroke and source/provenance through codec round trips', () => {
  const input = source(), before = structuredClone(input), frame = sourceFrame(readProject(input), 'screen'), oval = node(frame);
  assert.equal(oval.tag, 'div'); assert.equal(oval.metadata.pen.nodeType, 'ellipse'); assert.equal(oval.metadata.pen.presentation, 'native');
  assert.equal(oval.children.length, 0); assert.match(frame.document.css, /border-radius:50%/); assert.match(frame.document.css, /width:80px;height:40px/); assert.match(frame.document.css, /background-color:#123456/); assert.match(frame.document.css, /box-shadow:inset 0 0 0 2px #abcdef/);
  assert.deepEqual(decodeHtml(encodeHtml(frame.document), { previous: frame.document }), frame.document);
  assert.ok(!renderFile(frame.document).includes(input.fileToken)); assert.deepEqual(input, before); assert.deepEqual(JSON.parse(writeProject(input)), before);
});

test('native elliptical image/layer fills and disabled typed colors do not become square boxes or visible disabled paint', () => {
  const input = source(), oval = input.children[0].children[0];
  oval.fill = [{ type: 'color', color: '#ff0000', enabled: false }, { type: 'color', color: '#2468ab' }, { type: 'image', url: 'assets/portrait.svg', mode: 'cover' }];
  const frame = sourceFrame(input, 'screen');
  assert.match(frame.document.css, /border-radius:50%/); assert.ok(frame.document.css.includes('portrait.svg')); assert.match(frame.document.css, /linear-gradient\(#2468ab,#2468ab\)/); assert.ok(!frame.document.css.includes('#ff0000'));
  oval.fill = { type: 'color', color: '#ff0000', enabled: false };
  const disabled = sourceFrame(input, 'screen'); assert.ok(!disabled.document.css.includes('#ff0000')); assert.ok(!disabled.document.css.includes('background-'));
  oval.stroke = { type: 'color', color: '#ff0000', enabled: false }; assert.ok(!sourceFrame(input, 'screen').document.css.includes('solid #ff0000'));
  oval.stroke = []; assert.ok(!sourceFrame(input, 'screen').document.css.includes('border:'));
  oval.stroke = '#abcdef'; oval.strokeAlignment = 'outer'; oval.strokeWidth = 1.5; const outer = sourceFrame(input, 'screen'); assert.match(outer.document.css, /box-shadow:0 0 0 1.5px #abcdef/); assert.match(outer.document.css, /border-radius:50%/);
  oval.effect = { type: 'shadow', shadowType: 'outer', offset: { x: 2, y: 3 }, blur: 4, color: '#000000' }; assert.match(sourceFrame(input, 'screen').document.css, /box-shadow:0 0 0 1.5px #abcdef,2px 3px 4px #000000/);
});

test('native layer blur uses its finite nonnegative radius while retaining canonical effects and scalar variables', () => {
  const input = source(), oval = input.children[0].children[0]; input.variables.blur = { type: 'number', value: 36 }; oval.effect = { type: 'blur', radius: '$blur' };
  const before = structuredClone(input), frame = sourceFrame(input, 'screen'); assert.match(frame.document.css, /filter:blur\(36px\)/); assert.deepEqual(input, before);
  oval.effect.enabled = false; assert.ok(!sourceFrame(input, 'screen').document.css.includes('filter:'));
});

test('unsupported ellipse strokes, active paints and blur bounds still refuse instead of inventing approximations', () => {
  for (const mutate of [n => { n.innerRadius = 0.5; }, n => { n.sweepAngle = 180; }, n => { n.strokeAlignment = 'outside'; }, n => { n.fill = { type: 'gradient', colors: [] }; }, n => { n.effect = { type: 'blur', radius: -1 }; }]) {
    const input = source(); mutate(input.children[0].children[0]); const before = structuredClone(input); assert.throws(() => sourceFrame(input, 'screen'), { code: 'UNSUPPORTED_PEN_RENDER' }); assert.deepEqual(input, before);
  }
});
