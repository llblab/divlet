import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompiler } from '../lib/compiler.ts';
import { themeOf } from '../lib/theme.ts';
import { themeOf as legacyTheme } from '../lib/styling.js';
import draft from '../index.js';
import { rendererSource } from '../lib/identity.ts';
import { fileURLToPath } from 'node:url';

const styles = rendererSource().stylesheets;
const BASE = fileURLToPath(new URL('../lib/', import.meta.url));
const rows: Array<{ name: string; tokens: Record<string, string>; candidates: string[] }> = [
  { name: 'new arbitrary, responsive and state utilities', tokens: { '--color-brand': '#123456' }, candidates: ['p-[37px]', 'md:p-[41px]', 'text-brand', 'data-[state=on]:opacity-25'] },
  { name: 'no candidates', tokens: {}, candidates: [] },
  { name: 'deduplicated literal candidates', tokens: {}, candidates: ['p-4', 'block', 'p-4', 'unknown-divlet-candidate'] },
  { name: 'spacing and ordinary variables', tokens: { '--spacing': '2px', '--app-gap': '7px' }, candidates: ['p-4', 'gap-3'] },
  { name: 'important theme values remain excluded', tokens: { '--color-brand': '#ff0000!important' }, candidates: ['text-brand'] },
];
for (const row of rows) test(`portable compiler matches selected legacy Node output for ${row.name} (finite probe, not identity)`, async () => {
  const compile = createCompiler(styles), tokens = Object.freeze(row.tokens), candidates = Object.freeze(row.candidates), before = JSON.stringify(row);
  const actual = await compile(tokens, candidates), expected = await draft.compileClasses(tokens, [...candidates], BASE);
  assert.equal(actual, expected);
  assert.equal(JSON.stringify(row), before);
});

test('Node and browser compilation share one unchanged token-theme interpreter', () => {
  assert.equal(legacyTheme, themeOf);
  assert.equal(themeOf({ '--color-brand': '#123456', '--app-gap': '7px', '--spacing': '2px', '--color-muted': '#000!important' }), '@theme {\n  --color-brand: #123456;\n  --spacing: 2px;\n}\n');
});

test('browser compiler captures stylesheet bytes and isolates repeat/concurrent candidate and token sets', async () => {
  const mutable = { ...styles }, compile = createCompiler(mutable);
  mutable['index.css'] = 'invalid source after capture';
  const [first, second] = await Promise.all([
    compile({ '--color-brand': '#123456' }, ['p-[37px]', 'text-brand']),
    compile({ '--color-brand': '#abcdef' }, ['p-[19px]', 'text-brand']),
  ]);
  assert.ok(first.includes('37px') && !first.includes('19px'));
  assert.ok(second.includes('19px') && !second.includes('37px'));
  assert.ok(first.includes('#123456') && !first.includes('#abcdef'));
  assert.ok(second.includes('#abcdef') && !second.includes('#123456'));
  assert.equal(await compile({ '--color-brand': '#123456' }, ['text-brand', 'p-[37px]']), first);
});

const refusals: Array<readonly [string, string, string]> = [
  ['unbundled imports', '@import "https://unrequested.invalid/source.css";', 'TAILWIND_COMPILER_STYLESHEET_UNAVAILABLE'],
  ['escaped imports', String.raw`@\69mport "https://unrequested.invalid/source.css";`, 'TAILWIND_COMPILER_STYLESHEET_UNAVAILABLE'],
  ['relative imports', '@import "../unrequested.css";', 'TAILWIND_COMPILER_STYLESHEET_UNAVAILABLE'],
  ['JavaScript plugins', '@plugin "unrequested-plugin";', 'TAILWIND_COMPILER_MODULE_UNAVAILABLE'],
  ['JavaScript config', '@config "./unrequested.config.js";', 'TAILWIND_COMPILER_MODULE_UNAVAILABLE'],
  ['source scanning', '@source "./unrequested/**/*";', 'TAILWIND_COMPILER_SOURCE_UNSUPPORTED'],
  ['inline source declarations', '@source inline("p-[37px]");', 'TAILWIND_COMPILER_SOURCE_UNSUPPORTED'],
];
for (const [name, source, code] of refusals) test(`browser compiler refuses ${name} instead of fetching/loading or pretending to scan`, async () => {
  await assert.rejects(async () => createCompiler({ ...styles, 'index.css': source })({}, ['block']), { code });
});

test('browser compiler keeps import-looking quoted data inert and never interprets source-map comments', async () => {
  const compile = createCompiler({ ...styles, 'index.css': `/*!# sourceMappingURL=data:application/json;base64,not-a-map */\n.probe::before{content:'@import "https://unrequested.invalid/literal.css";'}\n${styles['index.css']}` });
  const css = await compile({}, ['block']);
  assert.ok(css.includes('unrequested.invalid/literal.css'));
});

test('browser compiler diagnoses a missing bundled stylesheet before compilation', () => {
  // @ts-expect-error Composition must supply the complete four-file graph.
  assert.throws(() => createCompiler({ 'index.css': '' }), { code: 'TAILWIND_COMPILER_STYLESHEET_UNAVAILABLE' });
});
