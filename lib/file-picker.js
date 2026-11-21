// Filesystem navigation UI. The host supplies a read-only listing; consumers own selection policy, writes and modal lifetime.
import { el, icon } from './util.js';

export const directoryPath = value => value.endsWith('/') || value.endsWith('\\') ? value : value + (value.includes('\\') && !value.includes('/') ? '\\' : '/');

export function filePicker({ read, includeFiles = true, label, onChange = () => {}, onSubmit = () => {} }) {
  const element = el('div', 'file-picker');
  const bar = el('div', 'file-picker-path');
  const up = el('button', 'tool');
  up.type = 'button';
  up.setAttribute('aria-label', 'Parent folder');
  up.dataset.tip = 'Parent folder';
  up.append(icon('folderUp'));
  const input = el('input', 'field mono');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', label);
  const list = el('div', 'dir-list');
  bar.append(up, input);
  element.append(bar, list);
  let state = { info: null, error: '', pending: false };
  let sequence = 0, timer = null, disposed = false, reading = Promise.resolve();
  let rows = new Map();
  const update = next => {
    state = next;
    element.setAttribute('aria-busy', String(state.pending));
    up.disabled = !state.info?.parent;
    if (up.disabled && document.activeElement === up) input.focus({ preventScroll: true });
    onChange(state);
  };
  function paint() {
    const info = state.info;
    const nextRows = new Map();
    const nodes = [...(info?.dirs ?? []), ...(includeFiles ? info?.files ?? [] : [])].map(entry => {
      const target = entry.file || directoryPath(info.directory || info.path) + entry.name;
      const key = `${target}\0${!!entry.project}`;
      let row = rows.get(key);
      if (!row) {
        row = el('button', `dir${entry.project ? ' is-project' : ''}`);
        row.type = 'button';
        row.dataset.name = entry.name;
        row.append(icon(entry.project ? 'divlet' : 'folder'), el('span', 'dir-name', entry.name));
        if (entry.project) row.append(el('span', 'dir-tag', 'project'));
        row.addEventListener('click', () => go(target));
        row.addEventListener('dblclick', () => { if (entry.project && includeFiles) activate(); });
      }
      nextRows.set(key, row);
      return row;
    });
    rows = nextRows;
    if (!nodes.length) nodes.push(el('div', 'dir-empty', state.error ? 'Unable to list this folder' : info?.kind === 'missing' ? 'Nothing here yet' : includeFiles ? 'No project files or sub-folders' : 'No sub-folders here'));
    // Selecting a file in the same directory must not detach its row between clicks or lose keyboard focus.
    if (nodes.length !== list.children.length || nodes.some((node, index) => node !== list.children[index])) list.replaceChildren(...nodes);
  }
  function load(path) {
    if (disposed) return Promise.resolve();
    clearTimeout(timer); timer = null;
    input.value = path;
    const mine = ++sequence, target = input.value;
    update({ info: null, error: '', pending: true });
    reading = (async () => {
      try {
        const info = await read(target);
        if (disposed || mine !== sequence) return;
        update({ info, error: '', pending: false });
      } catch (error) {
        if (disposed || mine !== sequence) return;
        update({ info: null, error: error.message, pending: false });
      }
      paint();
    })();
    return reading;
  }
  function go(path) { load(path); input.focus(); }
  async function activate() {
    const pending = timer || !state.info && !state.pending ? load(input.value) : reading;
    const mine = sequence;
    await pending;
    if (!disposed && mine === sequence && state.info && !state.pending && !state.error) onSubmit(state.info);
  }
  up.addEventListener('click', () => { if (state.info?.parent) go(directoryPath(state.info.parent)); });
  input.addEventListener('input', () => {
    if (disposed) return;
    ++sequence;
    clearTimeout(timer);
    update({ info: null, error: '', pending: true });
    timer = setTimeout(() => load(input.value), 140);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); activate(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); list.querySelector('.dir')?.focus(); }
  });
  list.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const nodes = [...list.querySelectorAll('.dir')], at = nodes.indexOf(document.activeElement);
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'ArrowUp' && at <= 0) input.focus();
    else nodes[Math.max(0, Math.min(nodes.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
  up.disabled = true;
  return { element, input, load, get state() { return state; }, dispose() { disposed = true; ++sequence; clearTimeout(timer); } };
}
