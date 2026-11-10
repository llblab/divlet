// Layout, spacing and effects for selected elements — quick hands-on tools that write Tailwind
// classes (so the agent sees the same thing). With several elements selected, a change applies
// to all of them and differing values show as "Mixed".
import { el, icon, clamp } from '../../lib/util.js';
import { toast, newGroup } from '../../lib/store.js';
import { openMenu } from '../../lib/menu.js';
import * as tw from './tw.js';

const MIXED = Symbol('mixed');
const same = values => (values.every(value => value === values[0]) ? values[0] : MIXED);

const DISPLAY = [['block', 'Block'], ['flex', 'Flex'], ['grid', 'Grid'], ['inline', 'Inline'], ['inline-block', 'Inline block'], ['inline-flex', 'Inline flex'], ['inline-grid', 'Inline grid'], ['hidden', 'Hidden']];
const POSITION = [['static', 'Static'], ['relative', 'Relative'], ['absolute', 'Absolute'], ['fixed', 'Fixed'], ['sticky', 'Sticky']];
const AXIS = ['start', 'center', 'end'];
// How children are spread along the main axis (justify-content) and placed across it (align-items).
const JUSTIFY = [['start', 'Start'], ['center', 'Center'], ['end', 'End'], ['between', 'Between'], ['around', 'Around'], ['evenly', 'Evenly'], ['stretch', 'Stretch']];
const ALIGN = [['start', 'Start'], ['center', 'Center'], ['end', 'End'], ['stretch', 'Stretch'], ['baseline', 'Baseline']];
const ITEMS_X = [['start', 'Start'], ['center', 'Center'], ['end', 'End'], ['stretch', 'Stretch']];

// A field's focus session and whether the current commit comes from typing: the panel is one, so these live here.
// A session's edits (typing, then Enter) fold into one undo step, and a commit that lands mid-typing must not redraw the
// panel (that would take the input out from under the caret).
let sessionGroup = null;
let typingLive = false;

/* ---- small controls ---------------------------------------------------------- */

/** A labelled button that opens a menu of choices (with "Default" to remove the class). */
function pick(label, value, choices, onPick, { tip, variants = [] } = {}) {
  const node = el('button', 'pick');
  node.type = 'button';
  node.dataset.key = `pick:${label}`;
  node.setAttribute('aria-haspopup', 'menu');
  const shown = value === MIXED ? 'Mixed' : choices.find(([key]) => key === value)?.[1] ?? 'Default';
  node.setAttribute('aria-label', `${label}: ${shown}`);
  node.append(el('span', 'pick-k', label), el('span', `pick-v${value == null || value === MIXED ? ' faint' : ''}`, shown), icon('chevron', 'icon pick-caret'));
  if (variants.length) node.append(el('i', 'variant-dot'));
  node.dataset.tip = [tip || label, variants.length ? `also ${variants.join(' ')}` : ''].filter(Boolean).join(' · ');
  node.addEventListener('click', () => openMenu([
    ...choices.map(([key, text]) => ({ label: text, checked: key === value, run: () => onPick(key) })),
    '-',
    { label: 'Default', checked: value == null, run: () => onPick(null) },
  ], { anchor: node, label }));
  return node;
}

/** Icon buttons where one is on (or none, for "mixed" and defaults). */
function segmented(label, value, options, onPick) {
  const group = el('div', 'segs');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  for (const [key, iconName, tip] of options) {
    const node = el('button', `seg-icon${key === value ? ' on' : ''}`);
    node.type = 'button';
    node.dataset.tip = tip;
    node.setAttribute('aria-label', tip);
    node.setAttribute('aria-pressed', String(key === value));
    node.append(icon(iconName));
    node.addEventListener('click', () => onPick(key === value ? null : key));
    group.append(node);
  }
  return group;
}

function toggle(iconName, tip, on, run) {
  const node = el('button', `seg-icon solo${on ? ' on' : ''}`);
  node.type = 'button';
  node.dataset.tip = tip;
  node.setAttribute('aria-label', tip);
  node.setAttribute('aria-pressed', String(!!on));
  node.append(icon(iconName));
  node.addEventListener('click', run);
  return node;
}

/**
 * A compact value field: a short label you can drag to scrub (Shift ×10), arrows step by 1,
 * any text the parser accepts (px numbers, auto, 50%, 1/2). Empty clears the value.
 */
function field(key, label, value, onCommit, { tip, placeholder = '', parse = raw => raw, step = 1, min = -1e6, max = 1e6, variants = [], unit = '' } = {}) {
  const wrap = el('label', 'vf');
  const name = el('span', 'vf-k', label);
  const input = el('input', 'vf-input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.dataset.key = key;
  const shown = value === MIXED ? '' : value == null ? '' : String(value);
  input.value = shown;
  input.placeholder = value === MIXED ? '—' : placeholder;
  if (value === MIXED) wrap.classList.add('mixed');
  input.setAttribute('aria-label', tip || label);
  name.dataset.tip = `${tip || label}${value === MIXED ? ' · mixed' : ''}${variants.length ? ` · also ${variants.join(' ')}` : ''} · drag to scrub`;
  if (variants.length) wrap.append(el('i', 'variant-dot'));
  wrap.prepend(name, input);
  let syncUnit = () => {};
  // The unit stays visible beside plain numbers (and the empty default); words and fractions such as auto or 1/2 carry none.
  if (unit) {
    const suffix = el('span', 'vf-unit', unit);
    suffix.setAttribute('aria-hidden', 'true');
    const sync = () => { suffix.hidden = !/^-?\d*\.?\d*$/.test(input.value.trim()); };
    syncUnit = sync;
    input.addEventListener('input', sync);
    wrap.append(suffix);
    sync();
    input.addEventListener('change', sync);
    input.addEventListener('blur', sync);
  }
  let current = shown;
  // Typing commits too: a short pause after a valid value sends it, so the board follows the field without Enter. All the
  // commits of one focus session share a group (one undo step); text the parser rejects waits for Enter or blur, where it is
  // reported as before.
  let typing = 0;
  input.addEventListener('focus', () => { sessionGroup = newGroup(); });
  input.addEventListener('blur', () => { clearTimeout(typing); sessionGroup = null; });
  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      const text = input.value.trim();
      if (text === current || parse(text) === undefined) return;
      commit(text, { live: true });
    }, 140);
  });
  const commit = (raw, { live = false } = {}) => {
    const text = String(raw).trim();
    if (text === current) return;
    const parsed = parse(text);
    if (parsed === undefined) { toast(`“${text}” is not a value for ${tip || label}`); input.value = current; return; }
    current = text;
    typingLive = live;
    try { onCommit(parsed, text); } finally { typingLive = false; }
  };
  input.addEventListener('focus', () => input.select());
  input.addEventListener('change', () => commit(input.value));
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); commit(input.value); input.blur(); }
    else if (event.key === 'Escape') { input.value = current; input.blur(); }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const number = Number.parseFloat(input.value || placeholder || '0');
      if (!Number.isFinite(number)) return;
      event.preventDefault();
      input.value = String(clamp(number + (event.key === 'ArrowUp' ? step : -step) * (event.shiftKey ? 10 : 1), min, max));
      syncUnit();
      commit(input.value);
    }
  });
  name.addEventListener('pointerdown', event => {
    const origin = Number.parseFloat(input.value || placeholder || '0');
    if (!Number.isFinite(origin)) return;
    event.preventDefault();
    name.setPointerCapture(event.pointerId);
    const x0 = event.clientX;
    wrap.classList.add('scrubbing');
    const move = e => { input.value = String(clamp(origin + Math.round((e.clientX - x0) / 3) * step * (e.shiftKey ? 10 : 1), min, max)); syncUnit(); };
    const up = () => {
      name.removeEventListener('pointermove', move);
      name.removeEventListener('pointerup', up);
      name.removeEventListener('pointercancel', up);
      wrap.classList.remove('scrubbing');
      commit(input.value);
    };
    name.addEventListener('pointermove', move);
    name.addEventListener('pointerup', up);
    name.addEventListener('pointercancel', up);
  });
  return wrap;
}

/** 3×3 cells: which one is on, and what a click on a cell does. */
/* ---- appearance: corner radius, fill and text colour --------------------------------------------- */
const RADIUS_PRESETS = [['0', 'rounded-none'], ['4', 'rounded-sm'], ['8', 'rounded-lg'], ['12', 'rounded-xl'], ['16', 'rounded-2xl'], ['Full', 'rounded-full']];
const RADIUS_PX = { 'rounded-none': 0, 'rounded-xs': 2, 'rounded-sm': 4, rounded: 4, 'rounded-md': 6, 'rounded-lg': 8, 'rounded-xl': 12, 'rounded-2xl': 16, 'rounded-3xl': 24, 'rounded-4xl': 32 };
const KEYWORD_COLORS = { transparent: 'transparent', white: '#ffffff', black: '#000000' };

/** `rgb(12, 34, 56)` / `rgba(...)` from the page → `#0c2238` (alpha dropped); null when not a colour. */
const hexOf = css => {
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(String(css || ''));
  return m ? `#${[m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('')}` : /^#[0-9a-f]{6}$/i.test(css || '') ? css.toLowerCase() : null;
};
const alphaOf = css => { const m = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(String(css || '')); return m ? Number(m[1]) : 1; };

/** What a person typed (hex, a project token, white/black/transparent) → a class for `prefix` (bg or text), or undefined. */
function colorClass(prefix, raw) {
  const text = String(raw || '').trim();
  if (/^(transparent|white|black)$/i.test(text)) return `${prefix}-${text.toLowerCase()}`;
  if (/^current(color)?$/i.test(text)) return `${prefix}-current`;
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
  const inner = hex ? `#${hex[1].toLowerCase()}` : /^var\(--color-[a-z0-9-]+\)$/i.test(text) ? text : null;
  if (!inner) return undefined;
  return prefix === 'text' ? `text-[color:${inner}]` : `${prefix}-[${inner}]`;
}

/** The colour a class stands for, as something to show: `#112233`, `var(--color-brand)` or the class name for a palette colour. */
const classColor = name => (name ? (/^(?:bg|text|border)-\[(?:color:)?(.+)\]$/.exec(name)?.[1] ?? name.replace(/^(?:bg|text|border)-/, '')) : null);

function colorField({ key, label, tip, group, prefix, value, run, computed, tokens }) {
  const wrap = el('div', 'color-field');
  const current = value(cls => classColor(tw.get(cls, group)));
  const shownHex = current === MIXED ? null : hexOf(current) || KEYWORD_COLORS[current] || hexOf(computed);
  const swatch = el('input', 'swatch color-pick');
  swatch.type = 'color';
  swatch.value = /^#[0-9a-f]{6}$/i.test(shownHex || '') ? shownHex : '#000000';
  swatch.dataset.key = `${key}-swatch`;
  swatch.setAttribute('aria-label', `${label} colour picker`);
  const hex = el('input', 'vf-input color-hex');
  hex.type = 'text';
  hex.spellcheck = false;
  hex.autocomplete = 'off';
  hex.dataset.key = key;
  hex.value = current === MIXED || current == null ? '' : current;
  hex.placeholder = current === MIXED ? '—' : hexOf(computed) ?? (computed ? 'inherited' : 'none');
  hex.setAttribute('aria-label', tip);
  const set = (raw, shown) => {
    const next = colorClass(prefix, raw);
    if (next === undefined) { toast(`“${raw}” is not a colour: use #rrggbb, a project colour or white, black, transparent`); hex.value = hex.dataset.last ?? ''; return; }
    hex.dataset.last = hex.value = shown ?? raw;
    run(cls => tw.set(cls, group, next), `${label.toLowerCase()} ${shown ?? raw}`);
  };
  swatch.addEventListener('change', () => set(swatch.value));
  hex.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); if (hex.value.trim()) set(hex.value); hex.blur(); } else if (event.key === 'Escape') { hex.value = hex.dataset.last ?? hex.defaultValue; hex.blur(); } });
  hex.addEventListener('change', () => { if (hex.value.trim()) set(hex.value); });
  hex.addEventListener('focus', () => hex.select());
  const clear = el('button', 'tool mini color-clear');
  clear.type = 'button';
  clear.append(icon('close'));
  clear.setAttribute('aria-label', `Remove ${label.toLowerCase()}`);
  clear.dataset.tip = `Remove the ${label.toLowerCase()} class`;
  clear.hidden = current == null || current === MIXED;
  clear.addEventListener('click', () => run(cls => tw.set(cls, group, null), `no ${label.toLowerCase()}`));
  const name = el('span', 'vf-k', label);
  wrap.append(name, swatch, hex, clear);
  if (alphaOf(computed) < 1 && current == null) hex.title = 'Semi-transparent in the page';
  if (tokens.length) {
    const row = el('div', 'token-swatches');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', `${label} from the project colours`);
    for (const [token, tokenValue] of tokens.slice(0, 12)) {
      const dot = el('button', 'token-swatch');
      dot.type = 'button';
      // The board page does not define the project's custom properties: paint the swatch with the token's own value.
      if (/^#[0-9a-f]{3,8}$/i.test(String(tokenValue))) dot.style.background = tokenValue;
      dot.dataset.tip = token.replace(/^--color-/, '');
      dot.setAttribute('aria-label', `${label}: ${token.replace(/^--color-/, '')}`);
      dot.addEventListener('click', () => set(`var(${token})`, `var(${token})`));
      row.append(dot);
    }
    const box = el('div', 'color-block');
    box.append(wrap, row);
    return box;
  }
  return wrap;
}

function appearanceFold(nodes, { value, run, measured, tokens }) {
  const box = el('div', 'appearance-box');
  const radiusClass = value(cls => tw.get(cls, 'radius'));
  const radiusPx = radiusClass === MIXED ? MIXED : radiusClass == null ? null : radiusClass === 'rounded-full' ? 'Full' : RADIUS_PX[radiusClass] ?? (/^rounded-\[(\d+(?:\.\d+)?)px\]$/.exec(radiusClass)?.[1] ?? radiusClass);
  const computedRadius = measured?.colors?.radius ? String(Math.round(parseFloat(measured.colors.radius) || 0)) : '0';
  const radius = field('radius', 'R', radiusPx, (next, text) => run(cls => tw.set(cls, 'radius', next), `radius ${text || 'default'}`), {
    tip: 'Corner radius, px · type Full for a pill', unit: 'px', placeholder: computedRadius, min: 0, max: 1000,
    parse: raw => (/^full$/i.test(raw.trim()) ? 'rounded-full' : raw.trim() === '' ? null : /^\d+(?:\.\d+)?$/.test(raw.trim()) ? (Object.entries(RADIUS_PX).find(([, px]) => px === Number(raw.trim()))?.[0] ?? `rounded-[${Number(raw.trim())}px]`) : undefined),
  });
  const presets = el('div', 'radius-presets');
  presets.setAttribute('role', 'group');
  presets.setAttribute('aria-label', 'Corner radius presets');
  for (const [text, name] of RADIUS_PRESETS) {
    const chip = el('button', `chip${radiusClass === name ? ' on' : ''}`, text);
    chip.type = 'button';
    chip.dataset.tip = name === 'rounded-full' ? 'Fully rounded' : `${text}px corners`;
    chip.addEventListener('click', () => run(cls => tw.set(cls, 'radius', name), `radius ${text}`));
    presets.append(chip);
  }
  // Typography: size (Tailwind steps or any px) and weight.
  const FONT_STEPS = { 'text-xs': 12, 'text-sm': 14, 'text-base': 16, 'text-lg': 18, 'text-xl': 20, 'text-2xl': 24, 'text-3xl': 30, 'text-4xl': 36, 'text-5xl': 48, 'text-6xl': 60, 'text-7xl': 72, 'text-8xl': 96, 'text-9xl': 128 };
  const sizeClass = value(cls => tw.get(cls, 'fontSize'));
  const sizePx = sizeClass === MIXED ? MIXED : sizeClass == null ? null : FONT_STEPS[sizeClass] ?? /^text-\[length:(\d+(?:\.\d+)?)px\]$/.exec(sizeClass)?.[1] ?? sizeClass;
  const WEIGHTS = [['thin', 'Thin 100'], ['extralight', 'Extra light 200'], ['light', 'Light 300'], ['normal', 'Regular 400'], ['medium', 'Medium 500'], ['semibold', 'Semibold 600'], ['bold', 'Bold 700'], ['extrabold', 'Extra bold 800'], ['black', 'Black 900']];
  const weight = value(cls => tw.get(cls, 'fontWeight')?.slice(5) ?? null);
  const type = el('div', 'grid2');
  type.append(
    field('font-size', 'Aa', sizePx, next => run(cls => tw.set(cls, 'fontSize', next), `font size ${next ? sizePx === next ? '' : next.replace(/^text-/, '') : 'default'}`), {
      tip: 'Font size, px', unit: 'px', placeholder: measured?.colors?.fontSize ? String(Math.round(parseFloat(measured.colors.fontSize) || 16)) : '16', min: 1, max: 400,
      parse: raw => { const t = raw.trim(); if (!t) return null; if (!/^\d+(?:\.\d+)?$/.test(t)) return undefined; const hit = Object.entries(FONT_STEPS).find(([, px]) => px === Number(t)); return hit ? hit[0] : `text-[length:${Number(t)}px]`; },
    }),
    pick('Weight', weight, WEIGHTS, next => run(cls => tw.set(cls, 'fontWeight', next ? `font-${next}` : null), next ? `weight ${next}` : 'default weight'), { tip: 'Font weight' }),
  );
  // Border: width presets or any px, and a colour.
  const BORDER_STEPS = [['0', 'border-0'], ['1', 'border'], ['2', 'border-2'], ['4', 'border-4']];
  const borderClass = value(cls => tw.get(cls, 'borderWidth'));
  const borderPx = borderClass === MIXED ? MIXED : borderClass == null ? null : borderClass === 'border' ? 1 : borderClass === 'border-0' ? 0 : /^border-(\d+)$/.exec(borderClass)?.[1] ?? /^border-\[(\d+(?:\.\d+)?)px\]$/.exec(borderClass)?.[1] ?? borderClass;
  const border = field('border-width', 'B', borderPx, next => run(cls => tw.set(cls, 'borderWidth', next), `border ${next ? '' : 'none'}`.trim()), {
    tip: 'Border width, px', unit: 'px', placeholder: '0', min: 0, max: 64,
    parse: raw => { const t = raw.trim(); if (!t) return null; if (!/^\d+(?:\.\d+)?$/.test(t)) return undefined; return Number(t) === 1 ? 'border' : Number(t) === 0 ? 'border-0' : [2, 4, 8].includes(Number(t)) ? `border-${Number(t)}` : `border-[${Number(t)}px]`; },
  });
  const borderPresets = el('div', 'radius-presets');
  borderPresets.setAttribute('role', 'group');
  borderPresets.setAttribute('aria-label', 'Border width presets');
  for (const [text, name] of BORDER_STEPS) {
    const chip = el('button', `chip${borderClass === name ? ' on' : ''}`, text);
    chip.type = 'button';
    chip.dataset.tip = `${text}px border`;
    chip.addEventListener('click', () => run(cls => tw.set(cls, 'borderWidth', name), `border ${text}px`));
    borderPresets.append(chip);
  }
  const geometry = el('div', 'appearance-geometry');
  geometry.append(radius, border, presets, borderPresets);
  box.append(
    geometry,
    colorField({ key: 'fill', label: 'Fill', tip: 'Background colour', group: 'bgColor', prefix: 'bg', value, run, computed: measured?.colors?.background, tokens }),
    colorField({ key: 'stroke', label: 'Border', tip: 'Border colour', group: 'borderColor', prefix: 'border', value, run, computed: measured?.colors?.borderColor, tokens }),
    colorField({ key: 'ink', label: 'Text', tip: 'Text colour', group: 'textColor', prefix: 'text', value, run, computed: measured?.colors?.color, tokens }),
    type,
  );
  return box;
}

function alignGrid(label, x, y, onPick) {
  const grid = el('div', 'align-grid');
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', label);
  for (const row of AXIS) for (const col of AXIS) {
    const cell = el('button', `align-cell${col === x && row === y ? ' on' : col === x || row === y ? ' half' : ''}`);
    cell.type = 'button';
    const name = row === 'center' && col === 'center' ? 'center' : `${row === 'start' ? 'top' : row === 'end' ? 'bottom' : 'middle'} ${col === 'start' ? 'left' : col === 'end' ? 'right' : 'center'}`;
    cell.dataset.tip = `${label}: ${name}`;
    cell.setAttribute('aria-label', `${label} ${name}`);
    cell.setAttribute('aria-pressed', String(col === x && row === y));
    cell.append(el('i'));
    cell.addEventListener('click', () => onPick(col, row));
    grid.append(cell);
  }
  return grid;
}

const caption = text => el('span', 'caption', text);

function labeledSegments(label, control) {
  const group = el('div', 'labeled-segs');
  group.append(caption(label), control);
  return group;
}

/* ---- sections ------------------------------------------------------------------- */

/**
 * `nodes` are the selected elements (one or more), `parent` the single selection's parent (or
 * null), `apply(transform, label)` rewrites each element's className and commits once.
 */
export function layoutSections(nodes, { parent, apply, spacingFocus, measured = null, tokens = [] }) {
  tw.setColorNames(tokens.map(([name]) => name.replace(/^--color-/, '')));
  const classes = nodes.map(node => node.className || '');
  const value = fn => same(classes.map(fn));
  const variants = test => [...new Set(classes.flatMap(cls => tw.variantsOf(cls, test)))].slice(0, 4);
  const subject = nodes.length === 1 ? `#${nodes[0].id}` : `${nodes.length} elements`;
  const run = (fn, label) => apply(fn, `${label} on ${subject}`, { group: sessionGroup, refresh: !typingLive });

  /* layout */
  const display = value(cls => tw.get(cls, 'display'));
  const position = value(cls => tw.get(cls, 'position'));
  const layout = el('div', 'layout-box');
  const top = el('div', 'grid2');
  top.append(
    pick('Display', display, DISPLAY, next => run(cls => tw.set(cls, 'display', next), next ? `display ${next}` : 'default display'), { variants: variants('display') }),
    pick('Position', position, POSITION, next => run(cls => tw.set(cls, 'position', next), next ? next : 'default position'), { variants: variants('position') }),
  );
  layout.append(top);

  const isFlex = display === 'flex' || display === 'inline-flex';
  const isGrid = display === 'grid' || display === 'inline-grid';
  if (isFlex || isGrid) {
    const align = value(cls => JSON.stringify(tw.alignment(cls)));
    const current = align === MIXED ? { x: null, y: null, between: false } : JSON.parse(align);
    const row = el('div', 'flow-row');
    row.append(alignGrid('Align children', current.x, current.y, (x, y) => run(cls => tw.setAlignment(cls, x, y), `align ${y} ${x}`)));
    const side = el('div', 'flow-side');
    if (isFlex) {
      const direction = value(cls => (/^flex-col/.test(tw.get(cls, 'direction') || '') ? 'col' : 'row'));
      const wrap = value(cls => tw.get(cls, 'wrap') === 'flex-wrap');
      const tools = el('div', 'segs-row');
      tools.append(
        segmented('Direction', direction === MIXED ? null : direction, [['row', 'arrowRight', 'Row (flex-row)'], ['col', 'arrowDown', 'Column (flex-col)']], next => run(cls => tw.set(cls, 'direction', next === 'col' ? 'flex-col' : null), next === 'col' ? 'column' : 'row')),
        toggle('wrapLines', 'Wrap (flex-wrap)', wrap === true, () => run(cls => tw.set(cls, 'wrap', wrap === true ? null : 'flex-wrap'), wrap === true ? 'no wrap' : 'wrap')),
      );
      side.append(tools);
    } else {
      const cols = value(cls => tw.split(cls).filter(name => !tw.hasVariant(name) && /^grid-cols-\d+$/.test(name)).map(name => Number(name.slice(10))).at(-1) ?? null);
      side.append(field('grid-cols', 'Cols', cols, n => run(cls => {
        const without = tw.split(cls).filter(name => tw.hasVariant(name) || !/^grid-cols-/.test(name));
        return [...without, ...(n ? [`grid-cols-${n}`] : [])].join(' ');
      }, n ? `${n} columns` : 'default columns'), { tip: 'Columns (grid-cols-N)', placeholder: '1', min: 1, max: 12, parse: raw => (raw === '' ? null : /^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 12 ? Number(raw) : undefined) }));
    }
    const gap = value(cls => tw.valueOf(cls, 'gap'));
    side.append(field('gap', 'Gap', gap, next => run(cls => tw.set(cls, 'gap', next), `gap ${next ?? 'none'}`), { tip: 'Gap between children, px', unit: 'px', placeholder: '0', min: 0, parse: raw => tw.classFor('gap', raw) }));
    row.append(side);
    layout.append(row);
    // Beyond the 3×3 pad: spread (between / around / evenly), stretch and baseline.
    const justify = value(cls => tw.get(cls, 'justify')?.slice('justify-'.length) ?? null);
    const alignItems = value(cls => tw.get(cls, 'items')?.slice('items-'.length) ?? null);
    const spread = el('div', 'grid2');
    spread.append(
      pick(isFlex ? 'Justify' : 'Spread', justify, JUSTIFY, next => run(cls => tw.set(cls, 'justify', next ? `justify-${next}` : null), next ? `justify ${next}` : 'default justify'), { tip: isFlex ? 'Along the main axis (justify-content)' : 'Spread the columns (justify-content)', variants: variants('justify') }),
      pick('Align', alignItems, ALIGN, next => run(cls => tw.set(cls, 'items', next ? `items-${next}` : null), next ? `align ${next}` : 'default align'), { tip: 'Across the main axis (align-items)', variants: variants('items') }),
    );
    if (isGrid) {
      const itemsX = value(cls => tw.get(cls, 'justifyItems')?.slice('justify-items-'.length) ?? null);
      spread.append(pick('Items', itemsX, ITEMS_X, next => run(cls => tw.set(cls, 'justifyItems', next ? `justify-items-${next}` : null), next ? `items ${next}` : 'default items'), { tip: 'Inside each cell, horizontally (justify-items)', variants: variants('justifyItems') }));
    }
    layout.append(spread);
  }

  // Not a flex or grid container yet: one click centres what is inside it, or the element itself in its parent.
  if (!isFlex && !isGrid) {
    const centre = el('div', 'centre-row');
    centre.append(el('span', 'vf-k', 'Center'));
    const inside = el('button', 'link-button', 'Content');
    inside.type = 'button';
    inside.dataset.key = 'center-content';
    inside.dataset.tip = 'Centre the children horizontally and vertically (flex, items-center, justify-center)';
    inside.addEventListener('click', () => run(cls => tw.set(tw.set(tw.set(cls, 'display', 'flex'), 'items', 'items-center'), 'justify', 'justify-center'), 'center content'));
    const itself = el('button', 'link-button', 'Element');
    itself.type = 'button';
    itself.dataset.key = 'center-element';
    itself.dataset.tip = 'Centre this element horizontally in its parent (auto side margins)';
    itself.addEventListener('click', () => run(cls => tw.setSide(tw.setSide(cls, 'margin', 'l', 'auto'), 'margin', 'r', 'auto'), 'center element'));
    centre.append(inside, itself);
    layout.append(centre);
  }

  const pinned = position === 'absolute' || position === 'fixed' || position === 'sticky';
  if (pinned) {
    const where = value(cls => JSON.stringify(tw.pin(cls)));
    const current = where === MIXED ? { x: null, y: null } : JSON.parse(where);
    const row = el('div', 'flow-row');
    row.append(alignGrid('Pin to', current.x, current.y, (x, y) => run(cls => tw.setPin(cls, x, y), `pin ${y} ${x}`)));
    const inset = el('div', 'box4');
    for (const [side, tip] of [['t', 'Top'], ['r', 'Right'], ['b', 'Bottom'], ['l', 'Left']]) {
      const token = value(cls => tw.sides(cls, 'inset')[side]);
      inset.append(field(`inset-${side}`, tip, token === MIXED ? MIXED : tw.display(token), next => run(cls => tw.setSide(cls, 'inset', side, next), `${tip.toLowerCase()} ${next ?? 'auto'}`), { tip: `${tip} offset, px`, unit: 'px', placeholder: 'auto', parse: tw.fromInput }));
    }
    row.append(inset);
    layout.append(row);
  }

  const text = value(cls => tw.get(cls, 'textAlign')?.slice(5) ?? null);
  const textRow = el('div', 'segs-row align-controls');
  textRow.append(labeledSegments('Text', segmented('Text align', text === MIXED ? null : text, [['left', 'textL', 'Align left'], ['center', 'textC', 'Align center'], ['right', 'textR', 'Align right'], ['justify', 'textJ', 'Justify']], next => run(cls => tw.set(cls, 'textAlign', next ? `text-${next}` : null), next ? `text ${next}` : 'default text align'))));
  const parentFlow = parent ? tw.get(parent.className || '', 'display') : null;
  if (parentFlow && /flex|grid/.test(parentFlow) && !pinned) {
    const self = value(cls => tw.get(cls, 'self')?.slice(5) ?? null);
    textRow.append(labeledSegments('Self', segmented('Align self in the parent', self === MIXED ? null : self, [['start', 'alignT', 'Self: start'], ['center', 'alignCV', 'Self: center'], ['end', 'alignB', 'Self: end'], ['stretch', 'distV', 'Self: stretch']], next => run(cls => tw.set(cls, 'self', next ? `self-${next}` : null), next ? `self ${next}` : 'default self'))));
  }
  layout.append(textRow);

  /* Eight independent fields: margin around padding, with quiet side labels and no linking modes. */
  const spacing = el('div', 'spacing-box');
  const model = el('div', 'boxmodel');
  model.setAttribute('role', 'group');
  model.setAttribute('aria-label', 'Spacing in pixels');
  const sideNames = { t: 'top', r: 'right', b: 'bottom', l: 'left' };
  const spaceField = (kind, short, side) => {
    const token = value(cls => tw.sides(cls, kind)[side]);
    const node = field(`${short}-${side}`, '', token === MIXED ? MIXED : tw.display(token), next => {
      run(cls => tw.setSide(cls, kind, side, next), `${kind} ${sideNames[side]} ${next == null ? 'none' : tw.display(next)}`);
    }, { tip: '', placeholder: String(measured?.[kind]?.['trbl'.indexOf(side)] ?? 0), min: kind === 'padding' ? 0 : -1e4, parse: tw.fromInput });
    node.classList.add('bm-field');
    const label = `${kind[0].toUpperCase()}${kind.slice(1)} ${sideNames[side]}, px`;
    node.setAttribute('aria-label', label);
    node.querySelector('input').setAttribute('aria-label', label);
    node.querySelector('.vf-k')?.remove();
    const hint = el('span', 'bm-side', sideNames[side]);
    hint.setAttribute('aria-hidden', 'true');
    node.prepend(hint);
    const light = on => spacingFocus?.(on ? { kind, sides: [side] } : null);
    node.addEventListener('pointerenter', () => light(true));
    node.addEventListener('pointerleave', () => { if (!node.contains(document.activeElement)) light(false); });
    node.addEventListener('focusin', () => light(true));
    node.addEventListener('focusout', () => light(false));
    return node;
  };
  const square = (kind, inner = null) => {
    const sq = el('div', `bm-sq bm-${kind}`);
    sq.setAttribute('role', 'group');
    sq.setAttribute('aria-label', kind === 'margin' ? 'Margin' : 'Padding');
    for (const side of ['t', 'r', 'b', 'l']) {
      const cell = el('div', `bm-cell bm-${side}`);
      cell.append(spaceField(kind, kind === 'margin' ? 'm' : 'p', side));
      sq.append(cell);
    }
    const centre = el('div', 'bm-centre');
    centre.append(inner ?? el('div', 'bm-core', 'content'));
    const mark = el('span', 'bm-mark', kind === 'margin' ? 'M' : 'P');
    mark.setAttribute('aria-hidden', 'true');
    sq.append(centre, mark);
    return sq;
  };
  const unit = el('span', 'bm-unit', 'px');
  unit.setAttribute('aria-hidden', 'true');
  model.append(square('margin', square('padding')), unit);
  spacing.append(model);

  /* effects */
  const effects = el('div', 'box3');
  const opacity = value(cls => tw.valueOf(cls, 'opacity'));
  const z = value(cls => tw.valueOf(cls, 'z'));
  const blur = value(cls => tw.valueOf(cls, 'blur'));
  effects.append(
    field('opacity', 'Opacity', opacity, next => run(cls => tw.set(cls, 'opacity', next), `opacity ${next ? next.slice(8) : 100}%`), { tip: 'Opacity, %', unit: '%', placeholder: '100', min: 0, max: 100, parse: raw => tw.classFor('opacity', raw) }),
    field('z', 'Z-index', z, next => run(cls => tw.set(cls, 'z', next), `z-index ${next ?? 'auto'}`), { tip: 'Stacking order (z-index)', placeholder: 'auto', parse: raw => tw.classFor('z', raw) }),
    field('blur', 'Blur', blur, next => run(cls => tw.set(cls, 'blur', next), `blur ${next ?? 'none'}`), { tip: 'Blur, px', unit: 'px', placeholder: '0', min: 0, max: 200, parse: raw => tw.classFor('blur', raw) }),
  );

  // Fold order in the inspector: Appearance sits last, under Spacing and Effects.
  return [['layout', 'Layout', layout], ['spacing', 'Spacing', spacing], ['effects', 'Effects', effects], ['appearance', 'Appearance', appearanceFold(nodes, { value, run, measured, tokens })]];
}
