/*
 * The inspector's view of an element's authored CSS: what the property controls read and the declarations they write.
 * Pure functions, no DOM, so they run unchanged in Node tests.
 *
 * A "view" is a plain object of CSS property → authored value for ONE element. It is built from inline declarations (shorthands
 * expanded, later declarations winning) and, when a plugin registered a representation reader (Tailwind classes), from that
 * representation underneath: inline CSS has the higher priority in the cascade, so it overrides utilities.
 * Controls write `styles` patches ({ property: value | null }); the writer decides how they are stored (native inline
 * declarations, or utility classes when a style engine is active). Nothing here persists editor state.
 */

/* ---- reading: inline declarations ---------------------------------------------------------------------- */
const SIDES = ['top', 'right', 'bottom', 'left'];
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const BOX = {
  padding: SIDES.map(side => `padding-${side}`),
  margin: SIDES.map(side => `margin-${side}`),
  inset: [...SIDES],
  'border-width': SIDES.map(side => `border-${side}-width`),
  'border-style': SIDES.map(side => `border-${side}-style`),
  'border-color': SIDES.map(side => `border-${side}-color`),
  'border-radius': CORNERS.map(corner => `border-${corner}-radius`),
};
const PAIRS = { gap: ['row-gap', 'column-gap'], overflow: ['overflow-x', 'overflow-y'] };
const LINE_STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset']);
const LINE_WIDTH = /^(?:thin|medium|thick|[-+]?(?:\d+\.?\d*|\.\d+)(?:[a-z%]+)?)$/i;

/** Split on top-level spaces (functions stay whole); null when the value has `/` or `!important`. */
function words(value) {
  const out = [];
  let depth = 0, word = '';
  for (const ch of String(value).trim()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && !depth) { if (word) out.push(word); word = ''; } else word += ch;
  }
  if (word) out.push(word);
  return out.some(part => part === '/' || /!important/i.test(part)) ? null : out;
}

/** The longhand declarations a shorthand stands for, or null when its syntax is not understood. Mirrors core's native-styles. */
export function expandShorthand(property, value) {
  const parts = words(value);
  if (!parts || (parts.length > 1 && parts.some(part => /^(?:inherit|initial|unset|revert|revert-layer)$/i.test(part)))) return null;
  if (BOX[property]) {
    if (parts.length < 1 || parts.length > 4) return null;
    const [a, b = a, c = a, d = b] = parts;
    const values = [a, b, c, d];
    return BOX[property].map((name, index) => [name, values[index]]);
  }
  if (PAIRS[property]) return parts.length >= 1 && parts.length <= 2 ? PAIRS[property].map((name, index) => [name, parts[Math.min(index, parts.length - 1)]]) : null;
  if (property === 'border') {
    let width, style;
    const colour = [];
    for (const part of parts) {
      if (style === undefined && LINE_STYLES.has(part.toLowerCase())) style = part;
      else if (width === undefined && LINE_WIDTH.test(part)) width = part;
      else colour.push(part);
    }
    return colour.length > 1 ? null : [['border-width', width ?? 'medium'], ['border-style', style ?? 'none'], ['border-color', colour[0] ?? 'currentcolor']];
  }
  return null;
}
const covered = property => BOX[property] ?? PAIRS[property] ?? (property === 'border' ? ['border-width', 'border-style', 'border-color'] : []);
const longhandsOf = property => covered(property).flatMap(name => [name, ...longhandsOf(name)]);

/** Authored value of every property an ordered declaration list sets, shorthands expanded, later declarations winning. */
export function declaredValues(declarations) {
  const out = {};
  const set = (property, value) => {
    const expanded = expandShorthand(property, value);
    for (const name of longhandsOf(property)) delete out[name];
    out[property] = value;
    if (expanded) for (const [name, part] of expanded) set(name, part);
  };
  for (const [property, value] of declarations) set(property.startsWith('--') ? property : property.toLowerCase(), String(value));
  return out;
}

/* ---- reconciling inline declarations with utilities ---------------------------------------------------- */
const COVERING = ['padding', 'margin', 'inset', 'border-width', 'border-style', 'border-color', 'border-radius', 'gap', 'overflow', 'border'];
const keyOf = property => (property.startsWith('--') ? property : property.toLowerCase());
const coversOf = (decls, property) => {
  const wanted = new Set();
  const queue = [property];
  for (let index = 0; index < queue.length; index++) for (const name of COVERING.filter(item => covered(item).includes(queue[index]))) if (!wanted.has(name)) { wanted.add(name); queue.push(name); }
  return decls.flatMap(([name], index) => (wanted.has(keyOf(name)) ? [index] : []));
};

/**
 * Inline declarations after a utility takes over `properties`: the declarations that would defeat it (the property, what it covers
 * and any shorthand that covers it, expanded first so its siblings survive) are removed. Mirrors core's `releaseForUtilities`.
 * Returns the new declaration map and the patch that turns the old map into it (null removes a key).
 */
export function releaseInline(style, properties) {
  const decls = Object.entries(style || {});
  for (const raw of properties) {
    const property = keyOf(raw);
    for (let guard = 0; guard < 16; guard++) {
      const at = coversOf(decls, property);
      if (!at.length) break;
      const expanded = expandShorthand(keyOf(decls[at[0]][0]), decls[at[0]][1]);
      if (!expanded) break; // a shorthand we cannot read stays; the utility may then be defeated, which the caller can report
      decls.splice(at[0], 1, ...expanded);
    }
    const drop = new Set([property, ...longhandsOf(property)]);
    for (let index = decls.length - 1; index >= 0; index--) if (drop.has(keyOf(decls[index][0]))) decls.splice(index, 1);
  }
  const next = Object.fromEntries(decls);
  const delta = {};
  for (const key of Object.keys(style || {})) if (!(key in next)) delta[key] = null;
  for (const [key, value] of Object.entries(next)) if (style?.[key] !== value) delta[key] = value;
  return { style: next, delta };
}

/**
 * The view of one element: representation `readers` (applied first) underneath its inline declarations. A reader is
 * `{ view(className, context) → { property: value } }`; `context` carries what a representation needs from the project
 * (`{ tokens }`). Readers' shorthands are expanded the same way inline ones are.
 */
export function viewOf(node, readers = [], context = {}) {
  const view = {};
  for (const reader of readers) Object.assign(view, declaredValues(Object.entries(reader.view(node.className || '', context) || {})));
  Object.assign(view, declaredValues(Object.entries(node.style || {})));
  return view;
}

/* ---- values: what people type and what is shown --------------------------------------------------------- */
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;
const LENGTH = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vw|vh|dvh|svh|ch|vmin|vmax)$/;

/** What a field shows for a CSS length: plain px numbers bare (`16px` → `16`), everything else as written. */
export function show(value) {
  if (value == null || value === '') return '';
  const text = String(value).trim();
  const px = /^(-?(?:\d+\.?\d*|\.\d+))px$/.exec(text);
  if (px) return String(Math.round(Number(px[1]) * 100) / 100);
  if (NUMBER.test(text)) return String(Math.round(Number(text) * 100) / 100);
  return text;
}

/** A CSS length from what a person typed: `16` → `16px`, `1.5rem`, `50%`, `auto`; '' → null (remove); undefined when invalid. */
export function lengthInput(raw, { keywords = ['auto'], negative = true } = {}) {
  const text = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return null;
  if (NUMBER.test(text)) { const n = Number(text); return !negative && n < 0 ? undefined : n === 0 ? '0' : `${n}px`; }
  if (LENGTH.test(text)) return !negative && text.startsWith('-') ? undefined : text;
  if (keywords.includes(text)) return text;
  if (/^(?:calc|min|max|clamp)\(.+\)$/.test(text) || /^var\(--[\w-]+\)$/.test(text)) return text;
  return undefined;
}

/** `rgb()` colours the page reports → `#rrggbb`; null when not a plain colour. */
export const hexOf = css => {
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(String(css || ''));
  return m ? `#${[m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('')}` : /^#[0-9a-f]{6}$/i.test(css || '') ? css.toLowerCase() : null;
};

/** What a person typed (hex, a project token, a keyword) → a CSS colour value; undefined when it is not one. */
export function colourInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^(transparent|currentcolor|current|inherit)$/i.test(text)) return /^current$/i.test(text) ? 'currentColor' : text.toLowerCase() === 'currentcolor' ? 'currentColor' : text.toLowerCase();
  if (/^(white|black)$/i.test(text)) return text.toLowerCase() === 'white' ? '#ffffff' : '#000000';
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
  if (hex) return `#${hex[1].toLowerCase()}`;
  if (/^var\(--[\w-]+\)$/.test(text) || /^(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(.+\)$/i.test(text)) return text;
  return undefined;
}

/* ---- flex / grid alignment -------------------------------------------------------------------------------- */
const AXIS = ['start', 'center', 'end'];
/** `flex-start`/`start`/`left`/`self-start` → start; likewise end; other keywords unchanged. */
export const edgeOf = value => {
  const text = String(value ?? '').trim().toLowerCase();
  if (/^(?:flex-|self-)?start$|^left$/.test(text)) return 'start';
  if (/^(?:flex-|self-)?end$|^right$/.test(text)) return 'end';
  return text || null;
};
/** The value to write for start/end in a flex container (`flex-start`) or a grid/other context (`start`). */
export const edgeValue = (edge, flex) => (edge === 'start' || edge === 'end') && flex ? `flex-${edge}` : edge;

export const isFlex = display => display === 'flex' || display === 'inline-flex';
export const isGrid = display => display === 'grid' || display === 'inline-grid';

/** Where a flex or grid container puts its children: { x, y } of start/center/end (or null). */
export function alignment(view) {
  const grid = isGrid(view.display);
  const column = /^column/.test(view['flex-direction'] || '');
  const justify = edgeOf(grid ? view['justify-items'] : view['justify-content']);
  const items = edgeOf(view['align-items']);
  const main = AXIS.includes(justify) ? justify : null;
  const cross = AXIS.includes(items) ? items : null;
  return { x: column && !grid ? cross : main, y: column && !grid ? main : cross, between: !grid && view['justify-content'] === 'space-between' };
}

/** Declarations that align a container's children to a cell of the 3×3 grid. */
export function alignmentEdits(view, x, y) {
  const grid = isGrid(view.display);
  const flex = !grid;
  const column = /^column/.test(view['flex-direction'] || '');
  const [main, cross] = column && flex ? [y, x] : [x, y];
  return grid
    ? { 'justify-items': edgeValue(main, false), 'align-items': edgeValue(cross, false) }
    : { 'justify-content': edgeValue(main, true), 'align-items': edgeValue(cross, true) };
}

/* ---- pinned (positioned) elements --------------------------------------------------------------------------- */
const TRANSLATE = /translate\(\s*(-50%|0(?:px)?)\s*(?:,\s*(-50%|0(?:px)?))?\s*\)/;
/** Where an absolutely positioned element is pinned: { x, y } of start/center/end from its offsets. */
export function pin(view) {
  const translate = TRANSLATE.exec(view.transform || '');
  const axis = (start, end, centred) => (centred && start === '50%' ? 'center' : start != null && end == null ? 'start' : end != null && start == null ? 'end' : null);
  return { x: axis(view.left, view.right, translate?.[1] === '-50%'), y: axis(view.top, view.bottom, translate?.[2] === '-50%') };
}

/** Declarations that pin to a cell: edges at 0, or centred at 50% with a -50% translate. */
export function pinEdits(view, x, y) {
  const edits = {};
  const place = (start, end, value) => { edits[start] = value === 'start' ? '0' : value === 'center' ? '50%' : null; edits[end] = value === 'end' ? '0' : null; };
  place('left', 'right', x);
  place('top', 'bottom', y);
  const tx = x === 'center' ? '-50%' : '0', ty = y === 'center' ? '-50%' : '0';
  edits.transform = x === 'center' || y === 'center' ? `translate(${tx}, ${ty})` : null;
  return edits;
}

/* ---- single values ------------------------------------------------------------------------------------------ */
/** Opacity 0–100 for the field, or null. */
export function opacityOf(view) {
  if (view.opacity == null) return null;
  const text = String(view.opacity);
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? Math.round(text.endsWith('%') ? n : n * 100) : null;
}
export const opacityInput = raw => {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) return undefined;
  const percent = Math.round(Math.min(100, Math.max(0, n)));
  return percent === 100 ? null : String(percent / 100);
};

/** The radius of a `blur()` in `filter`, in px, or null. */
export function blurOf(view) {
  const match = /(?:^|\s)blur\(\s*(-?[\d.]+)px\s*\)/.exec(view.filter || '');
  return match ? Number(match[1]) : null;
}
/** A `filter` value with the blur term set (others kept) or removed; null removes the declaration when nothing is left. */
export function blurEdit(view, px) {
  const rest = String(view.filter || '').replace(/(?:^|\s)blur\([^)]*\)/g, ' ').trim().replace(/\s+/g, ' ');
  const next = px && px > 0 ? [rest, `blur(${px}px)`].filter(Boolean).join(' ') : rest;
  return next || null;
}

export const zInput = raw => {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'auto') return 'auto';
  return /^-?\d+$/.test(text) ? String(Number.parseInt(text, 10)) : undefined;
};

/** A `repeat(N, minmax(0, 1fr))` column count, or null for any other grid template. */
export function gridColumns(view) {
  const match = /^repeat\(\s*(\d+)\s*,\s*minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)\s*\)$/.exec(view['grid-template-columns'] || '');
  return match ? Number(match[1]) : null;
}
export const gridColumnsEdit = count => (count ? `repeat(${count}, minmax(0, 1fr))` : null);

/** The gap to show: one value when both axes agree, else `row column`. */
export function gapOf(view) {
  const row = view['row-gap'] ?? view.gap, column = view['column-gap'] ?? view.gap;
  if (row == null && column == null) return null;
  if (row === column || column == null) return show(row);
  return row == null ? show(column) : `${show(row)} ${show(column)}`;
}

/** Font weight as a number: keywords map to their numbers. */
export function weightOf(view) {
  const text = String(view['font-weight'] ?? '').trim().toLowerCase();
  if (!text) return null;
  const keyword = { normal: '400', bold: '700', lighter: null, bolder: null }[text];
  return keyword === undefined ? (/^\d+$/.test(text) ? text : null) : keyword;
}

/** Corner radius for the field: all four corners equal → that value (`Full` for a pill); otherwise null. */
export function radiusOf(view) {
  const corners = CORNERS.map(corner => view[`border-${corner}-radius`] ?? view['border-radius']);
  if (corners.some(value => value == null) || corners.some(value => value !== corners[0])) return corners.every(value => value == null) ? null : undefined;
  return /^(?:9999px|999px|100%|50%)$/.test(corners[0]) ? 'Full' : show(corners[0]);
}
/** Corner radius: a plain number reads as px, and px/%/rem/em plus the `full` keyword are kept as written. */
export const radiusInput = raw => {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^full$/i.test(text)) return '9999px';
  if (/^\d+(?:\.\d+)?$/.test(text)) return `${Number(text)}px`;
  return /^\d+(?:\.\d+)?(?:px|%|rem|em)$/i.test(text) ? text.toLowerCase() : undefined;
};

/** Line height as written: a multiple (`1.5`), a length or percentage, or `normal`. */
/** The line height's number for the field: its unit sits beside it in the unit button (`150%` → `150`, `24px` → `24`). */
export function lineHeightOf(view) {
  const text = view['line-height'];
  if (text == null) return null;
  return show(text).replace(/(?:px|rem|em|%)$/i, '');
}

/**
 * A line height accepts a unitless multiple, px/%/rem/em, `normal`, or empty to remove it. A bare number at or above 10 is a
 * percentage written without its sign (`150`), because a line height of 10 multiples does not exist; below that it stays the
 * multiple it reads as (`1.5`), which is the same value as `150%`.
 */
export const lineHeightInput = raw => {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^normal$/i.test(text)) return 'normal';
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return Number(text) >= 10 ? `${Number(text)}%` : text;
  return /^(?:\d+(?:\.\d+)?)(?:px|%|rem|em)$/i.test(text) ? text.toLowerCase() : undefined;
};

/** The unit a written line height uses: `%`, `em`, `rem`, `px`, or `×` for a unitless multiple; null for a keyword or nothing. */
export function lineHeightUnit(text) {
  const value = String(text ?? '').trim().toLowerCase();
  const written = /^[-+]?[\d.]+(px|rem|em|%)$/.exec(value);
  if (written) return written[1];
  return /^[-+]?[\d.]+$/.test(value) ? '×' : null;
}

/**
 * The same line height spelled in another unit, as its number: `24` px is `150` %, `1.5` em or `1.5` times. `%`, `em` and a
 * unitless multiple all measure the element's own font size — `base` px — so converting between them changes no value, and px
 * converts against that same size. Null when there is nothing to convert.
 */
export function lineHeightIn(number, from, to, base = 16) {
  const value = Number.parseFloat(String(number ?? '').trim());
  if (!from || !to || !Number.isFinite(value) || !(base > 0)) return null;
  const px = from === 'px' ? value : from === '%' ? (value / 100) * base : value * base;
  const result = to === 'px' ? px : to === '%' ? (px / base) * 100 : px / base;
  return String(Math.round(result * 1000) / 1000);
}

/**
 * The authored overflow of both axes as one value — what the Layout selector shows and writes. `null` when nothing is authored and
 * `'mixed'` when the two axes disagree (or a single axis is set), because one shorthand cannot honestly claim such a pair.
 */
export function overflowOf(view) {
  const x = view['overflow-x'] ?? view['overflow'] ?? null;
  const y = view['overflow-y'] ?? view['overflow'] ?? null;
  if (x == null && y == null) return null;
  return x === y && typeof x === 'string' ? x : 'mixed';
}

/** Font size in px for the field (`16px`, `1rem` at the 16px root), or the value as written. */
export function fontSizeOf(view) {
  const text = view['font-size'];
  if (text == null) return null;
  const rem = /^([\d.]+)rem$/.exec(text);
  return rem ? String(Math.round(Number(rem[1]) * 16 * 100) / 100) : show(text);
}
