import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument, applyDocumentPatch, inspectDocument, createDemoDocument, DivletError } from '../lib/model.ts';

function sample() {
  return { schemaVersion: 1, id: 'test', name: 'A test', version: 1, artboard: { x: 0, y: 0, width: 390, height: 844 }, rootId: 'root', nodes: { root: { id: 'root', type: 'element', tag: 'main', children: ['label'] }, label: { id: 'label', type: 'text', content: 'Hello' } } };
}

test('Canonical document normalizes defaults, attribute names and rendered newlines without mutating input', () => {
  const input = sample();
  input.nodes.root.attrs = { TITLE: 'One\r\nTwo' };
  input.nodes.label.content = 'One\rTwo';
  const before = structuredClone(input);
  const doc = validateDocument(input);
  assert.deepEqual(input, before);
  assert.equal(doc.nodes.root.attrs.title, 'One\nTwo');
  assert.equal(doc.nodes.label.content, 'One\nTwo');
  assert.deepEqual(doc.nodes.root.style, {});
  assert.deepEqual(doc.tokens, {});
  assert.deepEqual(validateDocument(doc), doc);
});

test('Final-state patch can move a child and add a node atomically', () => {
  const doc = validateDocument(sample());
  const next = applyDocumentPatch(doc, { nodes: { root: { children: ['group'] }, group: { id: 'group', type: 'element', tag: 'section', children: ['label'], metadata: { intent: 'Group the greeting' } }, label: { content: 'Changed' } } });
  assert.deepEqual(next.nodes.root.children, ['group']);
  assert.deepEqual(next.nodes.group.children, ['label']);
  assert.equal(next.nodes.label.content, 'Changed');
  assert.equal(doc.nodes.label.content, 'Hello');
  assert.equal(next.version, doc.version);
});

test('Patch merge preserves absent fields, replaces arrays and removes null properties', () => {
  let doc = validateDocument(sample());
  doc = applyDocumentPatch(doc, { nodes: { root: { attrs: { title: 'Original', 'aria-label': 'Greeting' }, style: { padding: '12px', color: 'red' }, metadata: { nested: { a: 1, b: 2 } } } } });
  const next = applyDocumentPatch(doc, { nodes: { root: { attrs: { title: null }, style: { color: null }, metadata: { nested: { a: null, c: 3 } } } } });
  assert.deepEqual(next.nodes.root.attrs, { 'aria-label': 'Greeting' });
  assert.deepEqual(next.nodes.root.style, { padding: '12px' });
  assert.deepEqual(next.nodes.root.metadata, { nested: { b: 2, c: 3 } });
  const removed = applyDocumentPatch(next, { nodes: { label: null, root: { children: [] } } });
  assert.equal(removed.nodes.label, undefined);
});

test('Invalid candidate leaves original state untouched', () => {
  const doc = validateDocument(sample());
  const before = structuredClone(doc);
  assert.throws(() => applyDocumentPatch(doc, { nodes: { label: null } }), DivletError);
  assert.deepEqual(doc, before);
  assert.throws(() => applyDocumentPatch(doc, { id: 'another' }), /Unsupported patch/);
  assert.throws(() => applyDocumentPatch(doc, JSON.parse('{"nodes":{"__proto__":{"polluted":true}}}')), /Unsafe property/);
  assert.equal({}.polluted, undefined);
});

test('Reject malformed identity, graphs, unsupported fields and executable content', () => {
  const cases = [
    doc => { delete doc.id; },
    doc => { doc.nodes.root.id = 'other'; },
    doc => { doc.nodes.root.children = ['missing']; },
    doc => { doc.nodes.root.children = ['root']; },
    doc => { doc.nodes.root.children = ['label', 'label']; },
    doc => { doc.nodes.orphan = { id: 'orphan', type: 'text', content: '' }; },
    doc => { doc.rootId = 'label'; },
    doc => { doc.nodes.root.tag = 'script'; },
    doc => { doc.nodes.root.attrs = { onclick: 'evil()' }; },
    doc => { doc.nodes.root.attrs = { href: 'java\nscript:evil()' }; },
    doc => { doc.nodes.root.attrs = { title: 'a', TITLE: 'b' }; },
    doc => { doc.nodes.root.style = { padding: 12 }; },
    doc => { doc.nodes.root.style = { color: 'red;background:blue' }; },
    doc => { doc.nodes.root.style = { color: 'red;}' }; },
    doc => { doc.nodes.root.style = { color: 'red;}body{display:none}x{color:blue' }; },
    doc => { doc.tokens = { '--color-brand': 'red;}body{display:none}x{--another:blue' }; },
    doc => { doc.nodes.label.content = 'A\0B'; },
    doc => { doc.nodes.label.content = '\ud800'; },
    doc => { doc.css = '@plugin "./evil.js";'; },
    doc => { doc.css = '@import "https://example.test/a.css";'; },
    doc => { doc.css = 'p { color: red'; },
    doc => { doc.nodes.root.unknown = true; },
    doc => { doc.artboard.width = Infinity; }
  ];
  for (const mutate of cases) {
    const doc = sample();
    mutate(doc);
    assert.throws(() => validateDocument(doc), DivletError, mutate.toString());
  }
});

test('SVG filter tags remain confined to SVG and reject executable attributes', () => {
  for (const tag of ['filter', 'feGaussianBlur']) {
    const outside = sample();
    outside.nodes.root.tag = tag;
    assert.throws(() => validateDocument(outside), /must be inside svg/);
    const inside = sample();
    inside.nodes.root.tag = 'svg';
    inside.nodes.root.children = ['effect'];
    delete inside.nodes.label;
    inside.nodes.effect = { id: 'effect', type: 'element', tag, attrs: { onload: 'evil()' }, children: [] };
    assert.throws(() => validateDocument(inside), /Unsupported attribute onload/);
  }
});

test('Content model rejects browser-repaired paragraph and list trees', () => {
  for (const tags of [['p', 'span', 'div'], ['ul', 'li', 'li']]) {
    const doc = sample();
    doc.nodes = Object.fromEntries(tags.map((tag, index) => [`node-${index}`, { id: `node-${index}`, type: 'element', tag, children: index + 1 < tags.length ? [`node-${index + 1}`] : [] }]));
    doc.rootId = 'node-0';
    assert.throws(() => validateDocument(doc), DivletError);
  }
});

test('Inspection returns bounded contextual nodes and preserves design metadata', () => {
  const doc = createDemoDocument();
  const found = inspectDocument(doc, { query: 'primary-action', depth: 1, limit: 5 });
  assert.equal(found.nodes[0].id, 'cta');
  assert.equal(found.nodes[0].metadata.purpose, 'primary-action');
  assert.deepEqual(found.nodes[0].ancestors, ['root', 'hero']);
  assert.equal(found.nodes[0].childNodes[0].content, 'Start exploring  ↗');
  const rootOnly = inspectDocument(doc, { depth: 0 });
  assert.equal(rootOnly.nodes.length, 1);
  assert.equal(rootOnly.nodes[0].childNodes, undefined);
  assert.throws(() => inspectDocument(doc, { ids: ['missing'] }), /Unknown node/);
  assert.throws(() => inspectDocument(doc, { limit: 201 }), /limit/);
});
