// Open a project from anywhere, or save a copy of this one somewhere else. The browser cannot see the
// disk, so project files and folders are listed by the server; the address is a path.
import { $, el, icon } from './util.js';
import { filePicker, directoryPath } from './file-picker.js';
import { store, request, post, toast } from './store.js';
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
let picker;
let busy = false;
let returnFocus = null;
let session = 0;
let recovery;
let failure = '';
const clearRecovery = () => { failure = ''; recovery.replaceChildren(); };
let input;
let status;
let primary;
let primaryLabel;
const actionLabels = { open: 'Open', save: 'Save here', project: 'Open project', collection: 'Open collection', create: 'Create project here', working: 'Working…' };

export const isOpen = () => !scrim.hidden;
export const canShowCopy = () => !!store.state?.project?.capabilities?.saveAs;

function label() {
  const info = picker?.state.info;
  if (!info) return { text: mode === 'open' ? actionLabels.open : actionLabels.save, ok: false, note: '' };
  if (mode === 'open') {
    if (info.kind === 'project') return { text: actionLabels.project, ok: true, note: 'A project is here.' };
    if (info.kind === 'collection') return { text: actionLabels.collection, ok: true, note: `${info.projects} project${info.projects === 1 ? '' : 's'} here — pick one on the next page.` };
    if (info.kind === 'new') return { text: actionLabels.create, ok: true, note: 'No project in this folder yet.' };
    return { text: actionLabels.project, ok: false, note: 'This folder does not exist.' };
  }
  if (info.kind === 'project' || info.kind === 'collection') return { text: actionLabels.save, ok: false, note: 'This folder already holds projects. Choose a new or empty folder.' };
  if (info.kind === 'missing') return { text: actionLabels.save, ok: true, note: `Will create ${info.missing}.` };
  return { text: actionLabels.save, ok: true, note: 'The folder must be empty.' };
}

function paintControls() {
  const state = label();
  primaryLabel.textContent = busy ? actionLabels.working : state.text;
  // Keep keyboard focus inside the modal when pending work disables a focused control.
  const focused = document.activeElement;
  if (focused === primary && (busy || !state.ok)) input.focus({ preventScroll: true });
  primary.disabled = busy || !state.ok;
  status.textContent = failure || (picker.state.pending ? 'Loading…' : state.note);
}

async function submit() {
  const state = label();
  if (busy || !state.ok) return;
  const mine = session, target = input.value.trim();
  const current = () => mine === session && !scrim.hidden && input.value.trim() === target;
  busy = true;
  clearRecovery();
  paintControls();
  try {
    const result = await post(mode === 'open' ? 'api/open-project' : 'api/save-project', mode === 'open' ? { path: target, create: picker.state.info.kind === 'new' } : { path: target, expectedVersion: store.state?.project?.version, expectedFormat: 'divlet' });
    if (!current()) return;
    toast(mode === 'open' ? 'Opening…' : 'Saved — opening the copy');
    location.href = result.url;
  } catch (error) {
    if (!current()) return;
    toast(error.message);
  } finally {
    if (mine === session && !scrim.hidden) { busy = false; paintControls(); }
  }
}

function render() {
  session++;
  picker?.dispose();
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
  picker = filePicker({
    read: path => request(`api/fs?path=${encodeURIComponent(path)}`),
    includeFiles: mode === 'open',
    label: mode === 'open' ? 'Project file or folder' : 'Folder for the copy',
    onChange: state => { clearRecovery(); failure = state.error; paintControls(); },
    onSubmit: submit,
  });
  input = picker.input;
  input.dataset.key = 'project-path';
  status = el('span', 'caption project-status');
  status.setAttribute('role', 'status');
  primary = el('button', 'cta project-go');
  primaryLabel = el('span', 'project-go-label');
  primary.append(primaryLabel);
  // All state labels share one grid cell, reserving real font-dependent width without another accessible control.
  for (const text of Object.values(actionLabels)) {
    const sizer = el('span', 'project-go-sizer', text);
    sizer.setAttribute('aria-hidden', 'true');
    primary.append(sizer);
  }
  primary.type = 'button';
  primary.addEventListener('click', submit);
  const foot = el('div', 'dialog-foot');
  // The action row stays directly under the list; status and errors follow it, so they never push the controls.
  foot.append(el('span', 'grow'), primary);
  recovery = el('div', 'project-recovery');
  dialog.replaceChildren(head, hint, picker.element, foot, status, recovery);
}

/** Open the dialog: `open` (any project) or `save` (a copy of this one). */
export function show(next = 'open') {
  if (next === 'save' && !canShowCopy()) { toast('Saving a copy is unavailable while this project has errors (see History) or when the board was not started by divlet.'); return; }
  mode = next;
  busy = false;
  returnFocus = document.activeElement;
  render();
  const here = String(store.state?.projectDir || '');
  const parent = here.replace(/[\\/][^\\/]*$/, '') || '/';
  const name = String(store.state?.project?.name || 'project').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'project';
  input.value = (mode === 'open' ? directoryPath(here) : `${directoryPath(parent)}${name}-copy`);
  scrim.hidden = false;
  primary.disabled = true;
  picker.load(input.value);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

export function toggle(open) {
  if (open) { show(typeof open === 'string' ? open : 'open'); return; }
  if (scrim.hidden) return;
  scrim.hidden = true;
  session++;
  picker.dispose();
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
