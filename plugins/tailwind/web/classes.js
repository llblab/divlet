// Tailwind classes in the inspector: each chip says what it does (hover for its CSS), a click
// edits it in place, × removes it, and typing suggests utilities with their effect.
import { el, icon } from '../../lib/util.js';
import { request, descriptor, undo, redo } from '../../lib/store.js';
import { attachSuggest } from '../../lib/suggest.js';

const enc = encodeURIComponent;
/** Class names: split on whitespace, and on commas only outside [] and () — `text-[clamp(40px,3.5vw,58px)]` is one class. */
function split(value) {
  const out = [];
  let depth = 0;
  let word = '';
  for (const ch of String(value || '')) {
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) || (ch === ',' && !depth)) { if (word) out.push(word); word = ''; } else word += ch;
  }
  if (word) out.push(word);
  return out;
}
const openBracket = value => (value.match(/[[(]/g) || []).length > (value.match(/[\])]/g) || []).length;

/* ---- what classes do (cached per frame; kept until a newer render answers) ---- */
const explained = new Map();

async function explain(documentId, names) {
  const render = descriptor(documentId)?.render ?? 0;
  let entry = explained.get(documentId);
  if (!entry || entry.render !== render) {
    entry = { render, classes: new Map(entry?.classes), fresh: new Set() };
    explained.set(documentId, entry);
  }
  const missing = names.filter(name => !entry.fresh.has(name));
  if (missing.length) {
    const result = await request(`api/classes?documentId=${enc(documentId)}&names=${enc(missing.join(' '))}`);
    for (const [name, info] of Object.entries(result.classes)) { entry.classes.set(name, info); entry.fresh.add(name); }
  }
  return entry.classes;
}

const TITLES = {
  utility: name => `${name} · click to edit`,
  custom: name => `${name} · a rule in the frame CSS`,
  marker: name => `${name} · Tailwind marker`,
  unknown: name => `${name} · does nothing (typo?)`,
};

function paint(chip, name, info) {
  if (!info) return;
  chip.dataset.kind = info.kind;
  chip.dataset.tip = TITLES[info.kind]?.(name) ?? name;
  chip.dataset.tipCode = [...info.lines, ...(info.custom ? ['', '+ frame CSS:', ...info.custom] : [])].join('\n');
  const dot = chip.querySelector('.cls-color');
  if (info.color && !dot) { const swatch = el('i', 'cls-color'); swatch.style.background = info.color; chip.prepend(swatch); }
}

/* ---- suggestions ------------------------------------------------------------ */
function attach(input, documentId, onAccept) {
  attachSuggest(input, {
    words: true,
    onAccept,
    fetch: async word => (await request(`api/classes?documentId=${enc(documentId)}&q=${enc(word)}&limit=8`)).items.map(item => ({
      ...item,
      partial: item.kind === 'variant',
      hint: item.kind === 'variant' ? 'variant' : item.kind === 'used' && !item.hint ? 'in this project' : item.hint,
    })),
  });
}

/* ---- the editor ------------------------------------------------------------- */

/**
 * Chips for the classes of `node` plus an input to add more. `save(next, label)` commits the
 * new class list (an array).
 */
export function classEditor(documentId, node, save) {
  const box = el('div', 'classes');
  const list = split(node.className);
  const known = explained.get(documentId)?.classes;
  const chips = list.map((name, index) => {
    const chip = el('span', 'cls');
    chip.dataset.kind = 'pending';
    const label = el('button', 'cls-name', name);
    label.type = 'button';
    label.setAttribute('aria-label', `Edit class ${name}`);
    label.addEventListener('click', () => editInPlace(chip, name, index));
    const remove = el('button', 'cls-x');
    remove.type = 'button';
    remove.tabIndex = -1;
    remove.setAttribute('aria-label', `Remove class ${name}`);
    remove.append(icon('close'));
    remove.addEventListener('click', event => { event.stopPropagation(); save(list.filter((_, i) => i !== index), `remove ${name}`); });
    chip.append(label, remove);
    paint(chip, name, known?.get(name));
    return chip;
  });
  box.append(...chips);

  function editInPlace(chip, name, index) {
    const input = el('input', 'cls-edit');
    input.type = 'text';
    input.value = name;
    input.size = Math.max(4, name.length + 1);
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.dataset.key = `class-edit:${index}`;
    input.setAttribute('aria-label', `Class ${name}`);
    let done = false;
    const finish = commit => {
      if (done) return;
      done = true;
      const next = split(input.value);
      if (!commit || (next.length === 1 && next[0] === name)) { input.replaceWith(chip); return; }
      const merged = [...list.slice(0, index), ...next, ...list.slice(index + 1)].filter((item, i, all) => all.indexOf(item) === i);
      save(merged, next.length ? `${name} → ${next.join(' ')}` : `remove ${name}`);
    };
    attach(input, documentId, () => finish(true));
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('input', () => { input.size = Math.max(4, input.value.length + 1); });
    input.addEventListener('blur', () => finish(true));
    chip.replaceWith(input);
    input.focus();
    input.select();
  }

  const input = el('input', 'cls-input');
  input.type = 'text';
  input.placeholder = list.length ? '+ class' : 'Tailwind classes, e.g. p-4 rounded-xl';
  input.dataset.key = 'class-add';
  input.setAttribute('aria-label', 'Add classes');
  input.spellcheck = false;
  input.autocomplete = 'off';
  const add = () => {
    const extra = split(input.value).filter(name => !list.includes(name));
    input.value = '';
    if (extra.length) save([...list, ...extra], `add ${extra.join(' ')}`);
  };
  attach(input, documentId, add);
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    // The field stays focused after a class is added; with nothing typed, Ctrl/Cmd+Z means the board's undo (the field has nothing of its own to undo).
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !input.value && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
      event.preventDefault();
      input.blur(); // the inspector redraws only when no field is being typed in
      (event.shiftKey || event.key.toLowerCase() === 'y' ? redo : undo)();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ' || (event.key === ',' && !openBracket(input.value))) { event.preventDefault(); add(); }
    else if (event.key === 'Backspace' && !input.value && list.length) save(list.slice(0, -1), `remove ${list.at(-1)}`);
    else if (event.key === 'Escape') { input.value = ''; input.blur(); }
  });
  input.addEventListener('blur', add);
  box.append(input);
  box.addEventListener('click', event => { if (event.target === box) input.focus(); });

  if (list.length) {
    explain(documentId, list).then(map => {
      if (!box.isConnected && !box.parentNode) return;
      list.forEach((name, index) => paint(chips[index], name, map.get(name)));
    }).catch(() => {});
  }
  return box;
}
