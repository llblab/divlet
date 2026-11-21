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

function field(key, label, value, onCommit, { tip, placeholder = '', parse = raw => raw, stepFrom = Number.parseFloat, step = 1, min = -1e6, max = 1e6, variants = [], unit = '', units = null, convert = () => null, defaultUnit = null } = {}) {
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
    const now = () => unit || chosen || defaultUnit;
    const sync = () => { unitButton.textContent = now(); };
    syncUnit = sync;
    // A new unit rewrites the number, not the meaning: `24` px becomes `150` % or `1.5` em. The authored spelling is the
    // source, so the switch really writes; with no value yet (`normal`, empty) it only remembers the unit for this field.
    const applyUnit = to => {
      const written = input.value.trim();
      chosen = to;
      sync();
      const next = unit && written ? convert(written, unit, to) : null;
      if (next == null || !written || to === unit) return;
      const spelled = to === '×' ? next : `${next}${to}`;
      const parsed = parse(spelled);
      if (parsed === undefined) { toast(`“${spelled}” is not a value for ${tip || label}`); return; }
      input.value = next;
      current = next;
      onCommit(parsed, spelled);
    };
    unitButton.addEventListener('pointerdown', event => event.stopPropagation());
    unitButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openMenu(units.map(unitKey => ({ label: UNIT_NAMES[unitKey] || unitKey, checked: now() === unitKey, run: () => applyUnit(unitKey) })), { anchor: unitButton, label: 'Unit' });
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

/** The colour a value stands for, as something to show: `#112233`, `var(--color-brand)` or the keyword. */
const colourShown = value => (value == null ? null : String(value));

function colorField({ key, label, tip, property, value, run, computed, tokens }) {
  const wrap = el('div', 'color-field');
  const current = value(view => colourShown(view[property]));
  const shownHex = current === MIXED ? null : css.hexOf(current) || KEYWORD_COLORS[current] || css.hexOf(computed);
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
  hex.placeholder = current === MIXED ? '—' : css.hexOf(computed) ?? (computed ? 'inherited' : 'none');
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
  wrap.append(name, swatch, hex, clear);
  if (alphaOf(computed) < 1 && current == null) hex.title = 'Semi-transparent in the page';
  if (tokens.length) {
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
const BORDER_SIDES_MENU = [['', 'All sides'], ['top', 'Top'], ['right', 'Right'], ['bottom', 'Bottom'], ['left', 'Left']];
/** Which edge the centre colour edits: one side at a time, remembered across the re-render choosing one causes. */
let borderSide = null;

function borderFold(views, { value, run, measured, tokens, widthField, nodeId, rerender }) {
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
    borderDiagram({ views, value, run, measured, tokens, widthField, nodeId, rerender }),
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
 * The border as the band it is: one hollow rectangle, exactly as wide as the box model's border band above it, with a corner
 * radius in each corner, an edge width at each edge's centre and its colour in the middle. The ring itself is painted from the
 * authored style and the colour of each side, so a side given its own colour reads as a different side rather than as a hidden
 * setting. The width follows that band (measured, so a narrow inspector narrows both), and falls back to the available width
 * when the band is not on screen.
 */
function borderDiagram({ views, value, run, measured, tokens, widthField, nodeId, rerender }) {
  const box = el('div', 'br-box');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Border ring: corner radii, edge widths and colour');
  const view = views.length === 1 ? views[0] : null;
  // Paint each edge from the authored state; a side with no line keeps a ghost of one so the ring still reads as a ring.
  for (const [cssName, side] of [['Top', 'top'], ['Right', 'right'], ['Bottom', 'bottom'], ['Left', 'left']]) {
    const own = view?.[`border-${side}-width`] ?? null;
    const px = own == null ? null : pxOf(own);
    const line = view?.[`border-${side}-style`] ?? view?.['border-style'] ?? null;
    const colour = css.borderColourOf(view ?? {}, side);
    const off = line === 'none' || line === 'hidden' || px === 0;
    box.style[`border${cssName}Style`] = off ? 'dotted' : BORDER_STYLES.some(([key]) => key === line) ? line : 'solid';
    box.style[`border${cssName}Width`] = `${off ? 1 : clamp(px ?? 2, 2, 8)}px`;
    box.style[`border${cssName}Color`] = off && colour == null ? 'var(--hair)' : css.hexOf(colour?.value) || measured?.colors?.borderColor || 'var(--hair)';
  }
  // The corners bend the ring by the radius they show: px directly, a percentage or `full` against the ring's own height.
  const radiusPx = corner => {
    const raw = view?.[`border-${corner}-radius`] ?? view?.['border-radius'] ?? null;
    if (raw == null) return 0;
    const text = String(raw).trim();
    if (/^(?:full|50%|100%|9999px|999px)$/i.test(text)) return 999;
    const px = pxOf(text);
    if (px != null) return px;
    const percent = /^(\d+(?:\.\d+)?)%$/.exec(text);
    return percent ? Number(percent[1]) : 0;
  };
  box.style.borderTopLeftRadius = `${clamp(radiusPx('top-left'), 0, 18)}px`;
  box.style.borderTopRightRadius = `${clamp(radiusPx('top-right'), 0, 18)}px`;
  box.style.borderBottomRightRadius = `${clamp(radiusPx('bottom-right'), 0, 18)}px`;
  box.style.borderBottomLeftRadius = `${clamp(radiusPx('bottom-left'), 0, 18)}px`;

  const cell = (node, className) => { const wrap = el('div', `br-cell ${className}`); wrap.append(node); return wrap; };
  const corner = key => {
    const named = { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right' }[key];
    const property = `border-${named}-radius`;
    const shown = value(v => { const radius = css.cornerRadiusOf(v, named); return radius === undefined ? MIXED : radius; });
    // The empty field quotes the radius this corner has on the page, so a radius set by a stylesheet is still visible.
    const quoted = pxOf(measured?.colors?.[`radius${key === 'tl' ? 'TopLeft' : key === 'tr' ? 'TopRight' : key === 'br' ? 'BottomRight' : 'BottomLeft'}`]);
    const node = field(`radius-${key}`, '', shown, next => run({ [property]: next }, `${named.replace('-', ' ')} radius ${next ?? 'default'}`), {
      tip: `${named.replace('-', ' ')} corner radius`, placeholder: quoted == null ? '—' : String(Math.round(quoted)), min: 0, max: 1e4, parse: css.radiusInput,
    });
    node.querySelector('.vf-k')?.remove();
    node.classList.add('br-field');
    node.setAttribute('aria-label', `${named} corner radius`);
    return cell(node, `br-corner br-${key}`);
  };
  const edge = side => {
    const node = widthField(side, { diagram: true, key: `border-width-${side}` });
    node.classList.remove('bm-value');
    node.classList.add('br-field');
    node.setAttribute('aria-label', `Border ${side}, px`);
    return cell(node, `br-edge br-${side}`);
  };
  // The middle of the ring is hollow: the colour is a sibling laid over it, so it can step outside a ring too narrow to hold
  // a swatch, a value and a clear button on one line.
  const shell = el('div', 'br-shell');
  const centre = el('div', 'br-centre');
  centre.setAttribute('role', 'group');
  centre.setAttribute('aria-label', 'Border colour');
  const target = borderSide?.nodeId === nodeId ? borderSide.side : '';
  // A menu button labelled by its own value, not the caption+value selector component: it says which side the colour is for.
  const sides = el('button', 'side-pick br-sides');
  sides.type = 'button';
  sides.dataset.key = 'border-side';
  sides.setAttribute('aria-haspopup', 'menu');
  sides.dataset.tip = 'Which side the colour belongs to';
  const chosen = () => (borderSide?.nodeId === nodeId ? borderSide.side : '');
  const name = side => BORDER_SIDES_MENU.find(([key]) => key === side)?.[1] ?? 'All sides';
  const shown = name(chosen());
  sides.setAttribute('aria-label', `Border colour side: ${shown}`);
  sides.append(el('span', `pick-v${chosen() ? '' : ' faint'}`, shown), icon('chevron', 'icon pick-caret'));
  const chooseSide = next => { borderSide = next ? { nodeId, side: next } : null; rerender?.(); };
  sides.addEventListener('click', () => openMenu([
    { label: 'All sides', checked: !chosen(), run: () => chooseSide('') },
    '-',
    ...BORDER_SIDES.map(side => ({ label: name(side), checked: chosen() === side, run: () => chooseSide(side) })),
  ], { anchor: sides, label: 'Border colour side' }));
  // The colour of the chosen side: the shared `border-color`, or one side's own longhand. Mixed sides read as nothing authored.
  const property = target ? `border-${target}-color` : 'border-color';
  const colour = colorField({
    key: 'stroke', label: target ? BORDER_SIDES_MENU.find(([key]) => key === target)[1] : 'Color',
    tip: `Border ${target || 'color'}`, property, value, run,
    computed: measured?.colors?.borderColor, tokens,
  });
  colour.querySelector('.vf-k')?.remove();
  colour.classList.add('br-colour');
  // The colour is the centre of the ring; the side it applies to reads under it.
  centre.append(colour, sides);
  // Beside the centre the ring's own corners (radii) and edges (widths) sit where they apply.
  box.append(corner('tl'), edge('t'), corner('tr'), edge('l'), edge('r'), corner('bl'), edge('b'), corner('br'));
  shell.append(box, centre);
  followBandWidth(box, shell);
  return shell;
}

/**
 * Follow the box model's border band: the diagram is that band pulled out of the box, so it keeps the band's own width —
 * measured, because the band narrows and widens with the inspector — and lets go of it when the band is not on screen.
 */
function followBandWidth(node, shell) {
  const panel = () => node.closest('#inspector');
  const apply = () => {
    const band = panel()?.querySelector('.boxmodel .bm-border');
    // Layout pixels, not painted ones: the interface scale zooms the board, and a width copied from a zoomed rect would be
    // written back already multiplied.
    const width = band ? band.offsetWidth : 0;
    node.style.width = width > 60 ? `${width}px` : '';
    shell.style.setProperty('--br-ring', width > 60 ? `${width}px` : '100%');
    // Below this the ring's hollow middle cannot hold a colour row, so the colour steps out under the ring instead of clipping.
    shell.classList.toggle('br-compact', width > 60 && width < 190);
  };
  apply();
  requestAnimationFrame(apply);
  const observer = new ResizeObserver(apply);
  requestAnimationFrame(() => { const host = panel(); if (host) observer.observe(host); else observer.disconnect(); });
}

/** The measured font size in px — what `%`, `em` and a unitless line height are measured against. */
const fontSizePx = measured => Number.parseFloat(measured?.colors?.fontSize) || 16;

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
      // `%`, `em` and a unitless multiple are one value — all measure the element's own font size — so the unit button
      // changes only the spelling, and px converts against that measured size. An unset line height opens on percent.
      units: ['%', 'px', 'em', '×'], defaultUnit: '%', unit: leadingUnit === MIXED ? '' : leadingUnit || '',
      convert: (number, from, to) => css.lineHeightIn(number, from, to, fontSizePx(measured)),
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
  model.setAttribute('aria-label', 'CSS box model in pixels');
  const propertyOf = (kind, side) => (kind === 'inset' ? SIDE_NAMES[side] : `${kind}-${SIDE_NAMES[side]}`);
  const spaceField = (kind, short, side) => {
    const property = propertyOf(kind, side);
    const authored = value(view => view[property] ?? null);
    const node = field(`${short}-${side}`, '', authored === MIXED ? MIXED : css.show(authored), next => {
      run({ [property]: next }, `${kind} ${SIDE_NAMES[side]} ${next == null ? 'none' : css.show(next)}`);
    }, { tip: '', placeholder: measured?.[kind] ? String(measured[kind]['trbl'.indexOf(side)]) : '—', min: kind === 'padding' ? 0 : -1e4, parse: raw => css.lengthInput(raw, { negative: kind !== 'padding' }) });
    node.classList.add('bm-field');
    const label = `${kind[0].toUpperCase()}${kind.slice(1)} ${SIDE_NAMES[side]}, px`;
    node.setAttribute('aria-label', label);
    node.querySelector('input').setAttribute('aria-label', label);
    node.querySelector('.vf-k')?.remove();
    const light = on => spacingFocus?.(on ? { kind, sides: [side] } : null);
    node.addEventListener('pointerenter', () => light(true));
    node.addEventListener('pointerleave', () => { if (!node.contains(document.activeElement)) light(false); });
    node.addEventListener('focusin', () => light(true));
    node.addEventListener('focusout', () => light(false));
    return node;
  };
  const number = value => Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '—';
  const nonnegative = raw => raw === '' ? null : /^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(raw) && Number.isFinite(parseFloat(raw)) ? parseFloat(raw) : undefined;
  const bareField = (key, label, shown, placeholder, onCommit) => {
    const node = field(key, '', shown, onCommit, { tip: label, placeholder, min: 0, parse: nonnegative });
    node.querySelector('.vf-k').remove();
    node.classList.add('bm-value');
    return node;
  };
  const borderFields = new Map(), borderEdits = new Map();
  const widthField = (side, { diagram = false, key } = {}) => {
    const property = `border-${SIDE_NAMES[side]}-width`, index = 'trbl'.indexOf(side);
    const authored = value(view => view[property] ?? null);
    const shown = authored === MIXED ? MIXED : authored == null ? null : css.show(authored);
    const placeholder = number(measured?.border?.[index]);
    const commitWidth = next => {
      const sequence = (borderEdits.get(side) ?? 0) + 1;
      borderEdits.set(side, sequence);
      const result = run({ [property]: next === null ? null : `${next}px` }, `${property} ${next ?? 'default'}`);
      if (!result?.then) return;
      const sync = async result => {
        if (borderEdits.get(side) !== sequence) return;
        const current = await readNodes(result?.version ?? result?.details?.actualVersion);
        const raw = same(current.map(node => css.viewOf(node, readers, context)[property] ?? null));
        const box = raw === null ? await readMeasured() : null;
        if (borderEdits.get(side) !== sequence) return;
        for (const input of borderFields.get(side) ?? []) if (input.isConnected) input.dispatchEvent(new CustomEvent('divlet:field-value', { detail: {
          value: raw === MIXED ? MIXED : raw == null ? null : css.show(raw), placeholder: number(box?.border?.[index]),
        } }));
      };
      result.then(sync, sync).catch(() => {}); // The writer reports refusals; restore inactive peers from accepted state too.
    };
    const node = diagram
      ? bareField(key ?? `border-${side}`, `Border ${SIDE_NAMES[side]}, px`, shown, placeholder, commitWidth)
      : field(`border-width-${side}`, SIDE_NAMES[side][0].toUpperCase() + SIDE_NAMES[side].slice(1), shown, commitWidth, { tip: `Border ${SIDE_NAMES[side]}, px`, placeholder, unit: 'px', min: 0, parse: nonnegative });
    borderFields.set(side, [...(borderFields.get(side) ?? []), node.querySelector('input')]);
    return node;
  };
  const edgeField = (kind, side, index) => {
    if (kind === 'margin' || kind === 'padding') return spaceField(kind, kind === 'margin' ? 'm' : 'p', side);
    if (kind === 'position') {
      const authored = value(view => view[SIDE_NAMES[side]] ?? null);
      const node = field(`inset-${side}`, '', authored === MIXED ? MIXED : css.show(authored), next => run({ [SIDE_NAMES[side]]: next }, `${SIDE_NAMES[side]} ${next ?? 'auto'}`), { tip: `${SIDE_NAMES[side][0].toUpperCase()}${SIDE_NAMES[side].slice(1)} offset, px`, placeholder: measured?.inset?.[index]?.replace(/px$/, '') ?? 'auto', parse: raw => css.lengthInput(raw) });
      node.querySelector('.vf-k')?.remove();
      node.classList.add('bm-offset');
      return node;
    }
    return widthField(side, { diagram: true });
  };
  const square = (kind, inner) => {
    const sq = el('div', `bm-sq bm-${kind}`);
    sq.setAttribute('role', 'group');
    sq.setAttribute('aria-label', kind[0].toUpperCase() + kind.slice(1));
    sq.append(el('span', 'bm-caption', kind));
    for (const [index, side] of ['t', 'r', 'b', 'l'].entries()) {
      const cell = el('div', `bm-cell bm-${side}`);
      cell.setAttribute('role', 'group');
      cell.setAttribute('aria-label', `${kind} ${SIDE_NAMES[side]}`);
      cell.append(edgeField(kind, side, index));
      sq.append(cell);
    }
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
      for (const cell of sq.querySelectorAll(':scope > .bm-cell')) {
        const input = cell.querySelector('input');
        const text = input ? input.value || input.placeholder : cell.textContent;
        const length = text.length;
        cell.style.setProperty('--bm-value-width', `calc(${length}ch + 2px)`);
        if (!cell.classList.contains('bm-l') && !cell.classList.contains('bm-r')) continue;
        side = Math.max(side, length);
        if (input) { measuring.font = getComputedStyle(input).font; strip = Math.max(strip, measuring.measureText(text).width + 4); }
      }
      sq.style.setProperty('--bm-side-width', strip ? `${Math.ceil(strip)}px` : `calc(${side}ch + 4px)`);
      sq.classList.toggle('bm-wide-sides', side > 4);
      sq.classList.toggle('bm-stacked-sides', side > 6);
    };
    for (const input of sq.querySelectorAll(':scope > .bm-cell input')) {
      input.addEventListener('input', fitValues);
      input.addEventListener('keydown', fitValues);
      input.addEventListener('change', fitValues);
      input.addEventListener('divlet:field-value', fitValues);
    }
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
    const authored = nodes.length === 1 && views[0][axis] != null;
    const size = bareField(`content-${axis}`, `Content ${axis}, px`, authored ? dimension : null, dimension, next => {
      run(async () => {
        if (next === null) return { [axis]: null };
        const box = await readMeasured();
        if (nodes.length !== 1 || !Number.isFinite(box?.content?.[axis])) throw new Error('Select one visible element to edit its content size.');
        const sides = axis === 'width' ? [1, 3] : [0, 2];
        const extra = box.boxSizing === 'border-box' ? sides.reduce((sum, side) => sum + box.padding[side] + box.border[side], 0) : 0;
        return { [axis]: `${next + extra}px` };
      }, `content ${axis} ${next ?? 'default'}`);
    });
    size.classList.add('bm-dimension');
    const input = size.querySelector('input');
    const fit = () => size.style.setProperty('--bm-value-width', `calc(${(input.value || input.placeholder).length}ch + 4px)`);
    for (const event of ['input', 'keydown', 'change']) input.addEventListener(event, fit);
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

  return [['layout', 'Layout', layout], ['spacing', 'Spacing', spacing], ['border', 'Border', borderFold(views, { value, run, measured, tokens, widthField, nodeId: nodes.length === 1 ? nodes[0].id : null, rerender })], ['appearance', 'Appearance', appearanceFold({ value, run, measured, tokens })], ['effects', 'Effects', effects]];
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
    const widest = Math.ceil(Math.max(...labels.map(node => node.getBoundingClientRect().width)));
    if (widest > 0) group.style.setProperty('--label-col', `${widest + 2}px`);
  }
}

