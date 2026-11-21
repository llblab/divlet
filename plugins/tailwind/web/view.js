// What a class list says, as the CSS declarations it stands for: the Tailwind representation reader for the core property
// controls. Pure functions, no DOM, unit-tested in Node. Only base classes are read (no `md:`/`hover:` prefix); responsive and
// state classes stay where they are and are reported separately so the controls can point at them.
//
// This is a view, never a store: a control edit becomes a `styles` patch and the writer lowers it to utilities (applyStyles in
// lib/styles.js). Anything this reader cannot express is simply absent from the view, and its classes are left untouched.
import * as tw from './tw.js';

const RADIUS_PX = { 'rounded-none': 0, 'rounded-xs': 2, 'rounded-sm': 4, rounded: 4, 'rounded-md': 6, 'rounded-lg': 8, 'rounded-xl': 12, 'rounded-2xl': 16, 'rounded-3xl': 24, 'rounded-4xl': 32 };
const FONT_STEPS = { 'text-xs': 12, 'text-sm': 14, 'text-base': 16, 'text-lg': 18, 'text-xl': 20, 'text-2xl': 24, 'text-3xl': 30, 'text-4xl': 36, 'text-5xl': 48, 'text-6xl': 60, 'text-7xl': 72, 'text-8xl': 96, 'text-9xl': 128 };
const WEIGHTS = { thin: '100', extralight: '200', light: '300', normal: '400', medium: '500', semibold: '600', bold: '700', extrabold: '800', black: '900' };
const LINE_STEPS = { 'leading-none': '1', 'leading-tight': '1.25', 'leading-snug': '1.375', 'leading-normal': '1.5', 'leading-relaxed': '1.625', 'leading-loose': '2' };
/** Whether a bracketed `text-[…]` value is a size rather than a colour: `text-[12.5px]` is a font size, `text-[#fff]` a colour. */
const isSizeValue = value => /^[-+]?(?:\d*\.?\d+)(?:px|rem|em|%|pt|pc|ch|ex|vw|vh|vmin|vmax)$/i.test(value) || /^(?:calc|clamp|min|max)\(/.test(value);
const EDGE = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch', baseline: 'baseline', normal: 'normal', auto: 'auto' };
const JUSTIFY = { ...EDGE, between: 'space-between', around: 'space-around', evenly: 'space-evenly' };
const SIZE_PREFIX = { 'min-w': 'min-width', 'min-h': 'min-height', 'max-w': 'max-width', 'max-h': 'max-height', w: 'width', h: 'height' };
const SIDES = { t: 'top', r: 'right', b: 'bottom', l: 'left' };

/** A spacing/size token as a CSS value: 4 → `16px`, `[13px]` → `13px`, 1/2 → `50%`, full → `100%`; null when not understood. */
export function cssOfToken(token) {
  if (token == null) return null;
  const px = tw.toPx(token);
  if (typeof px === 'number') return px === 0 ? '0' : `${px}px`;
  if (px === 'auto') return 'auto';
  if (px === 'full') return '100%';
  const fraction = /^(-?)(\d+)\/(\d+)$/.exec(px);
  if (fraction) return `${fraction[1]}${Math.round(Number(fraction[2]) / Number(fraction[3]) * 1e6) / 1e4}%`;
  const bracket = /^(-?)\[(.+)\]$/.exec(px);
  return bracket ? `${bracket[1]}${bracket[2].replace(/_/g, ' ')}` : null;
}

const KEYWORD_COLOURS = { white: '#ffffff', black: '#000000', transparent: 'transparent', current: 'currentColor', inherit: 'inherit' };
/** The colour a `bg-`/`text-`/`border-` value stands for: a literal, a palette/theme variable or a keyword. Alpha suffixes are dropped. */
function colourOfValue(rest, names) {
  const bracket = /^\[(?:color:)?(.+)\]$/.exec(rest);
  if (bracket) return bracket[1].replace(/_/g, ' ');
  const plain = rest.replace(/\/\d+$/, '');
  if (Object.hasOwn(KEYWORD_COLOURS, plain)) return KEYWORD_COLOURS[plain];
  if (/^(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}$/.test(plain) || names.has(plain)) return `var(--color-${plain})`;
  return null;
}

/** The declarations of one base class, in the order they set them; [] when the class is not one the controls understand. */
export function declarationsOfClass(name, names = new Set()) {
  const out = [];
  const arbitrary = /^\[([a-z-]+):(.+)\]$/.exec(name);
  if (arbitrary) return [[arbitrary[1], arbitrary[2].replace(/\\_/g, '\0').replace(/_/g, ' ').replace(/\0/g, '_')]];
  if (tw.GROUPS.display.test(name)) return [['display', name === 'hidden' ? 'none' : name]];
  if (tw.GROUPS.position.test(name)) return [['position', name]];
  let m = /^flex-(row|col|row-reverse|col-reverse)$/.exec(name);
  if (m) return [['flex-direction', m[1].replace('col', 'column')]];
  m = /^flex-(wrap|nowrap|wrap-reverse)$/.exec(name);
  if (m) return [['flex-wrap', m[1]]];
  m = /^justify-(start|end|center|between|around|evenly|stretch|normal)$/.exec(name);
  if (m) return [['justify-content', JUSTIFY[m[1]]]];
  m = /^items-(start|end|center|baseline|stretch)$/.exec(name);
  if (m) return [['align-items', EDGE[m[1]]]];
  m = /^justify-items-(start|end|center|stretch|normal)$/.exec(name);
  if (m) return [['justify-items', m[1]]];
  m = /^self-(auto|start|end|center|stretch|baseline)$/.exec(name);
  if (m) return [['align-self', EDGE[m[1]]]];
  m = /^text-(left|center|right|justify|start|end)$/.exec(name);
  if (m) return [['text-align', m[1]]];
  if (tw.GROUPS.opacity.test(name)) { const value = tw.valueOf(name, 'opacity'); return value == null ? [] : [['opacity', String(value / 100)]]; }
  if (tw.GROUPS.z.test(name)) { const value = tw.valueOf(name, 'z'); return value == null ? [] : [['z-index', String(value)]]; }
  if (tw.GROUPS.blur.test(name)) { const value = tw.valueOf(name, 'blur'); return value == null ? [] : [['filter', `blur(${value}px)`]]; }
  m = /^gap-(?!x-|y-)(.+)$/.exec(name);
  if (m) { const value = cssOfToken(m[1]); return value ? [['gap', value]] : []; }
  m = /^gap-(x|y)-(.+)$/.exec(name);
  if (m) { const value = cssOfToken(m[2]); return value ? [[m[1] === 'x' ? 'column-gap' : 'row-gap', value]] : []; }
  if (tw.GROUPS.radius.test(name)) {
    if (name === 'rounded-full') return [['border-radius', '9999px']];
    const literal = /^rounded-\[(.+)\]$/.exec(name);
    if (literal) return [['border-radius', literal[1]]];
    return Object.hasOwn(RADIUS_PX, name) ? [['border-radius', `${RADIUS_PX[name]}px`]] : [];
  }
  // `text-sm/6` sets a size and a line height; the step after the slash follows the spacing scale.
  m = /^(text-[a-z0-9]+)\/(\d+)$/.exec(name);
  if (m && Object.hasOwn(FONT_STEPS, m[1])) return [['font-size', `${FONT_STEPS[m[1]]}px`], ['line-height', `${Number(m[2]) * 4}px`]];
  if (Object.hasOwn(FONT_STEPS, name)) return [['font-size', `${FONT_STEPS[name]}px`]];
  m = /^text-\[length:(.+)\]$/.exec(name);
  if (m) return [['font-size', m[1]]];
  // A bare bracket without a colour is a size when its value reads as a length: `text-[12.5px]`, not a colour named 12.5px.
  m = /^text-\[(.+)\]$/.exec(name);
  if (m && !/^color:/.test(m[1]) && isSizeValue(m[1])) return [['font-size', m[1].replace(/_/g, ' ')]];
  if (Object.hasOwn(LINE_STEPS, name)) return [['line-height', LINE_STEPS[name]]];
  m = /^leading-(\d+)$/.exec(name);
  if (m) return [['line-height', `${Number(m[1]) * 4}px`]];
  m = /^leading-\[(.+)\]$/.exec(name);
  if (m) return [['line-height', m[1].replace(/_/g, ' ')]];
  m = /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/.exec(name);
  if (m) return [['font-weight', WEIGHTS[m[1]]]];
  m = /^font-\[(\d+)\]$/.exec(name);
  if (m) return [['font-weight', m[1]]];
  if (tw.GROUPS.borderWidth.test(name)) { const px = /^border-(\d+)$/.exec(name)?.[1] ?? (name === 'border' ? '1' : /^border-\[(\d+(?:\.\d+)?)px\]$/.exec(name)?.[1]); return px == null ? [] : [['border-width', `${px}px`]]; }
  m = /^border-(solid|dashed|dotted|double|hidden|none)$/.exec(name);
  if (m) return [['border-style', m[1]]];
  m = /^grid-cols-(\d+)$/.exec(name);
  if (m) return [['grid-template-columns', `repeat(${m[1]}, minmax(0, 1fr))`]];
  // Colours: the prefix says which property. Text colour is tried after the size/align keywords above have been excluded.
  m = /^(bg|text|border)-(.+)$/.exec(name);
  if (m) {
    const colour = colourOfValue(m[2], names);
    if (colour) return [[{ bg: 'background-color', text: 'color', border: 'border-color' }[m[1]], colour]];
  }
  m = /^(min-w|min-h|max-w|max-h|w|h)-(.+)$/.exec(name);
  if (m) { const value = cssOfToken(m[2]); return value ? [[SIZE_PREFIX[m[1]], value]] : []; }
  return out;
}

/** The authored CSS of a class list: later classes win, more specific box classes (`pt-2` over `p-4`) win over shorthands. */
export function classView(className, { tokens = {} } = {}) {
  const names = new Set(Object.keys(tokens).flatMap(token => { const match = /^--color-(.+)$/.exec(token); return match ? [match[1]] : []; }));
  tw.setColorNames(names);
  const view = {};
  const important = {};
  for (const name of tw.split(className).filter(item => !tw.hasVariant(item))) {
    // `class!` sets the same declarations with !important (`!class` is the older spelling); they win over the rest, box sides included.
    const strong = /!$/.test(name) || /^!/.test(name);
    for (const [property, value] of declarationsOfClass(name.replace(/!$/, '').replace(/^!/, ''), names)) (strong ? important : view)[property] = strong ? `${value} !important` : value;
  }
  for (const kind of ['padding', 'margin', 'inset']) {
    const sides = tw.sides(className, kind);
    for (const [side, token] of Object.entries(sides)) {
      if (token == null) continue;
      const value = cssOfToken(token);
      if (value) view[kind === 'inset' ? SIDES[side] : `${kind}-${SIDES[side]}`] = value;
    }
  }
  const tx = tw.get(className, 'translateX'), ty = tw.get(className, 'translateY');
  if ((tx || ty) && view.transform === undefined) {
    const part = (name, prefix) => (name ? (/^-?translate-[xy]-(?:1\/2)$/.test(name) ? (name.startsWith('-') ? '-50%' : '50%') : cssOfToken(name.replace(prefix, '')) ?? '0') : '0');
    view.transform = `translate(${part(tx, /^(-?)translate-x-/)}, ${part(ty, /^(-?)translate-y-/)})`;
  }
  return Object.assign(view, important);
}

/** Responsive or state classes that set the same CSS property as `property`, so a control can say "also md:flex". */
export function variantClasses(className, property) {
  const names = tw.split(className).filter(tw.hasVariant);
  const base = item => { let depth = 0, cut = -1; for (let i = 0; i < item.length; i++) { const ch = item[i]; if (ch === '[' || ch === '(') depth++; else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1); else if (ch === ':' && !depth) cut = i; } return item.slice(cut + 1); };
  return names.filter(item => declarationsOfClass(base(item)).some(([name]) => name === property));
}

/** The CSS properties a class list sets unconditionally (variant classes set none: they never replace an inline declaration). */
export function propertiesOfClass(name) {
  return tw.hasVariant(name) ? [] : Object.keys(classView(name));
}

/** Inline declarations a one-click conversion may hand to the utility writer: plain values only (no priorities, URLs or custom properties). */
export function convertibleInline(style) {
  return Object.entries(style || {}).filter(([property, value]) => !property.startsWith('--') && !/!important|url\(|image-set\(/i.test(String(value)));
}
