import test from 'node:test';
import assert from 'node:assert/strict';
import { styleAliasOverlay } from '../../scripts/style-transition-audit.mjs';

const source = `import type { CssDeclaration, CssDeclarationOperation } from './declarations.ts';
export type Style = Record<string, string>;
export type StyleOverrides = Record<string, string | null>;
export const example = { style: { color: 'red' }, note: 'Record<string, string>' };
`;

test('the diagnostic overlay changes only the two draft alias type spans', () => {
  const result = styleAliasOverlay(source);
  assert.equal(result.text, source.replace('Style = Record<string, string>', 'Style = CssDeclaration[]').replace('StyleOverrides = Record<string, string | null>', 'StyleOverrides = CssDeclarationOperation[]'));
  assert.deepEqual(result.aliases.map(({ name }) => name), ['Style', 'StyleOverrides']);
  assert.equal(result.text.split('\n').length, source.split('\n').length, 'diagnostic line locations stay meaningful');
  assert.ok(source.includes('Style = Record<string, string>'), 'the source input is unchanged');
});

test('stale or already-cut-over aliases refuse instead of silently manufacturing an audit', () => {
  for (const input of [source.replace('Style = Record<string, string>', 'Style = CssDeclaration[]'), source.replace('StyleOverrides =', 'OtherOverrides ='), source + 'type Style = Record<string, string>;']) {
    assert.throws(() => styleAliasOverlay(input), /retire or rebase this diagnostic probe explicitly/);
  }
});
