// Attribute destinations use final native HTML/SVG scope; model admission still owns placement, duplicate and resource guards.
import { componentTextProject, expandComponentProject } from './component-text.js';

function sample(ref, entries, { svg = false, use = false, consumerSvg = svg } = {}) {
  const source = componentTextProject(ref, Object.fromEntries(entries), { empty: svg });
  const nodes = source.frames[0].nodes;
  nodes.button.attrs = { title: 'Definition', 'data-retain': 'keep' };
  if (nodes.nested) nodes.nested.descendants = { button: { ...(svg ? {} : { text: 'Lower layer' }), attrs: { title: 'Lower', 'data-layer': 'lower' } } };
  if (svg) {
    nodes.root.tag = 'svg'; nodes.button.tag = use ? 'use' : 'g';
    if (nodes.wrapper) nodes.wrapper.tag = 'g';
    if (nodes.outer) nodes.outer.tag = 'g';
  }
  source.frames[1].nodes.root.tag = consumerSvg ? 'svg' : 'main';
  if (use) nodes.button.attrs.href = 'asset:icon';
  // URL syntax/tag context only; resource byte/declaration closure belongs to writer/materialization witnesses.
  return source;
}
function expanded(api, input) {
  const result = expandComponentProject(api, input);
  // Attribute record order has no semantics; keep all values, other fields and provenance exact.
  for (const node of Object.values(result.document.nodes)) if (node.type === 'element') node.attrs = Object.fromEntries(Object.entries(node.attrs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return result;
}
const reversed = entries => [...entries].reverse().map(([address, override]) => [address, override.attrs ? { ...override, attrs: Object.fromEntries(Object.entries(override.attrs).reverse()) } : override]);
const conflict = (name, entries, ref = 'wrapper') => [false, true].map(reverse => ({
  name: `${name}, ${reverse ? 'reversed' : 'forward'}`, error: 'INVALID_OVERRIDE',
  run: api => expanded(api, sample(ref, reverse ? reversed(entries) : entries)),
}));
const stable = (name, entries, expected, { ref = 'wrapper', ...options } = {}) => ({ name, expected, run: api => {
  const forward = expanded(api, sample(ref, entries, options));
  const backward = expanded(api, sample(ref, reversed(entries), options));
  if (JSON.stringify(forward) !== JSON.stringify(backward)) throw new Error('Attribute peer order changed expanded values, identity or provenance');
  const read = id => ({ tag: forward.document.nodes[id].tag, attrs: forward.document.nodes[id].attrs });
  return ref === 'pair' ? ['instance:first', 'instance:second'].map(read) : read('instance:nested');
} });
const invalid = (name, entries, options) => ({ name, error: 'INVALID_DOCUMENT', run: api => expanded(api, sample('wrapper', entries, options)) });
const base = { 'data-retain': 'keep', 'data-layer': 'lower' };

export function attributeReferenceProject(svg = false) {
  if (svg) return sample('wrapper', [
    ['wrapper', { tag: 'svg', attrs: { viewBox: '0 0 24 32' } }],
    ['nested', { tag: 'rect', attrs: { x: '2', width: '3', height: '4' } }], ['nested/button', { attrs: { x: '2' } }],
  ], { svg: true, consumerSvg: false });
  const input = sample('wrapper', [
    ['nested', { attrs: { FOR: 'attribute-field', TITLE: 'Canonical' } }],
    ['nested/button', { tag: 'label', attrs: { for: 'attribute-field', title: 'Canonical' } }],
  ]);
  input.frames[1].nodes.root.children.push('field');
  input.frames[1].nodes.field = { id: 'field', type: 'element', tag: 'input', attrs: { id: 'attribute-field' } };
  return input;
}

export const componentAttributeCases = [
  ...conflict('attribute set/set peers conflict', [['nested', { attrs: { title: 'One' } }], ['nested/button', { attrs: { title: 'Two' } }]]),
  ...conflict('attribute set/delete peers conflict', [['nested', { attrs: { title: 'One' } }], ['nested/button', { attrs: { title: null } }]]),
  ...conflict('deep attribute aliases conflict', [['middle/nested', { attrs: { title: 'One' } }], ['middle/nested/button', { attrs: { title: 'Two' } }]], 'outer'),
  stable('normalized equal attribute values coalesce above lower layers', [['nested', { attrs: { title: 'Upper\r\nline' } }], ['nested/button', { attrs: { title: 'Upper\nline' } }]], { tag: 'button', attrs: { ...base, title: 'Upper\nline' } }),
  stable('equal null deletions remove the lower attribute once', [['nested', { attrs: { title: null } }], ['nested/button', { attrs: { title: null } }]], { tag: 'button', attrs: base }),
  stable('disjoint attribute names compose', [['nested', { attrs: { title: 'Upper' } }], ['nested/button', { attrs: { 'aria-label': 'Label' } }]], { tag: 'button', attrs: { ...base, title: 'Upper', 'aria-label': 'Label' } }),
  stable('different occurrences may set different values for the same attribute', [['first', { attrs: { title: 'One' } }], ['second', { attrs: { title: 'Two' } }]], [{ tag: 'span', attrs: { title: 'One' } }, { tag: 'span', attrs: { title: 'Two' } }], { ref: 'pair' }),
  stable('empty attribute values remain explicit strings', [['nested', { attrs: { title: '', 'data-kind': 'literal' } }], ['nested/button', { attrs: { 'data-kind': 'literal' } }]], { tag: 'button', attrs: { ...base, title: '', 'data-kind': 'literal' } }),
  stable('SVG case-sensitive names remain distinct', [['nested', { attrs: { viewBox: '0 0 10 10' } }], ['nested/button', { attrs: { viewbox: '0 0 20 20' } }]], { tag: 'g', attrs: { ...base, title: 'Lower', viewBox: '0 0 10 10', viewbox: '0 0 20 20' } }, { svg: true }),
  stable('resource href is checked against the final use tag', [['nested', { attrs: { href: 'asset:icon' } }], ['nested/button', { tag: 'use', attrs: { href: 'asset:icon' } }]], { tag: 'use', attrs: { ...base, title: 'Lower', href: 'asset:icon' } }, { svg: true }),
  stable('removing a resource href permits the final non-use tag', [['nested', { attrs: { href: null } }], ['nested/button', { tag: 'g' }]], { tag: 'g', attrs: { ...base, title: 'Lower' } }, { svg: true, use: true }),
  stable('equal HTML name aliases coalesce above lower layers', [['nested', { attrs: { TITLE: 'Upper\r\nline' } }], ['nested/button', { attrs: { title: 'Upper\nline' } }]], { tag: 'button', attrs: { ...base, title: 'Upper\nline' } }),
  ...conflict('HTML name aliases with different values conflict', [['nested', { attrs: { TITLE: 'One' } }], ['nested/button', { attrs: { title: 'Two' } }]]),
  ...conflict('HTML name aliases cannot set and delete', [['nested', { attrs: { TITLE: 'One' } }], ['nested/button', { attrs: { title: null } }]]),
  stable('HTML null aliases delete the lower canonical attribute', [['nested', { attrs: { TITLE: null } }], ['nested/button', { attrs: { title: null } }]], { tag: 'button', attrs: base }),
  stable('an uppercase HTML null alone removes a lower canonical attribute', [['nested', { attrs: { TITLE: null } }]], { tag: 'button', attrs: base }),
  stable('an uppercase HTML write replaces rather than duplicates a lower attribute', [['nested', { attrs: { TITLE: 'Upper' } }]], { tag: 'button', attrs: { ...base, title: 'Upper' } }),
  stable('equal HTML aliases within one attribute map coalesce', [['nested', { attrs: { TITLE: 'Upper', title: 'Upper' } }]], { tag: 'button', attrs: { ...base, title: 'Upper' } }),
  ...conflict('different HTML aliases within one attribute map conflict', [['nested', { attrs: { TITLE: 'One', title: 'Two' } }]]),
  stable('consumer SVG scope retains case after a final g retag', [['wrapper', { tag: 'g' }], ['nested', { attrs: { TITLE: 'One' } }], ['nested/button', { tag: 'g', attrs: { title: 'Two' } }]], { tag: 'g', attrs: { ...base, TITLE: 'One', title: 'Two' } }, { consumerSvg: true }),
  stable('a final svg root retag establishes descendant SVG scope', [['wrapper', { tag: 'svg' }], ['nested', { attrs: { TITLE: 'One' } }], ['nested/button', { tag: 'g', attrs: { title: 'Two' } }]], { tag: 'g', attrs: { ...base, TITLE: 'One', title: 'Two' } }),
  stable('final HTML retags fold names from a source SVG component', [['wrapper', { tag: 'div' }], ['nested', { attrs: { TITLE: 'Upper' } }], ['nested/button', { tag: 'button', attrs: { title: 'Upper' } }]], { tag: 'button', attrs: { ...base, title: 'Upper' } }, { svg: true, consumerSvg: false }),
  { name: 'native authored HTML duplicates still refuse before override planning', error: 'INVALID_DOCUMENT', run: api => {
    const input = sample('wrapper', []); input.frames[0].nodes.button.attrs = { TITLE: 'Equal', title: 'Equal' };
    return expanded(api, input);
  } },
  { name: 'untouched SVG attributes that collide after an HTML retag still refuse', error: 'INVALID_DOCUMENT', run: api => {
    const input = sample('wrapper', [['wrapper', { tag: 'div' }], ['nested', { tag: 'button' }]], { svg: true, consumerSvg: false });
    Object.assign(input.frames[0].nodes.button.attrs, { 'data-Name': 'One', 'data-name': 'Two' });
    return expanded(api, input);
  } },
  { name: 'lower-layer peers use the final consumer namespace rather than source scope', error: 'INVALID_OVERRIDE', run: api => {
    const input = sample('wrapper', [['wrapper', { tag: 'div' }], ['nested', { tag: 'button' }]], { svg: true, consumerSvg: false });
    input.frames[0].nodes.nested.descendants = { button: { attrs: { TITLE: 'One', title: 'Two' } } };
    return expanded(api, input);
  } },
  { name: 'an enclosing write cannot mask conflicting lower-layer HTML aliases', error: 'INVALID_OVERRIDE', run: api => {
    const input = sample('wrapper', [['wrapper', { tag: 'div' }], ['nested', { tag: 'button', attrs: { title: 'Upper' } }]], { svg: true, consumerSvg: false });
    input.frames[0].nodes.nested.descendants = { button: { attrs: { TITLE: 'One', title: 'Two' } } };
    return expanded(api, input);
  } },
  invalid('resource href cannot survive a final non-use tag', [['nested', { attrs: { href: 'asset:icon' } }], ['nested/button', { tag: 'g' }]], { svg: true, use: true }),
  invalid('an HTML alias cannot introduce a canonical unsafe JSON member', [['nested', { attrs: { Constructor: 'literal' } }]]),
  stable('SVG names do not inherit HTML unsafe-name case folding', [['nested', { attrs: { Constructor: 'literal' } }]], { tag: 'g', attrs: { ...base, title: 'Lower', Constructor: 'literal' } }, { svg: true }),
  invalid('unsafe JSON member names remain forbidden', [['nested', { attrs: { constructor: 'literal' } }]]),
  invalid('event handler attributes remain forbidden', [['nested', { attrs: { onclick: 'bad' } }]]),
  invalid('class attributes remain reserved for className', [['nested', { attrs: { class: 'bad' } }]]),
  invalid('executable URLs remain forbidden', [['nested', { attrs: { href: 'javascript:bad' } }]]),
  { name: 'text parts still refuse attribute overrides', error: 'INVALID_OVERRIDE', run: api => expanded(api, sample('wrapper', [['nested/label', { attrs: { title: 'bad-target' } }]])) },
];
