import test from 'node:test';
import assert from 'node:assert/strict';
import * as tw from '../web/tw.js';

test('groups read and replace only base classes, in place', () => {
  const cls = 'block md:flex p-4 text-sm';
  assert.equal(tw.get(cls, 'display'), 'block');
  assert.deepEqual(tw.variantsOf(cls, 'display'), ['md:flex']);
  assert.equal(tw.set(cls, 'display', 'grid'), 'grid md:flex p-4 text-sm');
  assert.equal(tw.set(cls, 'display', null), 'md:flex p-4 text-sm');
  assert.equal(tw.set('p-4', 'position', 'absolute'), 'p-4 absolute');
  assert.equal(tw.hasVariant('bg-[url(a:b)]'), false);
  assert.equal(tw.hasVariant('hover:bg-black'), true);
  assert.equal(tw.get('text-sm text-center text-[#fff]', 'textAlign'), 'text-center');
  assert.equal(tw.get('gap-x-4 gap-2', 'gap'), 'gap-2');
});

test('spacing tokens convert between Tailwind and px', () => {
  assert.equal(tw.toPx('4'), 16);
  assert.equal(tw.toPx('px'), 1);
  assert.equal(tw.toPx('[13px]'), 13);
  assert.equal(tw.toPx('[1.5rem]'), 24);
  assert.equal(tw.toPx('-3'), -12);
  assert.equal(tw.toPx('auto'), 'auto');
  assert.equal(tw.fromInput('16'), '4');
  assert.equal(tw.fromInput('18px'), '4.5');
  assert.equal(tw.fromInput('13'), '[13px]');
  assert.equal(tw.fromInput('1'), 'px');
  assert.equal(tw.fromInput('-8'), '-2');
  assert.equal(tw.fromInput('auto'), 'auto');
  assert.equal(tw.fromInput('50%'), '[50%]');
  assert.equal(tw.fromInput('1/2'), '1/2');
  assert.equal(tw.fromInput(''), null);
  assert.equal(tw.fromInput('wide'), undefined);
  assert.equal(tw.display('[13px]'), '13');
  assert.equal(tw.display('[50%]'), '50%');
});

test('box sides: effective values and the shortest classes', () => {
  assert.deepEqual(tw.sides('p-4 pt-2', 'padding'), { t: '2', r: '4', b: '4', l: '4' });
  assert.deepEqual(tw.sides('pt-2 p-4', 'padding'), { t: '2', r: '4', b: '4', l: '4' }, 'more specific wins whatever the order');
  assert.deepEqual(tw.sides('px-6 py-2 sm:p-10', 'padding'), { t: '2', r: '6', b: '2', l: '6' });
  assert.deepEqual(tw.sides('p-px', 'padding'), { t: 'px', r: 'px', b: 'px', l: 'px' });
  assert.equal(tw.setSide('p-4 text-sm', 'padding', 't', '2'), 'px-4 pt-2 pb-4 text-sm');
  assert.equal(tw.setSide('px-4 pt-2 pb-4', 'padding', 't', '4'), 'p-4');
  assert.equal(tw.setSide('p-4', 'padding', 'all', null), '');
  assert.equal(tw.setSide('mx-auto', 'margin', 't', '-2'), 'mx-auto -mt-2');
  assert.equal(tw.setSide('', 'margin', 'l', 'auto'), 'ml-auto');
  assert.equal(tw.setSide('inset-shadow-sm top-0', 'inset', 'l', '0'), 'inset-shadow-sm left-0 top-0');
  assert.equal(tw.isBoxClass('px-4', 'padding'), true);
  assert.equal(tw.isBoxClass('pointer-events-none', 'padding'), false);
});

test('container alignment follows the flex direction', () => {
  assert.deepEqual(tw.alignment('flex justify-center items-end'), { x: 'center', y: 'end', between: false });
  assert.deepEqual(tw.alignment('flex flex-col justify-center items-end'), { x: 'end', y: 'center', between: false });
  assert.equal(tw.setAlignment('flex', 'end', 'start'), 'flex justify-end items-start');
  assert.equal(tw.setAlignment('flex flex-col', 'end', 'start'), 'flex flex-col justify-start items-end');
  assert.equal(tw.setAlignment('grid', 'center', 'center'), 'grid justify-items-center items-center');
  assert.equal(tw.alignment('flex justify-between').between, true);
});

test('pinning sets edges or centers with a translate', () => {
  assert.equal(tw.setPin('absolute', 'end', 'start'), 'absolute right-0 top-0');
  assert.deepEqual(tw.pin('absolute right-0 top-0'), { x: 'end', y: 'start' });
  const centered = tw.setPin('absolute right-0 top-0', 'center', 'center');
  assert.equal(centered, 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2');
  assert.deepEqual(tw.pin(centered), { x: 'center', y: 'center' });
});

test('effects read and write their classes', () => {
  assert.equal(tw.valueOf('opacity-40', 'opacity'), 40);
  assert.equal(tw.classFor('opacity', '100'), null);
  assert.equal(tw.classFor('opacity', '35'), 'opacity-35');
  assert.equal(tw.valueOf('-z-10', 'z'), -10);
  assert.equal(tw.classFor('z', '-1'), '-z-1');
  assert.equal(tw.classFor('z', 'auto'), 'z-auto');
  assert.equal(tw.valueOf('blur-sm', 'blur'), 8);
  assert.equal(tw.valueOf('blur-[3px]', 'blur'), 3);
  assert.equal(tw.classFor('blur', '8'), 'blur-sm');
  assert.equal(tw.classFor('blur', '5'), 'blur-[5px]');
  assert.equal(tw.classFor('blur', '0'), null);
  assert.equal(tw.valueOf('gap-6', 'gap'), '24');
  assert.equal(tw.classFor('gap', '12'), 'gap-3');
  assert.equal(tw.classFor('z', 'x'), undefined);
});

test('spreading and stretching are separate from the 3×3 pad', () => {
  assert.equal(tw.set('flex justify-end items-start', 'justify', 'justify-evenly'), 'flex justify-evenly items-start');
  assert.equal(tw.set('flex justify-end items-start', 'items', 'items-stretch'), 'flex justify-end items-stretch');
  assert.equal(tw.set('flex items-baseline', 'justify', 'justify-around'), 'flex items-baseline justify-around');
  assert.equal(tw.get('grid justify-items-stretch items-center', 'justifyItems'), 'justify-items-stretch');
  assert.equal(tw.set('grid justify-items-stretch', 'justifyItems', 'justify-items-center'), 'grid justify-items-center');
  assert.deepEqual(tw.alignment('flex justify-evenly items-stretch'), { x: null, y: null, between: false });
  assert.equal(tw.setAlignment('flex justify-evenly items-stretch', 'center', 'end'), 'flex justify-center items-end');
});
