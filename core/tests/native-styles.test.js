import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNativeStyles, declaredValues, expandShorthand, releaseForUtilities } from '../lib/native-styles.ts';
import { applyDocumentPatch, createDemoDocument } from '../lib/model.ts';
import { setStyleEngines, styleEngine } from '../lib/engine.ts';

test('a longhand edit is written after a covering shorthand so it wins, and siblings are untouched', () => {
  assert.deepEqual(Object.entries(applyNativeStyles({ padding: '10px' }, { 'padding-right': '4px' })), [['padding', '10px'], ['padding-right', '4px']]);
  assert.deepEqual(Object.entries(applyNativeStyles({ 'padding-right': '4px', padding: '10px' }, { 'padding-right': '6px' })), [['padding', '10px'], ['padding-right', '6px']]);
  assert.deepEqual(Object.entries(applyNativeStyles({ color: 'red', 'padding-top': '1px' }, { padding: '8px' })), [['color', 'red'], ['padding', '8px']]);
});

test('removing a longhand expands the shorthand that set it instead of losing its siblings', () => {
  assert.deepEqual(applyNativeStyles({ padding: '10px 20px' }, { 'padding-right': null }), { 'padding-top': '10px', 'padding-bottom': '10px', 'padding-left': '20px' });
  const border = applyNativeStyles({ border: '1px solid #ccc' }, { 'border-top-width': null });
  assert.deepEqual(border, { 'border-right-width': '1px', 'border-bottom-width': '1px', 'border-left-width': '1px', 'border-style': 'solid', 'border-color': '#ccc' });
  assert.throws(() => applyNativeStyles({ padding: 'var(--a) / 1px' }, { 'padding-top': null }), { code: 'INVALID_PATCH' });
});

test('the authored view expands shorthands in declaration order, later declarations winning', () => {
  const view = declaredValues([['padding', '10px'], ['padding-right', '4px'], ['border', '2px dashed red'], ['border-top-width', '0']]);
  assert.equal(view['padding-left'], '10px'); assert.equal(view['padding-right'], '4px');
  assert.equal(view['border-top-width'], '0'); assert.equal(view['border-left-width'], '2px'); assert.equal(view['border-style'], 'dashed');
  assert.equal(expandShorthand('padding', '1px 2px 3px 4px')?.[3]?.[1], '4px');
  assert.equal(expandShorthand('padding', 'calc(1px + 2px) 2px')?.length, 4, 'functions stay whole');
});

test('inline declarations that would defeat a utility are released; unreleasable ones are reported', () => {
  assert.deepEqual(releaseForUtilities({ padding: '12px', color: 'red' }, ['padding-right']).style, { 'padding-top': '12px', 'padding-bottom': '12px', 'padding-left': '12px', color: 'red' });
  const blocked = releaseForUtilities({ padding: 'var(--a) / 1px' }, ['padding-top']);
  assert.deepEqual(blocked.blocked, ['padding-top']);
});

test('a styles patch edits inline CSS without an engine and utilities with one, never leaving a competing inline value', () => {
  const saved = styleEngine();
  try {
    const base = createDemoDocument(), id = base.rootId;
    base.nodes[id].style = { padding: '12px' };
    setStyleEngines([]);
    const native = applyDocumentPatch(base, { nodes: { [id]: { styles: { 'padding-right': '4px' } } } });
    assert.deepEqual(Object.entries(native.nodes[id].style), [['padding', '12px'], ['padding-right', '4px']]);
    assert.equal(native.nodes[id].className, base.nodes[id].className);
    setStyleEngines([{ id: 'host', applyStyles: (className, edits) => `${className} ${Object.keys(edits).join('+')}`.trim() }]);
    const lowered = applyDocumentPatch(base, { nodes: { [id]: { styles: { 'padding-right': '4px' } } } });
    assert.match(lowered.nodes[id].className, /padding-right$/);
    assert.deepEqual(lowered.nodes[id].style, { 'padding-top': '12px', 'padding-bottom': '12px', 'padding-left': '12px' }, 'the covering shorthand no longer beats the utility');
  } finally { setStyleEngines([saved]); }
});
