// Settings (the gear in the bottom-right toolbar, or Ctrl+,).
import { $, el, icon } from './util.js';
import { filePicker } from './file-picker.js';
import { on, emit, store, post, request, receiveState } from './store.js';
import * as canvas from './canvas.js';

const scrim = $('#help');
const dialog = scrim.querySelector('.dialog');
let returnFocus = null;
let outputPicker = null;
let outputDraft = null;
let pending = false;
let outputStatus = '';
const staleOutput = () => outputDraft && Number.isFinite(store.state?.project?.version) && store.state.project.version !== outputDraft.version;
const outputMessage = () => store.state?.project?.capabilities?.settings === false ? 'The source has an unaccepted external edit. Restore a valid source before changing settings.' : !pending && staleOutput() ? 'Project changed. Your draft is kept; reload current settings to discard it and use the latest version.' : outputStatus;

function loadOutput() {
  outputDraft = { value: store.state?.project?.outputDir || '', version: store.state?.project?.version };
  outputStatus = '';
}

async function saveOutput() {
  if (store.state?.project?.capabilities?.settings === false || pending || !outputDraft || !Number.isFinite(outputDraft.version)) return;
  pending = true;
  outputStatus = 'Saving…';
  render();
  try {
    const result = await post('api/project', { expectedVersion: outputDraft.version, patch: { outputDir: outputDraft.value.trim() || null }, label: 'Change build output directory' });
    outputDraft = { value: outputDraft.value.trim(), version: result.version };
    outputStatus = 'Build output saved.';
    receiveState(await request('api/project'));
  } catch (error) {
    outputStatus = `${error.message} Your draft is kept. Reload current settings before trying again if the project changed.`;
  } finally {
    pending = false;
    render();
    if (isOpen()) dialog.querySelector('#settings-output')?.focus({ preventScroll: true });
  }
}

export const isOpen = () => !scrim.hidden;

/* Interface size: 100–200%. The chrome (panels, menus, dialogs) is scaled as one; the canvas is not. */
export const UI_SIZES = [100, 125, 150, 175, 200];
export const uiPercent = () => Math.round((Number.parseFloat(document.documentElement.style.getPropertyValue('--ui')) || 1) * 100);
export function setUiSize(percent) {
  const value = UI_SIZES.includes(percent) ? percent / 100 : 1;
  if (value === 1) document.documentElement.style.removeProperty('--ui'); else document.documentElement.style.setProperty('--ui', String(value));
  try { if (value === 1) localStorage.removeItem('divlet:ui'); else localStorage.setItem('divlet:ui', String(value)); } catch {}
  emit('ui-size', value);
  if (isOpen()) { render(); dialog.querySelector(`.seg[data-ui="${Math.round(value * 100)}"]`)?.focus({ preventScroll: true }); }
  window.__divletFit?.();
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}
/** One step up or down the list (Ctrl+Alt + / −). */
export const stepUiSize = direction => setUiSize(UI_SIZES[Math.max(0, Math.min(UI_SIZES.length - 1, UI_SIZES.indexOf(uiPercent()) + direction))]);

function theme() {
  try { return localStorage.getItem('divlet:theme') || 'auto'; } catch { return 'auto'; }
}

export function setTheme(value) {
  if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value;
  else delete document.documentElement.dataset.theme;
  try { if (value === 'auto') localStorage.removeItem('divlet:theme'); else localStorage.setItem('divlet:theme', value); } catch {}
  emit('theme', value);
  if (isOpen()) { render(); dialog.querySelector(`.seg[data-theme="${value}"]`)?.focus({ preventScroll: true }); }
}

/** One settings block: the divider lives between blocks, so every block has the same space above and below the line. */
function block(content) {
  const node = el('div', 'settings-block');
  node.append(content);
  return node;
}

function render() {
  outputPicker?.dispose();
  outputPicker = null;
  const hadFocus = dialog.contains(document.activeElement);
  const head = el('div', 'dialog-head');
  const title = el('h2', '', 'Settings');
  title.id = 'help-title';
  const close = el('button', 'tool mini', '');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.dataset.tip = 'Close · Esc';
  close.append(icon('close'));
  close.addEventListener('click', () => toggle(false));
  head.append(title, close);

  const themes = el('div', 'segmented');
  themes.setAttribute('role', 'radiogroup');
  themes.setAttribute('aria-label', 'Theme');
  for (const [value, iconName, text] of [['auto', 'auto', 'Auto'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']]) {
    const option = el('button', `seg${theme() === value ? ' on' : ''}`);
    option.type = 'button';
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', String(theme() === value));
    option.dataset.theme = value;
    option.append(icon(iconName), el('span', '', text));
    option.addEventListener('click', () => setTheme(value));
    themes.append(option);
  }
  const appearance = el('div', 'settings-row');
  appearance.append(el('span', 'settings-label', 'Theme'), themes);

  const sizes = el('div', 'segmented');
  sizes.setAttribute('role', 'radiogroup');
  sizes.setAttribute('aria-label', 'Interface size');
  for (const percent of UI_SIZES) {
    const option = el('button', `seg${uiPercent() === percent ? ' on' : ''}`, `${percent}%`);
    option.type = 'button';
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', String(uiPercent() === percent));
    option.dataset.ui = String(percent);
    option.addEventListener('click', () => setUiSize(percent));
    sizes.append(option);
  }
  const scale = el('div', 'settings-row');
  scale.append(el('span', 'settings-label', 'Interface size'), sizes, el('span', 'caption', 'Menus, panels and text. The canvas keeps its own zoom.'));

  const handlesOn = canvas.editHandles();
  const handles = el('div', 'segmented');
  handles.setAttribute('role', 'radiogroup');
  handles.setAttribute('aria-label', 'Canvas editing handles');
  for (const [value, text] of [[true, 'On'], [false, 'Off']]) {
    const option = el('button', `seg${handlesOn === value ? ' on' : ''}`, text);
    option.type = 'button';
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', String(handlesOn === value));
    option.dataset.handles = value ? 'on' : 'off';
    option.addEventListener('click', () => { canvas.setEditHandles(value); render(); dialog.querySelector(`.seg[data-handles="${value ? 'on' : 'off'}"]`)?.focus({ preventScroll: true }); });
    handles.append(option);
  }
  const handleRow = el('div', 'settings-row');
  handleRow.append(el('span', 'settings-label', 'Canvas handles'), handles, el('span', 'caption', 'Pills for margin, padding, gap and size, and the grip, on the selected element.'));

  const output = el('form', 'settings-output');
  output.addEventListener('submit', event => { event.preventDefault(); saveOutput(); });
  output.append(el('h3', '', 'Build output'));
  for (const [label, value] of [['Source file', store.state?.project?.file || store.state?.projectPath || 'Not available'], ['Effective build path', store.state?.outputDir || 'Not available']]) {
    const row = el('div', 'settings-path');
    row.append(el('span', 'settings-label', label), el('code', '', value));
    output.append(row);
  }
  const label = el('label', 'settings-label', 'Relative output directory');
  label.htmlFor = 'settings-output';
  const input = el('input', '');
  input.id = 'settings-output';
  input.type = 'text';
  input.value = outputDraft?.value || '';
  input.disabled = store.state?.project?.capabilities?.settings === false || pending || !Number.isFinite(outputDraft?.version);
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-describedby', 'settings-output-hint settings-output-status');
  input.addEventListener('input', () => { outputDraft.value = input.value; });
  // The path can be typed or picked: the picker walks the same server-side listing the project dialog uses and turns the chosen
  // absolute folder into the relative directory this field wants.
  const browse = el('button', 'tool mini', '');
  browse.type = 'button';
  browse.setAttribute('aria-label', 'Choose the output folder');
  browse.dataset.tip = 'Choose a folder in a list; typing stays possible';
  browse.append(icon('folder'));
  browse.disabled = input.disabled;
  const field = el('div', 'settings-field');
  field.append(input, browse);
  const picker = el('div', 'settings-picker');
  picker.hidden = true;
  browse.addEventListener('click', () => {
    if (!picker.hidden) { outputPicker?.dispose(); outputPicker = null; picker.replaceChildren(); picker.hidden = true; return; }
    picker.hidden = false;
    openPicker();
  });
  const relative = (from, to) => {
    const a = String(from).split(/[\\/]+/).filter(Boolean), b = String(to).split(/[\\/]+/).filter(Boolean);
    let at = 0;
    while (at < a.length && at < b.length && a[at] === b[at]) at++;
    return [...Array(a.length - at).fill('..'), ...b.slice(at)].join('/');
  };
  const openPicker = () => {
    const use = el('button', 'tool', 'Use this folder');
    use.type = 'button';
    use.disabled = true;
    const status = el('p', 'caption file-picker-status');
    status.setAttribute('role', 'status');
    const choose = info => {
      if (!info || info.kind === 'missing') return;
      outputDraft.value = relative(store.state?.projectDir || '.', info.directory || info.path);
      render();
      if (isOpen()) dialog.querySelector('#settings-output')?.focus({ preventScroll: true });
    };
    const browser = filePicker({
      read: path => request(`api/fs?path=${encodeURIComponent(path)}`),
      includeFiles: false,
      label: 'Folder to browse',
      onChange: state => {
        use.disabled = state.pending || !state.info || state.info.kind === 'missing';
        status.textContent = state.error || (state.pending ? 'Loading…' : state.info?.kind === 'missing' ? 'This folder does not exist.' : '');
      },
      onSubmit: choose,
    });
    outputPicker = browser;
    use.addEventListener('click', () => { if (!browser.state.pending) choose(browser.state.info); });
    picker.replaceChildren(browser.element, use, status);
    browser.load(store.state?.projectDir || '.');
  };
  const stem = String(store.state?.project?.file || 'project.divlet').split(/[\\/]/).pop().replace(/\.(?:divlet|pen)$/i, '');
  const hint = el('p', 'caption', `Relative to the source folder. Blank uses .divlet/${stem}. Apply saves explicitly.`);
  hint.id = 'settings-output-hint';
  const actions = el('div', 'settings-actions');
  const apply = el('button', 'tool primary', 'Apply');
  apply.type = 'submit';
  const reset = el('button', 'tool', 'Reset to default');
  reset.type = 'button';
  reset.addEventListener('click', () => { outputDraft.value = ''; saveOutput(); });
  const reload = el('button', 'tool', 'Reload current settings');
  reload.type = 'button';
  reload.addEventListener('click', async () => {
    pending = true;
    outputStatus = 'Loading current settings…';
    render();
    try { receiveState(await request('api/project')); loadOutput(); }
    catch (error) { outputStatus = error.message; }
    finally { pending = false; render(); if (isOpen()) dialog.querySelector('#settings-output')?.focus({ preventScroll: true }); }
  });
  for (const button of [apply, reset, reload]) { button.disabled = pending || !Number.isFinite(outputDraft?.version) || button !== reload && store.state?.project?.capabilities?.settings === false; actions.append(button); }
  const status = el('p', 'caption settings-status', outputMessage());
  status.id = 'settings-output-status';
  status.setAttribute('role', 'status');
  // The status keeps its reserved line above the buttons, so its text never moves them: the actions stay in the bottom-right.
  output.append(label, field, picker, hint, status, actions);
  dialog.replaceChildren(head, block(appearance), block(scale), block(handleRow), block(output));
  if (isOpen() && hadFocus) dialog.querySelector('button:not(:disabled), input:not(:disabled)')?.focus({ preventScroll: true });
}

export function toggle(force) {
  const open = force ?? scrim.hidden;
  if (open === !scrim.hidden) return;
  if (open) {
    returnFocus = document.activeElement;
    if (!outputDraft) loadOutput();
    render();
    scrim.hidden = false;
    dialog.querySelector('.seg.on, button')?.focus({ preventScroll: true });
  } else {
    scrim.hidden = true;
    outputPicker?.dispose();
    outputPicker = null;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    else $('#viewport').focus({ preventScroll: true });
  }
}

scrim.addEventListener('pointerdown', event => { if (event.target === scrim) toggle(false); });
scrim.addEventListener('keydown', event => {
  event.stopPropagation();
  if (event.key === 'Escape') { event.preventDefault(); toggle(false); }
  if (event.key === 'Tab') {
    const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)')].filter(node => node.getClientRects().length);
    const index = focusable.indexOf(document.activeElement);
    event.preventDefault();
    focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
  }
});
on('help', value => toggle(value));
on('state', () => {
  if (!isOpen()) return;
  const paths = dialog.querySelectorAll('.settings-path code');
  if (paths[0]) paths[0].textContent = store.state?.project?.file || store.state?.projectPath || 'Not available';
  if (paths[1]) paths[1].textContent = store.state?.outputDir || 'Not available';
  if (!pending) dialog.querySelector('#settings-output-status').textContent = outputMessage();
});
