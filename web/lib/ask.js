import { $, el, icon, button, keys } from './util.js';
import { openMenu } from './menu.js';
import { store, on, emit, post, toast, descriptor } from './store.js';
import * as sidebar from './sidebar.js';
import * as chat from './chat.js';

/* The Agent tab: the conversation with Pi and the box to write to it. A request goes to the running Pi
   session together with what is selected; the status line shows what Pi is doing and can stop it; Pi's
   answers land in the conversation and its edits in History. */

const panel = $('#agent');
const RECENT_KEY = 'divlet:asks';
let sending = false;
let recall = -1;
let draft = '';
let watchdog = 0;
let returnFocus = null;

export const available = () => !!store.state?.agent?.connected;
export const isOpen = () => sidebar.isOpen('agent');
const agent = () => store.state?.agent || {};

const recent = () => { try { const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(list) ? list.filter(item => typeof item === 'string') : []; } catch { return []; } };
const remember = text => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([text, ...recent().filter(item => item !== text)].slice(0, 20))); } catch {} };

/* ---- composer ------------------------------------------------------------- */
const input = el('textarea', 'ask-input');
input.rows = 1;
input.placeholder = 'Ask the agent to change the layout…';
input.spellcheck = true;
input.dataset.key = 'ask';
input.setAttribute('aria-label', 'Request for the agent');
const hint = el('span', 'ask-hint');
const stopButton = button('stop', 'Stop the agent', () => stop(), 'mini ask-stop');
const send = el('button', 'cta ask-send');
send.type = 'button';
send.id = 'ask-send';
send.append(el('span', '', 'Send'), icon('send'));
send.addEventListener('click', () => submit());
const status = el('div', 'agent-status');
status.setAttribute('role', 'status');
status.hidden = true;
const statusText = el('span', 'agent-status-text');
const statusTime = el('time', 'agent-status-time');
status.append(el('span', 'spinner'), statusText, statusTime, stopButton);
const foot = el('div', 'ask-foot');
/* Two chips, no labels: the session that answers this board — model and thinking level — when the host can change them. An MCP
   client can only answer prompts, so there the chips are simply absent; nothing here is guessed or stored in the project. */
const sessionChips = el('div', 'agent-session');
const settingsError = el('div', 'agent-settings-error');
settingsError.hidden = true;
const post_ = (path, body) => post(path, body).catch(error => {
  // A refused change is reported where it was made, never as a silent no-op.
  settingsError.hidden = false;
  settingsError.textContent = error?.message || 'That setting could not be applied.';
  setTimeout(() => { settingsError.hidden = true; }, 6000);
  paintSession();
  return null;
});
const chip = (label, tip, options, current, choose) => {
  const node = el('button', 'agent-chip', label);
  node.type = 'button';
  node.dataset.tip = tip;
  node.setAttribute('aria-label', tip);
  node.addEventListener('click', () => {
    openMenu(options.map(option => ({
      label: option.label,
      icon: option.id === current ? 'check' : undefined,
      run: () => { if (option.id !== current) choose(option); },
    })), { anchor: node, label: tip, className: 'menu-agent' });
  });
  return node;
};
function paintSession() {
  const controls = agent().controls;
  const chips = [];
  if (controls?.model?.options?.length) {
    const current = controls.model.value;
    const option = controls.model.options.find(item => item.id === current);
    chips.push(chip(option?.label || current, `Model · ${current}`, controls.model.options, current, item => post_('api/agent/settings', { model: item.id })));
  }
  if (controls?.thinking?.options?.length) {
    const current = controls.thinking.value;
    chips.push(chip(current, `Thinking level · ${current}`, controls.thinking.options.map(level => ({ id: level, label: level })), current, item => post_('api/agent/settings', { thinking: item.id })));
  }
  sessionChips.replaceChildren(...chips);
  // The selectors replace the key hints rather than stacking under them; Send keeps the trailing bottom corner if they wrap.
  sessionChips.hidden = chips.length === 0;
  hint.hidden = chips.length > 0;
}
// One slot, two occupants: a host that can change the session shows the two selectors where the key hints would be; a host that
// cannot (MCP) shows the hints. Pi users are assumed to know the shortcuts; the selectors carry their own tips.
foot.append(sessionChips, hint, send);
const scope = el('div', 'ask-scope');
scope.id = 'ask-context';
input.setAttribute('aria-describedby', scope.id);
const suggest = el('div', 'ask-suggest');
const composer = el('div', 'agent-composer');
// Order is the reading order: what the request is about, the box, then send — with the session selectors in its footer.
composer.append(scope, input, foot, settingsError);
panel.append(chat.list, suggest, status, composer);

const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight + 2, 220)}px`; };

function context() {
  if (!store.selected.size) return null;
  const ids = [...store.selected];
  const nodes = store.node?.nodeIds.length && ids.length === 1 && store.node.documentId === ids[0] ? { documentId: ids[0], nodeIds: [...store.node.nodeIds] } : undefined;
  return { ids, nodes };
}

/** What the agent will see with the next request, so nobody has to guess what "this" means. */
function paintScope() {
  const ids = [...store.selected];
  const names = ids.map(id => descriptor(id)?.name || id);
  const nodes = store.node?.documentId === ids[0] && ids.length === 1 ? store.node.nodeIds : [];
  const value = el('span', 'ask-scope-v');
  if (!ids.length) value.append(el('span', '', 'the whole board (nothing selected)'));
  else if (ids.length > 1) value.append(el('span', '', `${ids.length} artboards`));
  else {
    // Only the frame name is truncated: it can be surprisingly long and the sidebar is narrow, while the selector after it
    // tells the user what the request is about and must stay whole. The whole name stays available as a tooltip.
    const frame = el('span', 'ask-scope-frame', names[0]);
    frame.dataset.tip = names[0];
    frame.title = names[0];
    value.append(frame);
    if (nodes.length) {
      value.append(el('span', 'ask-scope-sep', '›'));
      value.append(el('span', 'ask-scope-tail', nodes.length === 1 ? `#${nodes[0]}` : `${nodes.length} elements`));
    }
  }
  scope.replaceChildren(el('span', 'ask-scope-k', 'About'), ' ', value);
  scope.dataset.tip = 'Your next request goes to the agent together with this selection';
}

/** A few starting points while the conversation is empty; a click only fills the box, nothing is sent. */
function paintSuggest() {
  const empty = !store.recent.some(chat.isChat);
  suggest.hidden = !empty || !available();
  if (suggest.hidden) { suggest.replaceChildren(); return; }
  const ids = [...store.selected];
  const nodes = store.node?.documentId === ids[0] && ids.length === 1 ? store.node.nodeIds : [];
  const ideas = nodes.length ? ['Tighten the spacing', 'Make it responsive', 'Improve contrast and readability']
    : ids.length ? ['Make this page work on a phone', 'Add a footer', 'Describe what this page does']
    : ['Create a landing page for ', 'Add a pricing section', 'Review the whole board for consistency'];
  suggest.replaceChildren(...ideas.map(text => {
    const chip = el('button', 'ask-idea', text.trim());
    chip.type = 'button';
    chip.addEventListener('click', () => { input.value = text; grow(); paintStatus(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
    return chip;
  }));
}

function paintStatus() {
  paintScope();
  paintSuggest();
  paintSession();
  const state = agent();
  send.querySelector('span').textContent = state.busy ? 'Queue' : 'Send';
  send.dataset.tip = state.busy ? `The agent is working — this runs right after · ${keys('Enter')}` : `Send to the agent · ${keys('Enter')}`;
  send.disabled = sending || !available() || !input.value.trim();
  input.disabled = !available();
  // The sidebar can be dragged narrow, so the texts follow its own width (sidebar.js measures it).
  const tight = (document.documentElement.dataset.sidebar ?? 'wide') !== 'wide';
  input.placeholder = !available() ? (tight ? 'Open from Pi (/divlet)' : 'Open this board from Pi (/divlet) to talk to it')
    : tight ? 'Ask the agent…' : 'Ask the agent to change the layout…';
  const keysHint = tight ? [`${keys('Enter')} send`] : [`${keys('Enter')} send`, `${keys('Shift+Enter')} new line`, '↑ previous'];
  // Each key with its meaning is one unit: a narrow composer wraps between units, never inside one.
  if (!available()) {
    // Not connected: say so, and offer the exact command that connects this project in Pi.
    const file = store.state?.project?.file;
    const copy = button('copy', 'Copy the command that opens this project in Pi', async () => {
      const command = `/divlet ${file || ''}`.trim();
      try { await navigator.clipboard.writeText(command); toast(`Copied ${command} · paste it in the Pi terminal`); }
      catch { toast(`Run ${command} in the Pi terminal`); }
    }, 'mini ask-copy');
    hint.replaceChildren(el('span', '', 'No agent is connected to this board'), copy);
  } else hint.replaceChildren(...keysHint.map(text => el('span', 'hint-unit', text)));
  // The plaque above the box already says what the agent is doing; the hint keeps the keys so nothing moves or repeats it.
  hint.classList.toggle('busy', false);
}

/* Opened by a key typed in a preview frame: that frame keeps focus until typing pauses, so every
   character arrives through one ordered channel (keys forwarded by the frame) and none is reordered. */
let handOff = 0;
function focusInput() {
  clearTimeout(handOff);
  handOff = 0;
  if (!isOpen()) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

export function toggle(open = !isOpen(), { text, fromFrame = false } = {}) {
  if (open && !available()) {
    toast('No agent is connected to this board. Open it from Pi with /divlet, or connect an MCP client (divlet-mcp).');
    return false;
  }
  if (open === isOpen()) { if (open) { if (text !== undefined) { input.value = text; grow(); } input.focus(); } return open; }
  if (open) {
    returnFocus = document.activeElement instanceof HTMLElement && !panel.contains(document.activeElement) ? document.activeElement : null;
    if (text !== undefined) input.value = text;
    sidebar.show('agent');
    if (fromFrame) handOff = setTimeout(focusInput, 220);
    else focusInput();
  } else {
    clearTimeout(handOff);
    handOff = 0;
    sidebar.close();
    recall = -1;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    else $('#viewport').focus({ preventScroll: true });
  }
  return open;
}

/** The pane was shown or folded, by this module or by its tab. */
on('sidebar', ({ open, tab }) => {
  placeStatus();
  const now = open && tab === 'agent';
  if (now) { paintStatus(); grow(); chat.render(); }
  emit('ask-open', now);
});

// A narrow sidebar changes what fits: the placeholder and the key hints are re-chosen, and the textarea re-fits its value.
on('sidebar-width', () => { paintStatus(); grow(); });

function armWatchdog(delay = 9000, waits = 6) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (agent().busy || !available()) return;
    // A notice the user can still act on (Undo after a delete) keeps its window: this one waits its turn instead of replacing it.
    if (waits > 0 && document.querySelector('#toast:not([hidden]) .toast-action')) { armWatchdog(2000, waits - 1); return; }
    toast('Pi has not started yet. Check the Pi terminal — it needs a model and an API key.');
  }, delay);
}

/** Keys typed in a preview frame while focus is still moving to the field: keep them as text. */
export function typeAhead(key) {
  if (!isOpen()) return false;
  if (key === 'Backspace') input.value = input.value.slice(0, -1);
  else input.value += key;
  if (handOff) { clearTimeout(handOff); handOff = setTimeout(focusInput, 220); }
  else focusInput();
  grow();
  paintStatus();
  return true;
}

export async function submit(text = input.value) {
  const request = text.trim();
  if (!request || sending) return null;
  sending = true;
  paintStatus();
  const ctx = context();
  try {
    const result = await post('api/ask', { text: request, ids: ctx?.ids ?? [], nodes: ctx?.nodes });
    remember(request);
    if (input.value.trim() === request) input.value = '';
    draft = '';
    grow();
    if (result.queued) toast('Queued — Pi takes it right after the current task');
    if (!result.queued) armWatchdog();
    return result;
  } catch (error) {
    toast(error.message);
    return null;
  } finally {
    sending = false;
    paintStatus();
  }
}

let stopping = false;
export function stop() {
  stopping = true;
  paintChip();
  paintStatus();
  return post('api/agent/stop', {}).catch(error => { stopping = false; paintChip(); paintStatus(); toast(error.message); });
}

input.addEventListener('input', () => { grow(); paintStatus(); recall = -1; });
input.addEventListener('keydown', event => {
  event.stopPropagation();
  if (event.key === 'Escape') { event.preventDefault(); toggle(false); }
  else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
  else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey) {
    const list = recent();
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    // Like a shell: ↑ on an empty or untouched field (or while already recalling) walks back through requests.
    if (event.key === 'ArrowUp' && (atStart || !input.value || recall >= 0) && recall < list.length - 1) {
      event.preventDefault();
      if (recall < 0) draft = input.value;
      recall++;
      input.value = list[recall];
    } else if (event.key === 'ArrowDown' && recall >= 0) {
      event.preventDefault();
      recall--;
      input.value = recall < 0 ? draft : list[recall];
    } else return;
    grow();
    paintStatus();
  }
});
panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); toggle(false); } });

/* ---- one activity plaque: above the composer, or above the tabs when the sidebar folds ---- */
function placeStatus() {
  const floating = !!agent().busy && !sidebar.isOpen();
  const parent = floating ? $('#agent-status-dock') : panel;
  if (status.parentElement === parent) return;
  const focused = status.contains(document.activeElement) ? document.activeElement : null;
  parent.insertBefore(status, floating ? null : composer);
  if (focused instanceof HTMLElement && (floating || isOpen())) focused.focus({ preventScroll: true });
}
function elapsed() {
  const since = agent().since ? Date.parse(agent().since) : NaN;
  if (!Number.isFinite(since)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function paintChip() {
  const state = agent();
  if (!state.busy) stopping = false;
  status.hidden = !state.busy;
  stopButton.hidden = !state.busy;
  placeStatus();
  status.classList.toggle('stopping', stopping);
  document.body.classList.toggle('agent-busy', !!state.busy);
  $('#open-agent').setAttribute('aria-busy', String(!!state.busy));
  if (!state.busy) return;
  statusText.textContent = stopping ? 'Agent · stopping…' : `Agent · ${state.activity || 'working'}${state.queued ? ` · ${state.queued} queued` : ''}`;
  statusTime.textContent = elapsed();
}
setInterval(() => { if (!status.hidden) statusTime.textContent = elapsed(); }, 1000);

on('selection', () => { if (isOpen()) { paintScope(); paintSuggest(); } });
on('change', () => { if (isOpen()) paintSuggest(); });
on('state', () => {
  if (agent().busy) clearTimeout(watchdog);
  paintChip();
  if (isOpen()) paintStatus();
  emit('agent', agent());
});
on('change', change => {
  if (change.kind !== 'reply') return;
  if (sidebar.isOpen('agent')) return;
  toast(`Pi: ${String(change.summary || '').replace(/\*\*|`/g, '')}`, { label: 'Read', run: () => { sidebar.show('agent'); chat.focus(change.seq); } });
});
