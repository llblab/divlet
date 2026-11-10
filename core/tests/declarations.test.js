import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDeclarationOperations, serializeDeclarations } from '../lib/declarations.ts';
import { merge } from '../lib/model.ts';

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
