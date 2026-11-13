import { $, el, icon, button, clamp, round, debounce, keys, pressGuard } from './util.js';
import { store, capable, on, documents, descriptor, loadModel, cachedModel, commit, edit, toast, newGroup, selectNodes, parentOf, textChild, whenVersion, request, apiUrl, receiveState } from './store.js';
import { fit, rectOf, postToFrame, measuredBox } from './canvas.js';
import * as actions from './actions.js';
import { openMenu, menuAnchor, closeMenu } from './menu.js';
import { overflowBar } from './toolbar.js';
import { panelSections } from './panels.js';
import { components as componentSource } from './host.js';
import { fontFamilyControl } from './typography.js';
import { attributesEditor } from './attrs.js';
import { formatCss, highlightCss } from './css.js';
import { attachSuggest, filterLocal } from './suggest.js';

/* Suggestions for the free-form fields: CSS properties the browser knows and common attributes.
   Classes have their own suggestions (Tailwind utilities, see classes.js). */
const CSS_PROPERTIES = [...new Set(Object.keys(document.documentElement.style).filter(name => !/^(webkit|moz|ms)/i.test(name) && Number.isNaN(Number(name))).map(name => name.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)).filter(name => /^[a-z][a-z-]*$/.test(name)))].sort();
const ATTRIBUTES = 'alt aria-describedby aria-hidden aria-label aria-labelledby dir disabled download for height href hidden id lang loading name placeholder rel required role rows src srcset tabindex target title type value width'.split(' ');

const panel = $('#inspector');
let token = 0;
let deferred = false;
let holding = 0;
let controlContext = null;
// The operation outlives any selected-node control; replacement views reflect this same pending state.
const fontUpload = { pending: false, run: uploadFont };
function paintFontUpload() {
  const button = panel.querySelector('[data-key="font-upload"]');
  if (button) { button.disabled = fontUpload.pending; button.setAttribute('aria-busy', String(fontUpload.pending)); }
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const COLORISH = /^(#[0-9a-f]{3,8}|rgba?\(.+\)|hsla?\(.+\)|oklch\(.+\))$/i;
const PRESETS = [[390, 'Phone'], [768, 'Tablet'], [1024, 'Small laptop'], [1280, 'Laptop'], [1440, 'Desktop']];
const quiet = promise => promise?.catch?.(() => null);
/** Commit from an "add" input that keeps focus: re-render once accepted so the new chip/row appears at once. */
const refreshed = promise => quiet(promise)?.then(async result => {
  if (!result) return result;
  await whenVersion(result.documentId, result.version);
  render({ force: true });
  return result;
});
const TRANSIENT = /(^class-add$|-new-(key|value)$)/;

/** Pause re-rendering while a pointer gesture (scrubbing) owns an inspector control. */
function hold() {
  holding++;
  return () => { holding = Math.max(0, holding - 1); if (!holding && deferred) schedule(); };
}

function toHex(value) {
  if (HEX.test(value)) return value.length === 4 ? `#${[...value.slice(1)].map(c => c + c).join('')}` : value.toLowerCase();
  const probe = document.createElement('i');
  probe.style.color = value;
  if (!probe.style.color) return null;
  document.body.append(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
  probe.remove();
  return rgb ? `#${rgb.slice(0, 3).map(n => Math.round(Number(n)).toString(16).padStart(2, '0')).join('')}` : null;
}

/* ---- small controls ------------------------------------------------------- */
function numberField(key, label, value, onCommit, { step = 1, min = -1e7, max = 1e7, tip, unit = 'px' } = {}) {
  const wrap = el('div', 'num');
  const name = el('span', 'num-label', label);
  name.dataset.tip = tip || `${label} · drag to scrub, Shift ×10`;
  const input = el('input', 'num-input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.dataset.key = key;
  input.value = String(round(value, 2));
  input.setAttribute('aria-label', tip || label);
  wrap.append(name, input);
  if (unit) { const suffix = el('span', 'num-unit', unit); suffix.setAttribute('aria-hidden', 'true'); wrap.append(suffix); }
  // Numbers people type are often expressions ("1280/2", "390+24"); anything unparsable waits for Enter or blur.
  const parseValue = raw => {
    let parsed = Number.parseFloat(raw);
    if (/^[\d\s.+\-*/()]+$/.test(raw) && /[+\-*/]/.test(raw.trim().slice(1))) { try { parsed = Function(`"use strict";return (${raw})`)(); } catch {} }
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const apply = (raw, group) => {
    const parsed = parseValue(raw);
    if (parsed === undefined) { input.value = String(round(value, 2)); return; }
    const next = clamp(round(parsed, 2), min, max);
    input.value = String(next);
    if (next !== value) { value = next; onCommit(next, group); }
  };
  // Typing commits too: a short pause after a value that parses sends it, so the artboard follows the field without Enter.
  // One focus session shares a group (one undo step), and the panel is not redrawn mid-typing (the input keeps the caret).
  let session = null;
  let typing = 0;
  input.addEventListener('focus', () => { session = newGroup(); });
  input.addEventListener('blur', () => { clearTimeout(typing); session = null; });
  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      const raw = input.value.trim();
      if (raw && parseValue(raw) !== undefined) apply(input.value, session);
    }, 140);
  });
  input.addEventListener('change', () => apply(input.value));
  input.addEventListener('focus', () => input.select());
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') { apply(input.value); input.blur(); }
    else if (event.key === 'Escape') { input.value = String(round(value, 2)); input.blur(); }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      apply(String((Number.parseFloat(input.value) || 0) + (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : 1)));
    }
  });
  name.addEventListener('pointerdown', event => {
    event.preventDefault();
    name.setPointerCapture(event.pointerId);
    const release = hold();
    const origin = value;
    const x0 = event.clientX;
    const group = newGroup();
    const scrub = debounce(next => onCommit(next, group), 70);
    wrap.classList.add('scrubbing');
    const move = e => {
      const next = clamp(round(origin + Math.round((e.clientX - x0) / 2) * step * (e.shiftKey ? 10 : 1), 2), min, max);
      if (next === value) return;
      input.value = String(next);
      value = next;
      scrub(next);
    };
    const up = () => {
      name.removeEventListener('pointermove', move);
      name.removeEventListener('pointerup', up);
      name.removeEventListener('pointercancel', up);
      wrap.classList.remove('scrubbing');
      if (value !== origin) scrub.flush(value); else scrub.cancel();
      release();
    };
    name.addEventListener('pointermove', move);
    name.addEventListener('pointerup', up);
    name.addEventListener('pointercancel', up);
  });
  return wrap;
}

function textField(key, value, onCommit, { placeholder = '', mono = false, multiline = false, label } = {}) {
  const input = el(multiline ? 'textarea' : 'input', `field${mono ? ' mono' : ''}`);
  if (!multiline) input.type = 'text';
  else input.rows = 1;
  input.value = value ?? '';
  input.placeholder = placeholder;
  input.dataset.key = key;
  input.spellcheck = false;
  input.setAttribute('aria-label', label || placeholder || key);
  const grow = () => { if (multiline) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight + 2, 260)}px`; } };
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { input.value = value ?? ''; grow(); input.blur(); }
    else if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); input.blur(); }
  });
  input.addEventListener('input', grow);
  input.addEventListener('change', () => { if (input.value !== (value ?? '')) { value = input.value; onCommit(input.value); } });
  queueMicrotask(grow);
  return input;
}

/**
 * Code in a textarea with colors: the text sits in a transparent textarea over a highlighted copy.
 * The stored text is formatted when it is committed; "Format" does it on demand.
 */
function codeField(key, value, onCommit, { highlight, format, placeholder = '', label }) {
  const wrap = el('div', 'code');
  const pre = el('pre', 'code-hl');
  pre.setAttribute('aria-hidden', 'true');
  const input = el('textarea', 'code-ta');
  input.spellcheck = false;
  input.dataset.key = key;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  const shown = format(value ?? '');
  input.value = shown;
  const paint = () => { pre.innerHTML = `${highlight(input.value)}\n`; };
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight + 2, 420)}px`; pre.style.height = input.style.height; pre.scrollTop = input.scrollTop; };
  let saved = value ?? '';
  const commit = () => {
    const next = format(input.value);
    if (next !== input.value) { input.value = next; paint(); grow(); }
    if (next !== saved) { saved = next; onCommit(next); }
  };
  input.addEventListener('input', () => { paint(); grow(); });
  input.addEventListener('scroll', () => { pre.scrollTop = input.scrollTop; pre.scrollLeft = input.scrollLeft; });
  input.addEventListener('change', commit);
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { input.value = shown; paint(); grow(); input.blur(); }
    else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); input.blur(); }
  });
  paint();
  wrap.append(pre, input);
  queueMicrotask(grow);
  return { wrap, format: () => { input.value = format(input.value); paint(); grow(); commit(); } };
}

function section(name, ...children) {
  const node = el('section', 'group');
  if (name) node.dataset.section = name;
  node.append(...children.filter(Boolean));
  return node;
}

const actionBar = (...buttons) => { const bar = el('div', 'actions'); bar.append(...buttons.filter(Boolean)); return bar; };

/* Folds remember being opened or closed (per kind of section, across selections and reloads). */
const folds = (() => { try { return JSON.parse(localStorage.getItem('divlet:folds') || '{}'); } catch { return {}; } })();
function details(summary, content, open = false, count) {
  const node = el('details', 'fold');
  node.open = folds[summary] ?? open;
  node.addEventListener('toggle', () => {
    folds[summary] = node.open;
    try { localStorage.setItem('divlet:folds', JSON.stringify(folds)); } catch {}
  });
  const head = el('summary', '', summary);
  if (count) head.append(el('span', 'fold-count', String(count)));
  node.append(head, content);
  return node;
}

function swatch(value, label, onPick, fallback = 'plain') {
  const plain = value.trim();
  const keyword = /^(inherit|initial|unset|revert|currentcolor|transparent|none|auto)$/i.test(plain);
  const hex = !keyword && (COLORISH.test(plain) || /^[a-z]+$/i.test(plain)) ? toHex(plain) : null;
  if (!hex) return el('span', `swatch ${fallback}`);
  const color = el('input', 'swatch');
  color.type = 'color';
  color.value = hex;
  color.style.setProperty('--swatch', value);
  color.setAttribute('aria-label', `${label} color`);
  color.addEventListener('change', () => onPick(color.value));
  return color;
}

/* ---- artboard ------------------------------------------------------------- */
function artboardView(doc, model) {
  const a = rectOf(doc);
  const id = doc.id;
  // With the lock on, W and H keep the ratio the artboard had when it was selected.
  const locked = () => { try { return localStorage.getItem('divlet:ratio-lock') === '1'; } catch { return false; } };
  const patchArtboard = key => (value, group) => {
    const change = { [key]: value };
    if (locked() && (key === 'width' || key === 'height') && a.width > 0 && a.height > 0) {
      if (key === 'width') change.height = Math.max(1, Math.round(value * a.height / a.width));
      else change.width = Math.max(1, Math.round(value * a.width / a.height));
    }
    return quiet(commit(id, { artboard: change }, { label: key === 'width' || key === 'height' ? 'resize artboard' : 'move artboard', group }));
  };
  const view = [];
  view.push(section('name', textField('name', doc.name, value => quiet(commit(id, { name: value.trim() || doc.name }, { label: `rename to “${value.trim()}”` })), { placeholder: 'Artboard name', label: 'Artboard name' })));

  const geometry = el('div', 'grid2 geometry-grid');
  geometry.append(
    numberField('x', 'X', a.x, patchArtboard('x'), { tip: 'X position' }),
    numberField('y', 'Y', a.y, patchArtboard('y'), { tip: 'Y position' }),
  );
  geometry.append(
    numberField('width', 'W', a.width, patchArtboard('width'), { min: 1, max: 16384, tip: 'Viewport width' }),
    numberField('height', 'H', a.height, patchArtboard('height'), { min: 1, max: 16384, tip: 'Viewport height' }),
  );
  const presets = el('div', 'chips');
  for (const [width, device] of PRESETS) {
    const chip = el('button', `chip${a.width === width ? ' on' : ''}`, String(width));
    chip.type = 'button';
    chip.dataset.tip = `${device} · ${width} px wide`;
    chip.setAttribute('aria-pressed', String(a.width === width));
    chip.addEventListener('click', () => quiet(commit(id, { artboard: { width } }, { label: `width ${width}` })));
    presets.append(chip);
  }
  presets.append(button('rotate', 'Swap width and height', () => actions.rotateArtboard(id), 'mini'));
  // Aspect ratio: set the height from the width, or lock the ratio while typing W or H.
  const ratios = el('div', 'chips ratio-row');
  const lock = el('button', `chip lock${locked() ? ' on' : ''}`);
  lock.type = 'button';
  lock.dataset.key = 'ratio-lock';
  lock.dataset.tip = 'Keep the aspect ratio when changing W or H';
  lock.setAttribute('aria-label', 'Lock aspect ratio');
  lock.setAttribute('aria-pressed', String(locked()));
  lock.append(icon(locked() ? 'lock' : 'unlock'));
  lock.addEventListener('click', () => { try { localStorage.setItem('divlet:ratio-lock', locked() ? '0' : '1'); } catch {} render({ force: true }); });
  ratios.append(lock);
  for (const [name, w, h] of [['1:1', 1, 1], ['4:3', 4, 3], ['3:2', 3, 2], ['16:9', 16, 9], ['9:16', 9, 16]]) {
    const chip = el('button', `chip${Math.abs(a.width / a.height - w / h) < 0.004 ? ' on' : ''}`, name);
    chip.type = 'button';
    chip.dataset.tip = `Aspect ratio ${name} at the current width`;
    chip.addEventListener('click', () => quiet(commit(id, { artboard: { height: Math.max(1, Math.round(a.width * h / w)) } }, { label: `ratio ${name}` })));
    ratios.append(chip);
  }
  view.push(section('geometry', geometry, presets, ratios));

  const tokens = model?.tokens || {};
  const tokenBox = el('div', 'rows');
  for (const [name, value] of Object.entries(tokens)) {
    const line = el('div', 'kv');
    line.append(swatch(value, name, hex => quiet(commit(id, { tokens: { [name]: hex } }, { label: `token ${name}` }))));
    line.append(el('span', 'k', name.replace(/^--/, '')), textField(`token:${name}`, value, v => quiet(commit(id, { tokens: { [name]: v } }, { label: `token ${name}` })), { mono: true, label: `${name} value` }));
    line.append(button('close', 'Remove token', () => quiet(commit(id, { tokens: { [name]: null } }, { label: `remove token ${name}` })), 'mini'));
    tokenBox.append(line);
  }
  tokenBox.append(addRow('token', ['--color-brand', '#5b5bf0'], (name, value) => {
    const key = name.replace(/^(?!--)/, '--');
    if (key.length > 2 && value) refreshed(commit(id, { tokens: { [key]: value } }, { label: `token ${key}` }));
  }), el('span', 'caption', '--color-brand → bg-brand, text-brand'));
  view.push(section('tokens', details('Tokens', tokenBox, Object.keys(tokens).length > 0, Object.keys(tokens).length)));

  if (model) {
    const css = codeField('css', model.css, v => quiet(commit(id, { css: v }, { label: 'edit css' })), { highlight: highlightCss, format: formatCss, placeholder: '/* only what classes cannot do: @keyframes, complex selectors */', label: 'Custom CSS' });
    const cssBox = el('div', 'rows');
    const tidy = el('button', 'link-button', 'Format');
    tidy.type = 'button';
    tidy.dataset.tip = 'Lay the CSS out one declaration per line';
    tidy.addEventListener('click', () => css.format());
    cssBox.append(css.wrap, tidy);
    view.push(section('css', details('Custom CSS', cssBox, !!model.css)));
    view.push(section('meta', details('Metadata', metadataField('metadata', model.metadata, next => quiet(commit(id, { metadata: next }, { label: 'edit metadata' }))), false, Object.keys(model.metadata || {}).length)));
  }
  // Every artboard action in one row; what does not fit moves into a trailing dropdown by itself.
  view.push(overflowBar(actions.artboardItems(id)));
  return view;
}

/** Metadata as JSON; removed keys become null in the patch so they are really deleted. */
function metadataField(key, current, save) {
  return textField(key, JSON.stringify(current || {}, null, 2), v => {
    let parsed;
    try { parsed = JSON.parse(v || '{}'); } catch (error) { toast(`Metadata must be valid JSON: ${error.message}`); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { toast('Metadata must be a JSON object'); return; }
    const removed = Object.fromEntries(Object.keys(current || {}).filter(k => !(k in parsed)).map(k => [k, null]));
    save({ ...removed, ...parsed });
  }, { mono: true, multiline: true, placeholder: '{ "intent": "…" }', label: 'Metadata JSON' });
}

/** Two inputs that commit together, on Enter in either one or when the second loses focus. */
function addRow(key, placeholders, onAdd, suggestions) {
  const row = el('div', 'kv add');
  const first = textField(`${key}-new-key`, '', () => {}, { placeholder: placeholders[0], mono: true, label: `New ${key} name` });
  if (suggestions) attachSuggest(first, { fetch: word => filterLocal(suggestions, word), onAccept: () => second.focus() });
  const second = textField(`${key}-new-value`, '', () => {}, { placeholder: placeholders[1], mono: true, label: `New ${key} value` });
  const submit = () => {
    const a = first.value.trim();
    const b = second.value.trim();
    if (!a) return false;
    if (!b && !a.includes(':')) return false;
    onAdd(a, b);
    first.value = '';
    second.value = '';
    return true;
  };
  for (const input of [first, second]) input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); if (submit()) first.focus(); } });
  second.addEventListener('change', submit);
  row.append(first, second);
  return row;
}

/* ---- multi artboard ------------------------------------------------------- */
function multiView(docs) {
  const ids = docs.map(doc => doc.id);
  const count = el('div', 'count');
  count.append(el('b', '', String(docs.length)), el('span', '', 'artboards selected'));
  return [
    section('count', count),
    section('align', el('div', 'caption', 'Align and distribute'), actionBar(
      button('alignL', 'Align left edges', () => actions.alignArtboards(ids, 'x', 'start')),
      button('alignCH', 'Align horizontal centers', () => actions.alignArtboards(ids, 'x', 'center')),
      button('alignR', 'Align right edges', () => actions.alignArtboards(ids, 'x', 'end')),
      button('alignT', 'Align top edges', () => actions.alignArtboards(ids, 'y', 'start')),
      button('alignCV', 'Align vertical centers', () => actions.alignArtboards(ids, 'y', 'center')),
      button('alignB', 'Align bottom edges', () => actions.alignArtboards(ids, 'y', 'end')),
      button('distH', 'Distribute horizontally', () => actions.distributeArtboards(ids, 'x')),
      button('distV', 'Distribute vertically', () => actions.distributeArtboards(ids, 'y')),
    )),
  ];
}

/* ---- node ----------------------------------------------------------------- */
function parseDeclarations(text) {
  const out = {};
  for (const part of text.split(';')) {
    const at = part.indexOf(':');
    if (at < 1) continue;
    const key = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function kvEditor(documentId, node, field, save) {
  const box = el('div', 'rows');
  const current = node[field] || {};
  const patch = save || ((value, label) => refreshed(commit(documentId, { nodes: { [node.id]: { [field]: value } } }, { label: `${label} on ${node.id}` })));
  for (const [key, value] of Object.entries(current)) {
    const line = el('div', 'kv');
    line.append(field === 'style' ? swatch(value, key, hex => patch({ [key]: hex }, `set ${key}`), 'none') : el('span', 'swatch none'));
    const name = el('span', 'k', key);
    if (key.length > 10) name.dataset.tip = key;
    line.append(name, textField(`${field}:${key}`, value, v => patch(v === '' ? { [key]: null } : { [key]: v }, `set ${key}`), { mono: true, label: `${key} value` }), button('close', `Remove ${key}`, () => patch({ [key]: null }, `remove ${key}`), 'mini'));
    line.firstChild.dataset.tip = field === 'style' && COLORISH.test(value) ? 'Pick a color' : '';
    box.append(line);
  }
  box.append(addRow(field, field === 'style' ? ['property', 'value'] : ['attribute', 'value'], (key, value) => {
    if (field === 'style' && key.includes(':')) { const all = parseDeclarations(key); if (Object.keys(all).length) patch(all, 'set styles'); return; }
    patch({ [field === 'style' ? key.toLowerCase() : key]: value }, `set ${key}`);
  }, field === 'style' ? CSS_PROPERTIES.map(name => ({ name })) : ATTRIBUTES.map(name => ({ name }))));
  return box;
}

function textEditor(model, node) {
  let target = node;
  if (node.type === 'text') target = node;
  else if (!textChild(model, node) && !(node.type === 'element' && !node.children.length && !['img', 'input', 'br', 'hr'].includes(node.tag))) return null;
  const content = textChild(model, node)?.content ?? '';
  return textField('text', content, value => quiet(edit(model.id, { type: 'text', id: target.id, content: value }, { label: `edit text of ${target.id}` })), { multiline: true, placeholder: 'Text', label: 'Text content' });
}


/** URL the board can load for an image source written relative to the project source. */
function imageUrl(doc, src) {
  if (!src) return '';
  if (src.startsWith('asset:')) {
    const at = src.indexOf('#'), before = at < 0 ? src : src.slice(0, at);
    return apiUrl(`build/assets/${before.slice(6)}${before.includes('?') ? '&' : '?'}divlet-resource=${store.state?.project?.version || 0}${at < 0 ? '' : src.slice(at)}`);
  }
  if (/^(https?:|data:)/i.test(src)) return src;
  const projectDir = String(store.state?.projectDir || '').replaceAll('\\', '/');
  const html = String(doc.sourcePath || doc.modelPath || '').replaceAll('\\', '/');
  const folder = html.startsWith(projectDir) ? html.slice(projectDir.length + 1).split('/').slice(0, -1).join('/') : '';
  try { return new URL(src, apiUrl(`files/${folder ? `${folder}/` : ''}`)).href; } catch { return ''; }
}

function uploadInto(doc, node) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    try {
      const group = `image:${crypto.randomUUID()}`;
      const response = await fetch(apiUrl(`api/assets?name=${encodeURIComponent(file.name)}&documentId=${encodeURIComponent(doc.id)}&group=${encodeURIComponent(group)}`), { method: 'POST', headers: { 'Content-Type': file.type || 'image/png' }, body: file });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'Upload failed');
      const alt = node.attrs.alt || file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ');
      await refreshed(commit(doc.id, { nodes: { [node.id]: { attrs: { src: body.path, alt } } } }, { label: `image ${body.file}`, group }));
      toast(`Added ${body.file}`);
    } catch (error) { toast(error.message); }
  });
  picker.click();
}

async function assetMenu(doc, node, anchor) {
  let assets = [];
  try { assets = (await request(`api/assets?documentId=${encodeURIComponent(doc.id)}`)).assets; } catch (error) { toast(error.message); }
  openMenu([
    { heading: assets.length ? 'Images in divlet/' : 'No images in divlet/ yet' },
    ...assets.slice(0, 40).map(asset => ({ label: asset.file, icon: 'image', checked: asset.path === node.attrs.src, run: () => refreshed(commit(doc.id, { nodes: { [node.id]: { attrs: { src: asset.path } } } }, { label: `image ${asset.file}` })) })),
    '-',
    { label: 'Upload image…', icon: 'upload', run: () => uploadInto(doc, node) },
  ], { anchor, label: 'Image', className: 'menu-assets' });
}

function imageEditor(doc, node) {
  const box = el('div', 'image-box');
  const preview = el('div', 'thumb');
  const url = imageUrl(doc, node.attrs.src);
  if (url) { const img = el('img'); img.src = url; img.alt = ''; img.addEventListener('error', () => preview.classList.add('broken')); preview.append(img); }
  else preview.classList.add('empty');
  preview.append(icon('image', 'icon thumb-icon'));
  const side = el('div', 'image-side');
  const replace = el('button', 'link-button', node.attrs.src ? 'Replace…' : 'Choose…');
  replace.type = 'button';
  replace.dataset.key = 'image-replace';
  replace.addEventListener('click', event => assetMenu(doc, node, event.currentTarget));
  const upload = el('button', 'link-button', 'Upload');
  upload.type = 'button';
  upload.dataset.tip = 'Add an image file to divlet/assets — or drop it onto the artboard';
  upload.addEventListener('click', () => uploadInto(doc, node));
  const buttons = el('div', 'image-buttons');
  // Choosing or uploading project images needs a host that stores asset bytes; elsewhere the source stays a plain field.
  if (capable('assets')) buttons.append(replace, upload);
  const alt = textField('image-alt', node.attrs.alt ?? '', value => refreshed(commit(doc.id, { nodes: { [node.id]: { attrs: { alt: value } } } }, { label: `alt text of ${node.id}` })), { placeholder: 'Alt text (describe the image)', label: 'Alt text' });
  side.append(el('span', 'image-src', node.attrs.src || 'No source yet'), buttons);
  box.append(preview, side);
  const wrap = el('div', 'rows');
  wrap.append(box, alt);
  return wrap;
}

/* ---- components ---------------------------------------------------------- */
let componentsCache = { revision: -1, list: [], loading: false };
function componentList() {
  const revision = store.state?.revision ?? 0;
  if (componentSource && componentsCache.revision !== revision && !componentsCache.loading) {
    componentsCache.loading = true;
    componentSource.list().then(result => { componentsCache = { revision, list: result.components, loading: false }; schedule(); }).catch(() => { componentsCache.loading = false; });
  }
  return componentsCache.list;
}

/** An instance: which component it shows, its text overrides, and the ways out (go to, reset, detach). */
function instanceEditor(doc, node) {
  const ref = node.ref.includes('/') ? node.ref : `${doc.id}/${node.ref}`;
  const component = componentList().find(item => item.ref === ref);
  const box = el('div', 'rows');
  const head = el('div', 'instance-head');
  head.append(icon('instance', 'icon instance-icon'), el('span', 'instance-name', component?.name ?? ref), el('span', 'instance-from', descriptor(ref.split('/')[0])?.name ?? ref.split('/')[0]));
  const go = el('button', 'link-button', 'Go to');
  go.type = 'button';
  go.dataset.key = 'go-to-component';
  go.dataset.tip = 'Select the component this instance shows';
  go.addEventListener('click', () => actions.goToComponent(doc.id, node.id));
  head.append(go);
  box.append(head);
  const overrides = node.descendants || {};
  for (const text of component?.texts ?? []) {
    const current = overrides[text.id]?.content;
    const line = el('div', 'kv override');
    const name = el('span', 'k', text.id);
    if (text.id.length > 10) name.dataset.tip = text.id;
    const field = textField(`override:${text.id}`, current ?? text.content, value => {
      const next = value === text.content || value === '' ? { [text.id]: null } : { [text.id]: { content: value } };
      refreshed(commit(doc.id, { nodes: { [node.id]: { descendants: next } } }, { label: `override text of ${node.id}` }));
    }, { label: `${text.id} text`, placeholder: text.content });
    line.append(el('span', `swatch ${current !== undefined ? 'set' : 'none'}`), name, field);
    if (current !== undefined) line.append(button('undo', 'Back to the component text', () => refreshed(commit(doc.id, { nodes: { [node.id]: { descendants: { [text.id]: null } } } }, { label: `reset ${text.id} on ${node.id}` })), 'mini'));
    else line.append(el('span'));
    box.append(line);
  }
  const count = Object.keys(overrides).length;
  const foot = el('div', 'instance-foot');
  foot.append(el('span', 'caption', count ? `${count} override${count === 1 ? '' : 's'}` : 'Same as the component'));
  if (count) {
    const reset = el('button', 'link-button', 'Reset');
    reset.type = 'button';
    reset.addEventListener('click', () => refreshed(commit(doc.id, { nodes: { [node.id]: { descendants: null } } }, { label: `reset overrides of ${node.id}` })));
    foot.append(reset);
  }
  const detach = el('button', 'link-button', 'Detach');
  detach.type = 'button';
  detach.dataset.tip = 'Turn the instance into ordinary, editable elements';
  detach.addEventListener('click', () => actions.detachInstance(doc.id, node.id));
  foot.append(detach);
  box.append(foot);
  return box;
}

async function uploadFont(file) {
  if (fontUpload.pending) return;
  fontUpload.pending = true; paintFontUpload();
  try {
    const { version, capabilities } = store.state.project;
    if (!capabilities.fontUpload || !file.size || file.size > capabilities.fontUpload.maxBytes) throw new Error('Choose a nonempty TTF/OTF/WOFF or null-transform WOFF2 font of at most 20 MiB.');
    const bytes = await file.arrayBuffer();
    try { await new FontFace('divlet-device-probe', bytes).load(); }
    catch { throw new Error('The browser could not decode this font. Nothing was uploaded.'); }
    const response = await fetch(apiUrl(`api/fonts?name=${encodeURIComponent(file.name)}&expectedVersion=${version}`), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || 'Font upload failed');
    try { receiveState(await request('api/project')); await render({ force: true }); }
    catch { toast(`Added ${body.family}; refresh the board to see its family.`); return; }
    toast(`Added ${body.family}. Choose it in Family.`);
  } catch (error) { toast(error.message); }
  finally { fontUpload.pending = false; paintFontUpload(); }
}

/** Sections the registered panels (plugins) contribute for a selection; each change is one undo step for all selected elements. */
function panelFolds(kind, doc, nodes, parent) {
  // `refresh: false` is for an edit that lands while a field is being typed into: the panel must not replace the input
  // under the caret, so the change is committed without a forced re-render (the focusout path draws the deferred one).
  const applyClasses = (transform, label, { group, refresh = true, style } = {}) => {
    // Tab can reach several fields before the first write returns. Derive each change inside the writer queue,
    // not from the nodes captured when this panel was built, or the next field would erase the previous one.
    const result = commit(doc.id, async model => {
      const patch = {};
      for (const selected of nodes) {
        const node = model.nodes[selected.id];
        if (node?.type !== 'element') throw new Error(`Element no longer exists: ${selected.id}`);
        const next = transform(node.className || '');
        const inline = typeof style === 'function' ? await style(node) : style;
        const change = inline ? { style: inline } : {};
        if (next !== (node.className || '')) change.className = next;
        if (Object.keys(change).length) patch[node.id] = change;
      }
      return Object.keys(patch).length ? { nodes: patch } : null;
    }, { label, group });
    if (refresh) refreshed(result); else quiet(result);
    return result;
  };
  const ctx = {
    doc, nodes, node: nodes[0], parent, applyClasses,
    saveClasses: (next, label) => refreshed(commit(doc.id, { nodes: { [nodes[0].id]: { className: next.join(' ') } } }, { label: `${label} on ${nodes[0].id}` })),
    spacingFocus: focus => postToFrame(doc.id, { type: 'divlet:spacing-focus', focus }),
    measuredBox: nodeId => measuredBox(doc.id, nodeId),
    freshMeasuredBox: nodeId => {
      const render = descriptor(doc.id)?.render;
      const read = () => { const box = measuredBox(doc.id, nodeId); return box?.render === render ? box : null; };
      if (read()) return Promise.resolve(read());
      return new Promise((resolve, reject) => {
        const stop = on('spacing-box', () => { const box = read(); if (box) { stop(); clearTimeout(timer); resolve(box); } });
        const timer = setTimeout(() => { stop(); reject(new Error('The preview has not measured this render yet. Try the size edit again.')); }, 2000);
      });
    },
  };
  const sections = panelSections(kind, ctx);
  const family = fontFamilyControl(nodes, { css: [store.state?.project?.css, cachedModel(doc.id)?.css], apply: applyClasses, upload: store.state?.project?.capabilities?.fontUpload ? fontUpload : undefined });
  const appearance = sections.find(item => item.name === 'appearance');
  if (appearance) (appearance.content.querySelector('[data-inspector-slot="typography"]') ?? appearance.content).prepend(family);
  else {
    const content = el('div', 'appearance-box');
    content.append(family);
    sections.push({ name: 'appearance', title: 'Appearance', content });
  }
  return sections.map(({ name, title, content }) => section(name, title ? details(title, content, true) : content));
}

function idField(doc, node) {
  const wrap = el('label', 'ident-field');
  wrap.dataset.tip = 'Element ID · click to rename';
  const input = el('input', 'ident-input');
  input.type = 'text';
  input.value = node.id;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.dataset.key = 'node-id';
  input.setAttribute('aria-label', 'Element ID');
  const size = () => { input.size = Math.max(4, Math.min(28, input.value.length + 1)); };
  size();
  input.addEventListener('input', size);
  const commitId = () => {
    const to = input.value.trim();
    if (to === node.id) { input.value = node.id; size(); return; }
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(to)) { toast(`“${to}” is not a valid ID: start with a letter; letters, digits, - _ . : only`); input.value = node.id; size(); return; }
    quiet(edit(doc.id, { type: 'rename', id: node.id, to }, { label: `rename #${node.id} to #${to}` }))?.then(async result => {
      if (!result) { input.value = node.id; size(); return; }
      await whenVersion(result.documentId, result.version);
      selectNodes(doc.id, [to]);
    });
  };
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    else if (event.key === 'Escape') { input.value = node.id; size(); input.blur(); }
  });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('change', commitId);
  wrap.append(el('span', 'ident-hash', '#'), input);
  return wrap;
}

function nodeView(doc, model, nodeIds) {
  if (nodeIds.length > 1) {
    const count = el('div', 'count');
    count.append(el('b', '', String(nodeIds.length)), el('span', '', 'elements selected'));
    const elements = nodeIds.map(id => model.nodes[id]).filter(node => node?.type === 'element');
    // What applies to every selected element: layout, spacing and effects change all of them at once.
    const shared = elements.length === nodeIds.length ? panelFolds('nodes', doc, elements, null) : [];
    return [section('count', count), ...shared];
  }
  const node = model.nodes[nodeIds[0]];
  if (!node) return [];
  const view = [];
  const completeMap = (field, delta) => Object.fromEntries(Object.entries({ ...node[field], ...delta }).filter(([, value]) => value !== null));
  const head = el('div', 'node-head');
  if (node.type === 'element') {
    const tag = el('button', 'tag', node.tag);
    tag.type = 'button';
    tag.dataset.tip = 'Change tag';
    tag.setAttribute('aria-label', `Tag ${node.tag}, change`);
    tag.append(icon('chevron', 'icon caret'));
    tag.addEventListener('click', event => actions.tagMenu(doc.id, node.id, { anchor: event.currentTarget }));
    head.append(tag);
  } else if (node.type === 'ref') {
    const badge = el('span', 'tag static instance', 'instance');
    badge.prepend(icon('instance', 'icon caret-left'));
    head.append(badge);
  } else head.append(el('span', 'tag static', 'text'));
  if (node.type === 'element' && node.reusable) {
    const mark = el('button', 'component-mark');
    mark.type = 'button';
    mark.dataset.tip = 'This element is a component · click to stop';
    mark.append(icon('component'), el('span', '', 'Component'));
    mark.addEventListener('click', () => actions.toggleComponent(doc.id, node.id));
    head.append(mark);
  }
  head.append(idField(doc, node));
  view.push(section('head', head));
  // The layer's name (an imported design names its layers; their ids are generated hashes) is what people recognise.
  if (typeof node.metadata?.name === 'string' && node.metadata.name.trim() && node.metadata.name !== node.id) {
    const label = el('div', 'node-name', node.metadata.name.trim());
    label.dataset.tip = 'Layer name';
    view.push(section('node-name', label));
  }
  const text = textEditor(model, node);
  if (text) view.push(section('text', text));
  if (node.type === 'ref') view.push(section('instance', instanceEditor(doc, node)));
  if (node.type === 'element') {
    if (node.tag === 'img') view.push(section('image', imageEditor(doc, node)));
    view.push(...panelFolds('node', doc, [node], parentOf(model, node.id)));
    view.push(section('attrs', details('Attributes', attributesEditor(node, (attrs, label) => refreshed(commit(doc.id, { nodes: { [node.id]: { attrs } } }, { label: `${label} on ${node.id}` }))), true, Object.keys(node.attrs).length)));
    view.push(section('style', details('Inline style', kvEditor(doc.id, node, 'style'), Object.keys(node.style).length > 0, Object.keys(node.style).length)));
  }
  view.push(section('node-meta', details('Metadata', metadataField('node-metadata', node.metadata, next => quiet(commit(doc.id, { nodes: { [node.id]: { metadata: next } } }, { label: `edit metadata of ${node.id}` }))), false, Object.keys(node.metadata || {}).length)));
  const observed = store.observations.get(doc.id);
  const measured = observed?.nodes.find(item => item.id === node.id);
  if (measured && observed.render === doc.render) {
    const values = el('div', 'values');
    values.dataset.tip = 'Measured in the page (CSS px)';
    for (const [label, value] of [['X', measured.rect.x], ['Y', measured.rect.y], ['W', measured.rect.width], ['H', measured.rect.height]]) {
      const cell = el('span', 'value');
      cell.append(el('i', '', label), document.createTextNode(String(Math.round(value))));
      values.append(cell);
    }
    if (measured.overflowX || measured.overflowY) { const flag = el('span', 'value warn', 'overflow'); flag.dataset.tip = `Content overflows ${[measured.overflowX && 'horizontally', measured.overflowY && 'vertically'].filter(Boolean).join(' and ')}`; values.append(flag); }
    view.push(section('measured', values));
  }
  return view;
}

/* ---- rendering ------------------------------------------------------------ */
function typing() {
  const active = document.activeElement;
  // A colour picker holds an unfinished choice too: re-rendering under it would fire `change` on a detached node.
  return panel.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName) && !active.readOnly;
}

function contextOf(docs) {
  return JSON.stringify([docs.map(doc => [doc.id, doc.version, doc.render]), store.node?.documentId, store.node?.nodeIds, store.state?.project?.format, store.state?.project?.capabilities?.properties]);
}

function invalidateMenu(force = false) {
  if (panel.contains(menuAnchor()) && (force || controlContext !== contextOf(documents().filter(doc => store.selected.has(doc.id))))) {
    deferred = false; closeMenu({ restoreFocus: false });
  }
}

export async function render({ force = false } = {}) {
  const docs = documents().filter(doc => store.selected.has(doc.id));
  const ownedMenu = panel.contains(menuAnchor());
  if (!docs.length || store.expanded) { if (ownedMenu) { deferred = false; closeMenu({ restoreFocus: false }); } ++token; panel.hidden = true; panel.replaceChildren(); delete panel.dataset.view; controlContext = null; document.body.classList.remove('has-inspector'); return; }
  if ((!force && (typing() || holding)) || pressing()) { deferred = true; return; }
  // Geometry-only reports must not discard hover/focus and hide an action before it can
  // receive a press. Even a forced measurement refresh waits for an unchanged-context menu to close.
  // Keep the real controls and callbacks, never rebase their authority.
  if (controlContext === contextOf(docs) && (ownedMenu || !force && (panel.matches(':hover') || panel.contains(document.activeElement)))) { deferred = true; return; }
  if (ownedMenu) { deferred = false; closeMenu({ restoreFocus: false }); }
  const mine = ++token;
  deferred = false;
  let content;
  if (docs.length > 1) content = multiView(docs);
  else {
    const doc = docs[0];
    let model = cachedModel(doc.id);
    if (!model) {
      try { model = await loadModel(doc.id); } catch (error) { if (mine === token && !error.quiet && error.status !== 404) toast(error.message); return; }
      if (mine !== token) return;
    }
    const nodeIds = store.node?.documentId === doc.id ? store.node.nodeIds.filter(id => model.nodes[id]) : [];
    content = nodeIds.length ? nodeView(doc, model, nodeIds) : artboardView(doc, model);
  }
  const focused = document.activeElement;
  const key = panel.contains(focused) ? focused.dataset.key : null;
  const caret = key && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null;
  const pending = key && TRANSIENT.test(key) ? focused.value : null;
  const open = new Map([...panel.querySelectorAll('details')].map(node => [node.parentElement?.dataset.section, node.open]));
  const scroll = panel.scrollTop;
  const sameView = panel.dataset.view === viewKey();
  panel.replaceChildren(...content.filter(Boolean));
  controlContext = contextOf(docs);
  panel.dataset.view = viewKey();
  if (sameView) for (const node of panel.querySelectorAll('details')) { const state = open.get(node.parentElement?.dataset.section); if (state !== undefined) node.open = state; }
  panel.hidden = false;
  document.body.classList.add('has-inspector');
  if (sameView) panel.scrollTop = scroll;
  const claimed = focusWanted();
  if (key && !claimed) {
    const target = [...panel.querySelectorAll('[data-key]')].find(node => node.dataset.key === key);
    if (target) {
      if (pending) target.value = pending;
      target.focus({ preventScroll: true });
      if (caret && target.setSelectionRange) try { target.setSelectionRange(...caret); } catch {}
    }
  }
}

/* Double-click on something without text: the field that matters for that element gets focus. */
const PRIMARY = { img: 'src', video: 'src', audio: 'src', source: 'src', iframe: 'src', input: 'placeholder', textarea: 'placeholder', a: 'href', form: 'action' };
let wanted = null;
function focusWanted() {
  if (!wanted) return false;
  const { documentId, nodeId, tag } = wanted;
  const now = store.node;
  if (!now || now.documentId !== documentId || now.nodeIds.length !== 1 || now.nodeIds[0] !== nodeId || !panel.querySelector('[data-section]')) return false;
  wanted = null;
  const attribute = PRIMARY[tag];
  let target = null;
  if (attribute) {
    target = panel.querySelector(`[data-key="attr:${attribute}"]`);
    if (!target) {
      const name = panel.querySelector('[data-key="attr-new-key"]');
      target = panel.querySelector('[data-key="attr-new-value"]');
      if (name && target) { name.value = attribute; target.placeholder = attribute === 'src' ? 'assets/photo.png or https://…' : attribute === 'href' ? 'https://… or #section' : 'value'; }
    }
  } else target = panel.querySelector('[data-key="text"]');
  if (!target) return false;
  target.closest('details')?.setAttribute('open', '');
  target.focus({ preventScroll: false });
  target.select?.();
  return true;
}
on('edit-fallback', info => { wanted = info; requestAnimationFrame(() => setTimeout(focusWanted, 60)); });

/** Identity of what is shown, so folds and scroll survive updates of the same subject only. */
function viewKey() {
  return `${[...store.selected].sort().join(',')}|${store.node?.nodeIds.join(',') || ''}`;
}

const pressing = pressGuard(panel, () => { if (deferred && !typing() && !holding) render(); });
panel.addEventListener('focusout', () => { setTimeout(() => { if (deferred && !typing() && !holding && !pressing()) render(); }, 0); });

const schedule = (() => { let frame = 0; return () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => render()); }; })();
panel.addEventListener('divlet:menu-close', () => { if (deferred) schedule(); });
panel.addEventListener('pointerleave', () => { if (deferred) schedule(); });
const lastMeasurement = new Map();
on('selection', () => { invalidateMenu(true); schedule(); });
// Warm the component list so an instance never shows up without its name and texts.
on('state', () => { invalidateMenu(); if (documents().some(doc => doc.components?.length)) componentList(); schedule(); });
on('model', schedule);
on('expanded', schedule);
on('spacing-box', ({ documentId, nodeId }) => {
  if (store.node?.documentId !== documentId || !store.node.nodeIds.includes(nodeId)) return;
  // Typing (or a captured pointer) keeps the panel as it is; remembering that a render is owed is what makes the later
  // focusout/pointer flush draw it, and the timer below covers a pointer that simply rests on the panel.
  if (!typing() && !holding) schedule(); else deferred = true;
  // A measurement is what the empty fields quote. A normal render keeps deferring while the pointer rests over the panel, which
  // would leave those fields quoting the previous render (a pill's radius after its class was removed), so flush it forced —
  // only when nothing is being typed or held and no menu is open under the pointer.
  setTimeout(() => {
    if (!deferred || typing() || holding || pressing() || panel.contains(menuAnchor())) return;
    render({ force: true });
  }, 600);
});
on('observations', report => {
  if (typing() || !store.selected.has(report.documentId)) return;
  // The same height from a fresh render can make Fit height available again after an edit or Undo.
  const measurement = `${report.render}:${report.contentHeight}`;
  const changed = lastMeasurement.get(report.documentId) !== measurement;
  lastMeasurement.set(report.documentId, measurement);
  if (store.node || changed) schedule();
});
on('live-rect', ({ id, rect }) => {
  if (store.selected.size !== 1 || !store.selected.has(id)) return;
  for (const key of ['x', 'y', 'width', 'height']) {
    const input = panel.querySelector(`[data-key="${key}"]`);
    if (input && document.activeElement !== input) input.value = String(Math.round(rect[key]));
  }
});
