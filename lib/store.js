import { clamp } from './util.js';
import { readSession, shareSelection, writer } from './host.js';
export { base, apiUrl, request, post } from './host.js';

const listeners = new Map();
export const on = (name, fn) => { (listeners.get(name) || listeners.set(name, new Set()).get(name)).add(fn); return () => listeners.get(name).delete(fn); };
export const emit = (name, detail) => { for (const fn of listeners.get(name) || []) { try { fn(detail); } catch (error) { console.error(error); } } };

export const store = {
  state: null,
  selected: new Set(),
  node: null,
  mode: 'board',
  connection: 'connecting',
  observations: new Map(),
  models: new Map(),
  recent: [],
  expanded: null,
  /** Frames being deleted: hidden at once, shown again if the deletion fails. */
  leaving: new Set(),
};

/** A capability is unavailable only when the host says `false`; native hosts predate the newer flags and omit them. */
export const capable = name => store.state?.project?.capabilities?.[name] !== false;

export const documents = () => (store.state?.documents || []).filter(doc => !store.leaving.has(doc.id));
export const descriptor = id => documents().find(doc => doc.id === id);

/** Short notice. `action` adds one button; `sticky` keeps it until replaced or dismissed with `toast.clear(id)`. */
export function toast(message, action, { sticky = false, id } = {}) { emit('toast', { message, action, sticky, id }); }
toast.clear = id => emit('toast-clear', id);

/** Resolve once the project state lists `id` (new documents arrive over SSE after the POST returns). */
export function whenDocument(id, timeout = 4000) {
  if (descriptor(id)) return Promise.resolve(descriptor(id));
  return new Promise(resolve => {
    const stop = on('state', () => { if (descriptor(id)) { stop(); clearTimeout(timer); resolve(descriptor(id)); } });
    const timer = setTimeout(() => { stop(); resolve(descriptor(id) || null); }, timeout);
  });
}

/** Resolve once the project state shows document `id` at `version` or later. */
export function whenVersion(id, version, timeout = 4000) {
  const ready = () => (descriptor(id)?.version ?? 0) >= version;
  if (ready()) return Promise.resolve(true);
  return new Promise(resolve => {
    const stop = on('state', () => { if (ready()) { stop(); clearTimeout(timer); resolve(true); } });
    const timer = setTimeout(() => { stop(); resolve(ready()); }, timeout);
  });
}

/** The model including this client's latest accepted commit (waits for the state that announces it). */
export async function freshModel(id) {
  const target = known.get(id) || 0;
  if ((descriptor(id)?.version ?? 0) < target) await whenVersion(id, target);
  return cachedModel(id) || loadModel(id);
}

/* ---- tree helpers --------------------------------------------------------- */
export function parentMap(model) {
  const parents = new Map();
  for (const node of Object.values(model.nodes)) if (node.type === 'element') for (const child of node.children) parents.set(child, node.id);
  return parents;
}
export const parentOf = (model, id) => model.nodes[parentMap(model).get(id)] || null;
export function ancestorsOf(model, id) {
  const parents = parentMap(model);
  const path = [];
  for (let current = parents.get(id); current; current = parents.get(current)) path.unshift(current);
  return path;
}
export const CONTAINERS_EXCLUDED = new Set(['img', 'input', 'br', 'hr', 'area', 'col', 'source', 'track', 'wbr', 'textarea', 'select', 'option']);
export const canContain = node => node?.type === 'element' && !CONTAINERS_EXCLUDED.has(node.tag);
export function textChild(model, node) {
  if (node?.type === 'text') return node;
  if (node?.type === 'element' && node.children.length === 1 && model.nodes[node.children[0]]?.type === 'text') return model.nodes[node.children[0]];
  return null;
}

/* ---- model cache --------------------------------------------------------- */
const loading = new Map();
const modelRenders = new WeakMap();
export function cachedModel(id) {
  const model = store.models.get(id);
  return model && model.version === descriptor(id)?.version && modelRenders.get(model) === descriptor(id)?.render ? model : null;
}
export async function loadModel(id) {
  const cached = cachedModel(id);
  if (cached) return cached;
  if (!descriptor(id)) throw Object.assign(new Error(`The frame ${id} is gone`), { code: 'NOT_FOUND', quiet: true });
  const version = descriptor(id)?.version;
  const render = descriptor(id)?.render;
  const key = `${id}@${version}:${render}`;
  if (!loading.has(key)) {
    loading.set(key, readSession.readFrame(id).then(model => {
      if (descriptor(id)?.version !== version || descriptor(id)?.render !== render) return loadModel(id);
      if (model.version === version) {
        modelRenders.set(model, render);
        store.models.set(id, model);
        pruneNodeSelection(model);
        emit('model', model);
      }
      return model;
    }).finally(() => loading.delete(key)));
  }
  return loading.get(key);
}

/* ---- committing edits (serialised per document) -------------------------- */
const queues = new Map();
const known = new Map();
let groupSeed = 0;
export const newGroup = () => `u${Date.now().toString(36)}${(groupSeed++).toString(36)}`;
/** Resolves once every commit queued for one document has finished, whether it succeeded or not. */
export const idle = documentId => (queues.get(documentId) || Promise.resolve()).then(() => undefined);

function enqueue(documentId, task) {
  const result = (queues.get(documentId) || Promise.resolve()).then(task);
  queues.set(documentId, result.catch(() => {}));
  return result;
}

async function send(write, documentId, build, { version = Math.max(known.get(documentId) || 0, descriptor(documentId)?.version || 0), retry = true } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await write(build(version));
      known.set(documentId, result.version);
      return result;
    } catch (error) {
      if (error.code === 'REVISION_CONFLICT' && error.details?.actualVersion) known.set(documentId, error.details.actualVersion);
      if (retry && error.code === 'REVISION_CONFLICT' && attempt < 2 && error.details?.actualVersion) { version = error.details.actualVersion; continue; }
      throw error;
    }
  }
}

/** A literal patch, or async relative intent derived after prior local writes; derived patches never retry a stale model. */
export function commit(documentId, patch, { label, group, expectedVersion, expectedRender } = {}) {
  const guard = expectedVersion === undefined ? {} : { version: expectedVersion, retry: false };
  const format = store.state?.project?.format;
  return enqueue(documentId, async () => {
    if (typeof patch !== 'function') return send(writer.patch, documentId, version => ({ documentId, expectedVersion: version, expectedRender, patch, label, group }), guard);
    if (store.state?.project?.format !== format) throw Object.assign(new Error('The source format changed. Read it again before retrying.'), { code: 'REVISION_CONFLICT' });
    const model = await freshModel(documentId);
    if (store.state?.project?.format !== format || model !== cachedModel(documentId) || model.version < (known.get(documentId) || 0)) throw Object.assign(new Error('The frame model is not current. Read it again before retrying.'), { code: 'REVISION_CONFLICT' });
    const derived = await patch(model);
    if (store.state?.project?.format !== format || model !== cachedModel(documentId)) throw Object.assign(new Error('The frame changed while preparing this edit. Read it again before retrying.'), { code: 'REVISION_CONFLICT' });
    if (!derived) return null;
    return send(writer.patch, documentId, version => ({ documentId, expectedVersion: version, expectedRender, patch: derived, label, group }), { version: expectedVersion ?? model.version, retry: false });
  }).catch(error => { toast(error.message); throw error; });
}
export function edit(documentId, op, { label, group, expectedRender } = {}) {
  const format = store.state?.project?.format;
  return enqueue(documentId, async () => {
    if (typeof op !== 'function') return send(writer.edit, documentId, expectedVersion => ({ documentId, expectedVersion, expectedRender, op, label, group }));
    // Derive relative legacy intent after local commits; native operations keep their shown-view guards.
    if (store.state?.project?.format !== format) throw Object.assign(new Error('The source format changed. Read it again before retrying.'), { code: 'REVISION_CONFLICT' });
    const model = await freshModel(documentId);
    if (store.state?.project?.format !== format || model !== cachedModel(documentId) || model.version < (known.get(documentId) || 0)) throw Object.assign(new Error('The frame model is not current. Read it again before retrying.'), { code: 'REVISION_CONFLICT' });
    const derived = op(model);
    if (!derived) return null;
    return send(writer.edit, documentId, expectedVersion => ({ documentId, expectedVersion, expectedRender, op: derived, label, group }), { version: model.version, retry: false });
  }).catch(error => { toast(error.message); throw error; });
}

export const undo = () => writer.undo({}).catch(error => { toast(error.message); return null; });
export const redo = () => writer.redo({}).catch(error => { toast(error.message); return null; });

/* ---- selection ------------------------------------------------------------ */
let selectionSequence = 0;
let pendingSelection = null;
const same = (a, b) => a.length === b.length && a.every(id => b.includes(id));
export const isSelectionPending = () => !!pendingSelection;

function syncSelection() {
  if (!shareSelection) return;
  const seq = ++selectionSequence;
  const ids = [...store.selected];
  const nodes = store.node && ids.length === 1 && ids[0] === store.node.documentId ? { documentId: store.node.documentId, nodeIds: store.node.nodeIds } : undefined;
  pendingSelection = { seq, ids };
  shareSelection({ ids, nodes }).then(result => {
    if (seq !== selectionSequence) return;
    pendingSelection = null;
    receiveState(result);
  }).catch(error => {
    if (seq === selectionSequence) pendingSelection = null;
    toast(`Selection could not be shared: ${error.message}`);
  });
}

export function selectArtboards(ids, { additive = false, keepNode = false } = {}) {
  const valid = new Set(documents().map(doc => doc.id));
  const next = new Set(additive ? store.selected : []);
  for (const id of ids) if (valid.has(id)) next.add(id);
  store.selected = next;
  if (!keepNode || (store.node && !next.has(store.node.documentId))) store.node = null;
  emit('selection');
  syncSelection();
}

export function selectNodes(documentId, nodeIds, { reveal = false } = {}) {
  store.node = nodeIds.length ? { documentId, nodeIds: [...new Set(nodeIds)] } : null;
  store.selected = new Set([documentId]);
  emit('selection', { reveal });
  syncSelection();
}

/** Drop selected node IDs that no longer exist (after delete, undo or an agent edit). */
function pruneNodeSelection(model) {
  if (store.node?.documentId !== model.id) return;
  const kept = store.node.nodeIds.filter(id => model.nodes[id]);
  if (kept.length !== store.node.nodeIds.length) selectNodes(model.id, kept);
}

export function receiveState(next) {
  if (!next || !Array.isArray(next.documents) || !Number.isSafeInteger(next.stateVersion) || next.stateVersion < 1) return;
  const previous = store.state;
  if (previous && (next.projectId !== previous.projectId || next.url !== previous.url || next.project?.file !== previous.project?.file || next.stateVersion < previous.stateVersion || Number.isFinite(next.revision) && next.revision < previous.revision)) return;
  const oldSelection = previous?.selection;
  store.state = next;
  if (oldSelection && (next.selection?.revision ?? 0) < (oldSelection.revision ?? 0)) next.selection = oldSelection;
  const ids = Array.isArray(next.selection?.ids) ? next.selection.ids : [];
  // Only the initial host state seeds a local selection; later snapshot reads cannot overwrite the user's view.
  if ((!previous || shareSelection) && (!pendingSelection || same(ids, pendingSelection.ids))) store.selected = new Set(ids);
  store.selected = new Set([...store.selected].filter(id => next.documents.some(doc => doc.id === id)));
  if (!previous && next.selection?.selectedNodes && store.selected.has(next.selection.selectedNodes.documentId)) store.node = next.selection.selectedNodes;
  if (store.node && !store.selected.has(store.node.documentId)) store.node = null;
  for (const id of [...store.models.keys()]) if (!next.documents.some(doc => doc.id === id)) store.models.delete(id);
  for (const id of [...store.leaving]) if (!next.documents.some(doc => doc.id === id)) store.leaving.delete(id);
  emit('state', next);
}

/** Hide frames optimistically while they are deleted; `undo` shows them again. */
export function leave(ids, undo = false) {
  for (const id of ids) { if (undo) store.leaving.delete(id); else store.leaving.add(id); }
  if (!undo) { store.selected = new Set([...store.selected].filter(id => !store.leaving.has(id))); if (store.node && store.leaving.has(store.node.documentId)) store.node = null; }
  if (store.state) emit('state', store.state);
  emit('selection');
}

export function setConnection(value) {
  store.connection = value;
  emit('connection', value);
}

export function viewState(projectId) {
  try { return JSON.parse(localStorage.getItem(`divlet:${projectId}`) || 'null'); } catch { return null; }
}
export function saveViewState(projectId, value) {
  try { localStorage.setItem(`divlet:${projectId}`, JSON.stringify(value)); } catch {}
}
export { clamp };
