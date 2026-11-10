import test from 'node:test';
import assert from 'node:assert/strict';
import { declarationClass, convertPen } from '../lib/convert.js';

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

test('conversion covers every native node kind and leaves no PEN-specific carrier behind', () => {
  const source = { version: '2.21', children: [
    { id: 'f', type: 'frame', name: 'Frame', width: 200, height: 100, fill: '#ffffff', cornerRadius: 8, children: [
      { id: 'r', type: 'rectangle', width: 10, height: 10, fill: '#ff0000' },
      { id: 'e', type: 'ellipse', width: 10, height: 10, fill: '#00ff00' },
      { id: 't', type: 'text', content: 'Hello', fontSize: 12 },
    ] },
  ] };
  const { text, stats } = convertPen(source, { name: 'x' });
  const project = JSON.parse(text);
  assert.equal(stats.frames, 1);
  assert.equal(project.frames.length, 1);
  assert.ok(!text.includes('data-pen-'), 'no data-pen attributes');
  assert.ok(stats.utilities > 0);
});

test('instances that differ from their component only by overrides stay instances with overrides', () => {
  const source = { version: '2.21', children: [
    { id: 'card', type: 'frame', name: 'Card', reusable: true, x: 0, y: 0, width: 200, height: 80, fill: '#ffffff', children: [{ id: 'label', type: 'text', content: 'Title', fontSize: 14, fill: '#000000' }] },
    { id: 'page', type: 'frame', name: 'Page', x: 300, y: 0, width: 400, height: 300, layout: 'vertical', children: [
      { id: 'one', type: 'ref', ref: 'card' },
      { id: 'two', type: 'ref', ref: 'card', descendants: { label: { content: 'Second' } } },
    ] },
  ] };
  const { text, stats } = convertPen(source, { name: 'x' });
  const project = JSON.parse(text), page = project.frames.find(frame => frame.name === 'Page'), card = project.frames.find(frame => frame.name === 'Card');
  const refs = Object.values(page.nodes).filter(node => node.type === 'ref');
  assert.equal(refs.length, 2); assert.equal(stats.instances, 2);
  assert.ok(Object.values(card.nodes).some(node => node.reusable === true));
  const label = Object.values(card.nodes).find(node => node.type === 'text');
  assert.deepEqual(refs.map(ref => ref.descendants).sort((a, b) => Object.keys(a).length - Object.keys(b).length), [{}, { [label.id]: { content: 'Second' } }]);
});

test('variables stay live: colour, length, number and font variables become tokens referenced with var()', () => {
  const source = { version: '2.21',
    variables: { 'ink': { type: 'color', value: '#112233' }, 'space/2': { type: 'number', value: 8 }, 'line/body': { type: 'number', value: 1.5 }, 'font/family': { type: 'string', value: 'Inter' }, 'weight/bold': { type: 'string', value: '700' } },
    children: [{ id: 'f', type: 'frame', name: 'Frame', width: 200, height: 100, gap: '$space/2', padding: '$space/2', fill: '$ink', layout: 'vertical', children: [
      { id: 't', type: 'text', content: 'Hi', fontSize: 14, lineHeight: '$line/body', fontFamily: '$font/family', fontWeight: '$weight/bold', fill: '$ink' },
    ] }] };
  const { text } = convertPen(source, { name: 'x' });
  const project = JSON.parse(text);
  assert.equal(project.tokens['--space-2'], '8px');
  assert.equal(project.tokens['--line-body'], '1.5');
  assert.equal(project.tokens['--weight-bold'], '700');
  assert.equal(project.tokens['--font-family'], '"Inter",system-ui,sans-serif');
  assert.equal(project.tokens['--color-ink'], '#112233');
  const classes = Object.values(project.frames[0].nodes).map(node => node.className || '').join(' ');
  for (const reference of ['var(--space-2)', 'var(--line-body)', 'var(--weight-bold)', 'var(--font-family)', 'var(--color-ink)']) assert.ok(classes.includes(reference), reference);
  assert.ok(!classes.includes('[8px]') && !classes.includes('#112233'), 'no literal copy of a variable value');
});

test('nested instances stay instances: an instance of a component that contains instances is linked, with overrides addressed through the nested one', async () => {
  const { readProject } = await import('../../../core/lib/project.ts');
  const { expandFrame } = await import('../../../core/lib/project.ts');
  const source = { version: '2.21', children: [
    { id: 'btn', type: 'frame', name: 'Button', reusable: true, x: 0, y: 0, width: 80, height: 30, fill: '#112233', children: [{ id: 'btn-label', type: 'text', content: 'Go', fontSize: 12 }] },
    { id: 'card', type: 'frame', name: 'Card', reusable: true, x: 200, y: 0, width: 200, height: 100, layout: 'vertical', children: [
      { id: 'card-title', type: 'text', content: 'Title', fontSize: 14 },
      { id: 'card-btn', type: 'ref', ref: 'btn', descendants: { 'btn-label': { content: 'Open' } } },
    ] },
    { id: 'page', type: 'frame', name: 'Page', x: 0, y: 300, width: 500, height: 200, layout: 'vertical', children: [
      { id: 'one', type: 'ref', ref: 'card' },
      { id: 'two', type: 'ref', ref: 'card', descendants: { 'card-title': { content: 'Second' }, 'card-btn/btn-label': { content: 'Buy' } } },
    ] },
  ] };
  const { text, stats } = convertPen(source, { name: 'nested' });
  assert.ok(stats.instances >= 3, `instances linked: ${stats.instances}`);
  const { settings, frames } = readProject(JSON.parse(text));
  const page = frames.find(frame => frame.name === 'Page');
  const refs = Object.values(page.nodes).filter(node => node.type === 'ref');
  assert.equal(refs.length, 2, 'both card instances stay instances');
  assert.ok(Object.keys(refs.find(node => Object.keys(node.descendants).length).descendants).some(key => key.includes('/')), 'an override reaches through the nested instance');
  const lookup = new Map(frames.map(frame => [frame.id, frame]));
  const { document } = expandFrame(page, id => lookup.get(id), settings);
  const texts = Object.values(document.nodes).filter(node => node.type === 'text').map(node => node.content);
  assert.deepEqual(texts, ['Title', 'Open', 'Second', 'Buy']);
});
