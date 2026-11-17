// Domain: Native style edits. Owns: declarative CSS property edits applied to one element's inline declarations, with
// shorthand/longhand reconciliation. Excludes: utility classes (a style engine's), admission of values (the model validator's)
// and any DOM. Portable: no Node built-ins, so the browser writer shares it.

/** CSS property → value (or null to remove), the shape of a `styles` patch. */
export type StyleEdits = Record<string, string | number | null>;
type Pair = [property: string, value: string];

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
/** Shorthands whose one-to-four value syntax maps onto their longhands in top/right/bottom/left (or corner) order. */
const BOX: Record<string, readonly string[]> = {
  padding: SIDES.map(side => `padding-${side}`),
  margin: SIDES.map(side => `margin-${side}`),
  inset: [...SIDES],
  'border-width': SIDES.map(side => `border-${side}-width`),
  'border-style': SIDES.map(side => `border-${side}-style`),
  'border-color': SIDES.map(side => `border-${side}-color`),
  'border-radius': CORNERS.map(corner => `border-${corner}-radius`),
};
/** Shorthands expanded by repeating one value per longhand, in order. */
const PAIRS: Record<string, readonly string[]> = { gap: ['row-gap', 'column-gap'], overflow: ['overflow-x', 'overflow-y'] };
const BORDER_STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset']);
const BORDER_WIDTH = /^(?:thin|medium|thick|[-+]?(?:\d+\.?\d*|\.\d+)(?:[a-z%]+)?)$/i;

/** Split a value on top-level spaces (so `rgb(0 0 0)` and `var(--a, 1px 2px)` stay whole); null for `/` or `!important`. */
function words(value: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let word = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && !depth) { if (word) out.push(word); word = ''; } else word += ch;
  }
  if (word) out.push(word);
  return out.some(part => part === '/' || /!important/i.test(part)) ? null : out;
}

/** One-to-four values → [top, right, bottom, left]. */
function four(parts: string[]): string[] | null {
  if (parts.length < 1 || parts.length > 4) return null;
  const [a, b = a, c = a, d = b] = parts as [string, string?, string?, string?];
  return [a, b as string, c as string, d as string];
}

/** The longhand declarations a shorthand declaration stands for, in order; null when its syntax is not understood. */
export function expandShorthand(property: string, value: string): Pair[] | null {
  const parts = words(value);
  if (!parts || parts.some(part => /^(?:inherit|initial|unset|revert|revert-layer)$/i.test(part)) && parts.length > 1) return null;
  const box = BOX[property];
  if (box) {
    const values = four(parts);
    return values ? box.map((name, index) => [name, values[index] as string]) : null;
  }
  const pair = PAIRS[property];
  if (pair) {
    if (parts.length < 1 || parts.length > 2) return null;
    return pair.map((name, index) => [name, parts[Math.min(index, parts.length - 1)] as string]);
  }
  if (property === 'border') {
    let width: string | undefined, style: string | undefined;
    const colour: string[] = [];
    for (const part of parts) {
      if (style === undefined && BORDER_STYLES.has(part.toLowerCase())) style = part;
      else if (width === undefined && BORDER_WIDTH.test(part)) width = part;
      else colour.push(part);
    }
    if (colour.length > 1) return null;
    return [['border-width', width ?? 'medium'], ['border-style', style ?? 'none'], ['border-color', colour[0] ?? 'currentcolor']];
  }
  return null;
}

/** Longhand properties a shorthand covers directly (one level). */
function covered(property: string): readonly string[] {
  if (BOX[property]) return BOX[property] as readonly string[];
  if (PAIRS[property]) return PAIRS[property] as readonly string[];
  if (property === 'border') return ['border-width', 'border-style', 'border-color'];
  return [];
}
/** Every longhand beneath a property, through nested shorthands (`border` → `border-width` → `border-top-width`). */
export function longhandsOf(property: string): string[] {
  return covered(property).flatMap(name => [name, ...longhandsOf(name)]);
}
/** Shorthands that directly cover a property. */
const coveringOf = (property: string): string[] => ['padding', 'margin', 'inset', 'border-width', 'border-style', 'border-color', 'border-radius', 'gap', 'overflow', 'border'].filter(name => covered(name).includes(property));

const isCustom = (property: string): boolean => property.startsWith('--');
const keyOf = (property: string): string => isCustom(property) ? property : property.toLowerCase();

/**
 * The authored value of every property an inline declaration list sets, shorthands expanded, later declarations winning.
 * Unexpandable shorthands stay under their own name. This is the editing view; the browser still owns the cascade.
 */
export function declaredValues(declarations: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (property: string, value: string): void => {
    const expanded = expandShorthand(property, value);
    // A shorthand resets everything it covers, then writes what it can say.
    for (const name of longhandsOf(property)) delete out[name];
    out[property] = value;
    if (expanded) for (const [name, part] of expanded) set(name, part);
  };
  for (const [property, value] of declarations) set(keyOf(property), value);
  return out;
}

function fail(message: string): never { throw Object.assign(new Error(message), { code: 'INVALID_PATCH' }); }

const SAFE_PROPERTY = /^(?:--[A-Za-z0-9_-]{1,64}|[a-z][a-z-]{0,63})$/;
/** Admit one edit's property and value; the model validator checks the result again as CSS. */
export function checkEdit(property: string, value: unknown): string | null {
  if (!SAFE_PROPERTY.test(property)) fail(`Unsupported style property: ${property}.`);
  if (value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') fail(`Invalid value for ${property}.`);
  const text = String(value).trim();
  if (/[;{}<>\\]/.test(text) || text.length > 512) fail(`Invalid value for ${property}.`);
  return text;
}

/** Replace shorthand `at` by its longhands in place. Returns false when its syntax is not understood. */
function expandAt(decls: Pair[], index: number): boolean {
  const [property, value] = decls[index] as Pair;
  const expanded = expandShorthand(keyOf(property), value);
  if (!expanded) return false;
  decls.splice(index, 1, ...expanded);
  return true;
}

/** Declarations that cover `property` through shorthands, outermost last. */
function coversOf(decls: Pair[], property: string): number[] {
  const wanted = new Set<string>();
  const queue = [property];
  for (let index = 0; index < queue.length; index++) for (const name of coveringOf(queue[index] as string)) if (!wanted.has(name)) { wanted.add(name); queue.push(name); }
  return decls.flatMap(([name], index) => (wanted.has(keyOf(name)) ? [index] : []));
}

/** Expand every shorthand covering `property`, so the property can be removed without losing its siblings. False: not understood. */
function release(decls: Pair[], property: string): boolean {
  for (let guard = 0; guard < 16; guard++) {
    const at = coversOf(decls, property);
    if (!at.length) return true;
    if (!expandAt(decls, at[0] as number)) return false;
  }
  return false;
}

/** Index of the first declaration of a property, or -1. */
const firstOf = (decls: Pair[], property: string): number => decls.findIndex(([name]) => keyOf(name) === property);
/** Remove declarations of `names`, keeping the first of `keep` (when given) at its slot. */
function removeAll(decls: Pair[], names: ReadonlySet<string>, keep?: string): void {
  let kept = false;
  for (let index = 0; index < decls.length; index++) {
    const name = keyOf((decls[index] as Pair)[0]);
    if (!names.has(name)) continue;
    if (keep !== undefined && name === keep && !kept) { kept = true; continue; }
    decls.splice(index--, 1);
  }
}

/**
 * Apply property edits to inline declarations. An existing declaration keeps its slot (so Undo/Redo, which replay changed keys
 * over the stored order, reproduce it), a new one is appended, and a longhand that a LATER shorthand would override first has
 * that shorthand expanded in place. A shorthand edit removes the longhands it now covers. `null` removes the property, first
 * expanding any shorthand that would otherwise lose its siblings.
 */
export function applyNativeStyles(style: Readonly<Record<string, string>>, edits: StyleEdits): Record<string, string> {
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) fail('styles must be an object of CSS declarations.');
  const decls: Pair[] = Object.entries(style);
  for (const [raw, input] of Object.entries(edits)) {
    const value = checkEdit(raw, input);
    const property = keyOf(raw);
    const removal = value === null || value === '';
    if (removal && !release(decls, property)) fail(`${raw} cannot be removed: a shorthand that sets it is not understood. Replace the shorthand instead.`);
    const below = new Set(longhandsOf(property));
    if (!removal) {
      // A shorthand declared after this property would defeat it: expand those so the existing slot stays authoritative.
      for (let guard = 0; guard < 16; guard++) {
        const first = firstOf(decls, property);
        const later = first < 0 ? [] : coversOf(decls, property).filter(index => index > first);
        if (!later.length) break;
        if (!expandAt(decls, later[0] as number)) { removeAll(decls, new Set([property])); break; }
      }
    }
    removeAll(decls, new Set([property, ...below]), removal ? undefined : property);
    if (removal) { removeAll(decls, new Set([property])); continue; }
    const slot = firstOf(decls, property);
    if (slot >= 0) (decls[slot] as Pair)[1] = value as string; else decls.push([property, value as string]);
  }
  return Object.fromEntries(decls);
}

/**
 * Prepare inline declarations for utilities that will now set `properties`: the inline declarations that would defeat them are
 * removed (a covering shorthand is expanded first). Returns the new style and the properties that could not be released, which
 * the caller must keep as native declarations instead of utilities.
 */
export function releaseForUtilities(style: Readonly<Record<string, string>>, properties: readonly string[]): { style: Record<string, string>; blocked: string[] } {
  const decls: Pair[] = Object.entries(style);
  const blocked: string[] = [];
  for (const raw of properties) {
    const property = keyOf(raw);
    if (!release(decls, property)) { blocked.push(raw); continue; }
    const drop = new Set([property, ...longhandsOf(property)]);
    for (let index = decls.length - 1; index >= 0; index--) if (drop.has(keyOf((decls[index] as Pair)[0]))) decls.splice(index, 1);
  }
  return { style: Object.fromEntries(decls), blocked };
}
