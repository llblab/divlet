// One floating suggestion list for the inspector's inputs (classes, attributes, CSS properties).
// ↑↓ choose · Tab completes · Enter takes the chosen item (or what was typed) · Esc closes.
import { el, clamp, debounce, uiScale } from './util.js';

const pop = el('div', 'suggest');
pop.id = 'suggest';
pop.setAttribute('role', 'listbox');
pop.hidden = true;
document.body.append(pop);
let owner = null;
let options = null;
let items = [];
let active = -1;
let seq = 0;

function close() {
  seq++;
  if (owner) { owner.setAttribute('aria-expanded', 'false'); owner.removeAttribute('aria-activedescendant'); }
  owner = null;
  options = null;
  items = [];
  active = -1;
  pop.hidden = true;
  pop.replaceChildren();
}

function place() {
  if (!owner?.isConnected) return close();
  const r = owner.getBoundingClientRect();
  const w = pop.offsetWidth * uiScale();
  const h = pop.offsetHeight * uiScale();
  pop.style.left = `${clamp(r.left - 6, 6, innerWidth - w - 6)}px`;
  pop.style.top = `${r.bottom + 6 + h > innerHeight - 6 ? Math.max(6, r.top - h - 6) : r.bottom + 6}px`;
}

function paint() {
  pop.replaceChildren(...items.map((item, index) => {
    const row = el('div', `suggest-item${index === active ? ' on' : ''}`);
    row.id = `suggest-${index}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === active));
    const mark = el('i', `suggest-mark ${item.kind || ''}`);
    if (item.color) mark.style.background = item.color;
    row.append(mark, el('span', 'suggest-name', item.label ?? item.name), el('span', 'suggest-hint', item.hint || ''));
    row.addEventListener('pointerdown', event => { event.preventDefault(); accept(index); });
    row.addEventListener('pointermove', () => { if (active !== index) { active = index; paint(); } });
    return row;
  }));
  pop.hidden = !items.length;
  if (owner) {
    owner.setAttribute('aria-expanded', String(!!items.length));
    if (active >= 0) owner.setAttribute('aria-activedescendant', `suggest-${active}`); else owner.removeAttribute('aria-activedescendant');
  }
  place();
}

const lastWord = value => value.split(/\s+/).at(-1);

function accept(index) {
  const item = items[index];
  const input = owner;
  const settings = options;
  if (!item || !input) return;
  if (settings.words) { const words = input.value.split(/\s+/); words[words.length - 1] = item.name; input.value = words.join(' '); }
  else input.value = item.name;
  close();
  input.dispatchEvent(new Event('suggest-accept'));
  // A partial pick (a variant such as `hover:`) keeps typing; a whole one is taken at once.
  if (item.partial) { input.focus(); input.dispatchEvent(new Event('input')); return; }
  settings.onAccept?.(input, item);
}

/**
 * Offer `fetch(word)` results under `input`. `words: true` completes the last space-separated
 * word (class lists); otherwise the whole value. `onAccept(input, item)` runs on a pick.
 */
export function attachSuggest(input, { fetch, onAccept, words = false, empty = false }) {
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'suggest');
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';
  const show = async (force = false) => {
    if (document.activeElement !== input) return;
    const word = words ? lastWord(input.value) : input.value.trim();
    if (!word && !empty && !force) { if (owner === input) close(); return; }
    const mine = ++seq;
    let list;
    try { list = await fetch(word); } catch { return; }
    if (mine !== seq || document.activeElement !== input) return;
    list = (list || []).filter(item => item.name !== word).slice(0, 8);
    if (!list.length) { if (owner === input) close(); return; }
    owner = input;
    options = { onAccept, words };
    items = list;
    active = -1;
    paint();
  };
  const update = debounce(() => show(), 60);
  input.addEventListener('input', update);
  if (empty) input.addEventListener('focus', update);
  input.addEventListener('keydown', event => {
    // ↓ opens the list on an empty field; it never opens by itself over other controls unless `empty`.
    if (event.key === 'ArrowDown' && (owner !== input || pop.hidden)) { event.preventDefault(); show(true); return; }
    if (owner !== input || pop.hidden) return;
    const take = () => { event.preventDefault(); event.stopImmediatePropagation(); };
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      take();
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length + 1) % (items.length + 1);
      if (active === items.length) active = -1;
      paint();
    } else if (event.key === 'Tab' && !event.shiftKey) { take(); accept(Math.max(0, active)); }
    else if (event.key === 'Enter' && active >= 0) { take(); accept(active); }
    else if (event.key === 'Escape') { take(); close(); }
  });
  input.addEventListener('blur', () => { if (owner === input) close(); });
}

/** Local suggestions: names starting with the word first, then names containing it. */
export function filterLocal(list, word, limit = 8) {
  const needle = word.toLowerCase();
  const starts = list.filter(item => item.name.toLowerCase().startsWith(needle));
  const inside = needle.length > 1 ? list.filter(item => !item.name.toLowerCase().startsWith(needle) && item.name.toLowerCase().includes(needle)) : [];
  return [...starts, ...inside].slice(0, limit);
}

// A field that is replaced while its list is open (the inspector redraws) never gets a blur.
new MutationObserver(() => { if (owner && !owner.isConnected) close(); }).observe(document.body, { childList: true, subtree: true });
window.addEventListener('resize', () => { if (owner) place(); });
document.addEventListener('scroll', event => { if (owner && !pop.contains(event.target)) place(); }, true);
