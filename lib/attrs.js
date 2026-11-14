// Attributes of an element: what it has, the important ones it lacks (one click to add), and
// suggestions for names and values that fit its tag.
import { el, icon } from './util.js';
import { attachSuggest, filterLocal } from './suggest.js';

const COMMON = [
  ['id', 'name for links (#id) and labels'], ['title', 'tooltip text'], ['aria-label', 'name read by screen readers'],
  ['role', 'what it is for assistive tech'], ['aria-hidden', 'hide from screen readers'], ['tabindex', 'keyboard focus order'],
  ['hidden', 'not shown'], ['lang', 'language of the content'], ['dir', 'text direction'],
];
const BY_TAG = {
  a: [['href', 'where the link goes'], ['target', '_blank opens a new tab'], ['rel', 'noopener for new tabs'], ['download', 'download instead of opening']],
  img: [['src', 'image file, e.g. assets/photo.png'], ['alt', 'what the image shows'], ['loading', 'lazy: load when visible'], ['width', 'intrinsic width'], ['height', 'intrinsic height'], ['decoding', 'async decoding']],
  button: [['type', 'button, submit or reset'], ['disabled', 'not clickable'], ['name', 'form field name'], ['value', 'value sent with the form']],
  input: [['type', 'text, email, checkbox…'], ['name', 'form field name'], ['placeholder', 'hint inside the field'], ['value', 'initial value'], ['required', 'must be filled'], ['disabled', 'not editable'], ['autocomplete', 'browser autofill'], ['min', 'smallest value'], ['max', 'largest value']],
  textarea: [['name', 'form field name'], ['placeholder', 'hint inside the field'], ['rows', 'visible lines'], ['required', 'must be filled']],
  select: [['name', 'form field name'], ['required', 'must be chosen'], ['multiple', 'several choices']],
  option: [['value', 'value sent with the form'], ['selected', 'chosen at start']],
  label: [['for', 'id of its field']],
  form: [['action', 'where it is sent'], ['method', 'get or post']],
  video: [['src', 'video file'], ['controls', 'show player controls'], ['autoplay', 'start at once'], ['muted', 'no sound'], ['loop', 'repeat'], ['poster', 'image before playing'], ['playsinline', 'play inline on phones']],
  audio: [['src', 'audio file'], ['controls', 'show player controls'], ['loop', 'repeat']],
  time: [['datetime', 'machine-readable date']],
  ol: [['start', 'first number'], ['reversed', 'count down']],
  td: [['colspan', 'columns it spans'], ['rowspan', 'rows it spans']],
  th: [['scope', 'col or row'], ['colspan', 'columns it spans']],
  details: [['open', 'expanded at start']],
  nav: [['aria-label', 'name of this navigation']],
  section: [['aria-label', 'name of this region']],
};
const IMPORTANT = { a: ['href', 'target'], img: ['src', 'alt'], button: ['type', 'aria-label'], input: ['type', 'name', 'placeholder'], textarea: ['name', 'placeholder'], label: ['for'], form: ['action', 'method'], video: ['src', 'controls'], audio: ['src', 'controls'], nav: ['aria-label'], section: ['aria-label'] };
const BOOLEAN = new Set(['hidden', 'disabled', 'required', 'multiple', 'selected', 'controls', 'autoplay', 'muted', 'loop', 'reversed', 'open', 'download', 'playsinline', 'checked', 'readonly']);
const VALUES = {
  target: ['_blank', '_self'], rel: ['noopener noreferrer', 'nofollow', 'me'], loading: ['lazy', 'eager'], decoding: ['async', 'sync', 'auto'],
  method: ['get', 'post'], 'aria-hidden': ['true', 'false'], dir: ['ltr', 'rtl', 'auto'], scope: ['col', 'row'],
  autocomplete: ['on', 'off', 'name', 'email', 'tel', 'current-password', 'new-password', 'street-address'],
  role: ['button', 'link', 'navigation', 'banner', 'main', 'contentinfo', 'region', 'list', 'listitem', 'img', 'presentation', 'dialog', 'tab', 'tablist', 'tabpanel', 'status', 'alert'],
};
const TYPES = { button: ['button', 'submit', 'reset'], input: ['text', 'email', 'password', 'number', 'search', 'tel', 'url', 'checkbox', 'radio', 'date', 'time', 'file', 'range', 'color', 'hidden'] };

const namesFor = tag => [...(BY_TAG[tag] || []), ...COMMON].filter(([name], index, all) => all.findIndex(([other]) => other === name) === index);
const valuesFor = (tag, name) => (name === 'type' ? TYPES[tag] || [] : VALUES[name] || []);

/**
 * `node` is the element; `save(patch, label)` commits `{ attrs: { name: value | null } }`.
 * Each row edits one attribute; the last row adds one (name, then value).
 */
export function attributesEditor(node, save) {
  const box = el('div', 'rows attrs');
  const attrs = node.attrs || {};
  const known = new Map(namesFor(node.tag));
  for (const [name, value] of Object.entries(attrs)) {
    const line = el('div', 'kv');
    const key = el('span', 'k', name);
    key.dataset.tip = known.get(name) ? `${name} · ${known.get(name)}` : name;
    const input = el('input', 'field mono');
    input.type = 'text';
    input.value = value;
    input.spellcheck = false;
    input.dataset.key = `attr:${name}`;
    input.placeholder = BOOLEAN.has(name) ? 'on' : '';
    input.setAttribute('aria-label', `${name} value`);
    const commit = () => { if (input.value !== value) save({ [name]: input.value }, `${name}="${input.value.slice(0, 24)}"`); };
    const choices = valuesFor(node.tag, name);
    if (choices.length) attachSuggest(input, { empty: true, fetch: word => filterLocal(choices.map(item => ({ name: item })), choices.includes(word) ? '' : word), onAccept: commit });
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
      else if (event.key === 'Escape') { input.value = value; input.blur(); }
    });
    input.addEventListener('change', commit);
    const remove = el('button', 'tool mini');
    remove.type = 'button';
    remove.dataset.tip = `Remove ${name}`;
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.append(icon('close'));
    remove.addEventListener('click', () => save({ [name]: null }, `remove ${name}`));
    line.append(el('span', 'swatch none'), key, input, remove);
    box.append(line);
  }

  // Add: a name with suggestions for this tag, then its value.
  const add = el('div', 'kv add');
  const nameInput = el('input', 'field mono');
  nameInput.type = 'text';
  nameInput.placeholder = 'attribute';
  nameInput.spellcheck = false;
  nameInput.dataset.key = 'attr-new-key';
  nameInput.setAttribute('aria-label', 'New attribute name');
  const valueInput = el('input', 'field mono');
  valueInput.type = 'text';
  valueInput.placeholder = 'value';
  valueInput.spellcheck = false;
  valueInput.dataset.key = 'attr-new-value';
  valueInput.setAttribute('aria-label', 'New attribute value');
  const missing = () => namesFor(node.tag).filter(([name]) => !Object.hasOwn(attrs, name)).map(([name, hint]) => ({ name, hint }));
  const submit = () => {
    const name = nameInput.value.trim();
    if (!name) return false;
    if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name)) { nameInput.focus(); return false; }
    if (!valueInput.value && !BOOLEAN.has(name)) return false;
    save({ [name]: valueInput.value }, `${name}="${valueInput.value.slice(0, 24)}"`);
    nameInput.value = '';
    valueInput.value = '';
    return true;
  };
  const toValue = () => {
    const name = nameInput.value.trim();
    if (!name) return;
    if (BOOLEAN.has(name)) { submit(); return; }
    valueInput.placeholder = valuesFor(node.tag, name)[0] ?? known.get(name) ?? 'value';
    valueInput.focus();
  };
  attachSuggest(nameInput, { fetch: word => filterLocal(missing(), word), onAccept: toValue });
  attachSuggest(valueInput, { empty: true, fetch: word => { const choices = valuesFor(node.tag, nameInput.value.trim()); return filterLocal(choices.map(item => ({ name: item })), choices.includes(word) ? '' : word); }, onAccept: () => submit() });
  nameInput.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); toValue(); }
    else if (event.key === 'Escape') { nameInput.value = ''; nameInput.blur(); }
  });
  valueInput.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); if (submit()) nameInput.focus(); }
    else if (event.key === 'Escape') { valueInput.value = ''; valueInput.blur(); }
  });
  valueInput.addEventListener('change', () => { if (nameInput.value.trim() && valueInput.value) submit(); });
  add.append(nameInput, valueInput);
  box.append(add);

  // One click for the attributes this kind of element usually needs.
  const wanted = (IMPORTANT[node.tag] || []).filter(name => !Object.hasOwn(attrs, name));
  if (wanted.length) {
    const quick = el('div', 'chips quick-attrs');
    for (const name of wanted) {
      const chip = el('button', 'chip', `+ ${name}`);
      chip.type = 'button';
      chip.dataset.tip = known.get(name) ?? name;
      chip.addEventListener('click', () => { nameInput.value = name; toValue(); });
      quick.append(chip);
    }
    box.append(quick);
  }
  return box;
}
