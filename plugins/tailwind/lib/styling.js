/*
 * Tailwind for frames. Every frame is styled with Tailwind utilities, compiled locally for
 * exactly the classes it uses. Tokens in Tailwind theme namespaces (--color-*, --font-*,
 * --breakpoint-* …) become the theme, so `--color-paper` gives `bg-paper`, `text-paper`, …
 * The same design system explains classes (their CSS) and suggests them on the board.
 */
import { compile, __unstable__loadDesignSystem as loadDesignSystem } from '@tailwindcss/node';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const THEME_TOKEN = /^--(color|font|text|tracking|leading|breakpoint|container|spacing|radius|shadow|inset-shadow|drop-shadow|blur|perspective|aspect|ease|animate|default)(-[\w-]+)?$/;
const MARKER = /^(group|peer)(\/[\w-]+)?$/;
const CACHE_SIZE = 16;
const cache = new Map();

/** The `@theme` block for tokens that belong to a Tailwind namespace (others stay plain CSS variables). */
export function themeOf(tokens = {}) {
  const lines = Object.entries(tokens).filter(([name, value]) => THEME_TOKEN.test(name) && !/!important\s*$/i.test(value)).map(([name, value]) => `  ${name}: ${value};`);
  return lines.length ? `@theme {\n${lines.join('\n')}\n}\n` : '';
}


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

/** Class names that a selector list mentions, e.g. `.card > .title:hover` → card, title. */
function classesInSelector(selector) {
  const out = new Set();
  for (const match of selector.matchAll(/\.((?:\\.|[\w-])+)/g)) out.add(match[1].replace(/\\(.)/g, '$1'));
  return out;
}

/** Rules of the custom CSS by the classes they mention (selector text and declarations, with their at-rule context). */
export function customClasses(css) {
  const out = new Map();
  let root;
  try { root = postcss.parse(css || '', { map: false }); } catch { return out; }
  root.walkRules(rule => {
    if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
    const context = [];
    for (let parent = rule.parent; parent && parent.type === 'atrule'; parent = parent.parent) context.unshift(`@${parent.name} ${parent.params}`.trim());
    const declarations = [];
    rule.each(child => { if (child.type === 'decl') declarations.push(`${child.prop}: ${child.value}${child.important ? ' !important' : ''}`); });
    for (const name of classesInSelector(rule.selector)) {
      if (!out.has(name)) out.set(name, []);
      out.get(name).push({ context, selector: rule.selector, declarations });
    }
  });
  return out;
}

/* ---- explaining utilities --------------------------------------------------- */

const round = value => Number(value.toFixed(4)).toString();

/** Make a declaration value readable: theme variables resolved, simple calc() folded. */
function readable(value, variables, design) {
  let out = value;
  for (let pass = 0; pass < 4 && out.includes('var('); pass++) {
    out = out.replace(/var\((--[\w-]+)(?:,\s*((?:[^()]|\([^()]*(?:\([^()]*\)[^()]*)*\))*))?\)/g, (whole, name, fallback) => {
      if (variables.has(name)) return variables.get(name);
      const themed = /^--tw-/.test(name) ? undefined : design.resolveThemeValue?.(name);
      if (themed !== undefined && themed !== null) return String(themed);
      if (fallback !== undefined) return fallback.trim();
      return whole;
    });
  }
  for (let pass = 0; pass < 4; pass++) {
    const before = out;
    out = out.replace(/calc\(\s*(-?[\d.]+)(rem|px|em|%)?\s*\*\s*(-?[\d.]+)(rem|px|em|%)?\s*\)/g, (whole, a, unitA, b, unitB) => {
      if (unitA && unitB) return whole;
      return `${round(Number(a) * Number(b))}${unitA || unitB || ''}`;
    });
    out = out.replace(/calc\(\s*(-?[\d.]+)\s*\/\s*(-?[\d.]+)\s*\)/g, (whole, a, b) => (Number(b) ? round(Number(a) / Number(b)) : whole));
    out = out.replace(/calc\(\s*(-?[\d.]+)(rem|px|em|%)?\s*([+-])\s*(-?[\d.]+)(rem|px|em|%)?\s*\)/g, (whole, a, unitA, sign, b, unitB) => {
      if ((unitA || '') !== (unitB || '') && Number(a) && Number(b)) return whole;
      return `${round(Number(a) + (sign === '-' ? -1 : 1) * Number(b))}${unitA || unitB || ''}`;
    });
    out = out.replace(/^0(rem|px|em|%)$/, '0');
    if (out === before) break;
  }
  return out;
}

/** Replace the utility's own class in a selector with `&` (it is escaped as CSS does: `.md\:p-4`, `.\32 xl\:p-2`). */
function ownClass(selector, name) {
  return selector.replace(/\.((?:\\[0-9a-f]{1,6} ?|\\.|[\w-])+)/gi, (whole, escaped) => {
    const plain = escaped.replace(/\\([0-9a-f]{1,6}) ?/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/\\(.)/g, '$1');
    return plain === name ? '&' : whole;
  });
}
const pxOf = value => (/^-?[\d.]+rem$/.test(value) ? ` /* ${round(Number.parseFloat(value) * 16)}px */` : '');

/** What a utility does, as short lines of CSS: context (media, state) first, then declarations. */
function explainUtility(name, css, design) {
  let root;
  try { root = postcss.parse(css, { map: false }); } catch { return [css.trim()]; }
  const initial = new Map();
  root.walkAtRules('property', rule => {
    rule.walkDecls('initial-value', declaration => initial.set(rule.params.trim(), declaration.value));
  });
  const lines = [];
  root.walkRules(rule => {
    if (rule.parent?.type === 'atrule' && rule.parent.name === 'property') return;
    const variables = new Map(initial);
    const own = [];
    rule.each(child => {
      if (child.type !== 'decl') return;
      if (child.prop.startsWith('--tw-')) variables.set(child.prop, child.value);
      else own.push(child);
    });
    if (!own.length) return;
    const context = [];
    for (let parent = rule.parent; parent && parent.type === 'atrule'; parent = parent.parent) context.unshift(`@${parent.name} ${parent.params}`.trim());
    const state = rule.selector.split(',').map(part => ownClass(part.trim(), name)).filter(part => part !== '&');
    if (state.length) context.push(state.join(', '));
    if (context.length) lines.push(context.join(' · '));
    for (const declaration of own) {
      const value = readable(declaration.value, variables, design).replace(/\s+/g, ' ').replace(/(0 0 #0000, )+/g, '');
      lines.push(`${context.length ? '  ' : ''}${declaration.prop}: ${value}${declaration.important ? ' !important' : ''}${pxOf(value)}`);
    }
  });
  root.walkAtRules(rule => {
    // Nested at-rules inside a rule (the `container` utility): show them as context lines.
    if (rule.parent?.type === 'rule') {
      const inner = [];
      rule.walkDecls(declaration => inner.push(`  ${declaration.prop}: ${readable(declaration.value, initial, design)}`));
      if (inner.length) lines.push(`@${rule.name} ${rule.params}`, ...inner);
    }
  });
  return lines.length ? lines : [css.trim()];
}

const COLOR_PROPS = /^(color|background-color|border(-[a-z]+)*-color|outline-color|text-decoration-color|fill|stroke|caret-color|accent-color|--tw-ring-color|--tw-shadow-color)$/;

/**
 * Explain classes for the board and the agent:
 * `utility` (Tailwind, with its CSS), `custom` (rules of the frame/project CSS), `marker`
 * (group, peer) or `unknown` (no effect: a typo, or a name with no rule).
 */
export async function explainClasses({ tokens, css, names, base }) {
  const design = await slot(tokens, base).design;
  const custom = customClasses(css);
  const list = [...new Set(names)].slice(0, 200);
  const compiled = design.candidatesToCss(list);
  const out = {};
  list.forEach((name, index) => {
    const own = custom.get(name);
    if (compiled[index]) {
      const lines = explainUtility(name, compiled[index], design);
      const swatch = colorOf(compiled[index], design);
      out[name] = { kind: 'utility', lines, ...(swatch ? { color: swatch } : {}), ...(own ? { custom: rulesText(own) } : {}) };
    } else if (own) out[name] = { kind: 'custom', lines: rulesText(own) };
    else if (MARKER.test(name)) out[name] = { kind: 'marker', lines: [`marks a ${name.split('/')[0]} for ${name.split('/')[0]}-* variants on other elements`] };
    else out[name] = { kind: 'unknown', lines: ['no Tailwind utility and no CSS rule — this class does nothing'] };
  });
  return out;
}

function rulesText(rules) {
  const lines = [];
  for (const rule of rules.slice(0, 6)) {
    const indent = rule.context.length ? '  ' : '';
    if (rule.context.length) lines.push(rule.context.join(' · '));
    lines.push(`${indent}${rule.selector} {`, ...rule.declarations.slice(0, 12).map(line => `${indent}  ${line};`), ...(rule.declarations.length > 12 ? [`${indent}  …`] : []), `${indent}}`);
  }
  if (rules.length > 6) lines.push(`… ${rules.length - 6} more rules`);
  return lines;
}

function colorOf(css, design) {
  let root;
  try { root = postcss.parse(css, { map: false }); } catch { return null; }
  let color = null;
  root.walkDecls(declaration => {
    if (color || !COLOR_PROPS.test(declaration.prop)) return;
    const value = readable(declaration.value, new Map(), design);
    if (/^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color-mix)\(.*\)|[a-z]+)$/i.test(value) && !/^(inherit|currentcolor|transparent|initial|unset)$/i.test(value)) color = value;
  });
  return color;
}

/** Find the classes an element uses that have no effect. `byNode` maps node IDs to class strings. */
export async function unknownClasses({ tokens, css, byNode, base }) {
  const names = [...new Set(Object.values(byNode).flatMap(value => value.split(/\s+/)).filter(Boolean))];
  if (!names.length) return {};
  const design = await slot(tokens, base).design;
  const custom = customClasses(css);
  const compiled = design.candidatesToCss(names);
  const dead = new Set(names.filter((name, index) => !compiled[index] && !custom.has(name) && !MARKER.test(name)));
  if (!dead.size) return {};
  const out = {};
  for (const [id, value] of Object.entries(byNode)) {
    const bad = value.split(/\s+/).filter(name => dead.has(name));
    if (bad.length) out[id] = bad;
  }
  return out;
}

/* ---- suggestions ------------------------------------------------------------ */

const natural = new Intl.Collator('en', { numeric: true }).compare;

async function catalog(tokens, base) {
  const item = slot(tokens, base);
  if (!item.classes) {
    item.classes = item.design.then(design => {
      const utilities = design.getClassList().map(([name]) => name).filter(name => !name.startsWith('-') || name.length < 14);
      const variants = [];
      for (const variant of design.getVariants()) {
        if (variant.name === '*' || variant.name === '**') continue;
        if (!variant.values.length) variants.push(variant.name);
        else if (['group', 'peer', 'not', 'max', 'min'].includes(variant.name)) for (const value of variant.values.slice(0, 40)) variants.push(`${variant.name}-${value}`);
      }
      return { design, utilities, variants };
    });
  }
  return item.classes;
}

/** Build the class list for suggestions ahead of the first keystroke. */
export function warmSuggestions(tokens, base) {
  catalog(tokens, base).catch(() => {});
}

/** Split `md:hover:bg-` into its variant prefix and the utility being typed (brackets keep their colons). */
function splitVariants(query) {
  let depth = 0;
  let cut = -1;
  for (let index = 0; index < query.length; index++) {
    const ch = query[index];
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ':' && !depth) cut = index;
  }
  return cut < 0 ? ['', query] : [query.slice(0, cut + 1), query.slice(cut + 1)];
}

/**
 * Classes to offer while typing: ones already used in the project first, then Tailwind
 * utilities by prefix, then by word inside the name; variants (`hover:`) when they match.
 */
export async function suggestClasses({ tokens, query, used = [], limit = 10, base }) {
  const { design, utilities, variants } = await catalog(tokens, base);
  const [prefix, word] = splitVariants(String(query || '').trim());
  const needle = word.toLowerCase();
  const picked = [];
  const seen = new Set();
  const add = (name, kind) => { if (!seen.has(name) && picked.length < limit * 3) { seen.add(name); picked.push({ name, kind }); } };
  if (needle) {
    for (const name of used.filter(name => name.startsWith(needle)).sort(natural)) add(name, 'used');
    const starts = utilities.filter(name => name.startsWith(needle));
    starts.sort((a, b) => a.length - b.length || natural(a, b));
    for (const name of starts.slice(0, limit * 2)) add(name, 'utility');
    if (needle.length >= 2) for (const name of variants.filter(name => name.startsWith(needle)).slice(0, 4)) add(`${name}:`, 'variant');
    if (picked.length < limit && needle.length >= 3) {
      const inside = utilities.filter(name => !name.startsWith(needle) && (name.includes(`-${needle}`) || name.includes(needle)));
      inside.sort((a, b) => Number(!a.includes(`-${needle}`)) - Number(!b.includes(`-${needle}`)) || a.length - b.length || natural(a, b));
      for (const name of inside.slice(0, limit)) add(name, 'utility');
    }
  }
  const items = picked.slice(0, limit).map(item => ({ ...item, name: item.kind === 'variant' ? prefix + item.name : prefix + item.name }));
  const utilitiesOnly = items.filter(item => item.kind !== 'variant');
  const compiled = design.candidatesToCss(utilitiesOnly.map(item => item.name));
  utilitiesOnly.forEach((item, index) => {
    const css = compiled[index];
    if (!css) return;
    const lines = explainUtility(item.name, css, design).filter(line => !line.endsWith(':') && line.includes(':'));
    const first = lines.find(line => /^\s*[\w-]+: /.test(line));
    if (first) item.hint = first.trim().replace(/ \/\*.*\*\/$/, '');
    const color = colorOf(css, design);
    if (color) item.color = color;
  });
  return items.filter(item => item.kind === 'variant' || item.hint || item.kind === 'used');
}
