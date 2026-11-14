import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDeclarationOperations, serializeDeclarations } from '../lib/declarations.ts';
import { merge, validStyle, validDeclarations, validateDocument, DivletError } from '../lib/model.ts';

test('inline serialization retains declaration order, repeated fallbacks and values', () => {
  const declarations = [['display', '-webkit-box'], ['display', 'flex'], ['padding-left', '20px'], ['padding', '10px'], ['color', 'var(--Accent) !important']];
  assert.equal(serializeDeclarations(declarations), 'display:-webkit-box;display:flex;padding-left:20px;padding:10px;color:var(--Accent) !important');
  assert.equal(serializeDeclarations(declarations, true), 'display: -webkit-box; display: flex; padding-left: 20px; padding: 10px; color: var(--Accent) !important');
  assert.notEqual(serializeDeclarations(declarations), serializeDeclarations([...declarations].reverse()));
  assert.equal(serializeDeclarations([]), '');
});

test('set replaces every match at the first position while retaining other declaration order', () => {
  const source = [['display', '-webkit-box'], ['color', 'red'], ['display', 'flex'], ['padding', '10px']];
  assert.deepEqual(applyDeclarationOperations(source, [['display', 'grid']]), [['display', 'grid'], ['color', 'red'], ['padding', '10px']]);
  assert.deepEqual(applyDeclarationOperations(source, [['color', 'blue'], ['margin', '0']]), [['display', '-webkit-box'], ['color', 'blue'], ['display', 'flex'], ['padding', '10px'], ['margin', '0']]);
});

test('remove deletes every match and remove-then-set explicitly moves a property', () => {
  const source = [['padding-left', '20px'], ['padding', '10px'], ['padding-left', '30px']];
  assert.deepEqual(applyDeclarationOperations(source, [['padding-left', null]]), [['padding', '10px']]);
  assert.deepEqual(applyDeclarationOperations(source, [['padding-left', null], ['padding-left', '16px']]), [['padding', '10px'], ['padding-left', '16px']]);
  assert.deepEqual(applyDeclarationOperations(source, [['absent', null]]), source);
});

test('ordinary property matching ignores case while custom properties retain it', () => {
  const source = [['COLOR', 'red'], ['color', 'blue'], ['--Accent', 'gold'], ['--accent', 'black']];
  assert.deepEqual(applyDeclarationOperations(source, [['Color', 'green'], ['--accent', null]]), [['Color', 'green'], ['--Accent', 'gold']]);
});

test('declaration operations neither mutate nor alias their inputs', () => {
  const source = Object.freeze([Object.freeze(['color', 'red']), Object.freeze(['color', 'blue'])]);
  const operations = Object.freeze([Object.freeze(['padding', '10px'])]);
  const unchanged = applyDeclarationOperations(source, []);
  const changed = applyDeclarationOperations(source, operations);
  unchanged[0][1] = 'black';
  changed[2][1] = '20px';
  assert.deepEqual(source, [['color', 'red'], ['color', 'blue']]);
  assert.deepEqual(operations, [['padding', '10px']]);
});

test('CSS names are dictionary data, never object prototype properties', () => {
  const source = [['constructor', 'a'], ['__proto__', 'b'], ['prototype', 'c']];
  assert.deepEqual(applyDeclarationOperations(source, [['constructor', 'd'], ['__proto__', null]]), [['constructor', 'd'], ['prototype', 'c']]);
});

test('unique-property legacy maps retain their merge ordering under ordered operations', () => {
  const names = ['padding', 'padding-left', 'color', 'display', '--Accent', '--accent'];
  for (let seed = 0; seed < 64; seed++) {
    const source = Object.fromEntries(names.filter((_, index) => (seed + index) % 3 !== 0).map(name => [name, `old-${name}`]));
    const operations = Array.from({ length: 20 }, (_, index) => [names[(seed + index * 5) % names.length], (seed + index) % 4 === 0 ? null : `value-${index}`]);
    let expected = source;
    for (const [property, value] of operations) expected = merge(expected, { [property]: value });
    assert.deepEqual(applyDeclarationOperations(Object.entries(source), operations), Object.entries(expected));
    assert.equal(serializeDeclarations(Object.entries(source)), Object.entries(source).map(([name, value]) => `${name}:${value}`).join(';'));
  }
});

test('long edit sequences retain slots without accumulating replaced declarations', () => {
  const source = Array.from({ length: 10000 }, (_, index) => [`property-${index}`, `${index}`]);
  const operations = Array.from({ length: 10000 }, (_, index) => [`property-${index}`, `new-${index}`]);
  const result = applyDeclarationOperations(source, operations);
  assert.equal(result.length, source.length);
  assert.deepEqual(result[0], ['property-0', 'new-0']);
  assert.deepEqual(result.at(-1), ['property-9999', 'new-9999']);
});

test('ordered CSS admission preserves fallbacks, declaration order and source isolation', () => {
  const input = Object.freeze([['display', '-webkit-box'], ['display', 'flex'], ['padding-left', '20px'], ['padding', '10px'], ['--Accent', 'one\r\ntwo'], ['color', 'red !important']].map(Object.freeze));
  const result = validDeclarations(input, 'root');
  assert.deepEqual(result, [['display', '-webkit-box'], ['display', 'flex'], ['padding-left', '20px'], ['padding', '10px'], ['--Accent', 'one\ntwo'], ['color', 'red !important']]);
  result[0][1] = 'grid';
  assert.equal(input[0][1], '-webkit-box');
  assert.deepEqual(validDeclarations(undefined, 'root'), []);
  assert.deepEqual(validDeclarations(null, 'root'), []);
  assert.deepEqual(validDeclarations([], 'root'), []);
});

test('ordered CSS admission distinguishes literal values from nullable override operations', () => {
  const operations = [['padding-left', null], ['padding-left', '16px'], ['color', 'red !important']];
  assert.deepEqual(validDeclarations(operations, 'instance', true), operations);
  assert.throws(() => validDeclarations(operations, 'root'), { code: 'INVALID_DOCUMENT' });
  for (const input of [{}, 'color:red', 0, [null], [['color']], [['color', 'red', 'extra']], [[1, 'red']], [['color', undefined]], [['color', 1]], Array(1), [Object.assign(['color', 'red'], { extra: true })], Object.assign([['color', 'red']], { extra: true })]) {
    assert.throws(() => validDeclarations(input, 'root'), error => error instanceof DivletError && error.code === 'INVALID_DOCUMENT');
  }
});

test('ordered CSS admission shares legacy declaration safety, normalization and value bounds', () => {
  for (const style of [{}, { padding: ' 4px ', color: 'red !important' }, { '--Accent': 'one\r\ntwo' }]) {
    assert.deepEqual(validDeclarations(Object.entries(style), 'root'), Object.entries(validStyle(style, 'root')));
  }
  assert.deepEqual(validDeclarations([['color', null]], 'root', true), Object.entries(validStyle({ color: null }, 'root', true)));
  for (const [property, value] of [['bad property', 'red'], ['color', 'red;background:blue'], ['color', 'red;}body{display:none}x{color:blue'], ['color', '</style>'], ['color', 'expression(evil())'], ['background', 'url(javascript:evil())'], ['color', '\0'], ['color', '\ud800'], ['--x', 'a'.repeat(16385)]]) {
    assert.throws(() => validDeclarations([[property, value]], 'root'), error => error instanceof DivletError);
    assert.throws(() => validStyle({ [property]: value }, 'root'), error => error instanceof DivletError);
  }
  assert.equal(validDeclarations([['--x', 'a'.repeat(16384)]], 'root')[0][1].length, 16384);
});

test('ordered CSS helpers do not silently activate a new draft wire profile', () => {
  const frame = { schemaVersion: 1, id: 'ordered', name: 'Ordered', version: 1, artboard: { x: 0, y: 0, width: 100, height: 100 }, rootId: 'root', nodes: { root: { id: 'root', type: 'element', tag: 'main', children: [], style: { color: 'red' } } } };
  assert.equal(validateDocument(frame).nodes.root.style.color, 'red');
  const ordered = validDeclarations(Object.entries(frame.nodes.root.style), 'root');
  assert.throws(() => validateDocument({ ...frame, nodes: { root: { ...frame.nodes.root, style: ordered } } }), { code: 'INVALID_DOCUMENT' });
});
