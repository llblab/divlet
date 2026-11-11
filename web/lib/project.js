// Open a project from anywhere, or save a copy of this one somewhere else. The browser cannot see the
// disk, so project files and folders are listed by the server; the address is a path.
import { $, el, icon, debounce } from './util.js';
import { store, request, post, toast, on, receiveState } from './store.js';
import { sourceUpdates } from './host.js';

const scrim = el('div', 'scrim chrome');
scrim.id = 'project';
scrim.hidden = true;
const dialog = el('section', 'dialog project-dialog');
dialog.setAttribute('role', 'dialog');
dialog.setAttribute('aria-modal', 'true');
scrim.append(dialog);
($('#ui') || document.body).append(scrim);

/**
 * A project that came from an import (a .pen) notices when its source file changed afterwards and offers to import it again
 * as a new project beside it; the current project is never overwritten.
 */
const noticed = new Set();
export async function checkImport() {
  if (!sourceUpdates) return;
  let status;
  try { status = (await sourceUpdates.readStatus()).status; } catch { return; }
  if (!status?.changed || noticed.has(status.source)) return;
  noticed.add(status.source);
  toast(`“${status.source}” changed after it was imported. This project is untouched.`, {
    label: 'Import again',
    run: async () => {
      try {
        const { file } = await sourceUpdates.reimport();
        toast(`Imported again as ${file.split(/[\\/]/).pop()}`, { label: 'Open', run: () => sourceUpdates.openProject(file).then(result => { location.href = result.url; }).catch(error => toast(error.message)) }, { sticky: true });
      } catch (error) { toast(error.message); }
    },
  }, { sticky: true });
}

let mode = 'open';
let info = null;
let resolvedInput = null;
let busy = false;
let returnFocus = null;
let seq = 0;
let session = 0;
let recovery;
let failure = '';
const clearRecovery = () => { failure = ''; recovery.replaceChildren(); };
let input;
let list;
let status;
let primary;
let upButton;

export const isOpen = () => !scrim.hidden;
export const canShowCopy = () => !!store.state?.project?.capabilities?.saveAs;
const sep = () => (/^[A-Za-z]:\\/.test(info?.path || '') || String(info?.path || '').includes('\\') ? '\\' : '/');
const withSep = value => (value.endsWith('/') || value.endsWith('\\') ? value : value + sep());

function label() {
  if (!info) return { text: mode === 'open' ? 'Open' : 'Save here', ok: false, note: '' };
  if (mode === 'open') {
    if (info.kind === 'project') return { text: 'Open project', ok: true, note: 'A project is here.' };
    if (info.kind === 'collection') return { text: 'Open collection', ok: true, note: `${info.projects} project${info.projects === 1 ? '' : 's'} here — pick one on the next page.` };
    if (info.kind === 'new') return { text: 'Create project here', ok: true, note: 'No project in this folder yet.' };
    return { text: 'Open project', ok: false, note: 'This folder does not exist.' };
  }
  if (info.kind === 'project' || info.kind === 'collection') return { text: 'Save here', ok: false, note: 'This folder already holds projects. Choose a new or empty folder.' };
  if (info.kind === 'missing') return { text: 'Save here', ok: true, note: `Will create ${info.missing}.` };
  return { text: 'Save here', ok: true, note: 'The folder must be empty.' };
}

function paintControls() {
  const state = label(), upDisabled = !info?.parent;
  primary.textContent = busy ? 'Working…' : state.text;
  // Keep keyboard focus inside the modal when pending work disables a focused control.
  const focused = document.activeElement;
  if (focused === primary && (busy || !state.ok) || focused === upButton && upDisabled) input.focus({ preventScroll: true });
  primary.disabled = busy || !state.ok;
  status.textContent = failure || state.note;
  upButton.disabled = upDisabled;
}

function paintList() {
  paintControls();
  list.replaceChildren();
  const entries = [...(info?.dirs ?? []), ...(mode === 'open' ? (info?.files ?? []) : [])];
  for (const dir of entries) {
    const row = el('button', `dir${dir.project ? ' is-project' : ''}`);
    row.type = 'button';
    row.dataset.name = dir.name;
    row.append(icon(dir.project ? 'divlet' : 'folder'), el('span', 'dir-name', dir.name));
    if (dir.project) row.append(el('span', 'dir-tag', 'project'));
    row.addEventListener('click', () => go(dir.file || withSep(info.directory || info.path) + dir.name));
    row.addEventListener('dblclick', () => { if (dir.project && mode === 'open') { input.value = dir.file || withSep(info.directory || info.path) + dir.name; submit(); } });
    list.append(row);
  }
  if (!list.childElementCount) list.append(el('div', 'dir-empty', info?.kind === 'missing' ? 'Nothing here yet' : 'No project files or sub-folders'));
}

async function load(path) {
  const mine = ++seq;
  try {
    const result = await request(`api/fs?path=${encodeURIComponent(path)}`);
    if (mine !== seq) return;
    info = result;
    resolvedInput = path.trim();
    paintList();
  } catch (error) { if (mine === seq) { status.textContent = error.message; primary.disabled = true; } }
}
const reload = debounce(() => load(input.value), 140);

function go(path) {
  clearRecovery();
  input.value = path;
  load(path);
  input.focus();
}

async function submit() {
  const state = label();
  if (busy || !state.ok) return;
  const mine = session, target = input.value.trim();
  const current = () => mine === session && !scrim.hidden && input.value.trim() === target;
  busy = true;
  clearRecovery();
  paintList();
  try {
    const result = await post(mode === 'open' ? 'api/open-project' : 'api/save-project', mode === 'open' ? { path: target, create: info.kind === 'new' } : { path: target, expectedVersion: store.state?.project?.version, expectedFormat: 'divlet' });
    if (!current()) return;
    toast(mode === 'open' ? 'Opening…' : 'Saved — opening the copy');
    location.href = result.url;
  } catch (error) {
    if (!current()) return;
    toast(error.message);
  } finally {
    if (mine === session && !scrim.hidden) { busy = false; paintList(); }
  }
}

function render() {
  session++;
  seq++;
  failure = '';
  const head = el('div', 'dialog-head');
  const title = el('h2', '', mode === 'open' ? 'Open project' : 'Save a copy as…');
  title.id = 'project-title';
  dialog.setAttribute('aria-labelledby', 'project-title');
  const close = el('button', 'tool mini');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.dataset.tip = 'Close · Esc';
  close.append(icon('close'));
  close.addEventListener('click', () => toggle(false));
  head.append(title, close);

  const hint = el('p', 'project-hint', mode === 'open'
    ? 'Type or paste a .divlet/.pen file or folder on this computer, or pick one below. One project file opens directly; several open a collection. An empty folder starts project.divlet.'
    : 'Choose a new or empty folder. The selected project source and its resources are copied there; generated pages are rebuilt when the copy opens. This one stays as it is.');
  const bar = el('div', 'project-path');
  upButton = el('button', 'tool');
  upButton.type = 'button';
  upButton.dataset.tip = 'Parent folder';
  upButton.setAttribute('aria-label', 'Parent folder');
  upButton.append(icon('folderUp'));
  upButton.addEventListener('click', () => info?.parent && go(withSep(info.parent)));
  input = el('input', 'field mono');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.dataset.key = 'project-path';
  input.setAttribute('aria-label', mode === 'open' ? 'Project file or folder' : 'Folder for the copy');
  input.addEventListener('input', () => { clearRecovery(); reload(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Tab') return; // The modal, not native document order, owns focus containment.
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); submit(); }
    else if (event.key === 'Escape') { event.preventDefault(); toggle(false); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('.dir')?.focus(); }
  });
  bar.append(upButton, input);
  list = el('div', 'dir-list');
  list.setAttribute('role', 'list');
  list.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...list.querySelectorAll('.dir')];
    const at = rows.indexOf(document.activeElement);
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'ArrowUp' && at <= 0) input.focus();
    else rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
  status = el('span', 'caption project-status');
  status.setAttribute('role', 'status');
  primary = el('button', 'cta project-go');
  primary.type = 'button';
  primary.addEventListener('click', submit);
  const foot = el('div', 'dialog-foot');
  // The action row stays directly under the list; status and errors follow it, so they never push the controls.
  foot.append(el('span', 'grow'), primary);
  recovery = el('div', 'project-recovery');
  dialog.replaceChildren(head, hint, bar, list, foot, status, recovery);
}

/** Open the dialog: `open` (any project) or `save` (a copy of this one). */
export function show(next = 'open') {
  if (next === 'save' && !canShowCopy()) { toast('Saving a copy is unavailable while this project has errors (see History) or when the board was not started by divlet.'); return; }
  mode = next;
  info = null;
  resolvedInput = null;
  busy = false;
  returnFocus = document.activeElement;
  render();
  const here = String(store.state?.projectDir || '');
  const parent = here.replace(/[\\/][^\\/]*$/, '') || '/';
  const name = String(store.state?.project?.name || 'project').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'project';
  input.value = (mode === 'open' ? withSepSafe(here) : `${withSepSafe(parent)}${name}-copy`);
  scrim.hidden = false;
  primary.disabled = true;
  load(input.value);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
const withSepSafe = value => (value.endsWith('/') || value.endsWith('\\') ? value : value + (value.includes('\\') && !value.includes('/') ? '\\' : '/'));

export function toggle(open) {
  if (open) { show(typeof open === 'string' ? open : 'open'); return; }
  if (scrim.hidden) return;
  scrim.hidden = true;
  session++;
  seq++;
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  else $('#viewport').focus({ preventScroll: true });
}


scrim.addEventListener('pointerdown', event => { if (event.target === scrim) toggle(false); });
scrim.addEventListener('keydown', event => {
  event.stopPropagation();
  if (event.key === 'Escape') { event.preventDefault(); toggle(false); }
  if (event.key === 'Tab') {
    const focusable = [...dialog.querySelectorAll('button:not(:disabled), input, textarea')].filter(node => node.getClientRects().length);
    const index = focusable.indexOf(document.activeElement);
    event.preventDefault();
    focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
  }
});
