/*
 * Tailwind for frames. Every frame is styled with Tailwind utilities, compiled locally for
 * exactly the classes it uses. Tokens in Tailwind theme namespaces (--color-*, --font-*,
 * --breakpoint-* …) become the theme, so `--color-paper` gives `bg-paper`, `text-paper`, …
 * The same design system explains classes (their CSS) and suggests them on the board.
 */
import { compile, __unstable__loadDesignSystem as loadDesignSystem } from '@tailwindcss/node';
import valueParser from 'postcss-value-parser';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { themeOf } from './theme.ts';
import { customClasses, explainWith, unknownWith, catalogOf, suggestWith } from './design-tools.js';
export { themeOf };
const CACHE_SIZE = 16;
const cache = new Map();

function slot(tokens, base) {
  const theme = themeOf(tokens);
  const key = JSON.stringify([base, theme]);
  let item = cache.get(key);
  if (item) { cache.delete(key); cache.set(key, item); return item; }
  const source = `@import "tailwindcss";\n${theme}`;
  item = {
    source, compiled: new Map(),
    design: loadDesignSystem(source, { base }),
    classes: null,
  };
  // A theme that does not compile must not poison a newer cache slot.
  item.design.catch(() => { if (cache.get(key) === item) cache.delete(key); });
  cache.set(key, item);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return item;
}

/** Compiled CSS (preflight, theme and utilities) for the classes a frame uses. */
export async function compileClasses(tokens, candidates, base) {
  try {
    const item = slot(tokens, base), classes = [...new Set(candidates)].sort(), key = JSON.stringify(classes);
    let result = item.compiled.get(key);
    if (!result) {
      // Tailwind build() is incremental: never share a compiler across different candidate sets.
      result = compile(item.source, { base, onDependency() {} }).then(compiler => compiler.build(classes));
      item.compiled.set(key, result);
      result.catch(() => { if (item.compiled.get(key) === result) item.compiled.delete(key); });
      while (item.compiled.size > CACHE_SIZE) item.compiled.delete(item.compiled.keys().next().value);
    }
    return await result;
  }
  catch (error) { throw Object.assign(new Error(`Tailwind theme from tokens does not compile: ${error.message}`), { code: 'INVALID_TOKENS' }); }
}

// Direct numeric var() consumers only; custom-property pipelines and resource contexts are separate proofs.
const numericLengthProperties = new Set('width height min-width min-height max-width max-height flex-basis top right bottom left inset inset-block inset-inline inset-block-start inset-block-end inset-inline-start inset-inline-end padding padding-top padding-right padding-bottom padding-left padding-block padding-inline padding-block-start padding-block-end padding-inline-start padding-inline-end margin margin-top margin-right margin-bottom margin-left margin-block margin-inline margin-block-start margin-block-end margin-inline-start margin-inline-end gap row-gap column-gap border-width border-top-width border-right-width border-bottom-width border-left-width border-radius border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius outline-width outline-offset font-size letter-spacing text-indent'.split(' '));
const numericUnitlessProperties = new Set('opacity flex-grow flex-shrink order z-index font-weight line-height'.split(' '));

/** Copy-only Tailwind source rewrites; compiler AST and class order are proof, not persisted data. */
export async function createClassResourceMapper({ tokens = {}, numericTokens = {}, rewriteValue, onRename, onNumericReference = () => {}, onVariableDefinition = () => {} }) {
  const refuse = () => { throw Object.assign(new Error('Class resources require a proven literal or direct numeric value, unchanged compiler semantics and uncaptured owner-local context.'), { code: 'COPY_UNSUPPORTED_RESOURCE' }); };
  const compiler = call => { try { return call(); } catch { refuse(); } };
  const design = await loadDesignSystem(`@import "tailwindcss";\n${themeOf(tokens)}`, { base: fileURLToPath(new URL('../../', import.meta.url)) }).catch(refuse);
  const cache = new Map();
  let work = 0;
  const charge = value => { if ((work += Buffer.byteLength(value)) > 64 * 1024 * 1024) refuse(); };
  async function rewriteNode(node) {
    // Per-owner cascade proof cannot authorize utilities that restyle other owners/descendants.
    if (node.kind === 'rule' && node.selector !== '.divlet-resource' && (!node.selector.startsWith('&') || /[\s,>+~]/.test(node.selector))) refuse();
    if (node.kind === 'declaration' && typeof node.value === 'string') node.value = await rewriteValue(node.value, false);
    for (const child of node.nodes || []) await rewriteNode(child);
  }
  function numericReference(value) {
    const nodes = valueParser(value).nodes;
    if (nodes.length !== 1 || nodes[0].type !== 'function' || nodes[0].value !== 'var' || nodes[0].unclosed) return null;
    const args = nodes[0].nodes.filter(node => node.type !== 'space');
    return args.length === 1 && args[0].type === 'word' && Object.hasOwn(numericTokens, args[0].value) && Object.hasOwn(tokens, args[0].value) ? args[0].value : null;
  }
  async function numericCandidate(own, value) {
    if (!numericReference(value)) return false;
    const ast = compiler(() => design.compileAstNodes({ ...own, raw: 'divlet-resource' }));
    if (!ast.length) refuse(); charge(JSON.stringify(ast));
    const used = new Set();
    async function visit(node) {
      if (node.kind === 'rule' && node.selector !== '.divlet-resource' && (!node.selector.startsWith('&') || /[\s,>+~]/.test(node.selector))) refuse();
      if (node.kind === 'declaration' && typeof node.value === 'string') {
        const name = numericReference(node.value);
        if (name) {
          if (!(numericLengthProperties.has(node.property) && numericTokens[name] === 'px' || numericUnitlessProperties.has(node.property) && numericTokens[name] === '')) refuse();
          used.add(name);
        } else if (await rewriteValue(node.value, true) !== node.value) refuse();
      }
      for (const child of node.nodes || []) await visit(child);
    }
    for (const item of ast) await visit(item.node);
    if (!used.size) refuse();
    for (const name of used) onNumericReference(name);
    return true;
  }
  async function candidate(raw) {
    if (cache.has(raw)) return cache.get(raw);
    charge(raw);
    if (!/[()\\\\]|--/.test(raw)) { cache.set(raw, raw); return raw; }
    const parsed = compiler(() => [...design.parseCandidate(raw)]);
    if (!parsed.length) { cache.set(raw, raw); return raw; }
    if (parsed.length !== 1) refuse();
    const own = parsed[0];
    if (own.kind === 'arbitrary' && own.property.startsWith('--')) onVariableDefinition(own.property);
    if (own.variants.some(variant => variant.kind !== 'static' && !(variant.kind === 'functional' && variant.value?.kind === 'named'))) refuse();
    const value = own.kind === 'arbitrary' ? own.value : own.kind === 'functional' && own.value?.kind === 'arbitrary' ? own.value.value : null;
    if (value === null) refuse();
    if (await numericCandidate(own, value)) { cache.set(raw, raw); return raw; }
    const rewritten = await rewriteValue(value, true);
    if (rewritten === value) { cache.set(raw, raw); return raw; }
    const next = structuredClone(own);
    if (next.kind === 'arbitrary') next.value = rewritten;
    else next.value.value = rewritten;
    const name = compiler(() => design.printCandidate(next)), roundTrip = compiler(() => [...design.parseCandidate(name)]);
    if (/\s/.test(name) || roundTrip.length !== 1) refuse();
    const expected = structuredClone(compiler(() => design.compileAstNodes({ ...own, raw: 'divlet-resource' })));
    const actual = compiler(() => design.compileAstNodes({ ...roundTrip[0], raw: 'divlet-resource' }));
    if (!expected.length || !actual.length) refuse();
    for (const item of expected) await rewriteNode(item.node);
    charge(JSON.stringify(expected)); charge(JSON.stringify(actual));
    if (!isDeepStrictEqual(expected, actual)) refuse();
    onRename(raw, name);
    cache.set(raw, name);
    return name;
  }
  return async className => {
    charge(className);
    const parts = className.split(/(\s+)/), before = [...new Set(parts.filter(part => part && !/^\s+$/.test(part)))];
    for (let index = 0; index < parts.length; index++) if (parts[index] && !/^\s+$/.test(parts[index])) parts[index] = await candidate(parts[index]);
    const after = before.map(name => cache.get(name));
    if (new Set(after).size !== before.length) refuse();
    const order = names => {
      const positions = new Map(names.map((name, index) => [name, index]));
      return compiler(() => design.getClassOrder(names)).map(([name, rank]) => [positions.get(name), rank]).filter(([, rank]) => rank !== null).sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0).map(([index]) => index);
    };
    if (before.some((name, index) => name !== after[index]) && !isDeepStrictEqual(order(before), order(after))) refuse();
    return parts.join('');
  };
}


export { customClasses };

/* ---- explaining and suggesting: the shared tools over a Node-loaded design system ---------------- */

export async function explainClasses({ tokens, css, names, base }) {
  return explainWith(await slot(tokens, base).design, { css, names });
}

export async function unknownClasses({ tokens, css, byNode, base }) {
  if (!Object.values(byNode).some(value => value.split(/\s+/).some(Boolean))) return {};
  return unknownWith(await slot(tokens, base).design, { css, byNode });
}

async function catalog(tokens, base) {
  const item = slot(tokens, base);
  item.classes ??= item.design.then(catalogOf);
  return item.classes;
}

/** Build the class list for suggestions ahead of the first keystroke. */
export function warmSuggestions(tokens, base) {
  catalog(tokens, base).catch(() => {});
}

export async function suggestClasses({ tokens, query, used = [], limit = 10, base }) {
  return suggestWith(await catalog(tokens, base), { query, used, limit });
}
