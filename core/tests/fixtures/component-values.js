// Literal tag/class peers reuse the same component graph and expansion admission as the text witnesses.
import { componentTextProject, expandComponentProject } from './component-text.js';

function sample(ref, entries) {
  const source = componentTextProject(ref, Object.fromEntries(entries));
  const nodes = source.frames[0].nodes;
  nodes.button.className = 'definition';
  if (nodes.nested) nodes.nested.descendants.button = { text: 'Lower layer', tag: 'span', className: 'lower' };
  return source;
}
const conflict = (name, entries, ref = 'wrapper') => [false, true].map(reverse => ({
  name: `${name}, ${reverse ? 'reversed' : 'forward'}`, error: 'INVALID_OVERRIDE',
  run: api => expandComponentProject(api, sample(ref, reverse ? [...entries].reverse() : entries)),
}));
const stable = (name, entries, expected, ref = 'wrapper') => ({ name, expected, run: api => {
  const forward = expandComponentProject(api, sample(ref, entries));
  const backward = expandComponentProject(api, sample(ref, [...entries].reverse()));
  if (JSON.stringify(forward) !== JSON.stringify(backward)) throw new Error('Literal alias order changed expanded content, identity or provenance');
  const nodes = ref === 'pair' ? ['instance:first', 'instance:second'] : [ref === 'outer' ? 'instance:middle:nested' : 'instance:nested'];
  return nodes.map(id => {
    const node = forward.document.nodes[id];
    return { tag: node.tag, className: node.className, text: node.children.map(child => forward.document.nodes[child].content) };
  });
} });

export const componentValueCases = [
  ...conflict('aliased tag conflicts', [['nested', { tag: 'div' }], ['nested/button', { tag: 'p' }]]),
  ...conflict('aliased className conflicts', [['nested', { className: 'one' }], ['nested/button', { className: 'two' }]]),
  ...conflict('class spelling remains literal rather than token-sorted', [['nested', { className: 'a b' }], ['nested/button', { className: 'b a' }]]),
  ...conflict('deep scalar aliases conflict', [['middle/nested', { className: 'one' }], ['middle/nested/button', { className: 'two' }]], 'outer'),
  stable('identical normalized scalar peers coalesce above the lower layer', [['nested', { tag: 'div', className: 'same\r\nclasses' }], ['nested/button', { className: 'same\nclasses', tag: 'div' }]], [{ tag: 'div', className: 'same\nclasses', text: ['Lower layer'] }]),
  stable('empty class strings remain explicit literal replacements', [['nested', { className: '' }], ['nested/button', { className: '' }]], [{ tag: 'span', className: '', text: ['Lower layer'] }]),
  stable('disjoint scalar fields compose through aliases', [['nested', { tag: 'div' }], ['nested/button', { className: 'upper' }]], [{ tag: 'div', className: 'upper', text: ['Lower layer'] }]),
  stable('deep equal scalar aliases preserve the same occurrence', [['middle/nested', { tag: 'div', className: 'upper' }], ['middle/nested/button', { tag: 'div', className: 'upper' }]], [{ tag: 'div', className: 'upper', text: ['Lower layer'] }], 'outer'),
  stable('different occurrences may author different literals beside text edits', [['first', { tag: 'i', className: 'one', text: 'One' }], ['second', { tag: 'b', className: 'two', text: 'Two' }]], [{ tag: 'i', className: 'one', text: ['One'] }, { tag: 'b', className: 'two', text: ['Two'] }], 'pair'),
  { name: 'text parts still refuse element scalar fields', error: 'INVALID_OVERRIDE', run: api => expandComponentProject(api, sample('wrapper', [['nested/label', { tag: 'span', className: 'invalid-target' }]])) },
  { name: 'forbidden tags remain refused before expansion', error: 'INVALID_DOCUMENT', run: api => expandComponentProject(api, sample('wrapper', [['nested', { tag: 'script' }]])) },
];
