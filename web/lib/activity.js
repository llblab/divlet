import { $, el, icon, ago, pressGuard } from './util.js';
import { store, on, request, documents, descriptor, selectArtboards, selectNodes, loadModel } from './store.js';
import { reveal, flashNodes } from './canvas.js';
import * as sidebar from './sidebar.js';
import * as chat from './chat.js';

const panel = $('#activity');
const statusButton = $('#status');
const dot = $('#status-dot');
const diag = $('#diag-count');
const historyButton = $('#open-history');
const ACTOR = { agent: ['agent', 'Pi'], user: ['user', 'You'], file: ['file', 'File'], system: ['divlet', 'divlet'] };
const KIND = { undo: 'Undo', redo: 'Redo', create: 'New', delete: 'Removed', external: 'File edit' };
const CHAT = new Set(['ask', 'reply']);
let focusSeq = null;
let unread = 0;

export const isOpen = () => sidebar.isOpen('activity');
export function toggle(force) {
  if (force === undefined) sidebar.toggle('activity');
  else if (force) sidebar.show('activity');
  else if (isOpen()) sidebar.close();
}

export function paintStatus() {
  const diagnostics = store.state?.diagnostics || [];
  const unsaved = documents().some(doc => Number.isInteger(doc.savedVersion) && doc.savedVersion < doc.version);
  const kind = store.connection !== 'connected' ? store.connection : diagnostics.length ? 'attention' : unsaved ? 'saving' : 'live';
  dot.dataset.kind = kind;
  // The History button carries the count: issues in red, otherwise what Pi and files changed unseen.
  diag.hidden = !diagnostics.length && !unread;
  diag.textContent = diagnostics.length ? String(diagnostics.length) : String(Math.min(unread, 99));
  diag.classList.toggle('bad', diagnostics.length > 0);
  const count = documents().length;
  const text = { connecting: 'Connecting…', offline: 'Offline — reconnecting; the preview is kept', attention: `${diagnostics.length} issue${diagnostics.length === 1 ? '' : 's'} need attention`, saving: 'Saving…', live: `Live · all changes saved · ${count} artboard${count === 1 ? '' : 's'}` }[kind];
  statusButton.dataset.tip = `${statusButton.dataset.project || 'project'} · ${text} · click for project actions`;
  statusButton.setAttribute('aria-label', `Project menu. ${text}`);
  historyButton.dataset.tip = `History${diagnostics.length ? ` · ${diagnostics.length} issue${diagnostics.length === 1 ? '' : 's'}` : unread ? ` · ${unread} new` : ''} · H`;
}

export async function loadRecent() {
  try { store.recent = (await request('api/history?limit=100')).changes; }
  catch { /* the stream keeps it current */ }
  render();
  chat.render();
}

export function pushChange(change) {
  if (store.recent.some(item => item.seq === change.seq)) return;
  store.recent.push(change);
  if (store.recent.length > 300) store.recent.splice(0, store.recent.length - 300);
  if (!isOpen() && change.actor !== 'user' && !CHAT.has(change.kind)) { unread++; paintStatus(); }
  render();
  chat.note(change);
}

async function focusChange(change, documentIds = [change.documentId]) {
  const present = documentIds.filter(id => descriptor(id));
  if (present.length > 1) { selectArtboards(present); reveal(present[0]); return; }
  if (!descriptor(change.documentId)) return;
  selectArtboards([change.documentId]);
  reveal(change.documentId);
  if (!change.touched?.length) return;
  const model = await loadModel(change.documentId).catch(() => null);
  const alive = change.touched.filter(id => model?.nodes[id]);
  if (alive.length) {
    selectNodes(change.documentId, alive.slice(0, 1), { reveal: true });
    flashNodes(change.documentId, descriptor(change.documentId)?.render ?? 0, alive);
  }
}

/** Three or more issues of one kind (ten missing images after an import) read as one line that lists them on hover. */
function groupDiagnostics(issues) {
  const byCode = new Map();
  for (const item of issues) byCode.set(item.code, [...(byCode.get(item.code) || []), item]);
  return [...byCode.values()].flatMap(group => (group.length < 3 ? group : [{ ...group[0], message: `${group[0].message} — and ${group.length - 1} more of this kind`, group }]));
}

function diagnosticRow(item) {
  const line = el('div', 'diag');
  line.append(icon('alertDot'));
  const text = el('div', 'text');
  const where = [(item.path || item.documentId || '').split(/[\\/]/).slice(-2).join('/'), item.line ? `line ${item.line}:${item.column}` : ''].filter(Boolean).join(' · ');
  text.append(el('div', 'msg', item.message || 'Issue'), el('div', 'sub', [item.code, where].filter(Boolean).join(' · ')));
  line.append(text);
  if (item.code === 'MISSING_ASSET') text.append(el('div', 'sub', item.path ? 'Copy the file to the path shown on hover, or fix the path in the element.' : 'Fix the path in the element.'));
  // The hover names every expected path: the row itself shows only the last two segments.
  if (item.group) {
    line.dataset.tip = `${item.group.length} issues of this kind — expected path of each`;
    line.dataset.tipCode = item.group.slice(0, 12).map(entry => `${entry.message}${entry.path ? `\nexpected at ${entry.path}` : ''}`).join('\n') + (item.group.length > 12 ? `\n… ${item.group.length - 12} more` : '');
  } else if (item.code === 'MISSING_ASSET' && item.path) {
    line.dataset.tip = 'Expected path';
    line.dataset.tipCode = item.path;
  }
  if (item.documentId && descriptor(item.documentId)) {
    const show = el('button', 'link-button', 'Show');
    show.type = 'button';
    show.addEventListener('click', () => { selectArtboards([item.documentId]); reveal(item.documentId); });
    line.append(show);
  }
  return line;
}

/** Consecutive changes of one gesture (same undo group, actor and kind) read as one line. */
function collapse(changes) {
  const rows = [];
  for (const change of changes) {
    const previous = rows.at(-1);
    if (previous && !CHAT.has(change.kind) && change.group && previous.change.group === change.group && previous.change.actor === change.actor && previous.change.kind === change.kind) {
      previous.count++;
      previous.documents.add(change.documentId);
      previous.touched = [...new Set([...previous.touched, ...(change.touched || [])])];
      previous.change = change;
      previous.seqs.push(change.seq);
      continue;
    }
    rows.push({ change, count: 1, documents: new Set([change.documentId]), touched: [...(change.touched || [])], seqs: [change.seq] });
  }
  return rows;
}

function changeRow(row) {
  const { change, count } = row;
  const [iconName, who] = ACTOR[change.actor] || ACTOR.system;
  const line = el('button', `change actor-${change.actor} kind-${change.kind}`);
  line.type = 'button';
  const kind = KIND[change.kind];
  const title = change.label && change.label !== change.summary ? change.label : change.summary;
  const text = el('div', 'text');
  const msg = el('div', 'msg');
  if (kind) msg.append(el('span', 'kind', kind));
  msg.append(document.createTextNode(title));
  if (count > 1) msg.append(el('span', 'times', `×${count}`));
  const where = row.documents.size > 1 ? `${row.documents.size} artboards` : change.name || change.documentId;
  const details = [where, who, title !== change.summary ? change.summary : ''].filter(Boolean).join(' · ');
  text.append(msg, el('div', 'sub', details));
  const when = el('time', 'when', ago(change.at));
  when.dateTime = change.at;
  when.title = new Date(change.at).toLocaleString();
  line.append(icon(change.kind === 'undo' || change.kind === 'redo' ? change.kind : iconName), text, when);
  line.dataset.tip = count > 1 ? `${count} steps undone together · #${row.seqs[0]}–#${change.seq}` : `#${change.seq} · v${change.fromVersion ?? '—'} → v${change.toVersion ?? '—'}${change.touched?.length ? ` · ${change.touched.length} node${change.touched.length === 1 ? '' : 's'}` : ''}`;
  line.dataset.seq = String(change.seq);
  line.disabled = ![...row.documents].some(id => descriptor(id));
  line.addEventListener('click', () => focusChange({ ...change, touched: row.touched }, [...row.documents]));
  return line;
}

let pending = false;
const pressing = pressGuard(panel, () => { if (pending) render(); });

export function render() {
  paintStatus();
  if (!isOpen()) return;
  if (pressing()) { pending = true; return; }
  pending = false;
  unread = 0;
  paintStatus();
  const issues = store.state?.diagnostics || [];
  const body = el('div', 'panel-body');
  for (const item of groupDiagnostics(issues)) body.append(diagnosticRow(item));
  const changes = store.recent.filter(change => !CHAT.has(change.kind));
  const rows = collapse(changes).reverse();
  if (!rows.length && !issues.length) body.append(el('div', 'quiet', 'No changes yet. Every edit by you, Pi or external files appears here; the conversation with Pi is in the Agent tab.'));
  for (const row of rows) body.append(changeRow(row));
  const foot = el('div', 'panel-foot');
  const revision = el('span', 'value');
  revision.append(el('i', '', 'rev'), document.createTextNode(String(store.state?.revision ?? 0)));
  const frames = el('span', 'value');
  frames.dataset.tip = 'Live previews / artboards';
  frames.append(el('i', '', 'live'), document.createTextNode($('#live-count').textContent));
  foot.append(revision, frames);
  const scroll = panel.querySelector('.panel-body')?.scrollTop ?? 0;
  panel.replaceChildren(body, foot);
  body.scrollTop = scroll;
  if (focusSeq !== null) {
    const target = [...body.querySelectorAll('[data-seq]')].find(node => node.dataset.seq === String(focusSeq));
    focusSeq = null;
    if (target) { target.scrollIntoView({ block: 'nearest' }); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1200); }
  }
}

on('focus-change', seq => { if (store.recent.some(change => change.seq === seq && CHAT.has(change.kind))) return; focusSeq = seq; render(); });

on('state', render);
on('expanded', paintStatus);
on('connection', render);
on('sidebar', ({ open, tab }) => { if (open && tab === 'activity') render(); });
setInterval(() => { if (isOpen()) for (const node of panel.querySelectorAll('time.when')) node.textContent = ago(node.dateTime); }, 15000);
