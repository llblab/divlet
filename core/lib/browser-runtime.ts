/*
 * Owns: a browser-local project writer — one in-memory accepted state for a `.divlet` project opened in a page, with the same
 * tool-facing behaviour as the Node runtime for reading, frame/project patches, structural edits, frame lifecycle, work marks
 * and guarded Undo/Redo. Excludes: filesystem, watcher, HTTP, static output, fonts, embedded asset bytes, Markdown sites and
 * agent conversation; those stay with the local Node host and are reported as absent capabilities, never emulated.
 *
 * Validation, patch application, operations, component expansion, rendering checks, diffs, acceptance rules and the history
 * line are the shared kernel modules the Node runtime uses. The orchestration below mirrors `runtime.js` step for step;
 * `core/tests/browser-runtime.test.js` runs the same tool sequences through both writers and compares their results.
 * Persistence is a host callback that receives the serialized project after each accepted change.
 */
import { applyDocumentPatch, colourNames, inspectDocument, validateDocument, DivletError, LIMITS } from './model.ts';
import type { DocumentModel } from './model.ts';
import { diffDocuments, matchesPatch, summarizeChange, touchedNodeIds } from './diff.ts';
import { operationPatch } from './ops.ts';
import { HistoryLine } from './history.ts';
import { readProject, writeProject, patchSettings, listComponents, instancesOf, expandFrame } from './project.ts';
import { exportHtml } from './codec.ts';
import type { ProjectSettings } from './project.ts';
import { prepareFrameWith } from './prepare.ts';
import type { FrameCompiler, PreparedFrame } from './prepare.ts';
import { SETTINGS_FIELDS, sameDocument, sameSettings, settingsPatch, assertExpectedVersion, assertExpectedRender } from './acceptance.ts';
import { sameJson } from './validation.ts';
import { runOnRuntime, toolList } from './tools.ts';

const HISTORY_LIMIT = 500;
const UNDO_LIMIT = 200;
const capped = <T>(list: T[], limit = 50): T[] => list.slice(0, limit);
const clone = <T>(value: T): T => structuredClone(value);
function fail(code: string, message: string, details?: unknown): never { throw new DivletError(code, message, details); }
const randomId = (): string => [...globalThis.crypto.getRandomValues(new Uint8Array(12))].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** Tools this writer runs. `open_divlet` belongs to hosts that can open files; `create_frame` is a hidden host route. */
export const BROWSER_TOOLS: readonly string[] = Object.freeze(['read_divlet', 'patch_divlet', 'edit_divlet', 'frame_divlet', 'undo_divlet', 'mark_divlet']);

interface Entry extends PreparedFrame { render: number; savedVersion: number }
type Listener = (type: 'state' | 'change', value: unknown) => void;

export interface BrowserRuntimeOptions {
  /** The project source (`.divlet` JSON text or the parsed object). */
  readonly source: unknown;
  /** A label for the project, shown where the Node host shows its file path. Never a filesystem path. */
  readonly file: string;
  /** A stable identifier for this browser copy of the project. */
  readonly projectId: string;
  readonly compiler: FrameCompiler;
  /** Called after every accepted change with the serialized project; a rejection is reported as a diagnostic, never retried. */
  readonly persist?: (text: string) => Promise<void> | void;
  /** Capabilities the composition adds (for example `captureFonts: false`); merged into `project.capabilities`. */
  readonly capabilities?: Record<string, unknown>;
}

export class BrowserRuntime {
  #historyLine = new HistoryLine(randomId);
  #listeners = new Set<Listener>();
  #queue: Promise<unknown> = Promise.resolve();
  #persist: BrowserRuntimeOptions['persist'];
  #compiler: FrameCompiler;
  #stateKey = '';
  #capabilities: Record<string, unknown>;
  readonly file: string;
  readonly projectId: string;
  settings!: ProjectSettings;
  documents = new Map<string, Entry>();
  diagnostics = new Map<string, any>();
  observations = new Map<string, any>();
  selection: { ids: string[]; revision: number; selectedNodes?: any } = { ids: [], revision: 0 };
  revision = 0;
  stateVersion = 0;
  renderSeq = 0;
  history: any[] = [];
  seq = 0;
  undoStack: any[] = [];
  redoStack: any[] = [];
  groupCounter = 0;
  work: any[] = [];
  /** `conversation: false`: this host relays no board requests; agents reach it through its MCP tools. */
  agent: { connected: boolean; busy: boolean; activity: string | null; since: string | null; queued: number; conversation: false } = { connected: false, busy: false, activity: null, since: null, queued: 0, conversation: false };
  closed = false;
  url = '';

  private constructor(options: BrowserRuntimeOptions) {
    this.file = options.file;
    this.projectId = options.projectId;
    this.#compiler = options.compiler;
    this.#persist = options.persist;
    this.#capabilities = options.capabilities ?? {};
  }

  /** Validate and render a project source; any invalid frame refuses the whole open (there is no last working state yet). */
  static async open(options: BrowserRuntimeOptions): Promise<BrowserRuntime> {
    const runtime = new BrowserRuntime(options);
    const source = typeof options.source === 'string' ? JSON.parse(options.source) : options.source;
    const { settings, frames } = readProject(source);
    const lookup = new Map(frames.map(frame => [frame.id, frame]));
    const prepared = await runtime.prepareAll(frames.map(frame => frame.id), lookup, settings);
    runtime.settings = settings;
    runtime.documents = new Map([...prepared].map(([id, item]) => [id, runtime.entryFor(item)]));
    runtime.revision = 1; // as the Node host after loading its source
    return runtime;
  }

  /* ---- events (the board's read session subscribes here) ----------------------------------------- */

  subscribe(listener: Listener): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #emit(type: 'state' | 'change', value: unknown) { for (const listener of [...this.#listeners]) { try { listener(type, value); } catch { /* a view cannot break the writer */ } } }
  publish() { this.#emit('state', this.info()); }

  newGroup() { return `g${++this.groupCounter}`; }

  enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    if (this.closed) return Promise.reject(new DivletError('CLOSED', 'The divlet runtime has closed.'));
    const result = this.#queue.then(() => { if (this.closed) fail('CLOSED', 'The divlet runtime has closed.'); return task(); });
    this.#queue = result.catch(() => {});
    return result;
  }

  /* ---- state ---------------------------------------------------------------------------------------- */

  usedBy(id: string, entries: Map<string, Entry> = this.documents): string[] {
    return [...entries.values()].filter(entry => entry.document.id !== id && entry.uses.some(key => key.startsWith(`${id}/`))).map(entry => entry.document.id);
  }

  describe(entry: Entry) {
    const { document } = entry;
    return {
      id: document.id, name: document.name, version: document.version, render: entry.render, savedVersion: entry.savedVersion,
      artboard: document.artboard, metadata: document.metadata,
      components: Object.values(document.nodes).filter((node: any) => node.type === 'element' && node.reusable).map(node => node.id),
      instances: Object.values(document.nodes).filter(node => node.type === 'ref').length,
      uses: entry.uses, usedBy: this.usedBy(document.id),
    };
  }

  historyHead() {
    return { seq: this.seq, pointId: this.#historyLine.currentId, navigation: true, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0, undoLabel: this.undoStack.at(-1)?.label ?? null, redoLabel: this.redoStack.at(-1)?.label ?? null };
  }

  info() {
    const state = {
      projectId: this.projectId,
      url: this.url,
      revision: this.revision,
      project: {
        file: this.file, format: 'divlet',
        capabilities: { properties: true, settings: false, frames: true, saveAs: false, ...this.#capabilities },
        name: this.settings.name, version: this.settings.version, tokens: this.settings.tokens, css: this.settings.css, metadata: this.settings.metadata, outputDir: this.settings.outputDir, resources: [],
      },
      documents: [...this.documents.values()].map(entry => this.describe(entry)),
      diagnostics: [...this.diagnostics.values()],
      selection: clone(this.selection),
      history: this.historyHead(),
      clients: 0,
      agent: { ...this.agent },
      work: clone(this.work),
      site: null,
      clientPlugins: [],
    };
    const key = JSON.stringify(state);
    if (key !== this.#stateKey) { this.#stateKey = key; this.stateVersion++; }
    return { ...state, stateVersion: this.stateVersion };
  }

  getEntry(id: unknown): Entry {
    const entry = typeof id === 'string' ? this.documents.get(id) : undefined;
    if (!entry) fail('NOT_FOUND', `Unknown frame: ${id}. read_divlet view:project lists the frames.`);
    return entry;
  }

  components() {
    const frames = [...this.documents.values()].map(entry => entry.document);
    const usage = new Map<string, string[]>();
    for (const frame of frames) for (const instance of instancesOf(frame)) {
      const key = `${instance.frame}/${instance.node}`;
      if (!usage.has(key)) usage.set(key, []);
      usage.get(key)!.push(`${frame.id}/${instance.id}`);
    }
    return listComponents(frames).map(component => ({ ...component, instances: usage.get(component.ref) ?? [] }));
  }

  readTimeline() { return this.#historyLine.snapshot(this.undoStack, this.redoStack); }

  readHistory({ since = 0, limit = 50, documentId, actor }: any = {}) {
    if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail('INVALID_QUERY', 'since must be ≥ 0 and limit 1–500.');
    let changes = this.history.filter(change => change.seq > since && (!documentId || change.documentId === documentId) && (!actor || change.actor === actor));
    const truncated = changes.length > limit;
    changes = changes.slice(-limit);
    return { ...this.historyHead(), timeline: this.readTimeline(), truncated, changes: clone(changes) };
  }

  read({ view = 'project', documentId, ids, query, depth, limit, route, since }: any = {}) {
    if (view === 'project') return this.info();
    if (view === 'components') return { projectVersion: this.settings.version, components: this.components() };
    if (view === 'history') return this.readHistory({ since: since ?? undefined, limit: limit ?? undefined, documentId });
    if (view === 'selection') return { projectRevision: this.revision, selection: clone(this.selection) };
    if (view === 'diagnostics') return { revision: this.revision, diagnostics: [...this.diagnostics.values()] };
    if (view === 'site') { void route; fail('NO_SITE', 'This project has no Markdown site in the browser host.'); }
    const entry = this.getEntry(documentId || this.selection.ids[0] || this.documents.keys().next().value);
    if (view === 'document' || view === 'frame') return clone(entry.document);
    if (view === 'nodes') return { documentId: entry.document.id, version: entry.document.version, nodes: inspectDocument(entry.document, { ids, query, depth, limit }, { limits: LIMITS }) };
    if (view === 'preview') return { documentId: entry.document.id, version: entry.document.version, observation: clone(this.observations.get(entry.document.id) || null) };
    fail('INVALID_VIEW', `Unknown read view: ${view}`);
  }

  /** The preview page of one frame (no bridge: the composition injects its own preview channel). */
  render(id: string) {
    const entry = this.getEntry(id);
    return { documentId: id, version: entry.document.version, render: entry.render, html: entry.html };
  }

  /** Clean standalone HTML of a frame or of some of its nodes, as the Node host exports it (no embedded assets here). */
  exportDocument(id: string, { nodeId, nodeIds, expectedVersion, expectedProjectVersion }: any = {}) {
    const entry = this.getEntry(id);
    assertExpectedVersion(expectedVersion, entry.document);
    assertExpectedVersion(expectedProjectVersion, this.settings, 'project');
    const expanded = expandFrame(entry.document, frameId => this.documents.get(frameId)?.document, this.settings).document;
    if (nodeId || nodeIds !== undefined) {
      const ids = nodeIds ?? [nodeId];
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(node => typeof node !== 'string' || !Object.hasOwn(entry.document.nodes, node))) fail('NOT_FOUND', 'Export requires existing node IDs in one frame.');
      return { documentId: id, version: entry.document.version, ...(nodeId ? { nodeId } : { nodeIds: ids }), html: ids.map((item: string) => exportHtml(expanded, { nodeId: item, limits: LIMITS })).join('\n') };
    }
    const compiled = /<style data-divlet-compiled>([\s\S]*?)<\/style>/.exec(entry.html)?.[1] ?? '';
    return { documentId: id, version: entry.document.version, html: exportHtml(expanded, { compiledCss: compiled, limits: LIMITS }), fileName: `${id}.html` };
  }

  /** The serialized project, as the Node host would write it to its `.divlet` file. */
  source(): string { return writeProject(this.settings, [...this.documents.values()].map(entry => entry.document)); }

  /* ---- preparation ------------------------------------------------------------------------------- */

  prepare(input: unknown, { frames, settings = this.settings }: { frames?: Map<string, DocumentModel>; settings?: ProjectSettings } = {}) {
    return prepareFrameWith(input, { lookup: id => frames ? frames.get(id) : this.documents.get(id)?.document, settings, limits: LIMITS, compiler: this.#compiler });
  }

  entryFor(prepared: PreparedFrame, previous?: Entry): Entry {
    return { ...(previous || {}), ...prepared, savedVersion: prepared.document.version, render: previous && previous.html === prepared.html ? previous.render : ++this.renderSeq };
  }

  dependentsOf(ids: string[], entries = this.documents): string[] {
    const out = new Set<string>();
    for (const id of ids) for (const other of this.usedBy(id, entries)) if (!ids.includes(other)) out.add(other);
    return [...out];
  }

  async prepareAll(ids: string[], frames: Map<string, DocumentModel>, settings: ProjectSettings): Promise<Map<string, PreparedFrame>> {
    const prepared = new Map<string, PreparedFrame>();
    for (const id of ids) {
      try { prepared.set(id, await this.prepare(frames.get(id), { frames, settings })); }
      catch (error: any) { throw new DivletError(error.code || 'INVALID_DOCUMENT', `Frame ${id}: ${error.message}`, error.details); }
    }
    return prepared;
  }

  /** Persist the candidate through the host. A failing store keeps the accepted state and reports a diagnostic. */
  async persist(next: Map<string, Entry>, settings: ProjectSettings) {
    const text = writeProject(settings, [...next.values()].map(entry => entry.document));
    if (!this.#persist) return;
    try { await this.#persist(text); this.diagnostics.delete('storage'); }
    catch (error: any) { this.diagnostics.set('storage', { path: 'storage', code: 'STORAGE_FAILED', message: `The browser could not store this project: ${error?.message || error}`, at: new Date().toISOString() }); }
  }

  /* ---- history ------------------------------------------------------------------------------------ */

  record({ actor = 'agent', kind = 'patch', documentId, name, fromVersion, toVersion, group, label, from, to, text }: any) {
    const summary: any = from && to ? summarizeChange(from, to) : { fields: [], artboard: {}, nodes: { added: [], removed: [], changed: {} }, touched: 0, text: kind };
    if (text) summary.text = text;
    const change: any = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      actor, kind, documentId, name: name ?? to?.name ?? from?.name, fromVersion, toVersion,
      group: group ?? null, label: label ?? null,
      summary: summary.text,
      fields: summary.fields,
      artboard: summary.artboard,
      nodes: { added: capped(summary.nodes.added), removed: capped(summary.nodes.removed), changed: Object.fromEntries(Object.entries(summary.nodes.changed).slice(0, 50)) },
      touched: capped(touchedNodeIds(summary)),
    };
    if (documentId && this.documents.has(documentId)) change.render = this.documents.get(documentId)!.render;
    this.history.push(change);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.#emit('change', change);
    return change;
  }

  pushUndo(entry: any, { seq = this.seq, firstSeq = seq }: { seq?: number; firstSeq?: number } = {}) {
    const top = this.undoStack.at(-1);
    const merged = !!entry.group && top?.group === entry.group;
    if (merged) { top.items.push(...entry.items); if (entry.label) top.label = entry.label; }
    else this.undoStack.push(entry);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    const accepted = merged ? top : entry;
    this.#historyLine.accept(accepted, { seq, firstSeq, label: accepted.label }, merged);
  }

  /* ---- writes ------------------------------------------------------------------------------------- */

  create({ document, actor = 'agent', group, label, undoable = true }: any) {
    return this.enqueue(() => this._create({ document, actor, group, label, undoable }));
  }

  async _create({ document, actor, group, label, undoable, kind = 'create', text }: any) {
    const candidate = validateDocument(document);
    if (this.documents.has(candidate.id)) fail('ALREADY_EXISTS', `Frame ${candidate.id} already exists.`);
    const frames = new Map([...this.documents].map(([id, entry]) => [id, entry.document]));
    frames.set(candidate.id, candidate);
    const prepared = await this.prepare(candidate, { frames });
    const id = prepared.document.id;
    const next = new Map(this.documents);
    next.set(id, this.entryFor(prepared));
    await this.persist(next, this.settings);
    this.documents = next;
    this.revision++;
    const entry = next.get(id)!;
    const count = Object.keys(entry.document.nodes).length;
    const change = this.record({ actor, kind, documentId: id, toVersion: entry.document.version, group, label, to: entry.document, from: { ...entry.document, nodes: {} }, text: text ?? `${kind === 'create' ? 'created' : 'restored'} “${entry.document.name}” · ${count} node${count === 1 ? '' : 's'}` });
    if (undoable) this.pushUndo({ group: group ?? this.newGroup(), label: label ?? `create ${entry.document.name}`, items: [{ type: 'create', documentId: id, index: next.size - 1, document: clone(entry.document) }] }, { seq: change.seq });
    else this.#historyLine.reset({ seq: change.seq, label: change.summary });
    this.publish();
    return { documentId: id, version: entry.document.version, render: entry.render, revision: this.revision, seq: change.seq, saved: true };
  }

  async _remove(documentId: string, { actor, group, label, expectedVersion, undoable = true, kind = 'delete' }: any) {
    const entry = this.getEntry(documentId);
    assertExpectedVersion(expectedVersion, entry.document);
    const users = this.usedBy(documentId);
    if (users.length) fail('COMPONENT_IN_USE', `“${entry.document.name}” has components used by ${users.join(', ')}. Detach or replace those instances first.`, { usedBy: users });
    const index = [...this.documents.keys()].indexOf(documentId);
    const next = new Map(this.documents);
    next.delete(documentId);
    await this.persist(next, this.settings);
    this.documents = next;
    this.work = this.work.filter(item => item.documentId !== documentId);
    this.observations.delete(documentId);
    this.selection = { ...this.selection, ids: this.selection.ids.filter(id => id !== documentId), revision: this.selection.revision + 1 };
    delete this.selection.selectedNodes;
    this.revision++;
    const change = this.record({ actor, kind, documentId, name: entry.document.name, fromVersion: entry.document.version, group, label, from: entry.document, to: { ...entry.document, nodes: {} }, text: `removed “${entry.document.name}”` });
    if (undoable) this.pushUndo({ group: group ?? this.newGroup(), label: label ?? `delete ${entry.document.name}`, items: [{ type: 'delete', documentId, index, document: clone(entry.document) }] }, { seq: change.seq });
    else this.#historyLine.reset({ seq: change.seq, label: change.summary });
    this.publish();
    return { documentId, seq: change.seq, revision: this.revision };
  }

  patch({ documentId, expectedVersion, expectedRender, patch, actor = 'agent', group, label, undoable = true }: any) {
    return this.enqueue(() => this._patch({ documentId, expectedVersion, expectedRender, patch, actor, group, label, undoable }));
  }

  async _patch({ documentId, expectedVersion, expectedRender, patch, actor = 'agent', group, label, undoable = true, kind = 'patch' }: any) {
    const previous = this.getEntry(documentId);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== previous.document.version) fail('REVISION_CONFLICT', `Expected frame version ${previous.document.version}; received ${expectedVersion}. Read the frame again and rebuild the change.`, { actualVersion: previous.document.version });
    assertExpectedRender(expectedRender, previous);
    const candidate = applyDocumentPatch(previous.document, patch, { colourNames: colourNames(this.settings.tokens, previous.document.tokens) });
    candidate.version = previous.document.version + 1;
    if (sameDocument(candidate, previous.document)) {
      return { documentId, version: previous.document.version, render: previous.render, revision: this.revision, seq: null, summary: 'no change', changedNodeIds: [], rerendered: [], saved: false };
    }
    const frames = new Map([...this.documents].map(([id, entry]) => [id, entry.document]));
    frames.set(documentId, candidate);
    const dependents = this.dependentsOf([documentId]);
    const prepared = await this.prepareAll([documentId, ...dependents], frames, this.settings);
    const next = new Map(this.documents);
    for (const [id, item] of prepared) next.set(id, this.entryFor(item, this.documents.get(id)));
    await this.persist(next, this.settings);
    this.documents = next;
    const entry = next.get(documentId)!;
    this.revision++;
    const change = this.record({ actor, kind, documentId, fromVersion: previous.document.version, toVersion: entry.document.version, group, label, from: previous.document, to: entry.document });
    if (undoable && change.summary !== 'no change') {
      this.pushUndo({ group: group ?? this.newGroup(), label: label ?? change.summary, items: [{ type: 'patch', documentId, inverse: diffDocuments(entry.document, previous.document), forward: diffDocuments(previous.document, entry.document) }] }, { seq: change.seq });
    } else this.#historyLine.reset({ seq: change.seq, label: change.summary });
    this.publish();
    const nodeIds = new Set([...Object.keys(previous.document.nodes), ...Object.keys(entry.document.nodes)]);
    const changedNodeIds = [...nodeIds].filter(id => !sameJson(previous.document.nodes[id], entry.document.nodes[id]));
    const dead = changedNodeIds.filter(id => entry.unknown[id]?.length).map(id => `#${id}: ${entry.unknown[id]!.join(' ')}`);
    const warnings = dead.length ? [`Classes this browser host does not style (no compiled utility, no css rule): ${dead.slice(0, 8).join('; ')}${dead.length > 8 ? ` +${dead.length - 8} nodes` : ''}. Utility compilation needs the local divlet host; use the frame css or inline style here.`] : [];
    return { documentId, version: entry.document.version, render: entry.render, revision: this.revision, seq: change.seq, summary: change.summary, changedNodeIds, rerendered: dependents, saved: true, ...(warnings.length ? { warnings } : {}) };
  }

  patchProject({ expectedVersion, patch, actor = 'agent', group, label, undoable = true }: any) {
    return this.enqueue(() => this._patchProject({ expectedVersion, patch, actor, group, label, undoable }));
  }

  async _patchProject({ expectedVersion, patch, actor = 'agent', group, label, undoable = true, kind = 'patch' }: any) {
    if (!Number.isInteger(expectedVersion) || expectedVersion !== this.settings.version) fail('REVISION_CONFLICT', `Expected project version ${this.settings.version}; received ${expectedVersion}. Read the project again.`, { actualVersion: this.settings.version });
    if (patch && typeof patch === 'object' && Object.hasOwn(patch, 'assets') && patch.assets !== null) fail('ASSETS_UNAVAILABLE', 'Embedded assets need the local divlet host: this browser build does not decode project asset bytes.');
    const previous = this.settings;
    const settings = { ...patchSettings(previous, patch), version: previous.version + 1 };
    const frames = new Map([...this.documents].map(([id, entry]) => [id, entry.document]));
    const prepared = await this.prepareAll([...frames.keys()], frames, settings);
    const next = new Map(this.documents);
    for (const [id, item] of prepared) next.set(id, this.entryFor(item, this.documents.get(id)));
    await this.persist(next, settings);
    this.documents = next;
    this.settings = settings;
    this.revision++;
    const fields = SETTINGS_FIELDS.filter(key => !sameJson((previous as any)[key], (settings as any)[key]));
    const change = this.record({ actor, kind, documentId: null, name: settings.name, group, label, text: fields.length ? `project ${fields.join(', ')}` : 'no change' });
    if (undoable && fields.length) this.pushUndo({ group: group ?? this.newGroup(), label: label ?? `project ${fields.join(', ')}`, items: [{ type: 'project', inverse: settingsPatch(settings, previous), forward: settingsPatch(previous, settings) }] }, { seq: change.seq });
    else if (fields.length) this.#historyLine.reset({ seq: change.seq, label: change.summary });
    this.publish();
    return { project: true, version: settings.version, revision: this.revision, seq: change.seq, summary: change.summary, saved: true };
  }

  edit({ documentId, expectedVersion, expectedRender, op, actor = 'user', group, label }: any) {
    return this.enqueue(async () => {
      const entry = this.getEntry(documentId);
      if (expectedVersion !== entry.document.version) fail('REVISION_CONFLICT', `Expected frame version ${entry.document.version}; received ${expectedVersion}. Read the frame again.`, { actualVersion: entry.document.version });
      const { patch, ids, removed } = operationPatch(entry.document, op, { frame: id => this.documents.get(id)?.document, usedBy: this.usedBy(documentId) }) as any;
      const subject = (op.ids ?? [op.id ?? ids?.[0]]).filter(Boolean);
      const verb = ({ remove: 'delete', duplicate: 'duplicate', move: 'move', insert: 'add', text: 'edit text of', wrap: 'wrap', unwrap: 'unwrap', detach: 'detach', rename: 'rename' } as Record<string, string>)[op.type] ?? op.type;
      const result = await this._patch({ documentId, expectedVersion, expectedRender, patch, actor, group, label: label ?? `${verb} ${subject.slice(0, 3).join(', ')}${subject.length > 3 ? ` +${subject.length - 3}` : ''}`.trim() });
      return { ...result, ids: ids ?? [], removed: removed ?? [] };
    });
  }

  freeSpot(rect: any, gap = 80, extra: any[] = []) {
    const others = [...this.documents.values()].map(entry => entry.document.artboard).concat(extra);
    let next = { ...rect };
    for (let attempt = 0; attempt < 500; attempt++) {
      const hit = others.find(o => next.x < o.x + o.width + gap && next.x + next.width + gap > o.x && next.y < o.y + o.height + gap && next.y + next.height + gap > o.y);
      if (!hit) return next;
      next = { ...next, x: hit.x + hit.width + gap };
    }
    return next;
  }

  createArtboard({ name, width, height, x, y, from, expectedVersion, actor = 'user', group, label }: any = {}) {
    return this.enqueue(async () => {
      const taken = new Set(this.documents.keys());
      const slug = String(name || (from ? `${this.getEntry(from).document.name} copy` : 'artboard')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '') || 'artboard';
      let id = slug;
      for (let n = 2; taken.has(id); n++) id = `${slug}-${n}`;
      let document: any;
      if (from) {
        assertExpectedVersion(expectedVersion, this.getEntry(from).document, 'duplicated frame');
        const source: any = clone(this.getEntry(from).document);
        const proposed = { ...source.artboard, x: x ?? source.artboard.x + source.artboard.width + 80, y: y ?? source.artboard.y };
        for (const node of Object.values(source.nodes) as any[]) {
          if (node.type === 'element' && node.reusable) delete node.reusable;
          if (node.type === 'ref' && !node.ref.includes('/')) node.ref = `${from}/${node.ref}`;
        }
        if (width != null) proposed.width = width;
        if (height != null) proposed.height = height;
        document = { ...source, id, name: name || `${source.name} copy`, version: 1, artboard: x == null && y == null ? this.freeSpot(proposed) : proposed };
      } else {
        const rightmost = [...this.documents.values()].reduce((max, entry) => Math.max(max, entry.document.artboard.x + entry.document.artboard.width), -Infinity);
        const top = [...this.documents.values()].reduce((min, entry) => Math.min(min, entry.document.artboard.y), Infinity);
        document = {
          schemaVersion: 1, id, name: name || 'Untitled', version: 1,
          artboard: x != null && y != null ? { x, y, width: width ?? 1280, height: height ?? 800 } : this.freeSpot({ x: x ?? (Number.isFinite(rightmost) ? rightmost + 80 : 80), y: y ?? (Number.isFinite(top) ? top : 100), width: width ?? 1280, height: height ?? 800 }),
          rootId: 'root', tokens: {}, css: '', metadata: {},
          nodes: { root: { id: 'root', type: 'element', tag: 'main', className: 'min-h-screen p-8', attrs: {}, style: {}, metadata: {}, children: [] } },
        };
      }
      return this._create({ document, actor, group, label: label ?? `create ${document.name}`, undoable: true });
    });
  }

  removeDocument({ documentId, expectedVersion, actor = 'user', group, label }: any) {
    return this.enqueue(() => this._remove(documentId, { expectedVersion, actor, group, label }));
  }

  async _applyEntry(entry: any, direction: 'undo' | 'redo', actor: string) {
    const undoing = direction === 'undo';
    const items = undoing ? [...entry.items].reverse() : entry.items;
    const previous = this.documents;
    const previousSettings = this.settings;
    let frames = new Map([...previous].map(([id, item]) => [id, item.document as any]));
    let settings: any = previousSettings;
    let prepared: Map<string, PreparedFrame>;
    try {
      for (const item of items) {
        const change = undoing ? item.inverse : item.forward;
        const expected = undoing ? item.forward : item.inverse;
        if (item.type === 'patch') {
          const current = frames.get(item.documentId);
          if (!current || !matchesPatch(current, expected, change)) fail('CANNOT_UNDO', 'Later changes touched the same content.');
          frames.set(item.documentId, { ...applyDocumentPatch(current, change), version: current.version + 1 });
        } else if (item.type === 'project') {
          if (!matchesPatch({ ...settings, outputDir: settings.outputDir ?? undefined }, expected, change)) fail('CANNOT_UNDO', 'Later changes touched the same project fields.');
          settings = patchSettings(settings, change);
        } else if ((item.type === 'create') === undoing) {
          const current = frames.get(item.documentId);
          if (!current || !sameDocument(current, item.document)) fail('CANNOT_UNDO', `Frame ${item.documentId} has changed since this step.`);
          frames.delete(item.documentId);
        } else {
          if (frames.has(item.documentId)) fail('CANNOT_UNDO', `Frame ${item.documentId} already exists.`);
          const ordered = [...frames];
          ordered.splice(item.index ?? ordered.length, 0, [item.documentId, item.document]);
          frames = new Map(ordered);
        }
      }
      for (const [id, frame] of frames) {
        const current = previous.get(id)?.document;
        if (current) frames.set(id, sameDocument(current, frame) ? current : { ...frame, version: current.version + 1 });
      }
      settings = { ...settings, version: previousSettings.version + (sameSettings(previousSettings, settings) ? 0 : 1) };
      prepared = await this.prepareAll([...frames.keys()], frames, settings);
    } catch (error: any) {
      fail('CANNOT_UNDO', `This step no longer applies cleanly (${error.message}).`);
    }
    const next = new Map([...prepared].map(([id, item]) => [id, this.entryFor(item, previous.get(id))]));
    const removed = [...previous.keys()].filter(id => !next.has(id));
    await this.persist(next, settings);
    this.documents = next;
    this.settings = settings;
    this.work = this.work.filter(item => next.has(item.documentId));
    for (const id of removed) this.observations.delete(id);
    if (removed.length) {
      this.selection = { ...this.selection, ids: this.selection.ids.filter(id => next.has(id)), revision: this.selection.revision + 1 };
      if (this.selection.selectedNodes && !next.has(this.selection.selectedNodes.documentId)) delete this.selection.selectedNodes;
    }
    this.revision++;
    const group = this.newGroup();
    const meta = { actor, group, kind: direction, label: entry.label };
    if (!sameSettings(previousSettings, settings)) this.record({ ...meta, documentId: null, name: settings.name, text: `project ${SETTINGS_FIELDS.filter(key => !sameJson((previousSettings as any)[key], settings[key])).join(', ')}` });
    for (const [id, current] of next) {
      const from = previous.get(id)?.document;
      const to = current.document;
      if (from && sameDocument(from, to)) continue;
      this.record({ ...meta, documentId: id, fromVersion: from?.version, toVersion: to.version, from: from ?? { ...to, nodes: {} }, to });
    }
    for (const id of removed) {
      const from = previous.get(id)!.document;
      this.record({ ...meta, documentId: id, name: from.name, fromVersion: from.version, from, to: { ...from, nodes: {} }, text: `removed “${from.name}”` });
    }
  }

  async _replay(from: any[], to: any[], direction: 'undo' | 'redo', { documentId, actor = 'user', steps = 1 }: any = {}) {
    if (!Number.isInteger(steps) || steps < 1 || steps > UNDO_LIMIT) fail('INVALID_QUERY', `steps must be an integer from 1 to ${UNDO_LIMIT}.`);
    const indexes: number[] = [];
    for (let i = from.length - 1; i >= 0 && indexes.length < steps; i--) if (!documentId || from[i].items.some((item: any) => item.documentId === documentId || item.documentIds?.includes(documentId))) indexes.push(i);
    if (indexes.length < steps) fail('NOTHING_TO_UNDO', steps === 1 ? `Nothing to ${direction}.` : `Not enough history to ${direction} ${steps} steps.`);
    const entries = indexes.map(index => from[index]);
    const label = steps === 1 ? entries[0].label : `${direction} ${steps} steps`;
    const seq = this.seq;
    const ordered = direction === 'undo' ? [...entries].reverse() : entries;
    await this._applyEntry({ label, items: ordered.flatMap(entry => entry.items) }, direction, actor);
    for (const index of indexes) from.splice(index, 1);
    to.push(...entries);
    this.#historyLine.move(entries, direction, { seq: this.seq > seq ? this.seq : null, firstSeq: this.seq > seq ? seq + 1 : null, label });
    this.publish();
    return { ...this.historyHead(), label };
  }

  navigateHistory(options: any) {
    return this.enqueue(async () => {
      const { pointId, expectedPoint, actor = 'user' } = options ?? {};
      if (typeof pointId !== 'string' || !pointId || typeof expectedPoint !== 'string' || !expectedPoint) fail('INVALID_QUERY', 'pointId and expectedPoint must be nonempty state point IDs.');
      const timeline = this.readTimeline();
      if (expectedPoint !== timeline.current) fail('HISTORY_CONFLICT', 'History changed since it was read. Read the current timeline before navigating.');
      const index = timeline.points.findIndex(point => point.id === pointId);
      if (index < 0) fail('HISTORY_POINT_UNAVAILABLE', 'That state point is no longer on the retained current history segment.');
      const delta = index - timeline.index;
      if (!delta) return { ...this.historyHead(), changed: false };
      const direction = delta < 0 ? 'undo' : 'redo';
      const from = delta < 0 ? this.undoStack : this.redoStack, to = delta < 0 ? this.redoStack : this.undoStack;
      return { ...await this._replay(from, to, direction, { actor, steps: Math.abs(delta) }), changed: true };
    });
  }

  undo(options?: any) { return this.enqueue(() => this._replay(this.undoStack, this.redoStack, 'undo', options)); }
  redo(options?: any) { return this.enqueue(() => this._replay(this.redoStack, this.undoStack, 'redo', options)); }

  /* ---- view state ------------------------------------------------------------------------------- */

  markWork({ documentId, nodeIds = [], note, add = false }: any = {}) {
    const entry = this.getEntry(documentId);
    const ids = [...new Set((Array.isArray(nodeIds) ? nodeIds : [nodeIds]).filter((id: unknown) => typeof id === 'string'))].slice(0, 50) as string[];
    const unknown = ids.filter(id => !Object.hasOwn(entry.document.nodes, id));
    if (unknown.length) fail('NOT_FOUND', `Frame ${documentId} has no node ${unknown.slice(0, 5).join(', ')}. Read the frame for node IDs, or omit nodeIds to mark the whole frame.`);
    const text = typeof note === 'string' ? note.trim().slice(0, 120) : '';
    const area = { documentId, nodeIds: ids, ...(text ? { note: text } : {}), at: new Date().toISOString() };
    const kept = add ? this.work.filter(item => !(item.documentId === documentId && sameJson(item.nodeIds, ids))) : [];
    this.work = [...kept, area].slice(-10);
    this.publish();
    return { marked: area, work: this.work.length };
  }

  clearWork({ documentId }: any = {}) {
    const before = this.work.length;
    this.work = documentId ? this.work.filter(item => item.documentId !== documentId) : [];
    if (this.work.length !== before) this.publish();
    return { cleared: before - this.work.length };
  }

  setSelection({ ids, nodes }: any) {
    if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string')) fail('INVALID_SELECTION', 'Selection must be a list of document IDs.');
    const next: any = { ids: [...new Set(ids.filter((id: string) => this.documents.has(id)))], revision: this.selection.revision + 1 };
    if (nodes) {
      if (!Array.isArray(nodes.nodeIds) || nodes.nodeIds.length > 100 || nodes.nodeIds.some((id: unknown) => typeof id !== 'string')) fail('INVALID_SELECTION', 'Selected nodes must be a list of node IDs.');
      const entry = this.documents.get(nodes.documentId);
      const alive = entry && next.ids.length === 1 && next.ids[0] === nodes.documentId ? nodes.nodeIds.filter((id: string) => entry.document.nodes[id]) : [];
      if (alive.length) next.selectedNodes = { documentId: nodes.documentId, nodeIds: [...new Set(alive)], version: entry!.document.version };
    }
    this.selection = next;
    this.publish();
    return this.info();
  }

  setObservations({ documentId, version, nodes, contentHeight, scrollHeight }: any) {
    const entry = this.getEntry(documentId);
    if (version !== entry.render) fail('STALE_PREVIEW', 'Ignoring observations from an older render of this frame.');
    if (!Array.isArray(nodes) || nodes.length > 300) fail('INVALID_OBSERVATIONS', 'Expected at most 300 observed nodes.');
    const clean = nodes.map((node: any) => {
      if (!node || !entry.document.nodes[node.id] || !node.rect || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(node.rect[key]) || Math.abs(node.rect[key]) > 1e7) || node.rect.width < 0 || node.rect.height < 0) fail('INVALID_OBSERVATIONS', 'Invalid observed node geometry.');
      return { id: node.id, rect: { x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height }, overflowX: !!node.overflowX, overflowY: !!node.overflowY };
    });
    const page: Record<string, number> = {};
    for (const [key, value] of Object.entries({ contentHeight, scrollHeight })) if (Number.isFinite(value) && (value as number) >= 0 && (value as number) < 1e7) page[key] = Math.round(value as number);
    this.observations.set(documentId, { documentId, version: entry.document.version, render: entry.render, viewport: { width: entry.document.artboard.width, height: entry.document.artboard.height }, ...page, nodes: clean, receivedAt: new Date().toISOString() });
    return { ok: true };
  }

  /**
   * What the board shows about an agent working through this page. Unlike the Node host, an idle agent keeps its work marks:
   * stateless MCP calls carry no turn boundary, so marks end only by `mark_divlet { clear: true }` or replacement.
   */
  setAgent(patch: Partial<BrowserRuntime['agent']> = {}) {
    const next = { ...this.agent, ...patch };
    if (next.busy && !this.agent.busy) next.since = new Date().toISOString();
    if (!next.busy) { next.since = null; next.activity = null; next.queued = 0; }
    if (sameJson(next, this.agent)) return this.agent;
    this.agent = next;
    this.publish();
    return this.agent;
  }

  /** Run one shared contract tool against this writer (the same `run` Pi, MCP and the CLI use). */
  async callTool(name: string, args: unknown) {
    if (!BROWSER_TOOLS.includes(name)) fail('UNKNOWN_TOOL', `The browser host does not run ${name}.`);
    return runOnRuntime(name, args, this as any);
  }

  /** The shared tool descriptions this writer runs. */
  tools() { return toolList().filter(tool => BROWSER_TOOLS.includes(tool.name)); }

  async close() { await this.#queue; this.closed = true; this.#listeners.clear(); }
}
