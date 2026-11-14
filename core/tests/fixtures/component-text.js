// Portable text-override witnesses: shared admission/expansion results, not a second component implementation.
const element = (id, tag, children = [], extra = {}) => ({ id, type: 'element', tag, children, ...extra });
const frame = (id, nodes) => ({ schemaVersion: 1, id, name: id, version: 1, artboard: { x: 0, y: 0, width: 300, height: 200 }, rootId: 'root', nodes });

export function componentTextProject(ref, descendants, { empty = false } = {}) {
  const nodes = { root: element('root', 'main', ['button']), button: element('button', 'button', empty ? [] : ['label'], { reusable: true }) };
  if (!empty) nodes.label = { id: 'label', type: 'text', content: 'Definition', metadata: { retained: true } };
  if (ref === 'wrapper' || ref === 'outer') {
    nodes.root.children.push('wrapper');
    nodes.wrapper = element('wrapper', 'section', ['nested'], { reusable: true });
    nodes.nested = { id: 'nested', type: 'ref', ref: 'button', ...(empty ? {} : { descendants: { button: { text: 'Lower layer' } } }) };
  }
  if (ref === 'outer') {
    nodes.root.children.push('outer');
    nodes.outer = element('outer', 'section', ['middle'], { reusable: true });
    nodes.middle = { id: 'middle', type: 'ref', ref: 'wrapper' };
  }
  if (ref === 'pair') {
    nodes.root.children.push('pair');
    nodes.pair = element('pair', 'section', ['first', 'second'], { reusable: true });
    nodes.first = element('first', 'span'); nodes.second = element('second', 'span');
  }
  return { schemaVersion: 1, frames: [frame('definitions', nodes), frame('consumer', {
    root: element('root', 'main', ['instance']), instance: { id: 'instance', type: 'ref', ref: `definitions/${ref}`, descendants, metadata: { literal: null } },
  })] };
}

function expansion(api, input) {
  const before = JSON.stringify(input);
  try {
    const project = api.readProject(input), lookup = new Map(project.frames.map(frame => [frame.id, frame]));
    const expanded = api.expandFrame(project.frames[1], id => lookup.get(id), project.settings);
    return { document: expanded.document, parts: [...expanded.parts], uses: expanded.uses, instances: expanded.instances };
  } finally { if (JSON.stringify(input) !== before) throw new Error('Component text admission mutated its input'); }
}
const conflicting = (name, ref, entries, options) => [false, true].map(reverse => ({
  name: `${name}, ${reverse ? 'reversed' : 'forward'}`, error: 'INVALID_OVERRIDE',
  run: api => expansion(api, componentTextProject(ref, Object.fromEntries(reverse ? [...entries].reverse() : entries), options)),
}));
const stable = (name, ref, entries, expected, options) => ({ name, expected, run: api => {
  const forward = expansion(api, componentTextProject(ref, Object.fromEntries(entries), options));
  const backward = expansion(api, componentTextProject(ref, Object.fromEntries([...entries].reverse()), options));
  if (JSON.stringify(forward) !== JSON.stringify(backward)) throw new Error('Peer text order changed expanded identity, content or provenance');
  const textNodes = Object.values(forward.document.nodes).filter(node => node.type === 'text');
  return { text: textNodes.map(node => node.content), addresses: textNodes.map(node => forward.parts.find(([id]) => id === node.id)?.[1].address), metadata: textNodes.map(node => node.metadata), literal: forward.document.nodes.instance.metadata.literal };
} });

export const componentTextCases = [
  ...conflicting('element text versus its child content', 'button', [['button', { text: 'Parent' }], ['label', { content: 'Child' }]]),
  ...conflicting('nested root aliases target one text destination', 'wrapper', [['nested', { text: 'One' }], ['nested/button', { text: 'Two' }]]),
  ...conflicting('nested element text versus child content', 'wrapper', [['nested', { text: 'Parent' }], ['nested/label', { content: 'Child' }]]),
  ...conflicting('empty nested aliases conflict before generating text', 'wrapper', [['nested', { text: 'One' }], ['nested/button', { text: 'Two' }]], { empty: true }),
  stable('identical normalized text/content coalesces', 'button', [['button', { text: 'Equal\r\ntext' }], ['label', { content: 'Equal\ntext', metadata: { peer: true } }]], { text: ['Equal\ntext'], addresses: ['label'], metadata: [{ retained: true, peer: true }], literal: null }),
  stable('outer text layer replaces lower text and coalesces aliases', 'wrapper', [['nested', { text: 'Upper' }], ['nested/button', { text: 'Upper' }]], { text: ['Upper'], addresses: ['nested/label'], metadata: [{ retained: true }], literal: null }),
  stable('deep aliases preserve canonical child paths', 'outer', [['middle/nested', { text: 'Deep' }], ['middle/nested/button', { text: 'Deep' }]], { text: ['Deep'], addresses: ['middle/nested/label'], metadata: [{ retained: true }], literal: null }),
  stable('empty aliases generate one text part', 'wrapper', [['nested', { text: 'Empty' }], ['nested/button', { text: 'Empty' }]], { text: ['Empty'], addresses: ['nested#t1'], metadata: [{}], literal: null }, { empty: true }),
  stable('independent empty texts have order-independent identities', 'pair', [['first', { text: 'One' }], ['second', { text: 'Two' }]], { text: ['One', 'Two'], addresses: ['first#t1', 'second#t1'], metadata: [{}, {}], literal: null }),
];
