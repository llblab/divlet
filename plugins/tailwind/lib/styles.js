/*
 * Declarative styles → Tailwind classes. People and agents who do not know Tailwind state styles as CSS declarations
 * (`{ 'padding-top': '16px', color: '#fff' }`); this module turns each declaration into the matching utility (an
 * arbitrary-property class when no utility exists) and replaces whatever class already set the same property.
 * The same transpiler converts imported PEN styles (`convert.js`).
 */
const KEYWORD = {
  display: { flex: 'flex', none: 'hidden', block: 'block', grid: 'grid', 'inline-flex': 'inline-flex', 'inline-block': 'inline-block', inline: 'inline' },
  position: { relative: 'relative', absolute: 'absolute', fixed: 'fixed', sticky: 'sticky', static: 'static' },
  'flex-direction': { row: 'flex-row', column: 'flex-col', 'row-reverse': 'flex-row-reverse', 'column-reverse': 'flex-col-reverse' },
  'flex-wrap': { wrap: 'flex-wrap', nowrap: 'flex-nowrap' },
  'flex-shrink': { 0: 'shrink-0', 1: 'shrink' },
  'flex-grow': { 0: 'grow-0', 1: 'grow' },
  'align-items': { 'flex-start': 'items-start', center: 'items-center', 'flex-end': 'items-end', stretch: 'items-stretch', baseline: 'items-baseline' },
  'justify-content': { 'flex-start': 'justify-start', center: 'justify-center', 'flex-end': 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly' },
  'align-self': { stretch: 'self-stretch', 'flex-start': 'self-start', center: 'self-center', 'flex-end': 'self-end' },
  overflow: { hidden: 'overflow-hidden', auto: 'overflow-auto', visible: 'overflow-visible' },
  'white-space': { 'pre-wrap': 'whitespace-pre-wrap', nowrap: 'whitespace-nowrap', normal: 'whitespace-normal', pre: 'whitespace-pre' },
  'text-align': { left: 'text-left', right: 'text-right', center: 'text-center', justify: 'text-justify' },
};
const PREFIX = { width: 'w', height: 'h', 'min-width': 'min-w', 'min-height': 'min-h', 'max-width': 'max-w', 'max-height': 'max-h', gap: 'gap', left: 'left', top: 'top', right: 'right', bottom: 'bottom', 'border-radius': 'rounded', 'line-height': 'leading', 'font-weight': 'font', opacity: 'opacity' };
const KEYWORD_OWNER = new Map(Object.entries(KEYWORD).flatMap(([property, values]) => Object.values(values).map(name => [name, property])));
const PREFIX_OWNER = Object.entries(PREFIX).sort((a, b) => b[1].length - a[1].length).map(([property, prefix]) => [`${prefix}-`, property]);

/** Tailwind arbitrary values use `_` for spaces; a literal underscore is escaped. */
const arbitrary = value => value.trim().replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/\s+/g, '_');
const VARIABLE = /^var\(--[A-Za-z0-9_-]+\)$/;
const LENGTH = /^(?:[-\d.]+(?:px|rem|em|%)?|auto)$/;

/** The Tailwind class(es) for one declaration; `colorOf` maps a literal color to a shared token reference. */
/** Interactive radius edits use Tailwind's named steps. */
const RADIUS_SCALE = { '0': 'rounded-none', '0px': 'rounded-none', '2px': 'rounded-xs', '4px': 'rounded-sm', '6px': 'rounded-md', '8px': 'rounded-lg', '12px': 'rounded-xl', '16px': 'rounded-2xl', '24px': 'rounded-3xl', '32px': 'rounded-4xl', '9999px': 'rounded-full', '999px': 'rounded-full', '50%': 'rounded-full' };

/** With `scale`, whole multiples of 4px use Tailwind's spacing scale (`p-4`, `gap-2`) instead of arbitrary values (`p-[16px]`). */
const scaleToken = value => (/^\d+px$/.test(value) && parseInt(value, 10) % 4 === 0 ? String(parseInt(value, 10) / 4) : /^0$/.test(value) ? '0' : null);

export function declarationClass(property, value, colorOf = () => null, { scale = false } = {}) {
  value = value.trim();
  const keyword = KEYWORD[property]?.[value];
  if (keyword) return keyword;
  if ((property === 'width' || property === 'height') && value === '100%') return `${PREFIX[property]}-full`;
  if (property === 'font-size' && (/^[\d.]+px$/.test(value) || VARIABLE.test(value))) return `text-[length:${value}]`;
  if ((property === 'color' || property === 'background-color') && (/^#[0-9a-f]{3,8}$/i.test(value) || VARIABLE.test(value))) {
    const token = VARIABLE.test(value) ? null : colorOf(value);
    const inner = token ? `var(${token})` : value;
    return property === 'color' ? `text-[color:${inner}]` : `bg-[${inner}]`;
  }
  if ((property === 'padding' || property === 'margin') && value.split(' ').every(part => LENGTH.test(part)) && value.split(' ').length <= 4) return boxClasses(property === 'padding' ? 'p' : 'm', sidesOf(value.split(' ')), scale);
  if (scale && property === 'border-radius' && RADIUS_SCALE[value]) return RADIUS_SCALE[value];
  if (scale && (property === 'gap' || property === 'width' || property === 'height') && scaleToken(value)) return `${PREFIX[property]}-${scaleToken(value)}`;
  if (PREFIX[property] && !/[\s,]/.test(value)) return `${PREFIX[property]}-[${arbitrary(value)}]`;
  return `[${property}:${arbitrary(value)}]`;
}

/* ---- padding and margin: the four sides are merged, never overwritten blindly ---------------------- */
const SIDE_KEYS = ['t', 'r', 'b', 'l'];
function sidesOf(parts) {
  const [a, b = a, c = a, d = b] = parts.length === 3 ? [parts[0], parts[1], parts[2], parts[1]] : parts;
  return { t: a, r: b, b: c, l: d };
}
function boxClasses(letter, sides, scale = false) {
  const present = SIDE_KEYS.filter(key => sides[key] !== undefined);
  const token = value => (scale ? scaleToken(value) : null) ?? `[${value}]`;
  if (present.length === 4 && SIDE_KEYS.every(key => sides[key] === sides.t)) return `${letter}-${token(sides.t)}`;
  const out = [];
  if (sides.t !== undefined && sides.t === sides.b && sides.l !== undefined && sides.l === sides.r) return `${letter}y-${token(sides.t)} ${letter}x-${token(sides.l)}`;
  for (const key of present) out.push(`${letter}${key}-${token(sides[key])}`);
  return out.join(' ');
}
/** Parse one existing padding/margin class into `{ letter, sides }`, or null when it is not understood (it then stays untouched). */
function parseBox(name) {
  const match = /^(p|m)(t|r|b|l|x|y)?-(?:\[([^\]]+)\]|(\d+(?:\.\d+)?)|(px))$/.exec(name);
  if (!match) return null;
  const [, letter, axis, arbitraryValue, scale, px] = match;
  const value = arbitraryValue ?? (px ? '1px' : Number(scale) === 0 ? '0' : `${Number(scale) * 4}px`);
  const which = !axis ? SIDE_KEYS : axis === 'x' ? ['l', 'r'] : axis === 'y' ? ['t', 'b'] : [axis];
  return { letter, sides: Object.fromEntries(which.map(key => [key, value])) };
}

/** The CSS property a base (variant-free) class sets, or null when unknown. `colourNames` are the project's theme colour names
 * (`--color-brand` → `brand`), which own `bg-<name>` and `text-<name>`; built-in utilities always win over a theme name. */
export function propertyOfClass(name, colourNames) {
  const arbitraryProperty = /^\[([a-z-]+):/.exec(name);
  if (arbitraryProperty) return arbitraryProperty[1];
  if (name.startsWith('text-[length:')) return 'font-size';
  if (name.startsWith('text-[color:')) return 'color';
  if (name.includes(':')) return null;
  if (KEYWORD_OWNER.has(name)) return KEYWORD_OWNER.get(name);
  if (colourNames?.size) {
    if (name.startsWith('bg-') && colourNames.has(name.slice(3))) return 'background-color';
    if (name.startsWith('text-') && colourNames.has(name.slice(5))) return 'color';
  }
  if (/^rounded(?:-(?:none|xs|sm|md|lg|xl|2xl|3xl|4xl|full))?$/.test(name)) return 'border-radius';
  if (/^bg-(?:transparent|current|inherit|white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?)$/.test(name)) return 'background-color';
  if (/^text-(?:transparent|current|inherit|white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?)$/.test(name)) return 'color';
  if (/^bg-\[(?!url)/.test(name)) return 'background-color';
  if (/^font-\[\d/.test(name)) return 'font-weight';
  for (const [prefix, property] of PREFIX_OWNER) if (name.startsWith(prefix) && /^(?:\[|\d|(?:full|px|auto|screen|fit|min|max)$)/.test(name.slice(prefix.length))) return property;
  return null;
}

const BOX_PROPERTY = /^(padding|margin)(?:-(top|right|bottom|left))?$/;
const SAFE_PROPERTY = /^[a-z][a-z-]{0,63}$/;

/**
 * Apply declarations to a class string: each property's previous class(es) are replaced, `null` removes the property,
 * everything else (other utilities, variants, unknown classes) is kept in place. `colourNames` names the project's theme
 * colours so `bg-brand` counts as a background and `text-paper` as a colour instead of surviving beside the new class.
 */
export function applyStyles(className, styles, { colorOf, colourNames } = {}) {
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)) throw Object.assign(new Error('styles must be an object of CSS declarations.'), { code: 'INVALID_PATCH' });
  let tokens = String(className || '').split(/\s+/).filter(Boolean);
  const boxes = { padding: null, margin: null };
  for (const [property, value] of Object.entries(styles)) {
    if (!SAFE_PROPERTY.test(property)) throw Object.assign(new Error(`Unsupported style property: ${property}.`), { code: 'INVALID_PATCH' });
    if (value !== null && (typeof value !== 'string' && typeof value !== 'number' || /[;{}<>\\]/.test(String(value)) || String(value).length > 512)) throw Object.assign(new Error(`Invalid value for ${property}.`), { code: 'INVALID_PATCH' });
    const text = value === null ? null : String(value).trim();
    const box = BOX_PROPERTY.exec(property);
    if (box) {
      const kind = box[1];
      if (!boxes[kind]) {
        const sides = {};
        for (const name of tokens) { const parsed = parseBox(name); if (parsed && parsed.letter === kind[0]) Object.assign(sides, parsed.sides); }
        boxes[kind] = sides;
      }
      const parts = text === null ? null : text.split(/\s+/);
      if (parts && (parts.length > 4 || !parts.every(part => LENGTH.test(part)))) throw Object.assign(new Error(`${property} takes one to four lengths.`), { code: 'INVALID_PATCH' });
      if (!box[2]) { for (const key of SIDE_KEYS) delete boxes[kind][key]; if (parts) Object.assign(boxes[kind], sidesOf(parts)); }
      else { const key = box[2][0]; if (parts) boxes[kind][key] = parts[0]; else delete boxes[kind][key]; }
      continue;
    }
    tokens = tokens.filter(name => propertyOfClass(name, colourNames) !== property);
    if (text !== null && text !== '') tokens.push(...declarationClass(property, text, colorOf, { scale: true }).split(' '));
  }
  for (const kind of ['padding', 'margin']) if (boxes[kind]) {
    tokens = tokens.filter(name => !(parseBox(name)?.letter === kind[0]));
    const classes = boxClasses(kind[0], boxes[kind], true);
    if (classes) tokens.push(...classes.split(' '));
  }
  return [...new Set(tokens)].join(' ');
}
