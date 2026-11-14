// DOM IDs are document-scoped rendered strings, not native node IDs or instance addresses.
const element = (id, tag, children = [], attrs = {}, extra = {}) => ({ id, type: 'element', tag, children, attrs, ...extra });
const frame = (id, nodes, rootId = 'root') => ({ schemaVersion: 1, id, name: id, version: 1, artboard: { x: 0, y: 0, width: 300, height: 200 }, rootId, nodes });

export function domReferenceProject(kind, { unique = false } = {}) {
  let nodes, descendants;
  if (kind === 'svg') {
    nodes = {
      root: element('root', 'svg', ['defs', 'use', 'sample'], {}, { reusable: true }),
      defs: element('defs', 'defs', ['shape', 'paint', 'clip']),
      shape: element('shape', 'path', [], { id: 'shape', d: 'M0 0h4v4H0z' }),
      paint: element('paint', 'linearGradient', ['stop'], { id: 'paint' }),
      stop: element('stop', 'stop', [], { offset: '0', 'stop-color': 'red' }),
      clip: element('clip', 'clipPath', ['clip-shape'], { id: 'clip' }),
      'clip-shape': element('clip-shape', 'rect', [], { width: '4', height: '4' }),
      use: element('use', 'use', [], { href: '#shape' }),
      sample: element('sample', 'rect', [], { width: '4', height: '4', fill: 'url(#paint)', 'clip-path': 'url(#clip)' }),
    };
    descendants = Object.fromEntries(['shape', 'paint', 'clip'].map(id => [id, { attrs: { id: `${id}-2` } }]));
    descendants.use = { attrs: { href: '#shape-2' } };
    descendants.sample = { attrs: { fill: 'url(#paint-2)', 'clip-path': 'url(#clip-2)' } };
  } else {
    nodes = {
      root: element('root', 'section', ['target', 'help', 'referrer'], {}, { reusable: true }),
      target: element('target', 'input', [], { id: 'field' }),
      help: element('help', 'span', [], { id: 'help' }),
      referrer: element('referrer', kind === 'for' ? 'label' : 'button', [], kind === 'for' ? { for: 'field' } : { 'aria-labelledby': 'field help', 'aria-describedby': 'help' }),
    };
    descendants = { target: { attrs: { id: 'field-2' } }, help: { attrs: { id: 'help-2' } }, referrer: { attrs: kind === 'for' ? { for: 'field-2' } : { 'aria-labelledby': 'field-2 help-2', 'aria-describedby': 'help-2' } } };
  }
  return { schemaVersion: 1, frames: [frame('definitions', nodes), frame('consumer', {
    root: element('root', 'main', ['first', 'second']),
    first: { id: 'first', type: 'ref', ref: 'definitions/root' },
    second: { id: 'second', type: 'ref', ref: 'definitions/root', ...(unique ? { descendants } : {}) },
  })] };
}
export function expandDomProject(api, input, target = 'consumer') {
  const before = JSON.stringify(input);
  try {
    const project = api.readProject(input), lookup = new Map(project.frames.map(frame => [frame.id, frame]));
    return api.expandFrame(lookup.get(target), id => lookup.get(id), project.settings);
  } finally { if (JSON.stringify(input) !== before) throw new Error('DOM ID admission mutated the source fixture'); }
}
function native(ids, { reverse = false, upper = false } = {}) {
  const entries = ids.map((value, index) => [`node${index}`, element(`node${index}`, 'span', [], { [upper && index === 0 ? 'ID' : 'id']: value })]);
  return { schemaVersion: 1, frames: [frame('consumer', { root: element('root', 'main', entries.map(([id]) => id)), ...Object.fromEntries(reverse ? entries.reverse() : entries) })] };
}
const invalid = (name, source) => ({ name, error: 'INVALID_DOCUMENT', run: api => expandDomProject(api, source()) });
export const domIdCases = [
  ...[false, true].map(reverse => invalid(`duplicate authored DOM IDs, ${reverse ? 'reverse node map' : 'forward node map'}`, () => native(['same', 'same'], { reverse }))),
  invalid('HTML attribute names normalize before DOM ID uniqueness', () => native(['same', 'same'], { upper: true })),
  invalid('rendered attribute line endings normalize before uniqueness', () => native(['same\r\nid', 'same\nid'])),
  invalid('whitespace-only nonempty DOM IDs are still checked', () => native([' ', ' '])),
  invalid('prototype-shaped DOM ID values have no map privilege', () => native(['__proto__', '__proto__'])),
  ...['for', 'aria', 'svg'].map(kind => invalid(`${kind} references do not authorize duplicated instance DOM IDs`, () => domReferenceProject(kind))),
  { name: 'empty DOM IDs remain allowed and authored', expected: ['', ''], run: api => Object.values(expandDomProject(api, native(['', ''])).document.nodes).filter(node => node.type === 'element' && Object.hasOwn(node.attrs, 'id')).map(node => node.attrs.id) },
  { name: 'DOM ID values remain case-sensitive and Unicode-opaque', expected: ['Case', 'case', 'é', 'e\u0301', '__proto__', 'constructor'], run: api => Object.values(expandDomProject(api, native(['Case', 'case', 'é', 'e\u0301', '__proto__', 'constructor'])).document.nodes).filter(node => node.type === 'element' && Object.hasOwn(node.attrs, 'id')).map(node => node.attrs.id) },
  { name: 'native node IDs do not reserve DOM IDs', expected: 'node1', run: api => expandDomProject(api, native(['node1', 'other'])).document.nodes.node0.attrs.id },
  ...['for', 'aria', 'svg'].map(kind => ({ name: `explicit unique ${kind} instance IDs and references retain authored spelling`, expected: kind === 'svg' ? [['shape', 'paint', 'clip', '#shape', 'url(#paint)', 'url(#clip)'], ['shape-2', 'paint-2', 'clip-2', '#shape-2', 'url(#paint-2)', 'url(#clip-2)']] : kind === 'for' ? [['field', 'help', 'field'], ['field-2', 'help-2', 'field-2']] : [['field', 'help', 'field help', 'help'], ['field-2', 'help-2', 'field-2 help-2', 'help-2']], run: api => {
    const expanded = expandDomProject(api, domReferenceProject(kind, { unique: true }));
    const nodes = expanded.document.nodes;
    for (const name of ['first', 'second']) {
      const key = `${name}:${kind === 'svg' ? 'shape' : 'target'}`;
      const part = expanded.parts.get(key);
      if (part?.instance !== name || part.address !== (kind === 'svg' ? 'shape' : 'target')) throw new Error('DOM admission changed instance provenance');
    }
    return ['first', 'second'].map(name => kind === 'svg' ? ['shape', 'paint', 'clip'].map(id => nodes[`${name}:${id}`].attrs.id).concat(nodes[`${name}:use`].attrs.href, nodes[`${name}:sample`].attrs.fill, nodes[`${name}:sample`].attrs['clip-path']) : [nodes[`${name}:target`].attrs.id, nodes[`${name}:help`].attrs.id, ...Object.values(nodes[`${name}:referrer`].attrs)]);
  } })),
  { name: 'references are not silently rebased when an author changes only an ID', expected: ['field-2', 'field'], run: api => {
    const source = domReferenceProject('for', { unique: true });
    delete source.frames[1].nodes.second.descendants.referrer;
    const nodes = expandDomProject(api, source).document.nodes;
    return [nodes['second:target'].attrs.id, nodes['second:referrer'].attrs.for];
  } },
  { name: 'the same DOM IDs in independent frames are allowed', expected: ['same', 'same'], run: api => {
    const source = native(['same']);
    source.frames.push({ ...structuredClone(source.frames[0]), id: 'other', name: 'other' });
    const project = api.readProject(source);
    return project.frames.map(frame => frame.nodes.node0.attrs.id);
  } },
];
