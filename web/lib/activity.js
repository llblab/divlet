import { $, el, icon, ago, pressGuard } from './util.js';
import { store, on, request, post, documents, descriptor, selectArtboards, selectNodes, loadModel } from './store.js';
import { reveal, flashNodes } from './canvas.js';
import * as sidebar from './sidebar.js';
import * as chat from './chat.js';

const panel = $('#activity');
const statusButton = $('#status');
const dot = $('#status-dot');
const diag = $('#diag-count');
const historyButton = $('#open-history');
const ACTOR = { __proto__: null, agent: ['agent', 'Pi'], user: ['user', 'You'], file: ['file', 'File'], system: ['divlet', 'divlet'] };
const KIND = { __proto__: null, undo: 'Undo', redo: 'Redo', create: 'New', delete: 'Removed', external: 'File edit' };
const CHAT = new Set(['ask', 'reply']);
let focusSeq = null;
let unread = 0;
let timelineRead = null;
// Server point IDs may recur after Undo; each observed transition invalidates in-flight snapshots, including A → B → A.
let observedHead = '', stateGeneration = 0, requestedGeneration = -1;
let reading = false, readAgain = false, navigating = null, readError = '', navigationError = '', auditOpen = false, restorePoint = null;
const supportsNavigation = () => store.state?.history?.navigation === true;
const timelineReady = () => supportsNavigation() && timelineRead?.generation === stateGeneration && timelineRead.projectId === store.state?.projectId && timelineRead.timeline?.current === store.state?.history?.pointId;

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
  if (reading) { readAgain = true; return; }
  reading = true;
  const project = store.state?.projectId;
  const generation = stateGeneration;
  requestedGeneration = generation;
  try {
    const result = await request('api/history?limit=100');
    if (project && project !== store.state?.projectId) return;
    store.recent = [...new Map([...result.changes, ...store.recent].map(change => [change.seq, change])).values()].sort((a, b) => a.seq - b.seq).slice(-300);
    timelineRead = { projectId: store.state?.projectId, generation, timeline: result.navigation === true && Array.isArray(result.timeline?.points) ? result.timeline : null };
    readError = supportsNavigation() && !timelineRead.timeline ? 'This board did not supply a navigable timeline.' : '';
  } catch (error) { readError = `History could not be read: ${error.message}. Reopen History to retry.`; }
  finally {
    reading = false;
    render();
    chat.render();
    if (readAgain) { readAgain = false; if (isOpen() && supportsNavigation() && !timelineReady() && !readError) void loadRecent(); }
  }
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

function changeRow(row, readOnly = false) {
  const { change, count } = row;
  const [iconName, who] = ACTOR[change.actor] || ACTOR.system;
  const line = el(readOnly ? 'div' : 'button', `change actor-${change.actor} kind-${change.kind}${readOnly ? ' history-audit' : ''}`);
  if (!readOnly) line.type = 'button';
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
  if (!readOnly) {
    line.disabled = ![...row.documents].some(id => descriptor(id));
    line.dataset.tip += ' · Show affected elements in their current state';
    line.addEventListener('click', () => focusChange({ ...change, touched: row.touched }, [...row.documents]));
  }
  return line;
}

async function navigate(pointId, expectedPoint) {
  if (navigating || !supportsNavigation() || store.connection !== 'connected' || pointId === expectedPoint) return;
  navigating = pointId;
  navigationError = '';
  render();
  try { await post('api/history/navigate', { pointId, expectedPoint }); }
  catch (error) { navigationError = error.message; }
  finally { navigating = null; await loadRecent(); render(); }
}

function stateRow(point, index, timeline) {
  const current = point.id === timeline.current;
  const future = index > timeline.index;
  const line = el('button', `change history-state${current ? ' is-current' : ''}${future ? ' is-future' : ''}`);
  line.type = 'button';
  line.dataset.historyPoint = point.id;
  line.setAttribute('aria-label', `${current ? 'Current' : 'Restore'} project state: ${point.label}`);
  line.setAttribute('aria-disabled', String(current || !!navigating || store.connection !== 'connected'));
  if (current) line.setAttribute('aria-current', 'step');
  if (navigating === point.id) line.setAttribute('aria-busy', 'true');
  const text = el('div', 'text');
  text.append(el('div', 'msg', point.label));
  const range = point.seq == null ? 'Session baseline' : point.firstSeq !== point.seq ? `Grouped edit · #${point.firstSeq}–#${point.seq}` : `After edit #${point.seq}`;
  text.append(el('div', 'sub', range));
  line.append(icon('clock'), text, el('span', 'history-tag', current ? 'Current' : future ? 'Ahead' : 'Restore'));
  line.dataset.tip = current ? 'The project is at this state' : 'Restore the whole project after this grouped edit, including frame placement and project settings';
  const expectedPoint = timeline.current;
  line.addEventListener('click', () => navigate(point.id, expectedPoint));
  line.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const rows = [...panel.querySelectorAll('[data-history-point]')], at = rows.indexOf(line);
    const target = event.key === 'Home' ? rows[0] : event.key === 'End' ? rows.at(-1) : rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    target?.focus();
  });
  return line;
}

const BOUNDARY = {
  opened: 'Session history starts here. Restarting the board clears these state addresses.',
  untracked: 'Earlier states cannot be reached across an untracked source change.',
  nonlinear: 'Selective Undo/Redo separated this segment from earlier states.',
  retained: 'Only the retained states are available.',
};

let pending = false, keyboardPress = false;
const pressing = pressGuard(panel, () => { if (pending) render(); });
panel.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key) && event.target.closest('[data-history-point]')) keyboardPress = true; }, true);
const releaseKey = () => { if (!keyboardPress) return; keyboardPress = false; setTimeout(() => { if (pending) render(); }, 0); };
window.addEventListener('keyup', releaseKey, true);
window.addEventListener('blur', releaseKey);

export function render() {
  paintStatus();
  if (!isOpen()) return;
  if (pressing() || keyboardPress) { pending = true; return; }
  pending = false;
  unread = 0;
  paintStatus();
  const issues = store.state?.diagnostics || [];
  const body = el('div', 'panel-body');
  for (const item of groupDiagnostics(issues)) body.append(diagnosticRow(item));
  const changes = store.recent.filter(change => !CHAT.has(change.kind));
  const rows = collapse(changes).reverse();
  const supported = supportsNavigation();
  if (supported) {
    const states = el('div', 'history-states');
    states.setAttribute('role', 'group'); states.setAttribute('aria-label', 'Project states'); states.tabIndex = -1;
    states.append(el('div', 'caption history-caption', 'Project states'));
    if (timelineReady()) {
      const timeline = timelineRead.timeline;
      for (let i = timeline.points.length - 1; i >= 0; i--) states.append(stateRow(timeline.points[i], i, timeline));
      const limited = timeline.pastLimited || timeline.futureLimited ? ' Some legacy Undo/Redo entries lie outside this connected timeline.' : '';
      states.append(el('p', 'history-boundary', (BOUNDARY[timeline.boundary] || BOUNDARY.retained) + limited));
    } else states.append(el('div', 'quiet', readError ? 'Project states are unavailable.' : 'Reading the current project states…'));
    body.append(states);
    const audit = el('details', 'history-log');
    audit.open = auditOpen;
    audit.dataset.historyAudit = 'true';
    audit.addEventListener('toggle', () => { if (audit.isConnected) auditOpen = audit.open; });
    const summary = el('summary'); summary.append(icon('chevron'), el('span', 'text', 'Activity log'), el('span', 'value', String(rows.length)));
    audit.append(summary, el('p', 'history-boundary', 'Read-only activity, not state addresses. The conversation is in Agent.'));
    for (const row of rows) audit.append(changeRow(row, true));
    body.append(audit);
  } else {
    body.append(el('p', 'history-boundary', 'This board does not advertise state navigation. Rows only show affected elements in their current state.'));
    if (!rows.length && !issues.length) body.append(el('div', 'quiet', 'No changes yet. Every edit by you, Pi or external files appears here; the conversation with Pi is in the Agent tab.'));
    for (const row of rows) body.append(changeRow(row));
  }
  const foot = el('div', 'panel-foot');
  const revision = el('span', 'value');
  revision.append(el('i', '', 'rev'), document.createTextNode(String(store.state?.revision ?? 0)));
  const frames = el('span', 'value');
  frames.dataset.tip = 'Live previews / artboards';
  frames.append(el('i', '', 'live'), document.createTextNode($('#live-count').textContent));
  if (supported) {
    foot.classList.add('history-foot');
    const feedback = el('div', 'history-feedback', navigationError || readError || (navigating ? 'Restoring the project…' : ''));
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    feedback.classList.toggle('is-error', !!(navigationError || readError));
    const counters = el('div', 'history-counters'); counters.append(revision, frames);
    foot.append(feedback, counters);
  } else foot.append(revision, frames);
  const scroll = panel.querySelector('.panel-body')?.scrollTop ?? 0;
  const focused = panel.contains(document.activeElement) ? document.activeElement : null;
  const focusedPoint = focused?.dataset.historyPoint;
  if (focusedPoint) restorePoint = focusedPoint;
  const mayRestorePoint = !!focusedPoint || restorePoint && (document.activeElement === document.body || document.activeElement?.matches('.history-states'));
  if (!mayRestorePoint) restorePoint = null;
  const focusedAudit = focused?.parentElement?.matches('.history-log');
  panel.replaceChildren(body, foot);
  body.scrollTop = scroll;
  if (restorePoint && mayRestorePoint) {
    const target = [...body.querySelectorAll('[data-history-point]')].find(node => node.dataset.historyPoint === restorePoint) ?? body.querySelector('[aria-current="step"]');
    if (target) { target.focus({ preventScroll: true }); restorePoint = null; }
    else body.querySelector('.history-states')?.focus({ preventScroll: true });
  } else if (focusedAudit) body.querySelector('.history-log summary')?.focus({ preventScroll: true });
  if (focusSeq !== null) {
    const target = [...body.querySelectorAll('[data-seq]')].find(node => node.dataset.seq === String(focusSeq));
    focusSeq = null;
    if (target) { target.scrollIntoView({ block: 'nearest' }); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1200); }
  }
}

on('focus-change', seq => { if (store.recent.some(change => change.seq === seq && CHAT.has(change.kind))) return; focusSeq = seq; render(); });

on('state', () => {
  const supported = supportsNavigation();
  const head = JSON.stringify([store.state?.projectId, store.state?.history?.pointId, supported]);
  if (head !== observedHead) { observedHead = head; stateGeneration++; }
  if (isOpen() && supported && !timelineReady() && requestedGeneration !== stateGeneration) {
    if (reading) readAgain = true; else void loadRecent();
  }
  render();
});
on('expanded', paintStatus);
on('connection', render);
on('sidebar', ({ open, tab }) => { if (open && tab === 'activity') { void loadRecent(); render(); } else restorePoint = null; });
setInterval(() => { if (isOpen()) for (const node of panel.querySelectorAll('time.when')) node.textContent = ago(node.dateTime); }, 15000);
