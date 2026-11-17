/*
 * Explaining and suggesting Tailwind utilities from a loaded design system. Portable: PostCSS only, no Node built-ins and no
 * module loading, so the Node provider (styling.js) and the browser provider (browser.ts) share one implementation and differ only
 * in how they load the design system. `design` is Tailwind's design system for one theme.
 */
import parseCss from 'postcss/lib/parse';

const postcss = { parse: parseCss };
export const MARKER = /^(group|peer)(\/[\w-]+)?$/;

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

const natural = new Intl.Collator('en', { numeric: true }).compare;

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

/**
 * Explain classes for the board and the agent:
 * `utility` (Tailwind, with its CSS), `custom` (rules of the frame/project CSS), `marker`
 * (group, peer) or `unknown` (no effect: a typo, or a name with no rule).
 */
export function explainWith(design, { css, names }) {
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

/** Find the classes an element uses that have no effect. `byNode` maps node IDs to class strings. */
export function unknownWith(design, { css, byNode }) {
  const names = [...new Set(Object.values(byNode).flatMap(value => value.split(/\s+/)).filter(Boolean))];
  if (!names.length) return {};
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

/** The utilities and variants a design system knows, for suggestions. */
export function catalogOf(design) {
  const utilities = design.getClassList().map(([name]) => name).filter(name => !name.startsWith('-') || name.length < 14);
  const variants = [];
  for (const variant of design.getVariants()) {
    if (variant.name === '*' || variant.name === '**') continue;
    if (!variant.values.length) variants.push(variant.name);
    else if (['group', 'peer', 'not', 'max', 'min'].includes(variant.name)) for (const value of variant.values.slice(0, 40)) variants.push(`${variant.name}-${value}`);
  }
  return { design, utilities, variants };
}

/**
 * Classes to offer while typing: ones already used in the project first, then Tailwind
 * utilities by prefix, then by word inside the name; variants (`hover:`) when they match.
 */
export function suggestWith({ design, utilities, variants }, { query, used = /** @type {string[]} */ ([]), limit = 10 }) {
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
