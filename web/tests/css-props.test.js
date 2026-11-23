import test from 'node:test';
import assert from 'node:assert/strict';
import * as css from '../lib/css-props.js';
import { declaredValues as coreDeclaredValues, expandShorthand as coreExpand, releaseForUtilities } from '../../core/lib/native-styles.ts';

test('the authored view expands shorthands in order and agrees with the core editor', () => {
  const cases = [
    [['padding', '10px'], ['padding-right', '4px']],
    [['padding-right', '4px'], ['padding', '10px 20px']],
    [['border', '2px dashed red'], ['border-top-width', '0']],
    [['margin', '0 auto'], ['margin-left', '3px']],
    [['gap', '8px 12px']],
    [['border-radius', '4px 8px'], ['border-top-left-radius', '1px']],
    [['padding', 'calc(1px + 2px) 3px']],
    [['inset', '0'], ['top', '5px']],
  ];
  for (const declarations of cases) assert.deepEqual(css.declaredValues(declarations), coreDeclaredValues(declarations), JSON.stringify(declarations));
  for (const [property, value] of [['padding', '1px 2px 3px'], ['border', '1px solid #ccc'], ['gap', '4px'], ['margin', 'var(--a) / 1px'], ['overflow', 'hidden auto']]) assert.deepEqual(css.expandShorthand(property, value), coreExpand(property, value), `${property}: ${value}`);
});

test('a view puts inline declarations over a representation reader', () => {
  const reader = { view: className => ({ padding: '8px', display: className === 'flex' ? 'flex' : 'block' }) };
  const view = css.viewOf({ className: 'flex', style: { 'padding-left': '1px' } }, [reader]);
  assert.equal(view.display, 'flex');
  assert.equal(view['padding-left'], '1px');
  assert.equal(view['padding-top'], '8px');
});

test('lengths, colours and single values parse what a person types', () => {
  assert.equal(css.lengthInput('16'), '16px'); assert.equal(css.lengthInput('0'), '0'); assert.equal(css.lengthInput('1.5rem'), '1.5rem');
  assert.equal(css.lengthInput('auto'), 'auto'); assert.equal(css.lengthInput(''), null); assert.equal(css.lengthInput('wat'), undefined);
  assert.equal(css.lengthInput('-4', { negative: false }), undefined); assert.equal(css.lengthInput('-4'), '-4px');
  assert.equal(css.show('16px'), '16'); assert.equal(css.show('1.5rem'), '1.5rem'); assert.equal(css.show('0'), '0');
  assert.equal(css.colourInput('#ABC'), '#abc'); assert.equal(css.colourInput('white'), '#ffffff'); assert.equal(css.colourInput('var(--color-brand)'), 'var(--color-brand)');
  assert.equal(css.colourInput('nope'), undefined);
  assert.equal(css.opacityInput('40'), '0.4'); assert.equal(css.opacityInput('100'), null); assert.equal(css.opacityOf({ opacity: '0.4' }), 40);
  assert.equal(css.zInput('auto'), 'auto'); assert.equal(css.zInput('-3'), '-3'); assert.equal(css.zInput('x'), undefined);
  assert.equal(css.radiusInput('Full'), '9999px'); assert.equal(css.radiusOf({ 'border-radius': '9999px' }), 'Full'); assert.equal(css.radiusOf({ 'border-radius': '8px' }), '8');
  assert.equal(css.radiusOf({ 'border-radius': '8px', 'border-top-left-radius': '2px' }), undefined, 'unequal corners are mixed');
  // A radius field splits the number from its unit: `100%` stays a percentage, only the pill value is `full`, and `full` has no unit.
  assert.equal(css.cornerRadiusNumber({ 'border-radius': '100%' }, 'top-left'), '100'); assert.equal(css.cornerRadiusUnit({ 'border-radius': '100%' }, 'top-left'), '%');
  assert.equal(css.cornerRadiusNumber({ 'border-top-left-radius': '1.5rem', 'border-radius': '4px' }, 'top-left'), '1.5'); assert.equal(css.cornerRadiusUnit({ 'border-top-left-radius': '1.5rem' }, 'top-left'), 'rem');
  assert.equal(css.cornerRadiusNumber({ 'border-radius': '9999px' }, 'top-left'), 'full'); assert.equal(css.cornerRadiusUnit({ 'border-radius': '9999px' }, 'top-left'), null);
  assert.equal(css.cornerRadiusNumber({}, 'top-left'), null);
  // A box-model value is its number and its unit apart: px by default, a keyword or expression has none.
  assert.deepEqual(css.lengthParts('12px'), { number: '12', unit: 'px' }); assert.deepEqual(css.lengthParts('1.5rem'), { number: '1.5', unit: 'rem' });
  assert.deepEqual(css.lengthParts('50%'), { number: '50', unit: '%' }); assert.deepEqual(css.lengthParts('0'), { number: '0', unit: 'px' });
  assert.deepEqual(css.lengthParts('-123.4567px'), { number: '-123.457', unit: 'px' }); assert.deepEqual(css.lengthParts(null), { number: '', unit: null });
  assert.deepEqual(css.lengthParts('auto'), { number: 'auto', unit: null }); assert.deepEqual(css.lengthParts('var(--gap)'), { number: 'var(--gap)', unit: null });
  assert.equal(css.borderWidthInput('3'), '3px'); assert.equal(css.borderWidthInput('0.5rem'), '0.5rem'); assert.equal(css.borderWidthInput('thin'), 'thin');
  assert.equal(css.borderWidthInput(''), null); assert.equal(css.borderWidthInput('50%'), undefined, 'a border width has no percentage'); assert.equal(css.borderWidthInput('-1'), undefined);
  assert.equal(css.weightOf({ 'font-weight': 'bold' }), '700');
  assert.equal(css.fontSizeOf({ 'font-size': '1.5rem' }), '24');
});

test('alignment and pinning round-trip through declarations', () => {
  const flex = { display: 'flex', 'flex-direction': 'column' };
  const edits = css.alignmentEdits(flex, 'end', 'start');
  assert.deepEqual(edits, { 'justify-content': 'flex-start', 'align-items': 'flex-end' });
  assert.deepEqual(css.alignment({ ...flex, ...edits }), { x: 'end', y: 'start', between: false });
  const grid = css.alignmentEdits({ display: 'grid' }, 'center', 'end');
  assert.deepEqual(grid, { 'justify-items': 'center', 'align-items': 'end' });
  assert.deepEqual(css.alignment({ display: 'grid', ...grid }), { x: 'center', y: 'end', between: false });
  const pinned = css.pinEdits({}, 'center', 'start');
  assert.deepEqual(css.pin({ left: pinned.left, top: pinned.top, transform: pinned.transform }), { x: 'center', y: 'start' });
  assert.equal(css.blurOf({ filter: 'grayscale(1) blur(8px)' }), 8);
  assert.equal(css.blurEdit({ filter: 'grayscale(1) blur(8px)' }, 0), 'grayscale(1)');
  assert.equal(css.blurEdit({}, 0), null);
  assert.equal(css.gridColumns({ 'grid-template-columns': css.gridColumnsEdit(3) }), 3);
  assert.equal(css.gapOf({ gap: '8px' }), '8'); assert.equal(css.gapOf({ 'row-gap': '4px', 'column-gap': '8px' }), '4 8');
});

test('inline declarations a utility would lose to are released exactly as the core writer releases them', () => {
  const cases = [
    [{ padding: '12px', color: 'red' }, ['padding-right']],
    [{ border: '1px solid #ccc', color: 'red' }, ['border-top-width']],
    [{ 'padding-right': '4px', padding: '10px' }, ['padding-right']],
    [{ margin: '0 auto' }, ['margin-left', 'margin-right']],
    [{ padding: '8px', margin: '4px' }, ['padding']],
    [{ color: 'red' }, ['padding-right']],
  ];
  for (const [style, properties] of cases) {
    const client = css.releaseInline(style, properties);
    assert.deepEqual(client.style, releaseForUtilities(style, properties).style, JSON.stringify([style, properties]));
    // The delta replays onto the old map to give the new one (what a merge patch does).
    const replay = { ...style };
    for (const [key, value] of Object.entries(client.delta)) { if (value === null) delete replay[key]; else replay[key] = value; }
    assert.deepEqual(replay, client.style, 'the patch reproduces the released declarations');
  }
});
