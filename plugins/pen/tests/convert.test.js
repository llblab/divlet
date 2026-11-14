import test from 'node:test';
import assert from 'node:assert/strict';
import { convertPen } from '../lib/convert.js';
import postcss from 'postcss';
import { styleEngine, setStyleEngines } from '../../../core/lib/engine.ts';
import { cssAnnotationCases } from '../../../core/tests/fixtures/css-annotations.js';

const original = styleEngine();
test.before(() => setStyleEngines([]));
test.after(() => setStyleEngines([original]));
const declarationsFor = (project, node) => postcss.parse(project.css, { map: false }).nodes.find(rule => rule.selector === `[data-import-style="${node.attrs['data-import-style']}"]`).nodes.map(item => [item.prop, item.value]);

test('projected CSS keeps source-map-looking font names as literal data without an engine', () => {
  for (const { name, comment, literal } of cssAnnotationCases) {
    const { text } = convertPen({ version: '2.21', children: [{ id: 'label', type: 'text', content: 'Literal', fontFamily: comment }] });
    const project = JSON.parse(text), frame = project.frames[0];
    const family = declarationsFor(project, frame.nodes[frame.rootId]).find(([property]) => property === 'font-family');
    assert.equal(family[1], `${literal},system-ui,sans-serif`, name);
  }
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
  assert.ok(stats.declarations > 0);
  assert.equal(stats.utilities, 0);
  assert.equal(stats.arbitrary, 0);
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
  for (const reference of ['var(--space-2)', 'var(--line-body)', 'var(--weight-bold)', 'var(--font-family)', 'var(--color-ink)']) assert.ok(project.css.includes(reference), reference);
  assert.ok(Object.values(project.frames[0].nodes).every(node => !node.className), 'no generated utility classes');
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

test('literal colours stay literal; only authored variable references become live CSS', () => {
  const source = { version: '2.21', variables: { ink: { type: 'color', value: '#112233' } }, children: [{ id: 'f', type: 'frame', width: 200, height: 100, children: [
    { id: 'literal', name: 'Literal', type: 'rectangle', width: 20, height: 20, fill: '#112233' },
    { id: 'variable', name: 'Variable', type: 'rectangle', x: 30, width: 20, height: 20, fill: '$ink' },
  ] }] };
  const before = structuredClone(source);
  const project = JSON.parse(convertPen(source).text);
  const node = name => Object.values(project.frames[0].nodes).find(node => node.metadata.name === name);
  assert.ok(declarationsFor(project, node('Literal')).some(([property, value]) => property === 'background-color' && value === '#112233'));
  assert.ok(declarationsFor(project, node('Variable')).some(([property, value]) => property === 'background-color' && value === 'var(--color-ink)'));
  assert.deepEqual(source, before);
});

test('native styling hooks avoid authored attributes and escaped CSS without changing classes or inline priority', () => {
  const source = { version: '2.21', variables: { ink: { type: 'color', value: '#112233' } }, divlet: { theme: { '--app-accent': '$ink' }, css: String.raw`[data-import-st\79 le-2]{opacity:.1}.paint{color:var(--app-accent)}` }, children: [{ id: 'f', type: 'frame', width: 100, height: 100, fill: '#eee', divlet: { className: 'paint', attrs: { 'data-import-style': 'authored' }, style: { 'padding-left': '3px !important' } } }] };
  const project = JSON.parse(convertPen(source).text), frame = project.frames[0], root = frame.nodes[frame.rootId];
  assert.equal(root.className, 'paint');
  assert.equal(root.attrs['data-import-style'], 'authored');
  assert.match(root.attrs['data-import-style-3'], /^[a-f0-9]{20}$/);
  assert.equal(root.style['padding-left'], '3px !important');
  assert.equal(project.tokens['--app-accent'], '#112233');
  assert.ok(project.css.endsWith(source.divlet.css), 'authored shared CSS follows every generated frame rule');
});

test('token namespace aliases are reused only for a proven identical variable', () => {
  const source = { version: '2.21', variables: { ink: { type: 'color', value: '#112233' }, other: { type: 'color', value: '#445566' } }, divlet: { theme: { '--color-ink': '$ink' } }, children: [{ id: 'f', type: 'frame', width: 100, height: 100, fill: '$ink' }] };
  assert.equal(JSON.parse(convertPen(source).text).tokens['--color-ink'], '#112233');
  source.divlet.theme['--color-ink'] = '$other';
  const before = structuredClone(source);
  assert.throws(() => convertPen(source), { code: 'UNSUPPORTED_PEN_RENDER' });
  assert.deepEqual(source, before);
});

test('projection-only CSS references refuse conversion rather than silently losing their target', () => {
  const source = { version: '2.21', divlet: { css: '[data-pen-style]{opacity:.5}' }, children: [{ id: 'f', type: 'frame', width: 100, height: 100 }] };
  const before = structuredClone(source);
  assert.throws(() => convertPen(source), { code: 'UNSUPPORTED_PEN_RENDER' });
  assert.deepEqual(source, before);
});
