/*
 * Declarative styles → Tailwind classes. People and agents who do not know Tailwind state styles as CSS declarations
 * (`{ 'padding-top': '16px', color: '#fff' }`); this module turns each declaration into the matching utility (an
 * arbitrary-property class when no utility exists) and replaces whatever class already set the same property.
 * This optional representation does not own native inline declarations or foreign conversion.
 *
 * Replacing is the hard half. A class list written by hand or by another tool uses named utilities (`leading-tight`,
 * `max-w-md`, `gap-x-4`, `uppercase`, `border-red-500`); left beside the new class, the old one can win the cascade and the
 * edit appears to do nothing. `ownerOf` knows which longhand properties each core utility sets, and a utility that sets more
 * than the edit touches (`size-4`, `inset-0`, `gap-4`, `rounded-t-lg`, `border-2`) is split so its other sides survive.
 */
const KEYWORD = {
  display: { flex: 'flex', none: 'hidden', block: 'block', grid: 'grid', 'inline-flex': 'inline-flex', 'inline-block': 'inline-block', inline: 'inline', 'inline-grid': 'inline-grid', contents: 'contents', 'flow-root': 'flow-root', table: 'table', 'list-item': 'list-item' },
  position: { relative: 'relative', absolute: 'absolute', fixed: 'fixed', sticky: 'sticky', static: 'static' },
  'flex-direction': { row: 'flex-row', column: 'flex-col', 'row-reverse': 'flex-row-reverse', 'column-reverse': 'flex-col-reverse' },
  'flex-wrap': { wrap: 'flex-wrap', nowrap: 'flex-nowrap', 'wrap-reverse': 'flex-wrap-reverse' },
  'flex-shrink': { 0: 'shrink-0', 1: 'shrink' },
  'flex-grow': { 0: 'grow-0', 1: 'grow' },
  'align-items': { 'flex-start': 'items-start', start: 'items-start', center: 'items-center', 'flex-end': 'items-end', end: 'items-end', stretch: 'items-stretch', baseline: 'items-baseline' },
  'justify-content': { 'flex-start': 'justify-start', start: 'justify-start', center: 'justify-center', 'flex-end': 'justify-end', end: 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly', stretch: 'justify-stretch', normal: 'justify-normal' },
  'align-content': { 'flex-start': 'content-start', start: 'content-start', center: 'content-center', 'flex-end': 'content-end', end: 'content-end', 'space-between': 'content-between', 'space-around': 'content-around', 'space-evenly': 'content-evenly', stretch: 'content-stretch', normal: 'content-normal', baseline: 'content-baseline' },
  'justify-items': { start: 'justify-items-start', end: 'justify-items-end', center: 'justify-items-center', stretch: 'justify-items-stretch', normal: 'justify-items-normal' },
  'justify-self': { auto: 'justify-self-auto', start: 'justify-self-start', end: 'justify-self-end', center: 'justify-self-center', stretch: 'justify-self-stretch' },
  'align-self': { auto: 'self-auto', stretch: 'self-stretch', 'flex-start': 'self-start', start: 'self-start', center: 'self-center', 'flex-end': 'self-end', end: 'self-end', baseline: 'self-baseline' },
  overflow: { hidden: 'overflow-hidden', auto: 'overflow-auto', visible: 'overflow-visible', scroll: 'overflow-scroll', clip: 'overflow-clip' },
  'overflow-x': { hidden: 'overflow-x-hidden', auto: 'overflow-x-auto', visible: 'overflow-x-visible', scroll: 'overflow-x-scroll', clip: 'overflow-x-clip' },
  'overflow-y': { hidden: 'overflow-y-hidden', auto: 'overflow-y-auto', visible: 'overflow-y-visible', scroll: 'overflow-y-scroll', clip: 'overflow-y-clip' },
  'white-space': { 'pre-wrap': 'whitespace-pre-wrap', nowrap: 'whitespace-nowrap', normal: 'whitespace-normal', pre: 'whitespace-pre', 'pre-line': 'whitespace-pre-line', 'break-spaces': 'whitespace-break-spaces' },
  'text-align': { left: 'text-left', right: 'text-right', center: 'text-center', justify: 'text-justify', start: 'text-start', end: 'text-end' },
  'text-transform': { uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', none: 'normal-case' },
  'font-style': { italic: 'italic', normal: 'not-italic' },
  'text-decoration-line': { underline: 'underline', overline: 'overline', 'line-through': 'line-through', none: 'no-underline' },
  'border-style': { solid: 'border-solid', dashed: 'border-dashed', dotted: 'border-dotted', double: 'border-double', hidden: 'border-hidden', none: 'border-none' },
  visibility: { visible: 'visible', hidden: 'invisible', collapse: 'collapse' },
  'font-weight': { 100: 'font-thin', 200: 'font-extralight', 300: 'font-light', 400: 'font-normal', 500: 'font-medium', 600: 'font-semibold', 700: 'font-bold', 800: 'font-extrabold', 900: 'font-black', normal: 'font-normal', bold: 'font-bold' },
};
const PREFIX = { width: 'w', height: 'h', 'min-width': 'min-w', 'min-height': 'min-h', 'max-width': 'max-w', 'max-height': 'max-h', gap: 'gap', 'row-gap': 'gap-y', 'column-gap': 'gap-x', left: 'left', top: 'top', right: 'right', bottom: 'bottom', 'border-radius': 'rounded', 'line-height': 'leading', 'letter-spacing': 'tracking', 'font-weight': 'font', opacity: 'opacity' };
const BLUR_STEPS = { 4: 'xs', 8: 'sm', 12: 'md', 16: 'lg', 24: 'xl', 40: '2xl', 64: '3xl' };
const INSET = new Set(['top', 'right', 'bottom', 'left']);
const SIZES = new Set(['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height']);
const KEYWORD_OWNER = new Map(Object.entries(KEYWORD).flatMap(([property, values]) => Object.values(values).map(name => [name, property])));
/** Keyword values every size utility shares (`w-fit`, `max-h-none`), and the exact fractions worth a name. */
const SIZE_WORDS = { auto: 'auto', 'fit-content': 'fit', 'min-content': 'min', 'max-content': 'max', '100%': 'full', '50%': '1/2', '25%': '1/4', '75%': '3/4' };
/** Colour keywords that are exactly a Tailwind utility (`--color-white` is `#fff`, `--color-black` is `#000`). */
const COLOUR_WORDS = { transparent: 'transparent', currentcolor: 'current', currentColor: 'current', inherit: 'inherit', white: 'white', black: 'black' };

/** Tailwind arbitrary values use `_` for spaces; a literal underscore is escaped. */
const arbitrary = value => value.trim().replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/\s+/g, '_');
const VARIABLE = /^var\(--[A-Za-z0-9_-]+\)$/;
const LENGTH = /^(?:[-\d.]+(?:px|rem|em|%)?|auto)$/;
/** A literal colour value (as opposed to a length) inside an arbitrary `[…]`. */
const COLOURISH = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color|color-mix)\(|var\(--color-|color:)/i;
const PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const COLOUR_NAME = new RegExp(`^(?:transparent|current|inherit|white|black|(?:${PALETTE})-\\d{2,3})(?:/\\S+)?$`);

/** Interactive radius edits use Tailwind's named steps. */
const RADIUS_SCALE = { '0': 'rounded-none', '0px': 'rounded-none', '2px': 'rounded-xs', '4px': 'rounded-sm', '6px': 'rounded-md', '8px': 'rounded-lg', '12px': 'rounded-xl', '16px': 'rounded-2xl', '24px': 'rounded-3xl', '32px': 'rounded-4xl', '9999px': 'rounded-full', '999px': 'rounded-full', '50%': 'rounded-full' };

/** With `scale`, whole multiples of 4px use Tailwind's spacing scale (`p-4`, `gap-2`) instead of arbitrary values (`p-[16px]`). */
const scaleToken = value => (/^\d+px$/.test(value) && parseInt(value, 10) % 4 === 0 ? String(parseInt(value, 10) / 4) : /^0$/.test(value) ? '0' : null);
/**
 * The colour utility suffix for a value: a keyword utility, a literal in brackets or a shared token reference. Text always
 * carries the `color:` hint (`text-[…]` is also a font size); a border needs it only for a variable (`border-[…]` is also a width).
 */
function colourSuffix(value, colorOf, prefix) {
  if (Object.hasOwn(COLOUR_WORDS, value)) return COLOUR_WORDS[value];
  if (!/^#[0-9a-f]{3,8}$/i.test(value) && !VARIABLE.test(value)) return null;
  const token = VARIABLE.test(value) ? null : colorOf(value);
  const inner = token ? `var(${token})` : value;
  return prefix === 'text' || (prefix === 'border' && inner.startsWith('var(')) ? `[color:${inner}]` : `[${inner}]`;
}

/** The Tailwind class(es) for one declaration; `colorOf` maps a literal color to a shared token reference. */
export function declarationClass(property, value, colorOf = () => null, { scale = false } = {}) {
  value = value.trim();
  const keyword = KEYWORD[property]?.[value];
  if (keyword) return keyword;
  if ((property === 'width' || property === 'height') && value === '100%') return `${PREFIX[property]}-full`;
  if (property === 'font-size' && (/^[\d.]+(?:px|rem|em)$/.test(value) || VARIABLE.test(value))) return `text-[length:${value}]`;
  if (property === 'color' || property === 'background-color' || (scale && property === 'border-color')) {
    // Literal hex colours keep their spelling (`text-[color:#ffffff]`, not `text-white`); only colour keywords become named utilities.
    const prefix = { color: 'text', 'background-color': 'bg', 'border-color': 'border' }[property];
    const suffix = Object.hasOwn(COLOUR_WORDS, value) && !scale ? null : colourSuffix(value, colorOf, prefix);
    if (suffix) return `${prefix}-${suffix}`;
  }
  if ((property === 'padding' || property === 'margin') && value.split(' ').every(part => LENGTH.test(part)) && value.split(' ').length <= 4) return boxClasses(property === 'padding' ? 'p' : 'm', sidesOf(value.split(' ')), scale);
  if (scale && property === 'border-radius' && RADIUS_SCALE[value]) return RADIUS_SCALE[value];
  const corner = /^border-(top|bottom)-(left|right)-radius$/.exec(property);
  if (scale && corner && RADIUS_SCALE[value]) return RADIUS_SCALE[value].replace(/^rounded/, `rounded-${corner[1][0]}${corner[2][0]}`);
  if (scale && SIZES.has(property) && Object.hasOwn(SIZE_WORDS, value)) return `${PREFIX[property]}-${SIZE_WORDS[value]}`;
  if (scale && (property === 'gap' || property === 'row-gap' || property === 'column-gap' || property === 'line-height' || SIZES.has(property)) && scaleToken(value)) return `${PREFIX[property]}-${scaleToken(value)}`;
  // Whole-number steps have their own utilities (`opacity-40`, `z-10`, `blur-sm`, `grid-cols-3`); anything else stays arbitrary.
  if (scale && property === 'opacity') { const n = Number(value); const percent = Math.round(n * 100); if (value !== '' && Number.isFinite(n) && n >= 0 && n <= 1 && Math.abs(n * 100 - percent) < 1e-9) return `opacity-${percent}`; }
  if (scale && property === 'z-index') { if (/^-?\d+$/.test(value)) return value.startsWith('-') ? `-z-${value.slice(1)}` : `z-${value}`; if (value === 'auto') return 'z-auto'; }
  if (scale && property === 'filter') { const blur = /^blur\(\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(value); if (blur) { const step = BLUR_STEPS[blur[1]]; return step ? `blur-${step}` : `blur-[${blur[1]}px]`; } }
  if (scale && property === 'grid-template-columns') { const columns = /^repeat\(\s*(\d+)\s*,\s*minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)\s*\)$/.exec(value); if (columns && Number(columns[1]) >= 1 && Number(columns[1]) <= 12) return `grid-cols-${columns[1]}`; }
  // Offsets use the spacing scale too (`top-2`), with a leading minus for negative steps.
  if (scale && INSET.has(property)) { const negative = value.startsWith('-'); const token = scaleToken(negative ? value.slice(1) : value); if (token && !(negative && token === '0')) return `${negative ? '-' : ''}${property}-${token}`; }
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
  // A negative margin on the scale is `-mt-2`; anything else is an arbitrary value, sign included (`mt-[-3px]`).
  const name = (axis, value) => {
    if (value === 'auto') return `${letter}${axis}-auto`;
    const negative = letter === 'm' && scale && /^-\d+px$/.test(value) && scaleToken(value.slice(1));
    if (negative) return `-${letter}${axis}-${negative}`;
    return `${letter}${axis}-${(scale ? scaleToken(value) : null) ?? `[${value}]`}`;
  };
  if (present.length === 4 && SIDE_KEYS.every(key => sides[key] === sides.t)) return name('', sides.t);
  const out = [];
  const x = sides.l !== undefined && sides.l === sides.r, y = sides.t !== undefined && sides.t === sides.b;
  // A pair of equal opposite sides is one axis utility (`mx-auto`, `py-4`) when it is the whole edit or both pairs agree.
  if (x && y) return `${name('y', sides.t)} ${name('x', sides.l)}`;
  if (x && sides.t === undefined && sides.b === undefined) return name('x', sides.l);
  if (y && sides.l === undefined && sides.r === undefined) return name('y', sides.t);
  for (const key of SIDE_KEYS) if (sides[key] !== undefined) out.push(name(key, sides[key]));
  return out.join(' ');
}
/** Parse one existing padding/margin class into `{ letter, sides }`, or null when it is not understood (it then stays untouched). */
function parseBox(name) {
  const match = /^(-?)(p|m)(t|r|b|l|x|y)?-(?:\[([^\]]+)\]|(\d+(?:\.\d+)?)|(px)|(auto))$/.exec(name);
  if (!match) return null;
  const [, minus, letter, axis, arbitraryValue, scale, px, auto] = match;
  if (minus && letter === 'p') return null;
  let value = auto ? 'auto' : arbitraryValue ?? (px ? '1px' : Number(scale) === 0 ? '0' : `${Number(scale) * 4}px`);
  if (minus && value !== '0' && value !== 'auto') value = value.startsWith('-') ? value.slice(1) : `-${value}`;
  const which = !axis ? SIDE_KEYS : axis === 'x' ? ['l', 'r'] : axis === 'y' ? ['t', 'b'] : [axis];
  return { letter, sides: Object.fromEntries(which.map(key => [key, value])) };
}

/* ---- which longhands an existing utility sets --------------------------------------------------- */
const CORNER = { tl: 'border-top-left-radius', tr: 'border-top-right-radius', br: 'border-bottom-right-radius', bl: 'border-bottom-left-radius' };
const CORNERS_OF = { '': ['tl', 'tr', 'br', 'bl'], t: ['tl', 'tr'], r: ['tr', 'br'], b: ['br', 'bl'], l: ['tl', 'bl'], tl: ['tl'], tr: ['tr'], br: ['br'], bl: ['bl'] };
const EDGE = { t: 'top', r: 'right', b: 'bottom', l: 'left' };
const EDGES_OF = { '': ['t', 'r', 'b', 'l'], x: ['l', 'r'], y: ['t', 'b'], t: ['t'], r: ['r'], b: ['b'], l: ['l'] };
/** The longhands a property edit stands for: editing a shorthand replaces every utility that sets any of its parts. */
const LONGHANDS = {
  gap: ['row-gap', 'column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
  inset: ['top', 'right', 'bottom', 'left'],
  'border-radius': Object.values(CORNER),
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
};
const longhands = property => LONGHANDS[property] ?? [property];
const variantFree = name => { let depth = 0; for (const ch of name) { if (ch === '[' || ch === '(') depth++; else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1); else if (ch === ':' && !depth) return false; } return true; };
/** An arbitrary `[…]` value as CSS (Tailwind writes spaces as `_`). */
const bracketValue = text => /^\[(.+)\]$/.exec(text)?.[1].replace(/\\_/g, '\0').replace(/_/g, ' ').replace(/\0/g, '_') ?? null;
const isColourValue = (rest, colourNames) => {
  const inner = bracketValue(rest);
  if (inner !== null) return COLOURISH.test(inner) || (inner.startsWith('var(') && !inner.startsWith('length:'));
  return COLOUR_NAME.test(rest) || !!colourNames?.has(rest.replace(/\/\S+$/, ''));
};
const isLengthValue = rest => { const inner = bracketValue(rest); return inner !== null ? /^(?:length:|-?[\d.]+[a-z%]*$|(?:calc|clamp|min|max)\()/.test(inner) : /^\d+(?:\.\d+)?$/.test(rest) || rest === 'px'; };

/**
 * The longhand properties one base utility sets, and how to write the rest when an edit takes only some of them; null when
 * the class is not a core utility this writer understands (it is then left alone).
 */
function ownerOf(name, colourNames) {
  // `class!` (Tailwind 4) and the older `!class` mark the declarations important; they set the same properties.
  name = name.replace(/!$/, '').replace(/^!/, '');
  if (!variantFree(name)) return null;
  const own = (...props) => ({ props, split: null });
  const arbitraryProperty = /^\[([a-z-]+):(.+)\]$/.exec(name);
  if (arbitraryProperty) {
    const [, property, value] = arbitraryProperty, parts = longhands(property);
    if (parts.length === 1) return own(property);
    // One value for every part (`[border-width:3px]`) splits into the parts an edit leaves; a per-part list
    // (`[border-width:1px_2px]`) cannot be split faithfully, so it stays and the narrower edit is written after it.
    if (/(?<!\\)_/.test(value)) return null;
    return { props: parts, split: left => left.map(part => `[${part}:${value}]`) };
  }
  // `overflow-hidden` is a keyword of a shorthand: an axis edit must leave the other axis behind.
  let m = /^overflow-(x-|y-)?(.+)$/.exec(name);
  if (m) {
    if (m[1]) return own(m[1] === 'x-' ? 'overflow-x' : 'overflow-y');
    return { props: ['overflow-x', 'overflow-y'], split: left => left.map(prop => `overflow-${prop.slice(-1)}-${m[2]}`) };
  }
  if (KEYWORD_OWNER.has(name)) return own(...longhands(KEYWORD_OWNER.get(name)));
  const negative = name.startsWith('-');
  const bare = negative ? name.slice(1) : name;
  const sign = negative ? '-' : '';
  // Typography.
  if ((m = /^text-(.+)$/.exec(bare))) {
    const rest = m[1];
    // `text-sm/6` also sets the line height, which outlives a font-size edit as `leading-6`.
    const step = /^(xs|sm|base|lg|[2-9]?xl)(?:\/(.+))?$/.exec(rest);
    if (step) return step[2] ? { props: ['font-size', 'line-height'], split: left => left.map(prop => (prop === 'line-height' ? `leading-${step[2]}` : `text-${step[1]}`)) } : own('font-size');
    if (rest.startsWith('[length:')) return own('font-size');
    if (rest.startsWith('[color:')) return own('color');
    if (/^(?:wrap|nowrap|balance|pretty)$/.test(rest)) return own('text-wrap');
    if (/^(?:ellipsis|clip)$/.test(rest)) return own('text-overflow');
    if (isColourValue(rest, colourNames)) return own('color');
    if (isLengthValue(rest)) return own('font-size');
    return null;
  }
  if (/^leading-/.test(bare)) return own('line-height');
  if (/^tracking-/.test(bare)) return own('letter-spacing');
  // Only real family utilities: an authored class such as `font-lock` is not Tailwind's and must survive a family edit.
  if ((m = /^font-(.+)$/.exec(bare))) {
    if (/^\[\d/.test(m[1])) return own('font-weight');
    if (/^stretch-/.test(m[1])) return own('font-stretch');
    if (/^(?:sans|serif|mono|\[.+\])$/.test(m[1])) return own('font-family');
    return null;
  }
  if (/^whitespace-/.test(bare)) return own('white-space');
  // Backgrounds: only colours (`bg-cover`, `bg-[url(…)]` and gradients are other properties).
  if ((m = /^bg-(.+)$/.exec(bare))) return isColourValue(m[1], colourNames) && !/^\[(?:url|image|linear|radial|conic)/.test(m[1]) ? own('background-color') : null;
  // Borders: width, style or colour by value, per edge.
  if ((m = /^border(?:-([xytrbl]))?(?:-(.+))?$/.exec(bare))) {
    const [, edge = '', rest] = m;
    const edges = EDGES_OF[edge];
    if (rest === undefined || isLengthValue(rest)) {
      const props = edges.map(key => `border-${EDGE[key]}-width`);
      // Tailwind's width utilities also draw the line (`border-style: var(--tw-border-style)`, solid by default).
      return { props, drawsLine: true, split: left => left.map(prop => `border-${Object.keys(EDGE).find(key => `border-${EDGE[key]}-width` === prop)}${rest === undefined ? '' : `-${rest}`}`) };
    }
    if (isColourValue(rest, colourNames)) {
      const props = edges.map(key => `border-${EDGE[key]}-color`);
      return { props, split: left => left.map(prop => `border-${Object.keys(EDGE).find(key => `border-${EDGE[key]}-color` === prop)}-${rest}`) };
    }
    return null;
  }
  if ((m = /^rounded(?:-(tl|tr|br|bl|t|r|b|l))?(?:-(.+))?$/.exec(bare))) {
    const [, corner = '', rest] = m;
    const props = CORNERS_OF[corner].map(key => CORNER[key]);
    return { props, split: left => left.map(prop => `rounded-${Object.keys(CORNER).find(key => CORNER[key] === prop)}${rest === undefined ? '' : `-${rest}`}`) };
  }
  if (/^shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|none|\[.*\d.*\]))?$/.test(bare)) return own('box-shadow');
  // Spacing between items, overflow, sizes and offsets: shorthands split into what the edit leaves.
  if ((m = /^gap-(x-|y-)?(.+)$/.exec(bare))) {
    if (m[1]) return own(m[1] === 'x-' ? 'column-gap' : 'row-gap');
    return { props: ['row-gap', 'column-gap'], split: left => left.map(prop => `gap-${prop === 'row-gap' ? 'y' : 'x'}-${m[2]}`) };
  }
  if ((m = /^size-(.+)$/.exec(bare))) return { props: ['width', 'height'], split: left => left.map(prop => `${prop === 'width' ? 'w' : 'h'}-${m[1]}`) };
  if ((m = /^(min-w|max-w|min-h|max-h|w|h)-(.+)$/.exec(bare))) return own({ w: 'width', h: 'height', 'min-w': 'min-width', 'max-w': 'max-width', 'min-h': 'min-height', 'max-h': 'max-height' }[m[1]]);
  if ((m = /^inset-(?:(x|y)-)?(.+)$/.exec(bare))) {
    const props = EDGES_OF[m[1] ?? ''].map(key => EDGE[key]);
    return { props, split: left => left.map(prop => `${sign}${prop}-${m[2]}`) };
  }
  if ((m = /^(top|right|bottom|left)-/.exec(bare))) return own(m[1]);
  if (/^z-/.test(bare)) return own('z-index');
  if (/^opacity-/.test(bare)) return own('opacity');
  if (/^blur(?:-.+)?$/.test(bare)) return own('filter');
  if (/^grid-cols-/.test(bare)) return own('grid-template-columns');
  if (/^grid-rows-/.test(bare)) return own('grid-template-rows');
  if ((m = /^justify-(items|self)-/.exec(bare))) return own(`justify-${m[1]}`);
  if (/^justify-/.test(bare)) return own('justify-content');
  if (/^items-/.test(bare)) return own('align-items');
  if (/^self-/.test(bare)) return own('align-self');
  if (/^content-(?:start|end|center|between|around|evenly|stretch|baseline|normal)$/.test(bare)) return own('align-content');
  if ((m = /^place-(items|content|self)-(.+)$/.exec(bare))) {
    const [align, justify] = longhands(`place-${m[1]}`);
    const short = { 'align-items': 'items', 'align-content': 'content', 'align-self': 'self', 'justify-items': 'justify-items', 'justify-content': 'justify', 'justify-self': 'justify-self' };
    return { props: [align, justify], split: left => left.map(prop => `${short[prop]}-${m[2]}`) };
  }
  if (/^flex-(?:\d|auto|initial|none|\[)/.test(bare)) return own('flex-grow', 'flex-shrink', 'flex-basis');
  if (/^grow(?:-|$)/.test(bare)) return own('flex-grow');
  if (/^shrink(?:-|$)/.test(bare)) return own('flex-shrink');
  if (/^basis-/.test(bare)) return own('flex-basis');
  if (colourNames?.size && (m = /^(bg|text)-(.+)$/.exec(name)) && colourNames.has(m[2])) return own(m[1] === 'bg' ? 'background-color' : 'color');
  return null;
}

/** The CSS property a base (variant-free) class sets, or null when unknown. `colourNames` are the project's theme colour names
 * (`--color-brand` → `brand`), which own `bg-<name>` and `text-<name>`; built-in utilities always win over a theme name.
 * A utility that sets several longhands of one shorthand reports the shorthand (`gap-4` → `gap`, `rounded-lg` → `border-radius`). */
export function propertyOfClass(name, colourNames) {
  const owner = ownerOf(name, colourNames);
  if (!owner) return null;
  const { props } = owner;
  if (props.length === 1) return props[0];
  const shorthand = Object.entries(LONGHANDS).find(([, parts]) => parts.length === props.length && parts.every(part => props.includes(part)));
  return shorthand ? shorthand[0] : props[0];
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
    let text = value === null ? null : String(value).trim();
    // `value !important` is the same utility with Tailwind's important modifier (`pr-1!`); it is written as one class per
    // side, outside the padding/margin merge, so its priority stays on exactly the sides it was given for.
    const important = text !== null && /\s*!important$/i.test(text);
    if (important) text = text.replace(/\s*!important$/i, '');
    const box = important ? null : BOX_PROPERTY.exec(property);
    if (important && BOX_PROPERTY.test(property) && !text.split(/\s+/).every(part => LENGTH.test(part))) throw Object.assign(new Error(`${property} takes one to four lengths.`), { code: 'INVALID_PATCH' });
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
    // Every utility that sets a part of this property goes; one that also sets other parts leaves them as narrower utilities.
    const targets = new Set(longhands(property));
    const next = [];
    let lineLost = false;
    for (const name of tokens) {
      const owner = ownerOf(name, colourNames);
      if (!owner || !owner.props.some(prop => targets.has(prop))) { next.push(name); continue; }
      const left = owner.props.filter(prop => !targets.has(prop));
      if (left.length && owner.split) next.push(...owner.split(left));
      if (owner.drawsLine) lineLost = true;
    }
    // Tailwind's width utilities also draw the line (`border-style: var(--tw-border-style)`); the edited sides lose that with
    // them, so keep the line drawn unless a style utility states it.
    if (lineLost && !next.some(name => ownerOf(name, colourNames)?.props.includes('border-style'))) next.push('border-solid');
    tokens = next;
    if (text !== null && text !== '') tokens.push(...declarationClass(property, text, colorOf, { scale: true }).split(' ').map(name => (important ? `${name}!` : name)));
  }
  for (const kind of ['padding', 'margin']) if (boxes[kind]) {
    tokens = tokens.filter(name => !(parseBox(name)?.letter === kind[0]));
    const classes = boxClasses(kind[0], boxes[kind], true);
    if (classes) tokens.push(...classes.split(' '));
  }
  return [...new Set(tokens)].join(' ');
}
