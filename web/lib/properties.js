// Layout, spacing, border, effects and appearance for selected elements: the core property controls.
// They read the element's authored CSS (inline declarations, plus whatever a registered representation reader contributes) and
// write `styles` edits: `{ property: value | null }`. The writer stores them as native inline declarations, or as utility classes
// when a style engine is active, so these controls never depend on a plugin. With several elements selected, a change applies
// to all of them and differing values show as "Mixed".
import { el, icon, clamp } from './util.js';
import { toast, newGroup } from './store.js';
import { openMenu } from './menu.js';
import * as css from './css-props.js';

const MIXED = Symbol('mixed');
const same = values => (values.every(value => value === values[0]) ? values[0] : MIXED);

const DISPLAY = [['block', 'Block'], ['flex', 'Flex'], ['grid', 'Grid'], ['inline', 'Inline'], ['inline-block', 'Inline block'], ['inline-flex', 'Inline flex'], ['inline-grid', 'Inline grid'], ['none', 'Hidden']];
const OVERFLOW = [['visible', 'Visible'], ['hidden', 'Hidden'], ['clip', 'Clip'], ['scroll', 'Scroll'], ['auto', 'Auto']];
const POSITION = [['static', 'Static'], ['relative', 'Relative'], ['absolute', 'Absolute'], ['fixed', 'Fixed'], ['sticky', 'Sticky']];
const AXIS = ['start', 'center', 'end'];
// How children are spread along the main axis (justify-content) and placed across it (align-items).
const JUSTIFY = [['start', 'Start'], ['center', 'Center'], ['end', 'End'], ['space-between', 'Between'], ['space-around', 'Around'], ['space-evenly', 'Evenly'], ['stretch', 'Stretch']];
const ALIGN = [['start', 'Start'], ['center', 'Center'], ['end', 'End'], ['stretch', 'Stretch'], ['baseline', 'Baseline']];
const ITEMS_X = [['start', 'Start'], ['center', 'Center'], ['end', 'End'], ['stretch', 'Stretch']];

// A field's focus session and whether the current commit comes from typing: the panel is one, so these live here.
// A session's edits (typing, then Enter) fold into one undo step, and a commit that lands mid-typing must not redraw the
// panel (that would take the input out from under the caret).
let sessionGroup = null;
let typingLive = false;

/* ---- small controls ---------------------------------------------------------- */

/** A labelled button that opens a menu of choices (with "Default" to remove the declaration). */
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
 * stepFrom defines the numeric gesture/arrow origin independently of the authored-value parser.
 */
const UNIT_NAMES = { '%': 'Percent %', px: 'Pixels px', em: 'Em em', rem: 'Rem rem', '×': 'Multiple ×' };

function field(key, label, value, onCommit, { tip, placeholder = '', parse = raw => raw, stepFrom = Number.parseFloat, step = 1, min = -1e6, max = 1e6, variants = [], unit = '', units = null, defaultUnit = null, spell = false, unitOnNumbers = false } = {}) {
  const wrap = el('label', 'vf');
  const name = el('span', 'vf-k scrub', label);
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
  // A bare number typed into a field with a unit menu is written in the unit the menu names, so `50` beside `%` is `50%`.
  let spelling = text => text;
  // A unit typed into the number (`100%`) moves to the unit button once the value is accepted; the field then holds only the number.
  let adoptUnit = () => {};
  // A unit button: it names the unit the value is written in and rewrites the same length in another one, so a line height
  // can be read and written as `150%`, `24px`, `1.5em` or `1.5` without leaving the field. A value that has no unit yet
  // (empty, `normal`) keeps the unit last chosen for this field, opening with the field's own default.
  if (units) {
    const unitButton = el('button', 'vf-unit unit-switch');
    unitButton.type = 'button';
    unitButton.dataset.key = `unit:${key}`;
    unitButton.setAttribute('aria-haspopup', 'menu');
    unitButton.setAttribute('aria-label', `${tip || label} unit`);
    let chosen = null;
    const now = () => chosen || unit || defaultUnit;
    if (spell) spelling = text => (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text) && now() && now() !== '×' ? `${text}${now()}` : text);
    // A keyword such as `full` or `normal` is not a number and has no unit, so the button steps aside until a number returns.
    // `unitOnNumbers`: the unit belongs to a plain number only, whether typed or quoted by the placeholder (`auto`, `var(--x)` have none).
    const sync = () => {
      unitButton.textContent = now();
      unitButton.hidden = unitOnNumbers ? !/^-?(?:\d+\.?\d*|\.\d+)$/.test(input.value.trim() || input.placeholder) : /^[a-z][a-z-]*$/i.test(input.value.trim());
    };
    adoptUnit = to => { chosen = to; sync(); };
    syncUnit = sync;
    // A new unit changes only the unit: the number stays exactly as written, so `100` % switched to px is `100px`. Nothing is
    // converted — the point is to correct a unit chosen by mistake without retyping the number. A field with no number yet
    // (`normal`, a keyword, empty) only remembers the unit for the next one.
    const applyUnit = to => {
      const written = input.value.trim();
      chosen = to;
      sync();
      if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(written) || to === unit) { if (written && to === unit) { chosen = null; sync(); } return; }
      const spelled = to === '×' ? written : `${written}${to}`;
      const parsed = parse(spelled);
      if (parsed === undefined) { toast(`“${spelled}” is not a value for ${tip || label}`); chosen = null; sync(); return; }
      onCommit(parsed, spelled);
    };
    unitButton.addEventListener('pointerdown', event => event.stopPropagation());
    unitButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      // The entries are the units themselves (`px`, `%`, `rem`), never a name beside a symbol; the name is only the tooltip.
      openMenu(units.map(unitKey => ({ label: unitKey, hint: UNIT_NAMES[unitKey], checked: now() === unitKey, run: () => applyUnit(unitKey) })), { anchor: unitButton, label: 'Unit', className: 'menu-units' });
    });
    input.addEventListener('input', sync);
    wrap.append(unitButton);
    sync();
  } else if (unit) {
    // The unit stays visible beside plain numbers (and the empty default); words and fractions such as auto or 1/2 carry none.
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
  input.addEventListener('divlet:field-value', event => {
    if (document.activeElement === input || wrap.classList.contains('scrubbing')) return;
    const { value, placeholder } = event.detail;
    current = input.value = value === MIXED || value == null ? '' : String(value);
    input.placeholder = value === MIXED ? '—' : placeholder;
    wrap.classList.toggle('mixed', value === MIXED);
    syncUnit();
  });
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
      if (text === current || parse(spelling(text)) === undefined) return;
      commit(text, { live: true });
    }, 140);
  });
  const commit = (raw, { live = false } = {}) => {
    const text = String(raw).trim();
    if (text === current) return;
    const parsed = parse(spelling(text));
    if (parsed === undefined) { toast(`“${text}” is not a value for ${tip || label}`); input.value = current; return; }
    const typed = units ? /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|%)$/i.exec(text) : null;
    if (typed && units.includes(typed[2].toLowerCase())) { adoptUnit(typed[2].toLowerCase()); input.value = typed[1]; syncUnit(); }
    current = typed && units.includes(typed[2].toLowerCase()) ? typed[1] : text;
    typingLive = live;
    try { onCommit(parsed, text); } finally { typingLive = false; }
  };
  input.addEventListener('focus', () => input.select());
  input.addEventListener('change', () => commit(input.value));
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Tab') commit(input.value, { live: true }); // Let native focus order run without replacing the departing input.
    else if (event.key === 'Enter') { event.preventDefault(); commit(input.value); input.blur(); }
    else if (event.key === 'Escape') { input.value = current; input.blur(); }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const number = stepFrom(input.value || placeholder || '0');
      if (!Number.isFinite(number)) return;
      event.preventDefault();
      input.value = String(clamp(number + (event.key === 'ArrowUp' ? step : -step) * (event.shiftKey ? 10 : 1), min, max));
      syncUnit();
      commit(input.value);
    }
  });
  name.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || wrap.classList.contains('scrubbing')) return;
    const origin = stepFrom(input.value || placeholder || '0');
    if (!Number.isFinite(origin)) return;
    event.preventDefault();
    clearTimeout(typing);
    name.setPointerCapture(event.pointerId);
    const initial = input.value, x0 = event.clientX;
    wrap.classList.add('scrubbing');
    const move = e => {
      const delta = Math.round((e.clientX - x0) / 3) * step * (e.shiftKey ? 10 : 1);
      input.value = delta ? String(clamp(origin + delta, min, max)) : initial;
      syncUnit();
    };
    const finish = cancelled => {
      name.removeEventListener('pointermove', move);
      name.removeEventListener('pointerup', up);
      name.removeEventListener('pointercancel', cancel);
      name.removeEventListener('lostpointercapture', cancel);
      document.removeEventListener('keydown', keydown, true);
      wrap.classList.remove('scrubbing');
      if (name.hasPointerCapture(event.pointerId)) name.releasePointerCapture(event.pointerId);
      if (cancelled) { input.value = initial; syncUnit(); }
      else commit(input.value);
    };
    const up = () => finish(false);
    const cancel = () => finish(true);
    const keydown = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
    name.addEventListener('pointermove', move);
    name.addEventListener('pointerup', up);
    name.addEventListener('pointercancel', cancel);
    name.addEventListener('lostpointercapture', cancel);
    document.addEventListener('keydown', keydown, true);
  });
  return wrap;
}

/** 3×3 cells: which one is on, and what a click on a cell does. */

/* ---- appearance: corner radius, fill and text colour --------------------------------------------- */
const KEYWORD_COLORS = { transparent: 'transparent', white: '#ffffff', black: '#000000' };
const SIDE_NAMES = { t: 'top', r: 'right', b: 'bottom', l: 'left' };
const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const alphaOf = value => { const m = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(String(value || '')); return m ? Number(m[1]) : 1; };

let paintCanvas = null;
/**
 * A colour the page reports, in any notation, as `#rrggbb`: the plain `rgb()` forms are parsed, and anything else a browser can paint
 * (`oklch()`, `color-mix()`, `color()`, a named colour) by painting one pixel with it and reading it back, so a colour set in a modern
 * notation shows as itself instead of falling back to black. Transparent, or not a colour at all, is null.
 */
function paintedHex(colour) {
  const text = String(colour ?? '').trim();
  if (!text || /^(?:transparent|rgba?\([^)]*(?:,\s*0|\/\s*0)\s*\))$/i.test(text)) return null;
  const plain = css.hexOf(text);
  if (plain) return plain;
  paintCanvas ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  paintCanvas.clearRect(0, 0, 1, 1);
  paintCanvas.fillStyle = '#fe01fd';
  paintCanvas.fillStyle = text;
  // An unparseable value leaves the sentinel in place; the sentinel itself is not a colour a page would report.
  if (paintCanvas.fillStyle === '#fe01fd' && text.toLowerCase() !== '#fe01fd') return null;
  paintCanvas.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = paintCanvas.getImageData(0, 0, 1, 1).data;
  return a ? `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}` : null;
}

/** The colour a value stands for, as something to show: `#112233`, `var(--color-brand)` or the keyword. */
const colourShown = value => (value == null ? null : String(value));

function colorField({ key, label, tip, property, value, run, computed, tokens, compact = false }) {
  const wrap = el('div', 'color-field');
  const current = value(view => colourShown(view[property]));
  // No colour of its own (the page's inherited one shows) or several different ones: the swatch says so with hatching.
  wrap.classList.toggle('mixed', current === MIXED);
  wrap.classList.toggle('unset', current == null);
  const shownHex = current === MIXED ? null : css.hexOf(current) || KEYWORD_COLORS[current] || paintedHex(computed);
  const swatch = el('input', 'swatch color-pick');
  swatch.type = 'color';
  swatch.value = /^#[0-9a-f]{6}$/i.test(shownHex || '') ? shownHex : '#000000';
  swatch.dataset.key = `${key}-swatch`;
  swatch.setAttribute('aria-label', `${label} color picker`);
  const hex = el('input', 'vf-input color-hex');
  hex.type = 'text';
  hex.spellcheck = false;
  hex.autocomplete = 'off';
  hex.dataset.key = key;
  hex.value = current === MIXED || current == null ? '' : current;
  hex.placeholder = current === MIXED ? '—' : paintedHex(computed) ?? (computed ? 'inherited' : 'none');
  hex.setAttribute('aria-label', tip);
  const fitHex = () => hex.style.setProperty('--hex-width', `calc(${Math.max(7, (hex.value || hex.placeholder).length) + 2}ch + 8px)`);
  hex.addEventListener('input', fitHex);
  // A colour follows the picker and the typed text instead of waiting for the dialog to close. Each gesture (a drag, or one
  // focus session) is one group, so the whole change stays one Undo step; a live write keeps the next value pending instead
  // of stacking a backlog, so the page converges on the colour last picked, and it skips the forced re-render that would
  // replace the control under the pointer.
  let picking = 0, typing = 0, pending = null, inFlight = false;
  const begin = () => { if (!sessionGroup) sessionGroup = newGroup(); };
  const settle = () => { clearTimeout(picking); clearTimeout(typing); pending = null; sessionGroup = null; };
  const set = (raw, shown, { live = false } = {}) => {
    const next = css.colourInput(raw);
    if (next === undefined) { toast(`“${raw}” is not a color: use #rrggbb, a project color or white, black, transparent`); hex.value = hex.dataset.last ?? ''; fitHex(); return null; }
    const text = shown ?? raw;
    hex.dataset.last = text;
    // A queued live write must not overwrite text the user is still typing into the field.
    if (!(live && document.activeElement === hex && hex.value.trim() !== String(text).trim())) hex.value = text;
    fitHex();
    typingLive = live;
    try { return run({ [property]: next }, `${label.toLowerCase()} ${shown ?? raw}`); } finally { typingLive = false; }
  };
  const pump = () => {
    if (inFlight || pending === null) return;
    const raw = pending; pending = null;
    inFlight = true;
    Promise.resolve(set(raw, raw, { live: true })).catch(() => null).finally(() => { inFlight = false; pump(); });
  };
  // A window stays open for the length of one write, so a continuous drag keeps sending the latest colour instead of waiting
  // for the pointer to stop.
  const follow = raw => {
    pending = raw;
    if (picking) return;
    picking = setTimeout(() => { picking = 0; pump(); }, 40);
  };
  swatch.addEventListener('focus', begin);
  swatch.addEventListener('blur', settle);
  swatch.addEventListener('input', () => {
    begin();
    // The field shows the picked colour at once; the page follows within one write.
    hex.dataset.last = hex.value = swatch.value;
    fitHex();
    follow(swatch.value);
  });  // The dialog closing ends the gesture: the last colour is accepted with a normal re-render.
  swatch.addEventListener('change', () => { begin(); clearTimeout(picking); pending = null; set(swatch.value, swatch.value); settle(); });
  hex.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); if (hex.value.trim()) set(hex.value); hex.blur(); } else if (event.key === 'Escape') { hex.value = hex.dataset.last ?? hex.defaultValue; fitHex(); hex.blur(); } });
  hex.addEventListener('change', () => { if (hex.value.trim()) set(hex.value); });
  hex.addEventListener('focus', () => { begin(); hex.select(); });
  hex.addEventListener('blur', settle);
  // Typing a colour commits a short pause after it parses; a half-typed value waits for Enter or blur, where it is reported.
  hex.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      if (css.colourInput(hex.value.trim()) === undefined) return;
      if (hex.value.trim() === hex.dataset.last) return;
      begin();
      follow(hex.value.trim());
    }, 140);
  });
  const clear = el('button', 'tool mini color-clear');
  clear.type = 'button';
  clear.append(icon('close'));
  clear.setAttribute('aria-label', `Remove ${label.toLowerCase()}`);
  clear.dataset.tip = `Remove the ${label.toLowerCase()}`;
  clear.hidden = current == null || current === MIXED;
  clear.addEventListener('click', () => run({ [property]: null }, `no ${label.toLowerCase()}`));
  const name = el('span', 'vf-k', label);
  // The name is the field's label, not a scrub handle: it opens the same picker as the swatch and a drag on it writes nothing.
  name.setAttribute('aria-hidden', 'true');
  name.dataset.tip = `${label} · open the colour picker`;
  name.addEventListener('click', () => {
    try { if (swatch.showPicker) { swatch.showPicker(); return; } } catch {}
    swatch.click();
  });
  fitHex();
  wrap.append(name, swatch, ...(compact ? [] : [hex, clear]));
  if (alphaOf(computed) < 1 && current == null) hex.title = 'Semi-transparent in the page';
  // A swatch-only field is the selector and nothing else: the native picker holds the value, its tip says which side it paints,
  // and Delete or Backspace removes that side's own colour.
  if (compact) {
    wrap.classList.add('color-swatch-only');
    name.remove();
    swatch.setAttribute('aria-label', label);
    swatch.dataset.tip = `${label} · ${hex.placeholder || hex.value || 'open the colour picker'}`;
    swatch.addEventListener('keydown', event => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      event.preventDefault();
      run({ [property]: null }, `no ${label.toLowerCase()}`);
    });
  }
  if (tokens.length && !compact) {
    const row = el('div', 'token-swatches');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', `${label} from the project colors`);
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

const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset', 'none', 'hidden'].map(name => [name, name[0].toUpperCase() + name.slice(1)]);

const BORDER_SIDES = ['top', 'right', 'bottom', 'left'];
const BORDER_SIDES_MENU = [['top', 'Top'], ['right', 'Right'], ['bottom', 'Bottom'], ['left', 'Left']];

function borderFold(views, { value, run, measured, tokens }) {
  const box = el('div', 'border-box');
  const style = value(view => {
    const sides = BORDER_SIDES.map(side => view[`border-${side}-style`] ?? view['border-style'] ?? null);
    const first = sides[0];
    if (!sides.every(item => item === first)) return MIXED;
    return first === null || BORDER_STYLES.some(([key]) => key === first) ? first : MIXED;
  });
  const measuredStyle = measured?.colors?.borderStyle;
  const effectiveStyle = measuredStyle !== undefined && measuredStyle !== null ? (style === MIXED || !BORDER_STYLES.some(([key]) => key === measuredStyle) ? MIXED : measuredStyle) : style;
  box.append(
    pick('Style', effectiveStyle, BORDER_STYLES, next => run({
      // Per-side styles go first: the shorthand that follows then replaces them without expanding.
      ...Object.fromEntries(BORDER_SIDES.map(side => [`border-${side}-style`, null])),
      'border-style': next,
    }, `border style ${next ?? 'default'}`)),
    borderDiagram({ value, run, measured, tokens }),
  );
  return box;
}

/** A parsed px length from an authored or measured value, or null. */
const pxOf = raw => {
  if (raw == null) return null;
  const text = String(raw).trim();
  const match = /^(-?(?:\d+\.?\d*|\.\d+))px$/.exec(text);
  return match ? Number(match[1]) : /^-?(?:\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : null;
};

/**
 * The border as a frame: the box model's border band pulled out at its own size, its four sides cut on the diagonals into the
 * trapezoids of a picture frame with a one-pixel seam between them, like the band's own line. Each trapezoid is the colour
 * selector of its own side and is painted in that colour, so the preview and the control are one thing. The four corner radii sit
 * outside the frame, in the gutters beside its corners (above and below it in a panel too narrow for a gutter), where they can never
 * cover a side, and the cut-out middle — the box model's
 * padding band — always holds one radius for all four corners and one colour for all four sides. Edge widths are not repeated
 * here: they live on the four sides of the box model's border band.
 */
function borderDiagram({ value, run, measured, tokens }) {
  const box = el('div', 'br-box');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Border frame: the colour of each side');
  const hole = el('div', 'br-hole');
  const CORNERS = [['tl', 'top-left'], ['tr', 'top-right'], ['bl', 'bottom-left'], ['br', 'bottom-right']];
  const measuredOf = corner => pxOf(measured?.colors?.[`radius${corner === 'tl' ? 'TopLeft' : corner === 'tr' ? 'TopRight' : corner === 'bl' ? 'BottomLeft' : 'BottomRight'}`]);
  // The number and its unit are separate: the unit is a menu on the right of the field that swaps only the unit, and a bare
  // number typed beside it takes that unit.
  const radiusOptions = (tip, quoted, unit) => ({
    tip, placeholder: quoted == null ? '—' : String(Math.round(quoted)), min: 0, max: 1e4, parse: css.radiusInput, spell: true,
    units: ['px', '%', 'rem', 'em'], defaultUnit: 'px', unit: unit === MIXED ? '' : unit || '',
  });
  const corner = key => {
    const named = CORNERS.find(([short]) => short === key)[1];
    const property = `border-${named}-radius`;
    const shown = value(v => { const radius = css.cornerRadiusNumber(v, named); return radius === undefined ? MIXED : radius; });
    const unit = value(v => css.cornerRadiusUnit(v, named));
    // The empty field quotes the radius this corner has on the page, so a radius set by a stylesheet is still visible.
    const node = field(`radius-${key}`, '', shown, next => run({ [property]: next }, `${named.replace('-', ' ')} radius ${next ?? 'default'}`), radiusOptions(`${named.replace('-', ' ')} corner radius`, measuredOf(key), unit));
    node.querySelector('.vf-k')?.remove();
    node.classList.add('br-field', `br-${key}`);
    node.setAttribute('aria-label', `${named} corner radius`);
    return node;
  };
  // A colour selector over the whole trapezoid of one side: the native picker's swatch fills it and paints it.
  const sides = {};
  for (const side of BORDER_SIDES) {
    const label = `${BORDER_SIDES_MENU.find(([key]) => key === side)[1]} border`;
    const node = colorField({
      key: `stroke-${side}`, label, tip: `Border ${side} color`, property: `border-${side}-color`, value, run,
      computed: measured?.colors?.[`border${side[0].toUpperCase()}${side.slice(1)}Color`], tokens, compact: true,
    });
    node.classList.add('br-colour');
    node.setAttribute('aria-label', `${label} colour`);
    const wrap = el('div', `br-side br-${side[0]}`);
    wrap.append(node);
    sides[side] = wrap;
  }
  const centre = el('div', 'br-centre');
  // One radius for all four corners: it reads as one value only while they agree, and writing it replaces every corner at once,
  // so a value authored per corner cannot survive behind it and contradict what the field says.
  const agreed = read => {
    const all = CORNERS.map(([, corner]) => read(corner));
    if (all.some(item => item === undefined)) return MIXED;
    return all.every(item => item === all[0]) ? all[0] : MIXED;
  };
  const every = value(view => agreed(corner => css.cornerRadiusNumber(view, corner)));
  const everyUnit = value(view => agreed(corner => css.cornerRadiusUnit(view, corner)));
  const measuredCorners = CORNERS.map(([key]) => measuredOf(key));
  const quotedAll = measuredCorners.every(radius => radius != null && radius === measuredCorners[0]) ? measuredCorners[0] : null;
  // The four corner longhands, not the `border-radius` shorthand: a style engine lowers per-corner declarations into utilities it
  // owns, while the shorthand would leave nothing behind that the compiler can write.
  const cornersLonghands = next => Object.fromEntries(CORNERS.map(([, corner]) => [`border-${corner}-radius`, next]));
  const allCorners = field('radius', 'Radius', every, next => run(cornersLonghands(next), next == null ? 'default corner radius' : `corner radius ${next}`), radiusOptions('Radius of all four corners', quotedAll, everyUnit));
  allCorners.classList.add('br-all');
  // One colour for all four sides, written as the four side longhands for the same reason as the radius. It shows a colour only
  // while the sides agree.
  const sameColour = value(view => {
    const sideColours = BORDER_SIDES.map(side => colourShown(view[`border-${side}-color`] ?? view['border-color'] ?? null));
    return sideColours.every(item => item === sideColours[0]) ? sideColours[0] : MIXED;
  });
  const measuredColours = BORDER_SIDES.map(side => measured?.colors?.[`border${side[0].toUpperCase()}${side.slice(1)}Color`]);
  const allColour = colorField({
    key: 'stroke-all', label: 'Border', tip: 'Colour of all four borders', property: 'border-color',
    value: () => sameColour,
    run: (patch, label) => run(Object.fromEntries(BORDER_SIDES.map(side => [`border-${side}-color`, patch['border-color']])), label),
    computed: measuredColours.every(item => item && item === measuredColours[0]) ? measuredColours[0] : null, tokens: [],
  });
  allColour.classList.add('br-all-colour');
  centre.append(allCorners, allColour);
  hole.append(centre);
  // Reading order is the geometry: the left corners, the frame (its four sides, then the middle), the right corners.
  box.append(sides.top, sides.right, sides.bottom, sides.left, hole);
  const column = (name, ...nodes) => { const node = el('div', `br-col br-col-${name}`); node.append(...nodes); return node; };
  const shell = el('div', 'br-shell');
  shell.append(column('left', corner('tl'), corner('bl')), box, column('right', corner('tr'), corner('br')));
  followBand(box, sides, shell);
  return shell;
}

/** The seam between neighbouring sides, in px: a line like the box model band's own. */
const FRAME_SEAM = 1;

/**
 * The four sides of a frame as clip polygons, in px of the frame's padding box: `W`×`H` is the whole frame and `l`, `t`, `r`, `b`
 * the rim between its edge and the cut-out. Each diagonal joins an outer corner to the cut-out's matching corner; both sides that
 * meet there give up half the seam, measured across the diagonal, so the gap is the same width however the rim is proportioned.
 */
function framePolygons(W, H, l, t, r, b, seam) {
  const across = (rx, ry) => (seam * Math.hypot(rx, ry)) / 2;
  const alongX = (rx, ry) => across(rx, ry) / Math.max(1, ry);
  const alongY = (rx, ry) => across(rx, ry) / Math.max(1, rx);
  const polygon = points => `polygon(${points.map(([x, y]) => `${x.toFixed(2)}px ${y.toFixed(2)}px`).join(', ')})`;
  return {
    top: polygon([[alongX(l, t), 0], [W - alongX(r, t), 0], [W - r - alongX(r, t), t], [l + alongX(l, t), t]]),
    bottom: polygon([[alongX(l, b), H], [W - alongX(r, b), H], [W - r - alongX(r, b), H - b], [l + alongX(l, b), H - b]]),
    left: polygon([[0, alongY(l, t)], [0, H - alongY(l, b)], [l, H - b - alongY(l, b)], [l, t + alongY(l, t)]]),
    right: polygon([[W, alongY(r, t)], [W, H - alongY(r, b)], [W - r, H - b - alongY(r, b)], [W - r, t + alongY(r, t)]]),
  };
}

/**
 * Follow the box model's border band: the frame is that band pulled out of the box, so it has the band's own outer size and its
 * cut-out is the padding band's own place inside it — measured, because the band narrows and widens with the inspector and with
 * the values written on its edges. The middle controls always stay in the cut-out; when the band is not on screen the frame keeps
 * a default shape.
 */
function followBand(box, sides, shell) {
  const panel = () => box.closest('#inspector');
  const apply = () => {
    const band = panel()?.querySelector('.boxmodel .bm-border');
    const inner = band?.querySelector(':scope > .bm-centre > .bm-padding');
    // Layout pixels, not painted ones: the interface scale zooms the board, and a size copied from a zoomed rect would be
    // written back already multiplied. `offsetLeft`/`offsetTop` are measured from the band's padding edge, which is exactly
    // where this frame's own absolutely placed parts start.
    const width = band ? band.offsetWidth : 0, height = band ? band.offsetHeight : 0;
    const known = inner && width > 60 && height > 40;
    box.style.width = width > 60 ? `${width}px` : '';
    box.style.height = height > 40 ? `${height}px` : '';
    shell.style.setProperty('--br-w', width > 60 ? `${width}px` : '100%');
    // The corner radii sit in the gutters beside the frame while a gutter can hold one (a number and its unit); in a narrower panel
    // they go above and below it instead, which is the only place left.
    const gutter = ((shell.parentElement?.clientWidth || 0) - width) / 2 - 2;
    // Without a band to copy there are no gutters to know, so the radii take the rows above and below.
    shell.classList.toggle('br-narrow', !(width > 60) || gutter < (parseFloat(getComputedStyle(shell).getPropertyValue('--br-chip')) || 44));
    const rim = known ? { l: inner.offsetLeft, t: inner.offsetTop, r: Math.max(0, band.clientWidth - inner.offsetLeft - inner.offsetWidth), b: Math.max(0, band.clientHeight - inner.offsetTop - inner.offsetHeight) } : { l: 16, t: 20, r: 16, b: 20 };
    for (const [name, px] of Object.entries(rim)) box.style.setProperty(`--br-${name}`, `${px}px`);
    // The frame's padding box is the band's own, so its polygons come from the band, not from the (possibly hidden) frame.
    const W = known ? band.clientWidth : box.clientWidth, H = known ? band.clientHeight : box.clientHeight;
    if (!(W > 0 && H > 0)) return;
    const polygons = framePolygons(W, H, rim.l, rim.t, rim.r, rim.b, FRAME_SEAM);
    for (const side of BORDER_SIDES) sides[side].style.clipPath = polygons[side];
  };
  apply();
  requestAnimationFrame(apply);
  const observer = new ResizeObserver(apply);
  requestAnimationFrame(() => {
    const host = panel();
    if (!host) { observer.disconnect(); return; }
    observer.observe(host);
    const band = host.querySelector('.boxmodel .bm-border');
    if (band) observer.observe(band);
  });
}

const WEIGHTS = [['100', 'Thin 100'], ['200', 'Extra light 200'], ['300', 'Light 300'], ['400', 'Regular 400'], ['500', 'Medium 500'], ['600', 'Semibold 600'], ['700', 'Bold 700'], ['800', 'Extra bold 800'], ['900', 'Black 900']];

function appearanceFold({ value, run, measured, tokens }) {
  const box = el('div', 'appearance-box');
  // Typography: size (any px) and weight.
  const sizePx = value(view => css.fontSizeOf(view));
  const leading = value(view => css.lineHeightOf(view));
  const leadingUnit = value(view => css.lineHeightUnit(view['line-height']));
  const weight = value(view => css.weightOf(view));
  const type = el('div', 'grid2');
  type.append(
    field('font-size', 'Aa', sizePx, next => run({ 'font-size': next }, `font size ${next ?? 'default'}`), {
      tip: 'Font size, px', unit: 'px', placeholder: measured?.colors?.fontSize ? String(Math.round(parseFloat(measured.colors.fontSize) || 16)) : '16', min: 1, max: 400,
      parse: raw => css.lengthInput(raw, { keywords: [], negative: false }),
    }),
    field('line-height', 'Lh', leading, next => run({ 'line-height': next }, `line height ${next ?? 'default'}`), {
      tip: 'Line height: 150%, 24px, 1.5em or 1.5', placeholder: 'normal', min: 0, max: 1000, parse: css.lineHeightInput,
      // The unit button swaps only the unit and keeps the number. An unset line height opens on percent.
      units: ['%', 'px', 'em', '×'], defaultUnit: '%', unit: leadingUnit === MIXED ? '' : leadingUnit || '',
    }),
    pick('Weight', weight, WEIGHTS, next => run({ 'font-weight': next }, next ? `weight ${next}` : 'default weight'), { tip: 'Font weight' }),
  );
  const text = value(view => view['text-align'] ?? null);
  const textRow = el('div', 'segs-row align-controls');
  textRow.append(labeledSegments('Text', segmented('Text align', text === MIXED ? null : text, [['left', 'textL', 'Align left'], ['center', 'textC', 'Align center'], ['right', 'textR', 'Align right'], ['justify', 'textJ', 'Justify']], next => run({ 'text-align': next }, next ? `text ${next}` : 'default text align'))));
  const typography = el('div', 'typography-controls label-group');
  typography.dataset.inspectorSlot = 'typography';
  typography.append(type, textRow);
  const colors = el('div', 'appearance-colors');
  colors.append(
    colorField({ key: 'fill', label: 'Bg', tip: 'Background color', property: 'background-color', value, run, computed: measured?.colors?.background, tokens }),
    colorField({ key: 'ink', label: 'Text', tip: 'Text color', property: 'color', value, run, computed: measured?.colors?.color, tokens }),
  );
  box.append(colors, typography);
  return box;
}

/* ---- sections ------------------------------------------------------------------- */

/**
 * `nodes` are the selected elements (one or more), `parent` the single selection's parent (or null).
 * `apply(edits, label, options)` commits `styles` edits for every selected element once; `edits` is an object, or a function
 * `(view, node) → object` evaluated against the accepted element inside the writer queue. `readers` are representation readers
 * (see panels.js): `{ view(className) → declarations, variants?(className, property) → [names] }`.
 */
export function propertySections(nodes, { parent, apply, spacingFocus, measured = null, readMeasured = () => measured, readNodes = () => nodes, tokens = [], readers = [], rerender = null }) {
  const context = { tokens: Object.fromEntries(tokens) };
  const views = nodes.map(node => css.viewOf(node, readers, context));
  const value = fn => same(views.map(fn));
  const variants = property => [...new Set(nodes.flatMap(node => readers.flatMap(reader => reader.variants?.(node.className || '', property) ?? [])))].slice(0, 4);
  const subject = nodes.length === 1 ? `#${nodes[0].id}` : `${nodes.length} elements`;
  const run = (edits, label, options = {}) => apply(edits, `${label} on ${subject}`, { ...options, group: sessionGroup, refresh: !typingLive });

  /* layout */
  const display = value(view => view.display ?? null);
  const position = value(view => view.position ?? null);
  const layout = el('div', 'layout-box label-group');
  const top = el('div', 'grid2');
  const overflow = value(view => css.overflowOf(view));
  top.append(
    pick('Display', display, DISPLAY, next => run({ display: next }, next ? `display ${next === 'none' ? 'hidden' : next}` : 'default display'), { variants: variants('display') }),
    // How the box treats content that does not fit: a container behaviour next to Display, read from both axes as one value.
    pick('Overflow', overflow === 'mixed' ? MIXED : overflow, OVERFLOW, next => run({ overflow: next }, next ? `overflow ${next}` : 'default overflow'), { variants: variants('overflow') }),
  );
  layout.append(top);

  const flex = css.isFlex(display);
  const grid = css.isGrid(display);
  const edge = (next, isFlexContext) => (next ? css.edgeValue(next, isFlexContext) : null);
  if (flex || grid) {
    const align = value(view => JSON.stringify(css.alignment(view)));
    const current = align === MIXED ? { x: null, y: null, between: false } : JSON.parse(align);
    const row = el('div', 'flow-row');
    row.append(alignGrid('Align children', current.x, current.y, (x, y) => run(view => css.alignmentEdits(view, x, y), `align ${y} ${x}`)));
    const side = el('div', 'flow-side');
    if (flex) {
      const direction = value(view => (/^column/.test(view['flex-direction'] || '') ? 'col' : 'row'));
      const wrap = value(view => view['flex-wrap'] === 'wrap');
      const tools = el('div', 'segs-row');
      tools.append(
        segmented('Direction', direction === MIXED ? null : direction, [['row', 'arrowRight', 'Row (flex-direction: row)'], ['col', 'arrowDown', 'Column (flex-direction: column)']], next => run({ 'flex-direction': next === 'col' ? 'column' : null }, next === 'col' ? 'column' : 'row')),
        toggle('wrapLines', 'Wrap (flex-wrap)', wrap === true, () => run({ 'flex-wrap': wrap === true ? null : 'wrap' }, wrap === true ? 'no wrap' : 'wrap')),
      );
      side.append(tools);
    } else {
      const cols = value(view => css.gridColumns(view));
      side.append(field('grid-cols', 'Cols', cols, n => run({ 'grid-template-columns': css.gridColumnsEdit(n) }, n ? `${n} columns` : 'default columns'), { tip: 'Equal columns (grid-template-columns)', placeholder: '1', min: 1, max: 12, parse: raw => (raw === '' ? null : /^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 12 ? Number(raw) : undefined) }));
    }
    const gap = value(view => css.gapOf(view));
    side.append(field('gap', 'Gap', gap, next => run({ 'row-gap': null, 'column-gap': null, gap: next }, `gap ${next ?? 'none'}`), { tip: 'Gap between children, px', unit: 'px', placeholder: '0', min: 0, parse: raw => css.lengthInput(raw, { keywords: [], negative: false }) }));
    row.append(side);
    layout.append(row);
    // Beyond the 3×3 pad: spread (between / around / evenly), stretch and baseline.
    const justify = value(view => css.edgeOf(view['justify-content']));
    const alignItems = value(view => css.edgeOf(view['align-items']));
    const spread = el('div', 'grid2');
    spread.append(
      pick(flex ? 'Justify' : 'Spread', justify, JUSTIFY, next => run({ 'justify-content': edge(next, flex) }, next ? `justify ${next}` : 'default justify'), { tip: flex ? 'Along the main axis (justify-content)' : 'Spread the columns (justify-content)', variants: variants('justify-content') }),
      pick('Align', alignItems, ALIGN, next => run({ 'align-items': edge(next, flex) }, next ? `align ${next}` : 'default align'), { tip: 'Across the main axis (align-items)', variants: variants('align-items') }),
    );
    if (grid) {
      const itemsX = value(view => css.edgeOf(view['justify-items']));
      spread.append(pick('Items', itemsX, ITEMS_X, next => run({ 'justify-items': next }, next ? `items ${next}` : 'default items'), { tip: 'Inside each cell, horizontally (justify-items)', variants: variants('justify-items') }));
    }
    layout.append(spread);
  }

  // Not a flex or grid container yet: one click centres what is inside it, or the element itself in its parent.
  if (!flex && !grid) {
    const centre = el('div', 'centre-row row-labeled');
    centre.append(caption('Center'), el('div', 'row-controls'));
    const inside = el('button', 'link-button', 'Content');
    inside.type = 'button';
    inside.dataset.key = 'center-content';
    inside.dataset.tip = 'Centre the children horizontally and vertically (display: flex, align-items and justify-content: center)';
    inside.addEventListener('click', () => run({ display: 'flex', 'align-items': 'center', 'justify-content': 'center' }, 'center content'));
    const itself = el('button', 'link-button', 'Element');
    itself.type = 'button';
    itself.dataset.key = 'center-element';
    itself.dataset.tip = 'Centre this element horizontally in its parent (auto side margins)';
    itself.addEventListener('click', () => run({ 'margin-left': 'auto', 'margin-right': 'auto' }, 'center element'));
    centre.querySelector('.row-controls').append(inside, itself);
    layout.append(centre);
  }

  const pinned = position === 'absolute' || position === 'fixed' || position === 'sticky';
  if (pinned) {
    const where = value(view => JSON.stringify(css.pin(view)));
    const current = where === MIXED ? { x: null, y: null } : JSON.parse(where);
    const row = el('div', 'flow-row');
    row.append(alignGrid('Pin to', current.x, current.y, (x, y) => run(view => css.pinEdits(view, x, y), `pin ${y} ${x}`)));
    layout.append(row);
  }

  const parentDisplay = parent ? css.viewOf(parent, readers, context).display ?? null : null;
  if (parentDisplay && /flex|grid/.test(parentDisplay) && !pinned) {
    const parentFlex = css.isFlex(parentDisplay);
    const self = value(view => css.edgeOf(view['align-self']));
    const selfRow = el('div', 'segs-row align-controls');
    selfRow.append(labeledSegments('Self', segmented('Align self in the parent', self === MIXED ? null : self, [['start', 'alignT', 'Self: start'], ['center', 'alignCV', 'Self: center'], ['end', 'alignB', 'Self: end'], ['stretch', 'distV', 'Self: stretch']], next => run({ 'align-self': edge(next, parentFlex) }, next ? `self ${next}` : 'default self'))));
    layout.append(selfRow);
  }

  /* One developer-tools-style box model; the existing margin/padding and offset editors live on their actual edges. */
  const spacing = el('div', 'spacing-box');
  spacing.append(pick('Position', position, POSITION, next => run({ position: next }, next ? next : 'default position'), { variants: variants('position') }));
  const model = el('div', 'boxmodel');
  model.setAttribute('role', 'group');
  model.setAttribute('aria-label', 'CSS box model');
  const propertyOf = (kind, side) => (kind === 'inset' ? SIDE_NAMES[side] : `${kind}-${SIDE_NAMES[side]}`);
  // Every value of the box model is a number with its own unit: the unit sits beside the number as a small label (below it in a
  // narrow side strip) and becomes the unit menu while the cell has focus; a unit typed with the number moves there too.
  const LENGTH_UNITS = ['px', '%', 'rem', 'em'];
  // A value is a slot of its resting size holding the field. While the field has focus it becomes an editor laid over the widget:
  // the slot keeps its size, so nothing under the editor is moved, and the editor is painted above every band.
  const lengthField = (key, { raw, placeholder, tip, parse, units = LENGTH_UNITS, onCommit, min = -1e4 }) => {
    const parts = raw === MIXED ? null : css.lengthParts(raw);
    const vf = field(key, '', raw === MIXED ? MIXED : parts.number, onCommit, {
      tip, placeholder, min, parse, spell: true, units, defaultUnit: 'px', unit: parts?.unit ?? '', unitOnNumbers: true,
    });
    vf.querySelector('.vf-k')?.remove();
    // The unit label is not a tab stop of its own: a unit can be typed with the number, and the menu opens with the pointer.
    vf.querySelector('.vf-unit')?.setAttribute('tabindex', '-1');
    const input = vf.querySelector('input');
    const slot = el('div', 'bm-slot');
    slot.append(vf);
    slot.vf = vf;
    // The editor is as wide as its number and the unit button, never wider than that; it grows only with long text typed.
    const fit = () => slot.style.setProperty('--bm-edit-chars', String(Math.max(3, (input.value || input.placeholder).length)));
    const begin = () => {
      if (slot.classList.contains('editing')) return;
      slot.style.width = `${vf.offsetWidth}px`;
      slot.style.height = `${vf.offsetHeight}px`;
      // The widget lays itself out for the value as it stood, not for the text being typed.
      input.dataset.rest = input.value || input.placeholder;
      fit();
      slot.classList.add('editing');
    };
    const end = () => {
      if (!slot.classList.contains('editing')) return;
      slot.classList.remove('editing');
      slot.style.width = slot.style.height = '';
      delete input.dataset.rest;
      input.dispatchEvent(new Event('divlet:fit'));
    };
    slot.addEventListener('focusin', begin);
    slot.addEventListener('focusout', event => { if (!slot.contains(event.relatedTarget)) end(); });
    input.addEventListener('input', fit);
    return slot;
  };
  const spaceField = (kind, short, side) => {
    const property = propertyOf(kind, side);
    const label = `${kind[0].toUpperCase()}${kind.slice(1)} ${SIDE_NAMES[side]}`;
    const slot = lengthField(`${short}-${side}`, {
      raw: value(view => view[property] ?? null), tip: label,
      placeholder: measured?.[kind] ? String(measured[kind]['trbl'.indexOf(side)]) : '—',
      min: kind === 'padding' ? 0 : -1e4, parse: raw => css.lengthInput(raw, { negative: kind !== 'padding' }),
      onCommit: next => { run({ [property]: next }, `${kind} ${SIDE_NAMES[side]} ${next == null ? 'none' : next}`); },
    });
    const node = slot.vf;
    node.classList.add('bm-field');
    node.setAttribute('aria-label', label);
    node.querySelector('input').setAttribute('aria-label', label);
    const light = on => spacingFocus?.(on ? { kind, sides: [side] } : null);
    node.addEventListener('pointerenter', () => light(true));
    node.addEventListener('pointerleave', () => { if (!node.contains(document.activeElement)) light(false); });
    node.addEventListener('focusin', () => light(true));
    node.addEventListener('focusout', () => light(false));
    return slot;
  };
  const number = value => Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '—';
  // One border width per side, and only here: the Border block does not repeat them, so there is no second copy to keep in step.
  const widthField = side => {
    const property = `border-${SIDE_NAMES[side]}-width`, index = 'trbl'.indexOf(side);
    const slot = lengthField(`border-${side}`, {
      raw: value(view => view[property] ?? null), tip: `Border ${SIDE_NAMES[side]}`, placeholder: number(measured?.border?.[index]),
      min: 0, units: ['px', 'rem', 'em'], parse: css.borderWidthInput,
      onCommit: next => { run({ [property]: next }, `${property} ${next ?? 'default'}`); },
    });
    slot.vf.classList.add('bm-value');
    return slot;
  };
  const edgeField = (kind, side, index) => {
    if (kind === 'margin' || kind === 'padding') return spaceField(kind, kind === 'margin' ? 'm' : 'p', side);
    if (kind === 'position') {
      const name = SIDE_NAMES[side];
      const slot = lengthField(`inset-${side}`, {
        raw: value(view => view[name] ?? null), tip: `${name[0].toUpperCase()}${name.slice(1)} offset`,
        placeholder: measured?.inset?.[index]?.replace(/px$/, '') ?? 'auto', parse: raw => css.lengthInput(raw),
        onCommit: next => run({ [name]: next }, `${name} ${next ?? 'auto'}`),
      });
      slot.vf.classList.add('bm-offset');
      return slot;
    }
    return widthField(side);
  };
  const square = (kind, inner) => {
    const sq = el('div', `bm-sq bm-${kind}`);
    sq.setAttribute('role', 'group');
    sq.setAttribute('aria-label', kind[0].toUpperCase() + kind.slice(1));
    // The name and the top value share one strip in the flow of the band, so no font or panel width can make them collide;
    // the other three cells keep their own side strips. Tab order stays top, right, bottom, left.
    const cells = ['t', 'r', 'b', 'l'].map((side, index) => {
      const cell = el('div', `bm-cell bm-${side}`);
      cell.setAttribute('role', 'group');
      cell.setAttribute('aria-label', `${kind} ${SIDE_NAMES[side]}`);
      cell.append(edgeField(kind, side, index));
      return cell;
    });
    const strip = el('div', 'bm-top');
    strip.append(el('span', 'bm-caption', kind), cells[0]);
    sq.append(strip, ...cells.slice(1));
    const centre = el('div', 'bm-centre');
    centre.append(inner);
    sq.append(centre);
    // Long values widen their own cell; long left/right values widen both side bands alike, so the band stays symmetric.
    // Only values too long for a side band (or any long side in a narrow inspector, board.css) move to rows.
    // The side strip is measured in pixels of the value's own font: a `ch` there would resolve in the band's larger font for
    // the padding and in the value's smaller one for the cell, and the two halves of the strip would disagree.
    const measuring = document.createElement('canvas').getContext('2d');
    const fitValues = () => {
      let side = 0, strip = 0;
      for (const cell of sq.querySelectorAll(':scope > .bm-cell, :scope > .bm-top > .bm-cell')) {
        const input = cell.querySelector('input');
        const text = input ? input.dataset.rest ?? (input.value || input.placeholder) : cell.textContent;
        const length = text.length;
        cell.style.setProperty('--bm-value-width', `calc(${length}ch + 2px)`);
        if (!cell.classList.contains('bm-l') && !cell.classList.contains('bm-r')) continue;
        side = Math.max(side, length);
        if (input) {
          measuring.font = getComputedStyle(input).font;
          strip = Math.max(strip, measuring.measureText(text).width + 4);
          // The unit stands under the number in a side strip, so the strip is as wide as the wider of the two.
          const unit = cell.querySelector('.vf-unit');
          if (unit && !unit.hidden) { measuring.font = getComputedStyle(unit).font; strip = Math.max(strip, measuring.measureText(unit.textContent).width + 4); }
        }
      }
      sq.style.setProperty('--bm-side-width', strip ? `${Math.ceil(strip)}px` : `calc(${side}ch + 4px)`);
      sq.classList.toggle('bm-wide-sides', side > 4);
      sq.classList.toggle('bm-stacked-sides', side > 6);
    };
    for (const input of sq.querySelectorAll(':scope > .bm-cell input, :scope > .bm-top > .bm-cell input')) {
      input.addEventListener('input', fitValues);
      input.addEventListener('keydown', fitValues);
      input.addEventListener('change', fitValues);
      input.addEventListener('divlet:field-value', fitValues);
      input.addEventListener('divlet:fit', fitValues);
    }
    for (const unit of sq.querySelectorAll(':scope > .bm-cell .vf-unit, :scope > .bm-top > .bm-cell .vf-unit')) new MutationObserver(fitValues).observe(unit, { childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
    fitValues();
    return sq;
  };
  const core = el('div', 'bm-core');
  core.setAttribute('role', 'group');
  const width = number(measured?.content?.width), height = number(measured?.content?.height);
  core.setAttribute('aria-label', `Content size: ${width} by ${height} CSS px`);
  for (const [index, axis] of ['width', 'height'].entries()) {
    if (index) core.append(el('span', 'bm-times', '×'));
    const dimension = axis === 'width' ? width : height;
    const authoredRaw = nodes.length === 1 ? views[0][axis] ?? null : null;
    // An authored size in a unit the box does not measure in (`20rem`) shows as written; otherwise the measured content px.
    const asWritten = authoredRaw != null && css.lengthParts(authoredRaw).unit && css.lengthParts(authoredRaw).unit !== 'px' && measured?.boxSizing !== 'border-box';
    const size = lengthField(`content-${axis}`, {
      raw: asWritten ? authoredRaw : authoredRaw != null ? dimension : null, tip: `Content ${axis}`, placeholder: dimension, min: 0,
      parse: raw => css.lengthInput(raw, { keywords: [], negative: false }),
      onCommit: next => {
        run(async () => {
          if (next === null) return { [axis]: null };
          const box = await readMeasured();
          if (nodes.length !== 1 || !Number.isFinite(box?.content?.[axis])) throw new Error('Select one visible element to edit its content size.');
          const sides = axis === 'width' ? [1, 3] : [0, 2];
          const extra = box.boxSizing === 'border-box' ? sides.reduce((sum, side) => sum + box.padding[side] + box.border[side], 0) : 0;
          const px = next === '0' ? 0 : /^(\d+(?:\.\d+)?)px$/.exec(next)?.[1];
          if (px !== undefined) return { [axis]: `${Number(px) + extra}px` };
          // The border box adds padding and border in px, so a size in another unit is only the content's own when there are none.
          if (extra > 0) throw new Error(`A content ${axis} in ${next.replace(/[\d.]+/, '')} needs box-sizing: content-box here, or no padding and border; use px instead.`);
          return { [axis]: next };
        }, `content ${axis} ${next ?? 'default'}`);
      },
    });
    size.vf.classList.add('bm-value', 'bm-dimension');
    const input = size.querySelector('input');
    // The core lays itself out for the value as it stood, not for the text being typed.
    const fit = () => size.vf.style.setProperty('--bm-value-width', `calc(${(input.dataset.rest ?? (input.value || input.placeholder)).length}ch + 4px)`);
    for (const event of ['change', 'divlet:fit']) input.addEventListener(event, fit);
    fit();
    core.append(size);
  }
  model.append(square('position', square('margin', square('border', square('padding', core)))));
  spacing.append(model);


  /* effects */
  const effects = el('div', 'box3');
  const opacity = value(view => css.opacityOf(view));
  const z = value(view => view['z-index'] ?? null);
  const blur = value(view => css.blurOf(view));
  effects.append(
    field('opacity', 'Opacity', opacity, next => run({ opacity: next }, `opacity ${next == null ? 100 : Math.round(next * 100)}%`), { tip: 'Opacity, %', unit: '%', placeholder: '100', min: 0, max: 100, parse: css.opacityInput }),
    field('z', 'Z-index', z, next => run({ 'z-index': next }, `z-index ${next ?? 'auto'}`), { tip: 'Stacking order (z-index)', placeholder: 'auto', stepFrom: raw => raw.trim().toLowerCase() === 'auto' ? 0 : Number.parseInt(raw, 10), parse: css.zInput }),
    field('blur', 'Blur', blur, next => run(view => ({ filter: css.blurEdit(view, next === null ? 0 : next) }), `blur ${next ?? 'none'}`), { tip: 'Blur, px', unit: 'px', placeholder: '0', min: 0, max: 200, parse: raw => (raw.trim() === '' ? null : /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : undefined) }),
  );

  return [['layout', 'Layout', layout], ['spacing', 'Spacing', spacing], ['border', 'Border', borderFold(views, { value, run, measured, tokens })], ['appearance', 'Appearance', appearanceFold({ value, run, measured, tokens })], ['effects', 'Effects', effects]];
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
  const group = el('div', 'labeled-segs row-labeled');
  group.append(caption(label), control);
  return group;
}

/**
 * One label column per group of rows: every caption in a group gets the width of the widest one, so `Center` and `Self`
 * start their controls on the same line instead of each after its own word. Measured after the rows are in place and again
 * whenever the panel resizes, because the widest label depends on the font the interface is drawing with.
 */
export function syncLabelColumns(root) {
  for (const group of root.querySelectorAll('.label-group')) {
    const labels = [...group.querySelectorAll(':scope > .row-labeled > .caption, :scope > .row-labeled > .vf-k')];
    if (!labels.length) continue;
    // Measure with no floor first: a previous measurement must not keep a long label from shrinking back.
    group.style.removeProperty('--label-col');
    // Layout pixels: the panel is drawn under `transform: scale(--ui)`, where a rect would return the painted width
    // and hand the column twice the room it needs at 200%.
    const widest = Math.max(...labels.map(node => node.offsetWidth));
    if (widest > 0) group.style.setProperty('--label-col', `${widest + 2}px`);
  }
}

