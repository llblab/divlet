import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStyles, declarationClass, propertyOfClass } from '../lib/styles.js';
import { colourNames } from '../../../core/lib/model.ts';

const norm = text => text.split(' ').filter(Boolean).sort().join(' ');
const set = (className, styles) => norm(applyStyles(className, styles));
const eq = (actual, expected, message) => assert.equal(actual, norm(expected), message);

test('a declaration replaces the class that set the same property and keeps everything else', () => {
  eq(set('flex w-[100px] hover:w-[200px] text-sm', { width: '320px' }), 'flex hover:w-[200px] text-sm w-80');
  eq(set('flex w-full h-auto', { width: '320px', height: '50px' }), 'flex w-80 h-[50px]', 'named widths and heights are replaced too');
  eq(set('flex items-start', { 'align-items': 'center' }), 'flex items-center');
  eq(set('flex bg-[#fff]', { 'background-color': '#123456' }), 'bg-[#123456] flex');
  eq(set('flex w-[10px]', { width: null }), 'flex', 'null removes the property');
  eq(set('flex', { 'font-family': '"Inter", sans-serif' }), 'flex [font-family:"Inter",_sans-serif]', 'no utility: an arbitrary-property class');
  eq(set('[font-family:serif] flex', { 'font-family': 'monospace' }), 'flex [font-family:monospace]', 'arbitrary-property classes are replaced too');
});

test('padding and margin merge their sides instead of overwriting blindly', () => {
  eq(set('flex', { padding: '16px' }), 'flex p-4');
  eq(set('p-4', { 'padding-top': '8px' }), 'pb-4 pl-4 pr-4 pt-2');
  eq(set('px-2 py-4', { 'padding-left': '1px' }), 'pb-4 pl-[1px] pr-2 pt-4');
  eq(set('p-[10px]', { padding: '4px 8px' }), 'px-2 py-1');
  eq(set('mt-[5px] flex', { 'margin-top': null }), 'flex');
  assert.equal(set('m-2 p-2', { margin: '0 auto' }).includes('p-2'), true, 'padding is untouched by a margin change');
});

test('values and properties are validated', () => {
  assert.throws(() => applyStyles('', { 'width': 'a;b' }), { code: 'INVALID_PATCH' });
  assert.throws(() => applyStyles('', { 'Wid th': '1px' }), { code: 'INVALID_PATCH' });
  assert.throws(() => applyStyles('', []), { code: 'INVALID_PATCH' });
  assert.throws(() => applyStyles('', { padding: 'huge' }), { code: 'INVALID_PATCH' });
});

test('every class the transpiler writes is recognised as the property it sets', () => {
  for (const [property, value] of [['display', 'flex'], ['width', '320px'], ['gap', '8px'], ['font-size', '14px'], ['color', '#112233'], ['background-color', '#112233'], ['border-radius', '12px'], ['line-height', '1.5'], ['font-weight', '600'], ['opacity', '0.5'], ['box-shadow', '0 1px 2px #000']]) {
    assert.equal(propertyOfClass(declarationClass(property, value)), property, `${property}: ${declarationClass(property, value)}`);
  }
});

test('a node patch with styles rewrites the element classes through the ordinary patch path', async () => {
  const { applyDocumentPatch, createDemoDocument } = await import('../../../core/lib/model.ts');
  const doc = createDemoDocument(), id = 'cta';
  const next = applyDocumentPatch(doc, { nodes: { [id]: { styles: { width: '320px', 'padding-left': '4px', 'font-family': 'Georgia, serif' } } } });
  const classes = next.nodes[id].className.split(' ');
  assert.ok(classes.includes('w-80') && classes.includes('pl-1') && classes.includes('[font-family:Georgia,_serif]'));
  assert.ok(!Object.hasOwn(next.nodes[id], 'styles'));
  assert.throws(() => applyDocumentPatch(doc, { nodes: { 'cta-text': { styles: { width: '1px' } } } }), /styles apply to an element/);
});

test('interactive edits use the spacing scale for whole multiples of 4px, arbitrary values otherwise', () => {
  const set = (cls, styles) => applyStyles(cls, styles).split(' ').sort().join(' ');
  assert.equal(set('', { gap: '12px' }), 'gap-3');
  assert.equal(set('', { gap: '10px' }), 'gap-[10px]');
  assert.equal(set('', { 'margin-bottom': '68px' }), 'mb-17');
  assert.equal(set('mb-14', { 'margin-bottom': '0px' }), 'mb-0');
  assert.equal(set('', { padding: '0' }), 'p-0');
});

test('interactive edits use Tailwind radius steps and replace named colour classes', () => {
  const set = (cls, styles) => applyStyles(cls, styles).split(' ').sort().join(' ');
  assert.equal(set('flex', { 'border-radius': '12px' }), 'flex rounded-xl');
  assert.equal(set('rounded-lg', { 'border-radius': '10px' }), 'rounded-[10px]');
  assert.equal(set('rounded-lg shadow', { 'border-radius': '9999px' }), 'rounded-full shadow');
  assert.equal(set('bg-white text-slate-700 p-2', { 'background-color': '#112233', color: '#ffffff' }), 'bg-[#112233] p-2 text-[color:#ffffff]');
  assert.equal(set('bg-blue-500/50 rounded', { 'background-color': null, 'border-radius': null }), '');
  assert.equal(propertyOfClass('text-center'), 'text-align', 'alignment is not a colour');
  assert.notEqual(propertyOfClass('bg-cover'), 'background-color', 'a background size is not a colour');
});

test('a project colour name is a colour class: bg-brand and text-paper are replaced, not left beside the new one', () => {
  const names = colourNames({ '--color-brand': '#112233', '--font-sans': 'Inter' }, { '--color-paper': '#f4efe6' });
  const set = (cls, styles) => applyStyles(cls, styles, { colourNames: names }).split(' ').sort().join(' ');
  assert.equal(set('bg-brand p-2', { 'background-color': '#445566' }), 'bg-[#445566] p-2');
  assert.equal(set('text-paper text-sm', { color: '#000' }), 'text-[color:#000] text-sm');
  assert.equal(set('bg-brand text-paper', { 'background-color': null, color: null }), '');
  // Only theme colours count, and a built-in utility keeps its own property.
  assert.equal(set('bg-cover', { 'background-color': '#445566' }), 'bg-[#445566] bg-cover');
  assert.equal(set('text-center', { color: '#000' }), 'text-[color:#000] text-center');
  assert.equal(propertyOfClass('bg-brand'), null, 'without the theme a bare name stays unknown');
  assert.equal(propertyOfClass('bg-brand', names), 'background-color');
});

test('declarations become Tailwind utilities, and anything without a utility an arbitrary-property class', () => {
  const c = (property, value, colorOf) => declarationClass(property, value, colorOf);
  assert.equal(c('display', 'flex'), 'flex');
  assert.equal(c('flex-direction', 'column'), 'flex-col');
  assert.equal(c('align-items', 'flex-end'), 'items-end');
  assert.equal(c('justify-content', 'space-between'), 'justify-between');
  assert.equal(c('width', '100%'), 'w-full');
  assert.equal(c('width', '320px'), 'w-[320px]');
  assert.equal(c('gap', '8px'), 'gap-[8px]');
  assert.equal(c('padding', '16px'), 'p-[16px]');
  assert.equal(c('padding', '8px 16px'), 'py-[8px] px-[16px]');
  assert.equal(c('padding', '1px 2px 3px 4px'), 'pt-[1px] pr-[2px] pb-[3px] pl-[4px]');
  assert.equal(c('font-size', '14px'), 'text-[length:14px]');
  assert.equal(c('border-radius', '12px'), 'rounded-[12px]');
  assert.equal(c('background-color', '#15131E'), 'bg-[#15131E]');
  assert.equal(c('color', '#15131E', () => '--color-ink'), 'text-[color:var(--color-ink)]');
  assert.equal(c('font-family', '"Inter", system-ui, sans-serif'), '[font-family:"Inter",_system-ui,_sans-serif]');
  assert.equal(c('box-shadow', '0 1px 2px rgba(0,0,0,.2)'), '[box-shadow:0_1px_2px_rgba(0,0,0,.2)]');
  assert.equal(c('content', '"a_b"'), '[content:"a\\_b"]', 'a literal underscore is escaped');
});
