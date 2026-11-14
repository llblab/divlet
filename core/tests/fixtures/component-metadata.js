// Metadata patches are recursive records, atomic arrays/scalars and null deletions; strings remain opaque data.
import { componentTextProject, expandComponentProject } from './component-text.js';

function sample(ref, entries, { scalarBase = false } = {}) {
  const source = componentTextProject(ref, Object.fromEntries(entries));
  const nodes = source.frames[0].nodes;
  nodes.button.metadata = { retained: true, x: { lower: 1 } };
  nodes.button.className = 'definition'; nodes.button.attrs = { title: 'untouched' }; nodes.button.style = { color: 'red' };
  if (nodes.nested) nodes.nested.descendants.button.metadata = { x: scalarBase ? false : { lower: 2 }, layer: 'lower' };
  if (nodes.pair) for (const id of ['first', 'second']) nodes[id].metadata = { slot: id };
  return source;
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : value;
function expanded(api, input) {
  const result = expandComponentProject(api, input);
  // Metadata record order is not meaning. Preserve array order, primitive values and every other expansion field.
  for (const node of Object.values(result.document.nodes)) node.metadata = canonical(node.metadata);
  return result;
}
const conflict = (name, first, second, ref = 'wrapper') => [false, true].map(reverse => ({
  name: `${name}, ${reverse ? 'reversed' : 'forward'}`, error: 'INVALID_OVERRIDE', run: api => {
    const addresses = ref === 'outer' ? ['middle/nested', 'middle/nested/button'] : ['nested', 'nested/button'];
    const entries = addresses.map((address, index) => [address, { metadata: index ? second : first }]);
    return expanded(api, sample(ref, reverse ? entries.reverse() : entries));
  },
}));
const stable = (name, entries, expected, { ref = 'wrapper', ...options } = {}) => ({ name, expected, run: api => {
  const forward = expanded(api, sample(ref, entries, options)), backward = expanded(api, sample(ref, [...entries].reverse(), options));
  if (JSON.stringify(forward) !== JSON.stringify(backward)) throw new Error('Metadata peer order changed expanded values, identity or provenance');
  return ref === 'pair' ? ['instance:first', 'instance:second'].map(id => forward.document.nodes[id].metadata) : forward.document.nodes['instance:nested'].metadata;
} });
const base = { retained: true, layer: 'lower', x: { lower: 2 } };
export const componentMetadataCases = [
  ...conflict('metadata scalar peers conflict', { x: 1 }, { x: 2 }),
  ...conflict('metadata delete versus descendant edit conflicts', { x: null }, { x: { leaf: 'value' } }),
  ...conflict('metadata scalar replacement versus descendant edit conflicts', { x: false }, { x: { leaf: 'value' } }),
  ...conflict('metadata array replacement versus descendant edit conflicts', { x: [] }, { x: { leaf: 'value' } }),
  ...conflict('metadata delete versus empty object merge conflicts', { x: null }, { x: {} }),
  ...conflict('metadata nested leaf peers conflict', { x: { leaf: 'one' } }, { x: { leaf: 'two' } }),
  ...conflict('metadata strings retain opaque line endings', { x: 'same\r\nvalue' }, { x: 'same\nvalue' }),
  ...conflict('current metadata equality retains signed-zero distinction', { x: 0 }, { x: -0 }),
  ...conflict('metadata array order remains authored data', { x: [1, 2] }, { x: [2, 1] }),
  ...conflict('deep metadata aliases share the same destination', { x: 'one' }, { x: 'two' }, 'outer'),
  stable('identical nullable metadata operations coalesce', [['nested', { metadata: { x: null } }], ['nested/button', { metadata: { x: null } }]], { retained: true, layer: 'lower' }),
  stable('equal metadata strings retain opaque CRLF data', [['nested', { metadata: { x: 'opaque\r\nvalue' } }], ['nested/button', { metadata: { x: 'opaque\r\nvalue' } }]], { ...base, x: 'opaque\r\nvalue' }),
  stable('equal metadata signed zeros are not normalized by this planner', [['nested', { metadata: { x: -0 } }], ['nested/button', { metadata: { x: -0 } }]], { ...base, x: -0 }),
  stable('disjoint nested metadata leaves compose above the lower layer', [['nested', { metadata: { x: { a: 1 } } }], ['nested/button', { metadata: { x: { b: 2 } } }]], { ...base, x: { lower: 2, a: 1, b: 2 } }),
  stable('empty object merges coexist with descendant edits', [['nested', { metadata: { x: {} } }], ['nested/button', { metadata: { x: { leaf: true } } }]], { ...base, x: { lower: 2, leaf: true } }),
  stable('object merges coerce a lower-layer scalar without becoming peer replacement', [['nested', { metadata: { x: {} } }], ['nested/button', { metadata: { x: { leaf: true } } }]], { ...base, x: { leaf: true } }, { scalarBase: true }),
  stable('equal atomic arrays compare object keys but preserve null members and order', [['nested', { metadata: { x: [{ a: 1, b: [null, false, ''] }] } }], ['nested/button', { metadata: { x: [{ b: [null, false, ''], a: 1 }] } }]], { ...base, x: [{ a: 1, b: [null, false, ''] }] }),
  stable('equal false zero and empty string writes stay explicit', [['nested', { metadata: { x: { false: false, zero: 0, empty: '' } } }], ['nested/button', { metadata: { x: { empty: '', zero: 0, false: false } } }]], { ...base, x: { lower: 2, false: false, zero: 0, empty: '' } }),
  stable('literal punctuation and empty metadata keys are not flattened paths', [['nested', { metadata: { 'x.leaf': 1, '': { 'a/b': true } } }], ['nested/button', { metadata: { x: { leaf: 2 }, '/': 'literal' } }]], { ...base, x: { lower: 2, leaf: 2 }, 'x.leaf': 1, '': { 'a/b': true }, '/': 'literal' }),
  stable('different occurrences may author different metadata', [['first', { metadata: { value: 'one' } }], ['second', { metadata: { value: 'two' } }]], [{ slot: 'first', value: 'one' }, { slot: 'second', value: 'two' }], { ref: 'pair' }),
  { name: 'element and text-child metadata remain different destinations beside text peers', expected: { element: { ...base, owner: 'element' }, text: { retained: true, owner: 'text' }, value: 'Equal' }, run: api => {
    const result = expanded(api, sample('wrapper', [['nested', { text: 'Equal', metadata: { owner: 'element' } }], ['nested/label', { content: 'Equal', metadata: { owner: 'text' } }]]));
    return { element: result.document.nodes['instance:nested'].metadata, text: result.document.nodes['instance:nested:label'].metadata, value: result.document.nodes['instance:nested:label'].content };
  } },
  { name: 'top-level null metadata is not a universal override reset', error: 'INVALID_DOCUMENT', run: api => expanded(api, sample('wrapper', [['nested', { metadata: null }]])) },
  { name: 'unsupported metadata values are rejected before deletion or coalescence', error: 'INVALID_DOCUMENT', run: api => expanded(api, sample('wrapper', [['nested', { metadata: { x: undefined } }], ['nested/button', { metadata: { x: null } }]])) },
];
