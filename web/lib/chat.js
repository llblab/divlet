// The conversation with Pi: your requests and its answers, oldest first, in the Agent pane. Changes made to the
// project (by anyone) are the History pane's business, not this one's.
import { $, el, icon, ago, button } from './util.js';
import { store, on, toast, descriptor, selectArtboards, selectNodes, loadModel, cachedModel } from './store.js';
import { native } from './host.js';
import { reveal } from './canvas.js';
import * as sidebar from './sidebar.js';

const CHAT = new Set(['ask', 'reply']);
export const isChat = change => CHAT.has(change.kind);

export const list = el('div', 'chat-list');
list.setAttribute('role', 'log');
list.setAttribute('aria-label', 'Conversation with Pi');

/** The exact connection command shown to the user and offered by the Agent shortcut. */
export const connectCommand = () => native ? `/divlet ${store.state?.project?.file || ''}`.trim() : `npx -y @divlet/mcp --connect ${new URL('./', location.href).href}`;
const connection = el('section', 'agent-connect');
connection.setAttribute('aria-label', 'Connect an agent');
connection.append(el('h3', '', 'Connect an agent to this page'), el('p', '', native
  ? 'Open this project in Pi with the command below, or connect an MCP client that supports sampling.'
  : 'Register this command as an MCP server in your agent, then use the browser window it opens.'));
const commandBox = el('div', 'agent-connect-command');
const command = el('textarea', 'field mono agent-connect-value');
command.rows = 4;
command.readOnly = true;
command.spellcheck = false;
command.setAttribute('aria-label', 'Agent connection command');
const copyCommand = button('copy', 'Copy the connection command', async () => {
  const value = command.value;
  try {
    await navigator.clipboard.writeText(value);
    toast(native ? `Copied ${value} · paste it in the Pi terminal` : 'Copied · register it as an MCP server in your agent');
  } catch {
    command.focus(); command.select();
    toast('The clipboard is unavailable. Copy the selected command.');
  }
}, 'mini ask-copy');
copyCommand.append(el('span', '', 'Copy'));
commandBox.append(command, copyCommand);
connection.append(commandBox);
const connectionKey = () => `${!!store.state?.agent?.connected}:${store.state?.agent?.conversation !== false}:${connectCommand()}`;
let renderedConnection = null;
const expanded = new Set();
const unreadBadge = $('#agent-count');
let unread = 0;
let focusSeq = null;
let followLatest = true;
// An explicitly focused message stays in view through the layout changes that follow (the pane finishing its open/resize,
// the composer settling) until the reader scrolls it away; it is the one place `scrollTop` is re-applied after a resize.
let pinnedSeq = null, pinnedTop = 0;
let readWidth = 0, readHeight = 0;
const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
const scrollToLatest = () => { if (followLatest && list.clientHeight) list.scrollTop = list.scrollHeight; };
const revealPinned = () => {
  const target = pinnedSeq === null ? null : [...list.querySelectorAll('[data-seq]')].find(node => node.dataset.seq === String(pinnedSeq));
  if (!target || !list.clientHeight) return false;
  followLatest = false;
  target.scrollIntoView({ block: 'nearest' });
  followLatest = atBottom();
  pinnedTop = list.scrollTop;
  return true;
};
list.addEventListener('scroll', () => {
  // A queued scroll from the old layout is not a reader leaving the bottom after the composer/status resizes.
  if (list.clientHeight && list.clientWidth === readWidth && list.clientHeight === readHeight) {
    followLatest = atBottom();
    if (pinnedSeq !== null && Math.abs(list.scrollTop - pinnedTop) > 1) pinnedSeq = null;
  }
}, { passive: true });
new ResizeObserver(() => {
  readWidth = list.clientWidth; readHeight = list.clientHeight;
  if (pinnedSeq !== null && revealPinned()) return;
  scrollToLatest();
}).observe(list);

/** Plain text with `code`, **bold** and line breaks, built as DOM (never as HTML). */
function richText(text) {
  const box = el('div', 'rich');
  for (const [index, line] of text.split('\n').entries()) {
    if (index) box.append(document.createElement('br'));
    for (const part of line.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
      if (!part) continue;
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) box.append(el('code', '', part.slice(1, -1)));
      else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) box.append(el('b', '', part.slice(2, -2)));
      else box.append(document.createTextNode(part));
    }
  }
  return box;
}

function contextLabel(context) {
  if (!context) return '';
  if (context.nodes) {
    const doc = descriptor(context.nodes.documentId);
    return `${doc?.name || context.nodes.documentId} › ${context.nodes.ids.slice(0, 2).map(id => `#${id}`).join(', ')}${context.nodes.ids.length > 2 ? ` +${context.nodes.ids.length - 2}` : ''}`;
  }
  if (context.documents?.length) return context.documents.length === 1 ? context.documents[0].name : `${context.documents.length} artboards`;
  return 'whole project';
}

async function focusContext(context) {
  const ids = (context.documents || []).map(doc => doc.id).filter(id => descriptor(id));
  if (!ids.length) return;
  if (context.nodes && descriptor(context.nodes.documentId)) {
    const model = cachedModel(context.nodes.documentId) || await loadModel(context.nodes.documentId).catch(() => null);
    const alive = context.nodes.ids.filter(id => model?.nodes[id]);
    if (alive.length) { selectNodes(context.nodes.documentId, alive, { reveal: true }); reveal(context.nodes.documentId); return; }
  }
  selectArtboards(ids);
  reveal(ids[0]);
}

function bubble(change) {
  const mine = change.kind === 'ask';
  const line = el('div', `bubble ${mine ? 'from-user' : 'from-agent'}`);
  line.dataset.seq = String(change.seq);
  const head = el('div', 'bubble-head');
  head.append(icon(mine ? 'user' : 'sparkle'), el('b', '', mine ? 'You' : 'Pi'));
  if (mine && change.context) {
    const label = contextLabel(change.context);
    const about = el('button', 'bubble-about', label);
    about.type = 'button';
    // One line in the panel (it ellipsizes when the sidebar is narrow); the whole label is on hover.
    about.title = label;
    about.dataset.tip = `Select what this request was about · ${label}`;
    about.disabled = !(change.context.documents || []).some(doc => descriptor(doc.id));
    about.addEventListener('click', () => focusContext(change.context));
    head.append(about);
  }
  const when = el('time', 'when', ago(change.at));
  when.dateTime = change.at;
  when.title = new Date(change.at).toLocaleString();
  head.append(el('span', 'grow'), when);
  if (!mine) {
    const copy = button('copy', 'Copy this reply', async () => {
      try { await navigator.clipboard.writeText(change.message || change.summary || ''); toast('Reply copied'); }
      catch { toast('The clipboard is not available here'); }
    }, 'mini bubble-copy');
    head.append(copy);
  }
  const body = richText(change.message || change.summary || '');
  const long = (change.message || '').length > 280 || (change.message || '').split('\n').length > 6;
  const open = expanded.has(change.seq);
  body.classList.toggle('clamped', long && !open);
  line.append(head, body);
  if (long) {
    const more = el('button', 'link-button more', open ? 'Show less' : 'Show more');
    more.type = 'button';
    more.addEventListener('click', () => { if (expanded.has(change.seq)) expanded.delete(change.seq); else expanded.add(change.seq); render(); });
    line.append(more);
  }
  return line;
}

function paintUnread() {
  unreadBadge.hidden = !unread;
  unreadBadge.textContent = String(Math.min(unread, 99));
}

/** A new request or answer arrived: unseen answers are counted on the Agent tab until it is opened. */
export function note(change) {
  if (!isChat(change)) return;
  if (change.kind === 'ask') { followLatest = true; pinnedSeq = null; }
  if (change.kind === 'reply' && !sidebar.isOpen('agent')) { unread++; paintUnread(); }
  render();
}

export function render() {
  const top = list.scrollTop;
  const messages = store.recent.filter(isChat);
  const content = messages.map(bubble);
  const focused = connection.contains(document.activeElement) ? document.activeElement : null;
  if (!store.state?.agent?.connected) {
    const value = connectCommand();
    if (command.value !== value) command.value = value;
    content.push(connection);
  } else if (!messages.length) content.push(el('div', 'quiet', store.state.agent.conversation === false
    ? 'An agent is connected. Continue the conversation in your agent; its edits appear in History.'
    : 'No conversation yet. Ask the agent to change the layout below; its answers appear here, and every edit it makes is in History.'));
  list.replaceChildren(...content);
  renderedConnection = connectionKey();
  if (focused?.isConnected) focused.focus({ preventScroll: true });
  if (sidebar.isOpen('agent')) { unread = 0; paintUnread(); }
  if (focusSeq !== null) {
    const target = [...list.querySelectorAll('[data-seq]')].find(node => node.dataset.seq === String(focusSeq));
    focusSeq = null;
    if (target) { pinnedSeq = Number(target.dataset.seq); revealPinned(); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1200); return; }
  }
  if (followLatest) scrollToLatest();
  else if (list.clientHeight) list.scrollTop = top;
}

// Repaint connection transitions, not every activity update: keep command selection and older-message focus intact.
on('state', () => { if (renderedConnection !== connectionKey()) render(); });

/** Scroll to one message once the pane shows it. */
export function focus(seq) { focusSeq = seq; render(); }

setInterval(() => { if (sidebar.isOpen('agent')) for (const node of list.querySelectorAll('time.when')) node.textContent = ago(node.dateTime); }, 15000);
