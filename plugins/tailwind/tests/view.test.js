import test from 'node:test';
import assert from 'node:assert/strict';
import { classView, declarationsOfClass, variantClasses, cssOfToken } from '../web/view.js';
import { applyStyles } from '../lib/styles.js';
import { declaredValues } from '../../../web/lib/css-props.js';

test('a class list reads as the declarations it stands for, base classes only', () => {
  const view = classView('flex flex-col items-center justify-between gap-4 p-4 pt-2 mx-auto absolute top-2 -translate-x-1/2 left-1/2 opacity-40 z-10 blur-sm text-center rounded-xl font-bold text-xl bg-white md:p-8 hover:bg-black');
  assert.equal(view.display, 'flex'); assert.equal(view['flex-direction'], 'column');
  assert.equal(view['align-items'], 'center'); assert.equal(view['justify-content'], 'space-between');
  assert.equal(view.gap, '16px');
  assert.equal(view['padding-top'], '8px', 'a more specific side beats the shorthand'); assert.equal(view['padding-left'], '16px');
  assert.equal(view['margin-left'], 'auto'); assert.equal(view.top, '8px'); assert.equal(view.left, '50%');
  assert.equal(view.opacity, '0.4'); assert.equal(view['z-index'], '10'); assert.equal(view.filter, 'blur(8px)');
  assert.equal(view['text-align'], 'center'); assert.equal(view['border-radius'], '12px');
  assert.equal(view['font-weight'], '700'); assert.equal(view['font-size'], '20px'); assert.equal(view['background-color'], '#ffffff');
  assert.match(view.transform, /^translate\(-50%/);
  assert.deepEqual(variantClasses('p-4 md:p-8 hover:bg-black md:flex', 'padding-top'), [], 'shorthand variants are not listed against a longhand');
  assert.deepEqual(variantClasses('flex md:block md:p-4', 'display'), ['md:block']);
});

test('arbitrary properties, theme colours and fractions read back', () => {
  assert.equal(classView('[border-width:3px]')['border-width'], '3px');
  assert.equal(declaredValues(Object.entries(classView('[border-width:3px]')))['border-top-width'], '3px');
  assert.equal(classView('[padding:12px_6px]')['padding'], '12px 6px');
  assert.equal(classView('bg-brand text-brand', { tokens: { '--color-brand': '#123456' } })['background-color'], 'var(--color-brand)');
  assert.equal(classView('bg-brand')['background-color'], undefined, 'an unknown theme name is not a colour');
  assert.equal(classView('bg-[#14121c]')['background-color'], '#14121c');
  assert.equal(classView('text-[color:#fff] text-[length:20px]').color, '#fff');
  assert.equal(cssOfToken('1/2'), '50%'); assert.equal(cssOfToken('full'), '100%'); assert.equal(cssOfToken('[13px]'), '13px'); assert.equal(cssOfToken('4'), '16px');
  assert.deepEqual(declarationsOfClass('w-[672px]'), [['width', '672px']]);
});

test('what the writer lowers to utilities reads back as the same declarations', () => {
  const edits = { display: 'flex', 'padding-right': '4px', 'margin-left': 'auto', 'margin-right': 'auto', 'z-index': '3', opacity: '0.4', filter: 'blur(8px)', 'font-weight': '800', 'background-color': '#112233', top: '8px', 'grid-template-columns': 'repeat(3, minmax(0, 1fr))', 'border-radius': '12px' };
  const className = applyStyles('', edits, { scale: true });
  const view = classView(className);
  for (const [property, value] of Object.entries(edits)) assert.equal(declaredValues(Object.entries(view))[property], value, `${property} → ${className}`);
});
