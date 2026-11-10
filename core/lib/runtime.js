import { EventEmitter } from 'node:events';

import { createHash, randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { prepareFrame, frameMetadata } from './render.ts';
import { applyDocumentPatch, colourNames, inspectDocument, DivletError, validateDocument, SOURCE_LIMITS, LIMITS } from './model.ts';
import { exportHtml } from './codec.ts';
import { importerFor, pageExtensions } from './plugins.ts';
import { startServer } from './server.ts';
import { registerBoard, unregisterBoard } from './boards.ts';
import { buildSite } from './site.ts';
import { diffDocuments, diffValue, matchesPatch, summarizeChange, touchedNodeIds } from './diff.ts';
import { operationPatch } from './ops.ts';
import { expandPath, inspectPath, initProject, resolveProject, isProjectFile } from './projects.ts';
import { OutputStore, safeDirectory } from './output.ts';
import { buildStatic, readResourceBytes, normalizeExternalFiles } from './static.js';
import { readProject, writeProject, validateSettings, patchSettings, expandFrame, listComponents, instancesOf } from './project.ts';
import { importStatus, importAgain } from './import.ts';
import { clientPlugins, customClasses, explainClasses, suggestClasses, warmSuggestions } from './engine.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROJECT_FILE = 'project.divlet';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PROJECT_BYTES = SOURCE_LIMITS.bytes;
const MAX_ASSET_BYTES = 12 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const MAX_ASK = 4000;
const MAX_REPLY = 6000;
const HISTORY_LIMIT = 500;
const UNDO_LIMIT = 200;
const SETTINGS_FIELDS = ['name', 'tokens', 'css', 'metadata', 'outputDir'];
const capped = (list, limit = 50) => list.slice(0, limit);
const digest = value => createHash('sha256').update(value).digest('hex');
const hashOf = text => (text === null || text === undefined ? null : digest(text));
const imageUpload = (name, data) => {
  const extension = path.extname(String(name || '')).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) fail('UNSUPPORTED_ASSET', 'Only PNG, JPEG, GIF, WebP, SVG and AVIF images can be added.');
  if (!Buffer.isBuffer(data) || !data.length) fail('UNSUPPORTED_ASSET', 'The image is empty.');
  if (data.length > MAX_ASSET_BYTES) fail('BODY_TOO_LARGE', 'Images are limited to 12 MiB.');
  return { extension, bytes: Buffer.from(data) };
};
const sameDocument = (a, b) => isDeepStrictEqual({ ...a, version: 0 }, { ...b, version: 0 });
const sameSettings = (a, b) => SETTINGS_FIELDS.every(key => isDeepStrictEqual(a[key], b[key]));
const settingsPatch = (from, to) => Object.fromEntries(SETTINGS_FIELDS.map(key => [key, diffValue(from[key], to[key])]).filter(([, value]) => value !== undefined));
const inside = (root, target) => target === root || (!path.relative(root, target).startsWith('..' + path.sep) && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target)));

function fail(code, message, details) {
  throw new DivletError(code, message, details);
}

function failStaticBuild(error) {
  fail(error.code || 'STATIC_BUILD_FAILED', error.message, error.details);
}

/** JSON.parse with a line and column in the error, for diagnostics of hand-edited files. */
function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch (error) {
    const at = Number(/in JSON at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(error.message)?.[1]);
    const before = Number.isFinite(at) ? text.slice(0, at).split('\n') : null;
    // V8 parser messages may quote fileToken or other source values; keep only numeric locations.
    throw new DivletError('INVALID_JSON', `${label} is not valid JSON.`, before ? { line: before.length, column: before.at(-1).length + 1 } : undefined);
  }
}




const CLASS_RULES_HINT = 8;

/**
 * Feedback for the agent after a change: classes that do nothing on the nodes it touched, and
 * css that grows into a class stylesheet (the board edits Tailwind classes, not css rules).
 */
function styleWarnings({ unknown = {}, changed = [], css = null, where }) {
  const out = [];
  const dead = changed.filter(id => unknown[id]?.length).map(id => `#${id}: ${unknown[id].join(' ')}`);
  if (dead.length) out.push(`Classes with no effect (no Tailwind utility, no css rule): ${dead.slice(0, 8).join('; ')}${dead.length > 8 ? ` +${dead.length - 8} nodes` : ''}. Fix the name or use a Tailwind utility.`);
  if (css) {
    const [before, after] = css.map(text => customClasses(text).size);
    if (after >= CLASS_RULES_HINT && after > before) out.push(`${where} now styles ${after} classes. Prefer Tailwind utilities in className — the user edits classes on the board and cannot see css behind a class name; keep css for what utilities cannot express (@keyframes, complex selectors).`);
  }
  return out;
}


/**
 * A caller that names the state it read gets a refusal instead of silently overwriting a change it
 * never saw (AGENTS.md, "Validated commits"). Omitted means the caller accepted whatever is current.
 */
function assertExpectedVersion(expected, target, what = 'frame') {
  if (expected === undefined) return;
  if (!Number.isInteger(expected) || expected !== target.version) fail('REVISION_CONFLICT', `Expected ${what} version ${target.version}; received ${expected}. Read it again and rebuild the change.`, { actualVersion: target.version });
}

/** The rendered page a gesture was made against; a dependent re-render advances it without a version bump. */
function assertExpectedRender(expected, entry) {
  if (expected === undefined) return;
  if (!Number.isInteger(expected) || expected !== entry.render) fail('RENDER_CONFLICT', `Expected frame render ${entry.render}; received ${expected}. The page changed since it was read; reload the frame and repeat the change.`, { actualRender: entry.render, actualVersion: entry.document.version });
}

/*
 * Each .divlet file is an independent source of truth. Generated pages and metadata belong
 * to its OutputStore, by default .divlet/<source filename stem> beside that source file.
 * Source-relative assets and preview URLs do not depend on the output directory.
 */
export class DivletRuntime extends EventEmitter {
  /** `file` selects one project; directory convenience defaults to project.divlet. */
  constructor({ cwd, dir, file, watch = true, externalFiles = [] }) {
    super();
    this.projectPath = path.resolve(file || path.join(dir || cwd || process.cwd(), PROJECT_FILE));
    this.projectDir = path.dirname(this.projectPath);
    this.cwd = this.projectDir;
    this.projectId = digest(this.projectPath).slice(0, 16);
    this.output = new OutputStore(this.projectPath);
    this.externalFiles = Object.freeze(normalizeExternalFiles(this.projectDir, externalFiles));
    this.staticFiles = null;
    this.staticSources = new Map();
    this.pendingGeneration = null;
    this.watchEnabled = watch;
    this.settings = validateSettings({ name: path.basename(this.cwd) || 'Untitled project' });
    this.documents = new Map();
    this.sourceVersionFloor = 0; // A bounded high-water mark prevents stale revisions targeting restored roots.
    this.knownHashes = new Map();
    this.badHashes = new Map();
    this.diagnostics = new Map();
    this.observations = new Map();
    this.selection = { ids: [], revision: 0 };
    this.revision = 0;
    this.stateVersion = 0;
    this.stateKey = null;
    this.renderSeq = 0;
    this.clients = 0;
    this.queue = Promise.resolve();
    this.closed = false;
    this.url = '';
    this.site = null;
    this.siteVersion = 0;
    this.history = [];
    this.seq = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.groupCounter = 0;
    this.agent = { connected: false, busy: false, activity: null, since: null, queued: 0 };
    this.host = null; // set by whoever started the board: { open(path) → { url } }, so the board can open other projects
    this.work = []; // areas the agent announced it is working on: { documentId, nodeIds, note, at }
  }

  get outputDir() { return this.output.directory; }

  newGroup() {
    return `g${++this.groupCounter}`;
  }

  /** Append one accepted change to the readable action log and announce it. */
  record({ actor = 'agent', kind = 'patch', documentId, name, fromVersion, toVersion, group, label, from, to, text, message, context }) {
    const summary = from && to ? summarizeChange(from, to) : { fields: [], artboard: {}, nodes: { added: [], removed: [], changed: {} }, touched: 0, text: kind };
    if (text) summary.text = text;
    const change = {
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
    if (documentId && this.documents.has(documentId)) change.render = this.documents.get(documentId).render;
    if (message !== undefined) change.message = message;
    if (context !== undefined) change.context = context;
    this.history.push(change);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.emit('change', change);
    return change;
  }

  historyHead() {
    return { seq: this.seq, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0, undoLabel: this.undoStack.at(-1)?.label ?? null, redoLabel: this.redoStack.at(-1)?.label ?? null };
  }

  readHistory({ since = 0, limit = 50, documentId, actor } = {}) {
    if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail('INVALID_QUERY', 'since must be ≥ 0 and limit 1–500.');
    let changes = this.history.filter(change => change.seq > since && (!documentId || change.documentId === documentId) && (!actor || change.actor === actor));
    const truncated = changes.length > limit;
    changes = changes.slice(-limit);
    return { ...this.historyHead(), truncated, changes: structuredClone(changes) };
  }

  pushUndo(entry) {
    const top = this.undoStack.at(-1);
    // One gesture that commits while it runs keeps one undo step; its label describes the committed state it ended in.
    if (entry.group && top?.group === entry.group) { top.items.push(...entry.items); if (entry.label) top.label = entry.label; }
    else this.undoStack.push(entry);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  enqueue(task) {
    if (this.closed || this.closing) return Promise.reject(new DivletError('CLOSED', 'The divlet runtime has closed.'));
    const result = this.queue.then(() => {
      if (this.closed) fail('CLOSED', 'The divlet runtime has closed.');
      return task();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async start({ port = 0, createDemo = true, requireSource = false } = {}) {
    await safeDirectory(this.projectDir, { create: !requireSource });
    try { this.projectDir = await fs.realpath(this.projectDir); }
    catch (error) { if (requireSource && error.code === 'ENOENT') fail('NOT_FOUND', 'The selected project source directory disappeared before opening.'); throw error; }
    this.projectPath = path.join(this.projectDir, path.basename(this.projectPath));
    this.cwd = this.projectDir;
    this.projectId = digest(this.projectPath).slice(0, 16);
    this.output = new OutputStore(this.projectPath);
    this.server = await startServer(this, { port });
    this.url = this.server.url;
    try {
      await this.enqueue(() => this.load({ createDemo, requireSource }));
      this.ready = true;
    } catch (error) {
      await this.server.close();
      throw error;
    }
    // This process owns the project now: other clients attach to this board instead of opening a second writer.
    await registerBoard({ file: this.projectPath, url: this.url, projectId: this.projectId });
    if (this.watchEnabled) {
      this.timer = setInterval(() => this.scan().catch(error => this.recordDiagnostic('watcher', error)), 400);
      this.timer.unref();
    }
    return this;
  }

  /* ---- state for the board and the agent ----------------------------------- */

  usedBy(id, entries = this.documents) {
    return [...entries.values()].filter(entry => entry.document.id !== id && entry.uses.some(key => key.startsWith(`${id}/`))).map(entry => entry.document.id);
  }

  describe(entry) {
    const { document } = entry;
    return {
      id: document.id, name: document.name, version: document.version, render: entry.render, savedVersion: entry.savedVersion,
      artboard: document.artboard, metadata: document.metadata,
      components: Object.values(document.nodes).filter(node => node.type === 'element' && node.reusable).map(node => node.id),
      instances: Object.values(document.nodes).filter(node => node.type === 'ref').length,
      uses: entry.uses, usedBy: this.usedBy(document.id),
      modelPath: this.projectPath, sourcePath: this.projectPath, htmlPath: entry.htmlPath, metaPath: entry.metaPath,
    };
  }

  info() {
    const state = {
      projectId: this.projectId,
      cwd: this.cwd,
      projectDir: this.projectDir,
      outputDir: this.outputDir,
      url: this.url,
      revision: this.revision,
      project: { file: this.projectPath, format: 'divlet', capabilities: { properties: !this.diagnostics.has(this.projectPath), settings: !this.diagnostics.has(this.projectPath), frames: !this.diagnostics.has(this.projectPath), saveAs: !this.diagnostics.has(this.projectPath) }, name: this.settings.name, version: this.settings.version, tokens: this.settings.tokens, css: this.settings.css, metadata: this.settings.metadata, outputDir: this.settings.outputDir },
      documents: [...this.documents.values()].map(entry => this.describe(entry)),
      diagnostics: [...this.diagnostics.values()],
      selection: structuredClone(this.selection),
      history: this.historyHead(),
      clients: this.clients,
      agent: { ...this.agent },
      work: structuredClone(this.work),
      site: this.siteInfo(),
      clientPlugins: clientPlugins(),
    };
    // Diagnostic/selection/agent snapshots can change at equal edit revisions, across both HTTP and SSE.
    const key = digest(JSON.stringify(state));
    if (key !== this.stateKey) { this.stateKey = key; this.stateVersion++; }
    return { ...state, stateVersion: this.stateVersion };
  }

  publish() {
    this.emit('state', this.info());
  }

  recordDiagnostic(key, error, documentId) {
    const previous = this.diagnostics.get(key);
    const next = { path: key, code: error.code || 'INVALID_FILE', message: error.message, documentId, at: new Date().toISOString() };
    if (Number.isInteger(error.details?.line)) Object.assign(next, { line: error.details.line, column: error.details.column });
    if (error.details?.resourceAccess) next.resourceAccess = structuredClone(error.details.resourceAccess);
    if (previous && isDeepStrictEqual({ ...previous, at: null }, { ...next, at: null })) return;
    this.diagnostics.set(key, next);
    this.publish();
  }

  clearDiagnostic(key) {
    if (this.diagnostics.delete(key)) this.publish();
  }

  getEntry(id) {
    const entry = this.documents.get(id);
    if (!entry) fail('NOT_FOUND', `Unknown frame: ${id}. read_divlet view:project lists the frames.`);
    return entry;
  }

  components() {
    const frames = [...this.documents.values()].map(entry => entry.document);
    const usage = new Map();
    for (const frame of frames) for (const instance of instancesOf(frame)) {
      const key = `${instance.frame}/${instance.node}`;
      if (!usage.has(key)) usage.set(key, []);
      usage.get(key).push(`${frame.id}/${instance.id}`);
    }
    return listComponents(frames).map(component => ({ ...component, instances: usage.get(component.ref) ?? [] }));
  }

  read({ view = 'project', documentId, ids, query, depth, limit, route, since } = {}) {
    if (view === 'project') return this.info();
    if (view === 'components') return { projectVersion: this.settings.version, components: this.components() };
    if (view === 'history') return this.readHistory({ since: since ?? undefined, limit: limit ?? undefined, documentId });
    if (view === 'selection') return { projectRevision: this.revision, selection: structuredClone(this.selection) };
    if (view === 'diagnostics') return { revision: this.revision, diagnostics: [...this.diagnostics.values()] };
    if (view === 'site') {
      if (!route) return this.siteInfo();
      const page = this.sitePage(route);
      return { ...this.siteInfo(), route: this.siteRoute(route), document: structuredClone(page.document) };
    }
    const entry = this.getEntry(documentId || this.selection.ids[0] || this.documents.keys().next().value);
    if (view === 'document' || view === 'frame') return structuredClone(entry.document);
    if (view === 'nodes') {
      const nodes = inspectDocument(entry.document, { ids, query, depth, limit }, { limits: LIMITS });
      return { documentId: entry.document.id, version: entry.document.version, nodes };
    }
    if (view === 'preview') return { documentId: entry.document.id, version: entry.document.version, observation: structuredClone(this.observations.get(entry.document.id) || null) };
    fail('INVALID_VIEW', `Unknown read view: ${view}`);
  }

  render(id) {
    const entry = this.getEntry(id);
    return { documentId: id, version: entry.document.version, render: entry.render, html: entry.html };
  }

  siteInfo() {
    if (!this.site) return null;
    const { version, config, routes, tree } = this.site;
    const home = routes.some(route => route.path === '/') ? '/' : routes[0]?.path || '/';
    return structuredClone({ version, title: config.title, url: this.url + 'site' + home, templateId: config.templateId, contentDir: config.contentDir, config, routes, tree });
  }

  siteRoute(route) {
    if (typeof route !== 'string' || !route.startsWith('/') || /[\\?#\0]/.test(route)) fail('INVALID_ROUTE', 'Use an absolute site path such as /guide/start/.');
    const parts = route.split('/').filter(Boolean).map(part => {
      let value;
      try { value = decodeURIComponent(part); } catch { fail('INVALID_ROUTE', 'Invalid URL encoding in site path.'); }
      if (['.', '..'].includes(value) || /[\\/\0]/.test(value)) fail('INVALID_ROUTE', 'Unsafe site path.');
      return encodeURIComponent(value);
    });
    return '/' + (parts.length ? parts.join('/') + '/' : '');
  }

  sitePage(route) {
    const page = this.site?.pages.get(this.siteRoute(route));
    if (!page) fail('NOT_FOUND', `Unknown site route: ${route}`);
    return page;
  }

  renderSite(route) {
    const page = this.sitePage(route);
    return { documentId: page.document.id, version: this.site.version, html: page.html };
  }

  async siteCandidate(entries, settings) {
    
    try {
      const frames = new Map([...entries].map(([id, entry]) => [id, entry.document]));
      const site = await buildSite({ projectDir: this.projectDir, documents: entries, settings, prepare: input => this.prepare(input, { frames, settings }), readFile: file => this.fileContents(file), previous: this.site ?? { version: this.siteVersion }, siteBase: this.url + 'site/', assetBase: this.url + 'files/' });
      return { site, siteError: null };
    } catch (siteError) { return { site: this.site, siteError }; }
  }

  acceptSite(generation) {
    const key = path.join(this.projectDir, 'site.json');
    if (generation.siteError) this.recordDiagnostic(key, generation.siteError, this.site?.config.templateId);
    else this.diagnostics.delete(key);
    if (generation.site !== this.site) {
      this.site = generation.site;
      if (this.site) this.site.version = ++this.siteVersion;
      this.revision++;
    }
    this.publish();
  }

  async assetsChanged() {
    const budget = { bytes: 0 };
    for (const [file, expected] of this.staticSources) {
      try {
        await safeDirectory(path.dirname(file));
        const bytes = await readResourceBytes(file, budget);
        await safeDirectory(path.dirname(file));
        if (digest(bytes) !== expected) return true;
      } catch (error) { if (error.code !== 'ENOENT' || expected !== null) return true; }
    }
    return false;
  }

  async refreshSite() {
    if (this.pendingGeneration?.entries === this.documents && this.pendingGeneration.settings === this.settings) {
      const generation = this.pendingGeneration.generation;
      this.pendingGeneration = null;
      this.acceptSite(generation);
      return;
    }
    const candidate = await this.siteCandidate(this.documents, this.settings);
    if (candidate.site === this.site && this.staticFiles && !this.diagnostics.has('outputs') && !await this.assetsChanged()) {
      const key = path.join(this.projectDir, 'site.json');
      if (candidate.siteError) this.recordDiagnostic(key, candidate.siteError, this.site?.config.templateId);
      else this.clearDiagnostic(key);
      return;
    }
    try {
      const entries = new Map(this.documents);
      const generation = await this.prepareGeneration(entries, this.settings, candidate);
      await this.output.withLock(async () => {
        const removed = await this.obsoleteOutputs(generation.files);
        await this.output.preflight(generation.files, removed);
        await this.publishGeneration(entries, generation, [], { removed });
      });
      this.documents = entries;
      this.acceptSite(generation);
    } catch (error) { this.recordDiagnostic('outputs', error); }
  }

  /* ---- rendering ------------------------------------------------------------ */

  /**
   * Validate a frame against the project (its instances expanded), compile its Tailwind
   * classes, and produce the preview HTML (instrumented, lossless) and the generated file.
   */
  async prepare(input, { frames, settings = this.settings, limits = LIMITS } = {}) {
    return prepareFrame(input, { lookup: id => frames ? frames.get(id) : this.documents.get(id)?.document, settings, limits });
  }

  /** A board entry for a prepared frame; the render counter only moves when the preview changes. */
  entryFor(prepared, previous, outputDir = this.outputDir) {
    const id = prepared.document.id;
    return {
      ...(previous || {}),
      key: id,
      document: prepared.document,
      sourcePath: this.projectPath,
      html: prepared.html,
      // What the frame renders written as a page, before the static build rewrites resource URLs; `fileHtml` is the built copy.
      rawFileHtml: prepared.fileHtml,
      fileHtml: previous?.rawFileHtml === prepared.fileHtml ? previous.fileHtml : prepared.fileHtml,
      uses: prepared.uses,
      unknown: prepared.unknown,
      render: previous && previous.html === prepared.html ? previous.render : ++this.renderSeq,
      htmlPath: path.join(outputDir, `${id}.html`),
      metaPath: path.join(outputDir, `${id}.meta.json`),
    };
  }

  /** Frames that must re-render when `ids` change (they use components from them). */
  dependentsOf(ids, entries = this.documents) {
    const out = new Set();
    for (const id of ids) for (const other of this.usedBy(id, entries)) if (!ids.includes(other)) out.add(other);
    return [...out];
  }

  /** Prepare `ids` against the candidate `frames`; any failure names the frame it happened in. */
  async prepareAll(ids, frames, settings) {
    const prepared = new Map();
    for (const id of ids) {
      try { prepared.set(id, await this.prepare(frames.get(id), { frames, settings })); }
      catch (error) { throw new DivletError(error.code || 'INVALID_DOCUMENT', `Frame ${id}: ${error.message}`, error.details); }
    }
    return prepared;
  }

  metaOf(entry, entries) { return frameMetadata(entry, entries, this.projectPath); }

  /* ---- files ---------------------------------------------------------------- */

  async fileContents(file, limit = MAX_FILE_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_PROJECT_BYTES) fail('INVALID_OPERATION', 'Source read limit must be an integer within the project byte budget.');
    let handle, before;
    const conflict = () => fail('FILE_CONFLICT', `${path.basename(file)} changed while being read. Reload the source before retrying.`);
    const unchanged = stat => stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs;
    try {
      await safeDirectory(path.dirname(file));
      before = await fs.lstat(file, { bigint: true });
      if (before.isSymbolicLink()) fail('UNSAFE_PATH', 'Symbolic links are not allowed as divlet project files.');
      if (!before.isFile()) fail('INVALID_FILE', 'A divlet project file must be a regular file.');
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) fail('INVALID_FILE', 'A divlet project file must be a regular file.');
      if (!unchanged(stat)) conflict();
      if (stat.size > BigInt(limit)) fail('FILE_TOO_LARGE', `${path.basename(file)} exceeds the ${Math.round(limit / 1048576)} MiB file limit.`);
      // Read only the descriptor's bounded size plus one byte, never an unbounded pathname readFile.
      const size = Number(stat.size), buffer = Buffer.alloc(size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== size || !unchanged(await handle.stat({ bigint: true }))) conflict();
      await safeDirectory(path.dirname(file));
      const current = await fs.lstat(file, { bigint: true });
      if (current.isSymbolicLink()) fail('UNSAFE_PATH', 'Symbolic links are not allowed as divlet project files.');
      if (!current.isFile()) fail('INVALID_FILE', 'A divlet project file must be a regular file.');
      if (!unchanged(current)) conflict();
      return buffer.toString('utf8', 0, length);
    } catch (error) {
      if (error.code === 'ELOOP') fail('UNSAFE_PATH', 'Symbolic links are not allowed as divlet project files.');
      if (error.code === 'ENOENT') { if (before) conflict(); return null; }
      throw error;
    } finally { await handle?.close(); }
  }

  async atomicWrite(file, contents) {
    await safeDirectory(path.dirname(file));
    const parent = await fs.realpath(path.dirname(file));
    if (!inside(this.projectDir, parent)) fail('UNSAFE_PATH', 'File is outside the project source directory.');
    try {
      if ((await fs.lstat(file)).isSymbolicLink()) fail('UNSAFE_PATH', 'Refusing to overwrite a symbolic link.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(parent, `.divlet-save-${randomBytes(12).toString('hex')}`);
    try {
      await fs.writeFile(temporary, contents, { flag: 'wx' });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  /** Keep a file in divlet/.trash instead of deleting or overwriting it. */
  async trashFile(file, tag) {
    const trash = path.join(this.outputDir, '.trash');
    await safeDirectory(trash, { create: true });
    const target = path.join(trash, `${Date.now()}-${randomBytes(3).toString('hex')}-${tag}-${path.basename(file)}`);
    try { await fs.rename(file, target); return target; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }

  /** Refuse to write while project.divlet holds an external edit that could not be accepted. */
  assertWritable(scope = 'frames') {
    const pending = this.diagnostics.get(this.projectPath);
    if (pending) fail('EXTERNAL_PENDING', `${path.basename(this.projectPath)} has an external edit that is not valid yet (${pending.message}). Fix or revert the file; the board keeps the last valid state.`, { diagnostics: [pending] });
  }

  /**
   * Write the project file for the `next` frames, then the generated HTML of `write` and every
   * meta.json that changed. Generated files that were edited by hand are moved to divlet/.trash first.
   */
  async persist(next, { settings = this.settings, write = [], removed = [], sourceHash = this.knownHashes.get(this.projectPath) ?? null, generation } = {}) {
    const disk = await this.fileContents(this.projectPath, MAX_PROJECT_BYTES);
    const text = writeProject(settings, [...next.values()].map(entry => entry.document));
    if (Buffer.byteLength(text) > MAX_PROJECT_BYTES) fail('FILE_TOO_LARGE', 'The serialized project exceeds the source read limit.');
    if (hashOf(disk) !== sourceHash) fail('FILE_CONFLICT', `${path.basename(this.projectPath)} changed on disk and is being read now. Read the new state and retry.`);
    const output = new OutputStore(this.projectPath, settings.outputDir);
    const moved = output.directory !== this.outputDir;
    if (moved) write = [...next.keys()];
    generation ??= await this.prepareGeneration(next, settings);
    await output.withLock(async () => {
      const removedNames = await this.obsoleteOutputs(generation.files, output);
      await output.preflight(generation.files, removedNames);
      const latest = await this.fileContents(this.projectPath, MAX_PROJECT_BYTES);
      if (hashOf(latest) !== sourceHash) fail('FILE_CONFLICT', 'The project source changed during output preparation. Read it again and retry.');
      if (latest !== text) {
        await this.atomicWrite(this.projectPath, text);
      }
      this.knownHashes.set(this.projectPath, digest(text));
      for (const entry of next.values()) entry.savedVersion = entry.document.version;
      const previousOutput = this.output;
      this.output = output;
      try {
        await this.publishGeneration(next, generation, write, { moved, removed: removedNames });
        this.pendingGeneration = { entries: next, settings, generation };
      } catch (error) { this.recordDiagnostic('outputs', error); }
      for (const entry of removed) for (const file of [entry.htmlPath, entry.metaPath]) { this.knownHashes.delete(file); this.diagnostics.delete(file); }
      if (moved) for (const file of this.knownHashes.keys()) if (inside(previousOutput.directory, file) && !inside(output.directory, file)) { this.knownHashes.delete(file); this.diagnostics.delete(file); }
    });
  }

  async prepareGeneration(entries, settings, candidate) {
    const destination = new OutputStore(this.projectPath, settings.outputDir).directory;
    for (const [id, entry] of entries) {
      const file = `${id}.html`, htmlPath = path.join(destination, file);
      if (entry.htmlPath !== htmlPath) entries.set(id, { ...entry, htmlPath, metaPath: htmlPath.slice(0, -5) + '.meta.json', metaText: undefined });
    }
    candidate ??= await this.siteCandidate(entries, settings);
    const frames = new Map([...entries].map(([id, entry]) => [id, entry.rawFileHtml]));
    const site = new Map([...(candidate.site?.pages ?? [])].map(([route, page]) => [route, page.fileHtml]));
    let generation;
    try { generation = await buildStatic({ projectDir: this.projectDir, frames, site, assetBase: this.url + 'files/', siteBase: this.url + 'site/', externalFiles: this.externalFiles }); }
    catch (error) { failStaticBuild(error, this.projectPath, this.externalFiles); }
    const inputs = [...generation.sources.keys(), ...(candidate.site?.routes ?? []).map(route => route.sourcePath)];
    if (inputs.some(file => inside(destination, file))) fail('INVALID_OUTPUT_DIR', 'The output directory cannot contain authored resources or Markdown sources used by this project.');
    for (const [id, entry] of entries) {
      const fileHtml = String(generation.files.get(path.basename(entry.htmlPath)));
      if (entry.fileHtml !== fileHtml) entries.set(id, { ...entry, fileHtml });
    }
    for (const entry of entries.values()) generation.files.set(path.basename(entry.metaPath), this.metaOf(entry, entries));
    for (const [route, page] of candidate.site?.pages ?? []) {
      const directory = route.split('/').filter(Boolean).map(part => decodeURIComponent(part)).join('/');
      const name = directory ? `${directory}/index.html` : 'index.html';
      const htmlPath = path.join(destination, name);
      const entry = { document: page.document, htmlPath, fileHtml: generation.files.get(name), uses: page.uses ?? [] };
      generation.files.set(name.slice(0, -5) + '.meta.json', JSON.stringify({ ...JSON.parse(this.metaOf(entry, entries)), route, templateId: candidate.site.config.templateId }, null, 2) + '\n');
    }
    return { ...generation, ...candidate };
  }

  async obsoleteOutputs(files, output = this.output) {
    const manifest = await output.manifest();
    return Object.keys(manifest.files).filter(name => !files.has(name));
  }

  async publishGeneration(entries, generation, ids, { moved = false, removed = [] } = {}) {
    const selected = new Set(ids.map(id => path.basename(entries.get(id).htmlPath)));
    const frames = new Set([...entries.values()].map(entry => path.basename(entry.htmlPath)));
    const stylesheets = new Set(generation.stylesheets.values());
    const files = new Map();
    for (const [name, contents] of generation.files) {
      const previous = this.staticFiles?.get(name);
      const changed = previous === undefined || !Buffer.from(previous).equals(Buffer.from(contents));
      if (name.endsWith('.meta.json') || stylesheets.has(name) || moved || selected.has(name) || changed && (!frames.has(name) || this.staticFiles)) files.set(name, contents);
    }
    await this.output.writeLocked(files);
    if (removed.length) await this.output.removeLocked(removed);
    for (const [name, contents] of files) {
      const file = this.output.file(name);
      this.knownHashes.set(file, digest(contents));
      this.diagnostics.delete(file);
    }
    for (const name of removed) { this.knownHashes.delete(this.output.file(name)); this.diagnostics.delete(this.output.file(name)); }
    for (const entry of entries.values()) entry.metaText = this.metaOf(entry, entries);
    for (const key of this.diagnostics.keys()) if (key.startsWith('static:')) this.diagnostics.delete(key);
    for (const warning of generation.warnings) this.diagnostics.set(`static:${warning.path}`, { ...warning, at: new Date().toISOString() });
    this.staticFiles = generation.files;
    this.staticSources = generation.sources;
    this.diagnostics.delete('outputs');
  }

  /* ---- loading, imports and external edits --------------------------------- */

  readRenderableProject(text) {
    // Foreign formats are importer plugins (lib/plugins): opening converts them. The runtime edits Divlet projects only.
    return readProject(parseJson(text, path.basename(this.projectPath)));
  }

  async load({ createDemo, requireSource = true }) {
    const text = await this.fileContents(this.projectPath, MAX_PROJECT_BYTES);
    if (text !== null) {
      let project;
      try { project = this.readRenderableProject(text); }
      catch (error) {
        // Invalid source stays untouched and read-only; output collisions instead reject opening.
        this.badHashes.set(this.projectPath, hashOf(text));
        this.recordDiagnostic(this.projectPath, error);
        return;
      }
      this.knownHashes.set(this.projectPath, digest(text));
      await this.adopt(project.settings, project.frames, {});
      return;
    }
    if (requireSource || this.adopted || path.extname(this.projectPath).toLowerCase() === '.pen') fail('NOT_FOUND', 'The selected project source disappeared before opening. Restore it or select an existing source.');
    const siblings = (await fs.readdir(this.projectDir, { withFileTypes: true })).filter(item => item.isFile() && isProjectFile(item.name));
    const imported = siblings.length ? { frames: [], files: [], failed: false } : await this.collectHtml();
    if (!imported.frames.length && imported.failed) fail('INVALID_PROJECT', 'Initial HTML could not be admitted. Authored files were retained; no project source was created.');
    if (!imported.frames.length) {
      await initProject(this.projectPath, undefined, createDemo === undefined ? true : createDemo);
      return this.load({ createDemo: false, requireSource: true });
    }
    const frames = imported.frames;
    for (const file of imported.files) await this.trashFile(file, 'imported');
    await this.adopt(this.settings, frames);
    if (imported.frames.length) this.record({ actor: 'system', kind: 'import', documentId: null, text: `imported ${imported.frames.length} frame${imported.frames.length === 1 ? '' : 's'} into ${PROJECT_FILE} (the sources are in divlet/.trash)` });
  }


  /** Take a whole validated project as the current state and write whatever is missing or stale. */
  async adopt(settings, frames, { prepared } = {}) {
    const lookup = new Map(frames.map(frame => [frame.id, frame]));
    prepared ??= await this.prepareAll(frames.map(frame => frame.id), lookup, settings);
    const output = new OutputStore(this.projectPath, settings.outputDir);
    const next = new Map();
    for (const frame of frames) next.set(frame.id, this.entryFor(prepared.get(frame.id), undefined, output.directory));
    const generation = await this.prepareGeneration(next, settings);
    await output.preflight(generation.files);
    const stale = [];
    for (const entry of next.values()) {
      const disk = await this.fileContents(entry.htmlPath).catch(() => undefined);
      if (disk === entry.fileHtml) { this.knownHashes.set(entry.htmlPath, digest(disk)); continue; }
      let meta = null;
      try { meta = JSON.parse(await this.fileContents(entry.metaPath) ?? 'null'); } catch {}
      if (disk === null || disk === undefined || meta?.hashes?.html === hashOf(disk)) {
        // Outdated but untouched (our own earlier output): regenerate it without keeping a copy.
        if (typeof disk === 'string') this.knownHashes.set(entry.htmlPath, digest(disk));
        stale.push(entry.document.id);
      }
      else {
        // The generated page was edited by hand: keep it until the frame next changes.
        this.knownHashes.set(entry.htmlPath, meta?.hashes?.html ?? 'unknown');
        this.diagnostics.set(entry.htmlPath, this.editedDiagnostic(entry));
      }
    }
    await this.persist(next, { settings, write: stale, generation });
    this.settings = settings;
    this.documents = next;
    this.adopted = true;
    this.revision++;
    await this.refreshSite();
    this.publish();
  }

  editedDiagnostic(entry) {
    return { path: entry.htmlPath, code: 'GENERATED_FILE_EDITED', documentId: entry.document.id, at: new Date().toISOString(), message: `${path.basename(entry.htmlPath)} is generated from ${path.basename(this.projectPath)} and was edited by hand. The edit is not imported; it is moved to divlet/.trash when “${entry.document.name}” changes next. Make the change in the project (or ask Pi).` };
  }

  /** Import HTML pages when opening a folder without a project file. */
  async collectHtml() {
    const files = await this.listFiles();
    const frames = [];
    const used = [];
    let failed = false;
    for (const file of files) {
      try {
        const document = (await this.pageFrame(file, await this.fileContents(file))).document;
        frames.push(this.uniqueFrame(document, frames));
        used.push(file);
      } catch (error) {
        failed = true;
        this.recordDiagnostic(file, error);
      }
    }
    return { frames, files: used, failed };
  }

  /** A frame with an ID that does not collide with existing ones (or with `extra`). */
  uniqueFrame(document, extra = []) {
    const taken = new Set([...this.documents.keys(), ...extra.map(frame => frame.id)]);
    let id = document.id;
    for (let n = 2; taken.has(id); n++) id = `${document.id}-${n}`;
    return id === document.id ? document : validateDocument({ ...document, id });
  }

  async listFiles(directory = this.projectDir, files = [], pages = pageExtensions()) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (item.name.startsWith('.')) continue;
      const full = path.join(directory, item.name);
      if (full === this.outputDir) continue;
      if (item.isDirectory()) {
        if (await fs.lstat(path.join(full, '.divlet-build.json')).then(() => true, () => false)) continue;
        await this.listFiles(full, files, pages);
      }
      else if ((item.isFile() || item.isSymbolicLink()) && pages.has(path.extname(item.name).toLowerCase())) files.push(full);
      if (files.length > 400) fail('TOO_MANY_FILES', 'divlet/ holds too many HTML files to scan.');
    }
    return files;
  }

  scan() {
    return this.enqueue(async () => {
      await this.scanProject();
      // While project.divlet holds an unaccepted edit nothing is written; Markdown content still updates.
      if (!this.diagnostics.has(this.projectPath)) {
        await this.scanOutputs();
        const sources = (await fs.readdir(this.projectDir, { withFileTypes: true })).filter(item => item.isFile() && isProjectFile(item.name));
        if (sources.length === 1) await this.scanImports();
      }
      await this.refreshSite();
    });
  }

  async scanProject() {
    let text;
    try { text = await this.fileContents(this.projectPath, MAX_PROJECT_BYTES); }
    catch (error) { this.recordDiagnostic(this.projectPath, error); return; }
    const known = this.knownHashes.get(this.projectPath);
    if (text === null) {
      if (!known) return;
      // Deleted while the board is open: write it back from the accepted state.
      const restored = writeProject(this.settings, [...this.documents.values()].map(entry => entry.document));
      await this.atomicWrite(this.projectPath, restored);
      this.knownHashes.set(this.projectPath, digest(restored));
      this.diagnostics.delete(this.projectPath);
      this.record({ actor: 'system', kind: 'restore', documentId: null, text: `${path.basename(this.projectPath)} was deleted; restored it from the board` });
      this.publish();
      return;
    }
    const hash = digest(text);
    if (hash === known) { this.badHashes.delete(this.projectPath); this.clearDiagnostic(this.projectPath); return; }
    if (hash === this.badHashes.get(this.projectPath)) return;
    try {
      const project = this.readRenderableProject(text);
await this.importProject(project.settings, project.frames, hash);
      this.badHashes.delete(this.projectPath);
      this.clearDiagnostic(this.projectPath);
    } catch (error) {
      this.badHashes.set(this.projectPath, hash);
      this.recordDiagnostic(this.projectPath, error);
    }
  }

  /** Accept an external edit of the project file: every frame difference becomes a logged, undoable change. */
  async importProject(settings, frames, hash) {
    const settingsChanged = !sameSettings(settings, this.settings);
    const nextSettings = { ...settings, version: this.settings.version + (settingsChanged ? 1 : 0) };
    const docs = new Map();
    const changed = [];
    const created = [];
    for (const frame of frames) {
      const current = this.documents.get(frame.id);
      if (current && sameDocument(current.document, frame)) docs.set(frame.id, current.document);
      else if (current) { docs.set(frame.id, { ...frame, version: current.document.version + 1 }); changed.push(frame.id); }
      else { docs.set(frame.id, frame); created.push(frame.id); }
    }
    const removed = [...this.documents.keys()].filter(id => !docs.has(id));
    const wasAccepted = () => { this.knownHashes.set(this.projectPath, hash); };
    if (!settingsChanged && !changed.length && !created.length && !removed.length && [...docs.keys()].join() === [...this.documents.keys()].join()) { wasAccepted(); return; }
    const rerender = settingsChanged ? [...docs.keys()] : [...new Set([...changed, ...created, ...this.dependentsOf([...changed, ...removed]).filter(id => docs.has(id))])];
    const prepared = await this.prepareAll(rerender, docs, nextSettings);
    const next = new Map();
    for (const id of docs.keys()) next.set(id, prepared.has(id) ? this.entryFor(prepared.get(id), this.documents.get(id)) : this.documents.get(id));
    await this.persist(next, { settings: nextSettings, write: rerender, removed: removed.map(id => this.documents.get(id)), sourceHash: hash });
    const previous = this.documents;
    const previousSettings = this.settings;
    this.documents = next;
    this.settings = nextSettings;
    this.revision++;
    for (const id of removed) { this.observations.delete(id); this.selection = { ...this.selection, ids: this.selection.ids.filter(item => item !== id), revision: this.selection.revision + 1 }; }
    await this.refreshSite();
    const group = this.newGroup();
    const items = [];
    if (settingsChanged) {
      this.record({ actor: 'file', kind: 'external', documentId: null, name: nextSettings.name, group, label: 'project.divlet edit', text: `project ${SETTINGS_FIELDS.filter(key => !isDeepStrictEqual(previousSettings[key], nextSettings[key])).join(', ')}` });
      items.push({ type: 'project', inverse: settingsPatch(nextSettings, previousSettings), forward: settingsPatch(previousSettings, nextSettings) });
    }
    for (const id of changed) {
      const from = previous.get(id).document;
      const to = next.get(id).document;
      this.record({ actor: 'file', kind: 'external', documentId: id, fromVersion: from.version, toVersion: to.version, group, label: 'project.divlet edit', from, to });
      items.push({ type: 'patch', documentId: id, inverse: diffDocuments(to, from), forward: diffDocuments(from, to) });
    }
    for (const id of created) {
      const to = next.get(id).document;
      this.record({ actor: 'file', kind: 'create', documentId: id, toVersion: to.version, group, from: { ...to, nodes: {} }, to, text: `new frame “${to.name}” · ${Object.keys(to.nodes).length} nodes` });
      items.push({ type: 'create', documentId: id, document: structuredClone(to) });
    }
    for (const id of removed) {
      const from = previous.get(id).document;
      this.record({ actor: 'file', kind: 'delete', documentId: id, name: from.name, fromVersion: from.version, group, from, to: { ...from, nodes: {} }, text: `frame removed “${from.name}”` });
      items.push({ type: 'delete', documentId: id, document: structuredClone(from) });
    }
    if (items.length) this.pushUndo({ group, label: 'edit of project.divlet', items });
    this.publish();
  }

  /** Regenerate deleted outputs; flag generated pages that were edited by hand. */
  async scanOutputs() {
    const restore = new Map();
    for (const [name, contents] of this.staticFiles ?? []) {
      const file = this.output.file(name);
      let disk;
      try { disk = await this.output.read(name); }
      catch (error) { this.recordDiagnostic(file, error); continue; }
      if (disk === null || name.endsWith('.meta.json')) {
        if (disk === null || !disk.equals(Buffer.from(contents))) restore.set(name, contents);
      } else if (disk.equals(Buffer.from(contents))) {
        this.knownHashes.set(file, digest(contents));
        this.clearDiagnostic(file);
      } else if (await this.output.generated(name, disk)) restore.set(name, contents);
      else if (!this.diagnostics.has(file)) {
        const entry = [...this.documents.values()].find(item => item.htmlPath === file);
        if (entry) { this.diagnostics.set(file, this.editedDiagnostic(entry)); this.publish(); }
        else this.recordDiagnostic(file, new DivletError('GENERATED_FILE_EDITED', 'An owned static artifact was edited by hand. It is preserved when the source next changes.'));
      }
    }
    if (restore.size) {
      await this.output.write(restore);
      for (const [name, contents] of restore) { const file = this.output.file(name); this.knownHashes.set(file, digest(contents)); this.diagnostics.delete(file); }
      this.publish();
    }
  }

  /** Import one dropped page into a frame through its importer; `{ document, dropped }`. */
  async pageFrame(file, text) {
    const importer = await importerFor(file, candidate => this.fileContents(candidate));
    if (typeof importer?.page !== 'function') fail('INVALID_PROJECT', `${path.basename(file)} is not a page this board can import.`);
    const fallbackId = path.basename(file).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_.:-]/g, '-').replace(/^[^a-zA-Z]+/, '') || 'imported';
    const { document, dropped } = importer.page(text, { fallbackId, source: path.basename(file) });
    return { document, dropped };
  }

  /** A new HTML file dropped into the project folder becomes a frame of the project. */
  async scanImports() {
    const generated = new Set([...this.documents.values()].map(entry => entry.htmlPath));
    let files;
    try { files = await this.listFiles(); } catch (error) { this.recordDiagnostic('watcher', error); return; }
    for (const file of files) {
      if (generated.has(file) || this.staticSources.has(file)) continue;
      // The sidecar of the page that produced this file, whatever its extension: the core names no foreign format here.
      const sidecar = await this.fileContents(file.slice(0, -path.extname(file).length) + '.meta.json').catch(() => null);
      if (sidecar) {
        try { const project = JSON.parse(sidecar)?.project; if (typeof project === 'string' && isProjectFile(project)) continue; } catch {}
      }
      let text;
      try { text = await this.fileContents(file); } catch (error) { this.recordDiagnostic(file, error); continue; }
      if (text === null) continue;
      const hash = digest(text);
      if (this.badHashes.get(file) === hash) continue;
      try {
        const { document: decoded } = await this.pageFrame(file, text);
        const document = this.uniqueFrame({ ...decoded, version: 1 });
        await this.prepare(document);
        // The source is kept in divlet/.trash; the frame's generated page may take its place.
        await this.trashFile(file, 'imported');
        await this._create({ document, actor: 'file', kind: 'create', label: `import ${path.basename(file)}`, undoable: true, text: `imported ${path.relative(this.projectDir, file)} as “${document.name}”` });
        this.badHashes.delete(file);
        this.diagnostics.delete(file);
      } catch (error) {
        this.badHashes.set(file, hash);
        this.recordDiagnostic(file, error);
      }
    }
  }

  /* ---- changes ---------------------------------------------------------------- */

  create({ document, actor = 'agent', group, label, undoable = true }) {
    return this.enqueue(() => this._create({ document, actor, group, label, undoable }));
  }

  async _create({ document, actor, group, label, undoable, kind = 'create', text }) {
    this.assertWritable();
    const candidate = validateDocument(document);
    if (this.documents.has(candidate.id)) fail('ALREADY_EXISTS', `Frame ${candidate.id} already exists.`);
    const frames = new Map([...this.documents].map(([id, entry]) => [id, entry.document]));
    frames.set(candidate.id, candidate);
    const prepared = await this.prepare(candidate, { frames });
    const id = prepared.document.id;
    const next = new Map(this.documents);
    next.set(id, this.entryFor(prepared));
    await this.persist(next, { write: [id] });
    this.documents = next;
    this.revision++;
    await this.refreshSite();
    const entry = next.get(id);
    const count = Object.keys(entry.document.nodes).length;
    const change = this.record({ actor, kind, documentId: id, toVersion: entry.document.version, group, label, to: entry.document, from: { ...entry.document, nodes: {} }, text: text ?? `${kind === 'create' ? 'created' : 'restored'} “${entry.document.name}” · ${count} node${count === 1 ? '' : 's'}` });
    if (undoable) this.pushUndo({ group: group ?? this.newGroup(), label: label ?? `create ${entry.document.name}`, items: [{ type: 'create', documentId: id, document: structuredClone(entry.document) }] });
    this.publish();
    return { documentId: id, version: entry.document.version, render: entry.render, revision: this.revision, seq: change.seq, saved: true };
  }

  /** Remove a frame from the project; its generated files go to divlet/.trash. */
  async _remove(documentId, { actor, group, label, expectedVersion, undoable = true, kind = 'delete' }) {
    this.assertWritable();
    const entry = this.getEntry(documentId);
    assertExpectedVersion(expectedVersion, entry.document);
    const users = this.usedBy(documentId);
    if (users.length) fail('COMPONENT_IN_USE', `“${entry.document.name}” has components used by ${users.join(', ')}. Detach or replace those instances first.`, { usedBy: users });
    const next = new Map(this.documents);
    next.delete(documentId);
    await this.persist(next, { removed: [entry] });
    this.documents = next;
    this.work = this.work.filter(item => item.documentId !== documentId);
    this.observations.delete(documentId);
    this.selection = { ...this.selection, ids: this.selection.ids.filter(id => id !== documentId), revision: this.selection.revision + 1 };
    delete this.selection.selectedNodes;
    this.revision++;
    await this.refreshSite();
    const change = this.record({ actor, kind, documentId, name: entry.document.name, fromVersion: entry.document.version, group, label, from: entry.document, to: { ...entry.document, nodes: {} }, text: `removed “${entry.document.name}” (its files are in divlet/.trash)` });
    if (undoable) this.pushUndo({ group: group ?? this.newGroup(), label: label ?? `delete ${entry.document.name}`, items: [{ type: 'delete', documentId, document: structuredClone(entry.document) }] });
    this.publish();
    return { documentId, seq: change.seq, revision: this.revision };
  }

  patch({ documentId, expectedVersion, expectedRender, patch, actor = 'agent', group, label, undoable = true }) {
    return this.enqueue(() => this._patch({ documentId, expectedVersion, expectedRender, patch, actor, group, label, undoable }));
  }

  async _patch({ documentId, expectedVersion, expectedRender, patch, actor = 'agent', group, label, undoable = true, kind = 'patch' }) {
    const previous = this.getEntry(documentId);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== previous.document.version) fail('REVISION_CONFLICT', `Expected frame version ${previous.document.version}; received ${expectedVersion}. Read the frame again and rebuild the change.`, { actualVersion: previous.document.version });
    assertExpectedRender(expectedRender, previous);
    this.assertWritable();
    const candidate = applyDocumentPatch(previous.document, patch, { colourNames: colourNames(this.settings.tokens, previous.document.tokens) });
    candidate.version = previous.document.version + 1;
    // A patch that changes nothing is not a change: no version bump, no history row, no undo step, no write. A drag release
    // that repeats the value its live commits already applied lands here.
    if (sameDocument(candidate, previous.document)) {
      return { documentId, version: previous.document.version, render: previous.render, revision: this.revision, seq: null, summary: 'no change', changedNodeIds: [], rerendered: [], saved: false };
    }
    const frames = new Map([...this.documents].map(([id, entry]) => [id, entry.document]));
    frames.set(documentId, candidate);
    const dependents = this.dependentsOf([documentId]);
    const prepared = await this.prepareAll([documentId, ...dependents], frames, this.settings);
    const next = new Map(this.documents);
    for (const [id, item] of prepared) next.set(id, this.entryFor(item, this.documents.get(id)));
    await this.persist(next, { write: [...prepared.keys()] });
    this.documents = next;
    const entry = next.get(documentId);
    this.diagnostics.delete(entry.htmlPath);
    this.revision++;
    await this.refreshSite();
    const change = this.record({ actor, kind, documentId, fromVersion: previous.document.version, toVersion: entry.document.version, group, label, from: previous.document, to: entry.document });
    if (undoable && change.summary !== 'no change') {
      this.pushUndo({ group: group ?? this.newGroup(), label: label ?? change.summary, items: [{ type: 'patch', documentId, inverse: diffDocuments(entry.document, previous.document), forward: diffDocuments(previous.document, entry.document) }] });
    }
    this.publish();
    const nodeIds = new Set([...Object.keys(previous.document.nodes), ...Object.keys(entry.document.nodes)]);
    const changedNodeIds = [...nodeIds].filter(id => !isDeepStrictEqual(previous.document.nodes[id], entry.document.nodes[id]));
    const warnings = styleWarnings({ unknown: entry.unknown, changed: changedNodeIds, css: patch && Object.hasOwn(patch, 'css') ? [previous.document.css, entry.document.css] : null, where: 'Frame css' });
    return { documentId, version: entry.document.version, render: entry.render, revision: this.revision, seq: change.seq, summary: change.summary, changedNodeIds, rerendered: dependents, saved: true, ...(warnings.length ? { warnings } : {}) };
  }

  /** Change project-level fields: name, shared tokens, shared CSS and metadata. Every frame re-renders. */
  patchProject({ expectedVersion, patch, actor = 'agent', group, label, undoable = true }) {
    return this.enqueue(() => this._patchProject({ expectedVersion, patch, actor, group, label, undoable }));
  }

  async _patchProject({ expectedVersion, patch, actor = 'agent', group, label, undoable = true, kind = 'patch' }) {
    if (!Number.isInteger(expectedVersion) || expectedVersion !== this.settings.version) fail('REVISION_CONFLICT', `Expected project version ${this.settings.version}; received ${expectedVersion}. Read the project again.`, { actualVersion: this.settings.version });
    this.assertWritable();
    const previous = this.settings;
    const settings = { ...patchSettings(previous, patch), version: previous.version + 1 };
    const frames = new Map([...this.documents].map(([id, entry]) => [id, entry.document]));
    const prepared = await this.prepareAll([...frames.keys()], frames, settings);
    const next = new Map(this.documents);
    for (const [id, item] of prepared) next.set(id, this.entryFor(item, this.documents.get(id)));
    await this.persist(next, { settings, write: [...prepared.keys()] });
    this.documents = next;
    this.settings = settings;
    this.revision++;
    await this.refreshSite();
    const fields = SETTINGS_FIELDS.filter(key => !isDeepStrictEqual(previous[key], settings[key]));
    const change = this.record({ actor, kind, documentId: null, name: settings.name, group, label, text: fields.length ? `project ${fields.join(', ')}` : 'no change' });
    if (undoable && fields.length) this.pushUndo({ group: group ?? this.newGroup(), label: label ?? `project ${fields.join(', ')}`, items: [{ type: 'project', inverse: settingsPatch(settings, previous), forward: settingsPatch(previous, settings) }] });
    this.publish();
    const warnings = styleWarnings({ css: patch && Object.hasOwn(patch, 'css') ? [previous.css, settings.css] : null, where: 'Project css' });
    return { project: true, version: settings.version, revision: this.revision, seq: change.seq, summary: change.summary, saved: true, ...(warnings.length ? { warnings } : {}) };
  }













  /** Structured node operation (remove, duplicate, move, insert, text, wrap, unwrap, detach) from the board or tools. */
  edit({ documentId, expectedVersion, expectedRender, op, actor = 'user', group, label }) {
    return this.enqueue(async () => {
      const entry = this.getEntry(documentId);
      if (expectedVersion !== entry.document.version) fail('REVISION_CONFLICT', `Expected frame version ${entry.document.version}; received ${expectedVersion}. Read the frame again.`, { actualVersion: entry.document.version });
      this.assertWritable();
      const { patch, ids, removed } = operationPatch(entry.document, op, { frame: id => this.documents.get(id)?.document, usedBy: this.usedBy(documentId) });
      const subject = (op.ids ?? [op.id ?? ids?.[0]]).filter(Boolean);
      const verb = { remove: 'delete', duplicate: 'duplicate', move: 'move', insert: 'add', text: 'edit text of', wrap: 'wrap', unwrap: 'unwrap', detach: 'detach', rename: 'rename' }[op.type] ?? op.type;
      const result = await this._patch({ documentId, expectedVersion, expectedRender, patch, actor, group, label: label ?? `${verb} ${subject.slice(0, 3).join(', ')}${subject.length > 3 ? ` +${subject.length - 3}` : ''}`.trim() });
      return { ...result, ids: ids ?? [], removed: removed ?? [] };
    });
  }

  /** Shift a proposed artboard rectangle to the right until it no longer overlaps another artboard. */
  freeSpot(rect, gap = 80, extra = []) {
    const others = [...this.documents.values()].map(entry => entry.document.artboard).concat(extra);
    let next = { ...rect };
    for (let attempt = 0; attempt < 500; attempt++) {
      const hit = others.find(o => next.x < o.x + o.width + gap && next.x + next.width + gap > o.x && next.y < o.y + o.height + gap && next.y + next.height + gap > o.y);
      if (!hit) return next;
      next = { ...next, x: hit.x + hit.width + gap };
    }
    return next;
  }

  /** Create a blank frame, or a copy of an existing one placed to its right. */
  createArtboard({ name, width, height, x, y, from, expectedVersion, actor = 'user', group, label } = {}) {
    return this.enqueue(async () => {
      const taken = new Set(this.documents.keys());
      const slug = String(name || (from ? `${this.getEntry(from).document.name} copy` : 'artboard')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '') || 'artboard';
      let id = slug;
      for (let n = 2; taken.has(id); n++) id = `${slug}-${n}`;
      let document;
      if (from) {
        assertExpectedVersion(expectedVersion, this.getEntry(from).document, 'duplicated frame');
        const source = structuredClone(this.getEntry(from).document);
        const proposed = { ...source.artboard, x: x ?? source.artboard.x + source.artboard.width + 80, y: y ?? source.artboard.y };
        // A copy shares the original's components instead of defining look-alike ones.
        for (const node of Object.values(source.nodes)) {
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

  removeDocument({ documentId, expectedVersion, actor = 'user', group, label }) {
    return this.enqueue(() => this._remove(documentId, { expectedVersion, actor, group, label }));
  }



  async _applyEntry(entry, direction, actor) {
    this.assertWritable();
    const undoing = direction === 'undo';
    const items = undoing ? [...entry.items].reverse() : entry.items;
    const previous = this.documents;
    const previousSettings = this.settings;
    const frames = new Map([...previous].map(([id, item]) => [id, item.document]));
    let settings = previousSettings;
    let prepared;
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
          frames.set(item.documentId, item.document);
        }
      }
      for (const [id, frame] of frames) {
        const current = previous.get(id)?.document;
        if (current) frames.set(id, sameDocument(current, frame) ? current : { ...frame, version: current.version + 1 });
      }
      settings = { ...settings, version: previousSettings.version + (sameSettings(previousSettings, settings) ? 0 : 1) };
      prepared = await this.prepareAll([...frames.keys()], frames, settings);
    } catch (error) {
      fail('CANNOT_UNDO', `This step no longer applies cleanly (${error.message}).`);
    }
    const next = new Map([...prepared].map(([id, item]) => [id, this.entryFor(item, previous.get(id))]));
    const removed = [...previous.keys()].filter(id => !next.has(id));
    const write = [...next].filter(([id, item]) => !sameSettings(previousSettings, settings) || !previous.has(id) || !sameDocument(previous.get(id).document, item.document) || previous.get(id).fileHtml !== item.fileHtml).map(([id]) => id);
    await this.persist(next, { settings, write, removed: removed.map(id => previous.get(id)) });
    this.documents = next;
    this.settings = settings;
    this.work = this.work.filter(item => next.has(item.documentId));
    for (const id of removed) this.observations.delete(id);
    if (removed.length) {
      this.selection = { ...this.selection, ids: this.selection.ids.filter(id => next.has(id)), revision: this.selection.revision + 1 };
      if (this.selection.selectedNodes && !next.has(this.selection.selectedNodes.documentId)) delete this.selection.selectedNodes;
    }
    this.revision++;
    await this.refreshSite();
    const group = this.newGroup();
    const meta = { actor, group, kind: direction, label: entry.label };
    if (!sameSettings(previousSettings, settings)) this.record({ ...meta, documentId: null, name: settings.name, text: `project ${SETTINGS_FIELDS.filter(key => !isDeepStrictEqual(previousSettings[key], settings[key])).join(', ')}` });
    for (const [id, current] of next) {
      const from = previous.get(id)?.document;
      const to = current.document;
      if (from && sameDocument(from, to)) continue;
      this.record({ ...meta, documentId: id, fromVersion: from?.version, toVersion: to.version, from: from ?? { ...to, nodes: {} }, to });
    }
    for (const id of removed) {
      const from = previous.get(id).document;
      this.record({ ...meta, documentId: id, name: from.name, fromVersion: from.version, from, to: { ...from, nodes: {} }, text: `removed “${from.name}” (its files are in divlet/.trash)` });
    }
  }

  _step(from, to, direction, { documentId, actor = 'user' } = {}) {
    return this.enqueue(async () => {
      let index = -1;
      for (let i = from.length - 1; i >= 0; i--) if (!documentId || from[i].items.some(item => item.documentId === documentId || item.documentIds?.includes(documentId))) { index = i; break; }
      if (index < 0) fail('NOTHING_TO_UNDO', direction === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.');
      const [entry] = from.splice(index, 1);
      try { await this._applyEntry(entry, direction, actor); }
      catch (error) { from.splice(index, 0, entry); throw error; }
      to.push(entry);
      this.publish();
      return { ...this.historyHead(), label: entry.label };
    });
  }

  undo(options) {
    return this._step(this.undoStack, this.redoStack, 'undo', options);
  }

  redo(options) {
    return this._step(this.redoStack, this.undoStack, 'redo', options);
  }

  /* ---- Pi on the board ---------------------------------------------------- */

  /** Update what the board shows about the agent (connected, busy, current activity). */
  setAgent(patch = {}) {
    const next = { ...this.agent, ...patch };
    if (next.busy && !this.agent.busy) next.since = new Date().toISOString();
    if (!next.busy) { next.since = null; next.activity = null; next.queued = 0; }
    // The agent stopped: nothing is being worked on any more.
    const cleared = !next.busy && this.work.length > 0;
    if (cleared) this.work = [];
    if (isDeepStrictEqual(next, this.agent) && !cleared) return this.agent;
    this.agent = next;
    this.publish();
    return this.agent;
  }

  /**
   * The agent announces where it is working: a whole frame (no nodeIds) or elements of it. The
   * board animates those areas until the agent's turn ends, or `clearWork`. By default a call
   * replaces earlier areas; `add: true` keeps them.
   */
  markWork({ documentId, nodeIds = [], note, add = false } = {}) {
    const entry = this.getEntry(documentId);
    const ids = [...new Set((Array.isArray(nodeIds) ? nodeIds : [nodeIds]).filter(id => typeof id === 'string'))].slice(0, 50);
    const unknown = ids.filter(id => !Object.hasOwn(entry.document.nodes, id));
    if (unknown.length) fail('NOT_FOUND', `Frame ${documentId} has no node ${unknown.slice(0, 5).join(', ')}. Read the frame for node IDs, or omit nodeIds to mark the whole frame.`);
    const text = typeof note === 'string' ? note.trim().slice(0, 120) : '';
    const area = { documentId, nodeIds: ids, ...(text ? { note: text } : {}), at: new Date().toISOString() };
    const kept = add ? this.work.filter(item => !(item.documentId === documentId && isDeepStrictEqual(item.nodeIds, ids))) : [];
    this.work = [...kept, area].slice(-10);
    this.publish();
    return { marked: area, work: this.work.length };
  }

  /** Folders for the picker (names only). */
  browse(input) { return inspectPath(input, this.cwd); }

  /** Open another project from the board: returns the address to go to. `create` starts an empty project in an existing folder. */
  /** `{ source, changed }` when this project was imported from a file (changed: the file differs from what was imported). */
  importStatus() { return importStatus(this.projectPath, this.settings.metadata); }

  /** Import the source file again as a new project beside it; this project stays untouched. */
  importAgain() { return importAgain(this.projectPath, this.settings.metadata); }

  async openProject({ path: input, create = false } = {}) {
    if (!this.host) fail('NO_HOST', 'This board was not started by divlet itself, so it cannot open other projects. Start it with `divlet` or from Pi.');
    const target = expandPath(input, this.cwd);
    const info = await inspectPath(target, this.cwd);
    if (info.kind === 'missing') fail('NOT_FOUND', `${target} does not exist.`);
    if (create) {
      if (info.kind === 'project') fail('ALREADY_EXISTS', `${target} already holds a project.`);
      await initProject(path.extname(target) === '.divlet' ? target : path.join(target, PROJECT_FILE));
    }
    return this.host.open(target);
  }

  /**
   * Copy the selected source and its authored asset/site folders into a new or empty folder.
   * Never recursively copy the workspace: it may contain other projects or private files.
   */
  saveAs({ path: input, expectedVersion, expectedFormat } = {}) {
    return this.enqueue(async () => {
      assertExpectedVersion(expectedVersion, this.settings, 'project');
      if (!this.host) fail('NO_HOST', 'This board was not started by divlet itself, so it cannot open the saved copy.');
      if (expectedFormat !== undefined && expectedFormat !== 'divlet') fail('REVISION_CONFLICT', 'The project format changed. Reopen the copy dialog before saving.', { actualVersion: this.settings.version, actualFormat: 'divlet' });
      this.assertWritable();
      const target = expandPath(input, this.cwd);
      const within = (outer, inner) => inner === outer || inner.startsWith(outer + path.sep);
      if (within(this.projectDir, target)) fail('INVALID_TARGET', 'Choose a folder outside this project.');
      let entries = null;
      try { entries = await fs.readdir(target); } catch (error) { if (error.code !== 'ENOENT') fail('INVALID_TARGET', `${target} is not a folder.`); }
      if (entries?.length) fail('INVALID_TARGET', `${target} is not empty. Choose a new or empty folder.`);
      const copyFile = path.join(target, path.basename(this.projectPath));
      const copyOutput = new OutputStore(copyFile, this.settings.outputDir).directory;
      const copySettings = !within(target, copyOutput) || copyOutput === this.outputDir ? { ...this.settings, outputDir: null } : this.settings;
      await safeDirectory(target, { create: true });
      const sources = [path.basename(this.projectPath), 'assets', 'site.json', this.site?.config.contentDir, ...[...this.staticSources.keys()].map(file => path.relative(this.projectDir, file))].filter(Boolean);
      for (const relative of new Set(sources)) {
        const source = path.resolve(this.projectDir, relative);
        if (!inside(this.projectDir, source)) fail('UNSAFE_PATH', 'A copy source escapes the project directory.');
        if (!await fs.lstat(source).then(() => true, () => false)) continue;
        if (source === this.projectPath) {
          await fs.writeFile(copyFile, writeProject(copySettings, [...this.documents.values()].map(entry => entry.document)), { flag: 'wx' });
          continue;
        }
        await fs.cp(source, path.join(target, relative), { recursive: true, filter: async file => {
          const stat = await fs.lstat(file);
          if (stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Symbolic links are not copied as project sources.');
          if (stat.isDirectory() && await fs.lstat(path.join(file, '.divlet-build.json')).then(() => true, () => false)) return false;
          return !path.basename(file).startsWith('.') && !isProjectFile(file) || file === this.projectPath;
        } });
      }
      const opened = await this.host.open(target);
      return { ...opened, dir: target };
    });
  }


  /** Stop the animation: for one frame, or everywhere. */
  clearWork({ documentId } = {}) {
    const before = this.work.length;
    this.work = documentId ? this.work.filter(item => item.documentId !== documentId) : [];
    if (this.work.length !== before) this.publish();
    return { cleared: before - this.work.length };
  }

  /** Describe explicit board selection for a request: artboards, and nodes inside one of them. */
  askContext({ ids, nodes } = {}) {
    const documents = (Array.isArray(ids) ? ids : this.selection.ids).filter(id => typeof id === 'string' && this.documents.has(id)).slice(0, 20);
    const context = { documents: documents.map(id => { const doc = this.documents.get(id).document; return { id, name: doc.name, version: doc.version }; }) };
    const target = nodes && typeof nodes === 'object' ? nodes : (this.selection.selectedNodes ?? null);
    const entry = target && this.documents.get(target.documentId);
    if (entry && documents.length === 1 && documents[0] === target.documentId && Array.isArray(target.nodeIds)) {
      const doc = entry.document;
      const label = id => {
        const node = doc.nodes[id];
        if (node.type === 'text') return `text#${id} “${node.content.replace(/\s+/g, ' ').trim().slice(0, 40)}”`;
        if (node.type === 'ref') return `instance#${id} of ${node.ref.includes('/') ? node.ref : `${doc.id}/${node.ref}`}`;
        const textId = node.children.length === 1 && doc.nodes[node.children[0]].type === 'text' ? node.children[0] : null;
        const sample = textId ? doc.nodes[textId].content.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
        return `${node.tag}#${id}${sample ? ` “${sample}”` : ''}`;
      };
      const valid = target.nodeIds.filter(id => typeof id === 'string' && Object.hasOwn(doc.nodes, id)).slice(0, 30);
      if (valid.length) context.nodes = { documentId: doc.id, ids: valid, labels: valid.map(label) };
    }
    return context;
  }

  /**
   * The user message an agent receives for a board request. The context is one compact prompt block, in the shape the other
   * adapters use: a bracketed English header with `|key:value` metadata, its value on the same line, lists from the next line
   * in Markdown, then the request itself after a blank line. Nothing is described twice: the lists are the details of the one
   * sentence that follows the header, and the skill carries the workflow.
   */
  askMessage(text, context) {
    // Names come from the user and may hold line breaks; a list item must stay one line.
    const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const frames = context.documents.map(frame => ({ ...frame, name: oneLine(frame.name) }));
    const nodes = context.nodes;
    const header = ['divlet', `project:${this.projectId}`, `frames:${frames.length}`];
    if (nodes) header.push(`nodes:${nodes.ids.length}`);
    const summary = nodes
      ? `${frames.length === 1 ? `about “${frames[0].name}” with` : 'in'} ${nodes.ids.length} selected element${nodes.ids.length === 1 ? '' : 's'}`
      : frames.length === 1 ? `about “${frames[0].name}”`
        : frames.length ? `about ${frames.length} frames`
          : 'about the project as a whole; nothing is selected';
    const lines = [`[${header.join('|')}] ${summary}`];
    if (frames.length) {
      lines.push('frames:');
      for (const frame of frames) lines.push(`- ${frame.id} · v${frame.version} · “${frame.name}”`);
    }
    if (nodes) {
      lines.push(`elements in ${nodes.documentId}:`);
      for (const label of nodes.labels) lines.push(`- ${label}`);
    }
    lines.push('next:', '- read_divlet before changing anything', '- edit_divlet for structure, patch_divlet for classes, text and components', '- Tailwind classes first, custom css only as an exception (the divlet skill explains the workflow)');
    return `${lines.join('\n')}\n\n${text}`;
  }

  /** A request typed on the board. The Pi extension listens for `ask` and starts (or queues) a turn. */
  ask({ text, ids, nodes } = {}) {
    const request = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '';
    if (!request) fail('INVALID_ASK', 'Write what you would like Pi to do.');
    if (request.length > MAX_ASK) fail('INVALID_ASK', `Keep a request under ${MAX_ASK} characters.`);
    if (!this.agent.connected || !this.listenerCount('ask')) fail('NO_AGENT', 'No agent is connected to this board. Open it from Pi with /divlet, or connect an MCP client (divlet-mcp) that supports sampling.');
    const context = this.askContext({ ids, nodes });
    const queued = this.agent.busy;
    const first = request.split('\n')[0];
    const change = this.record({ actor: 'user', kind: 'ask', documentId: context.nodes?.documentId ?? context.documents[0]?.id ?? null, name: context.documents[0]?.name, text: first.length > 120 ? `${first.slice(0, 119)}…` : first, message: request, context });
    if (queued) this.setAgent({ queued: this.agent.queued + 1 });
    this.emit('ask', { text: request, message: this.askMessage(request, context), context, seq: change.seq, queued });
    return { ok: true, seq: change.seq, queued };
  }

  /**
   * Ask the connected agent host to change the model or the thinking level of the session that answers this board. Only a host
   * that advertised these controls (the Pi extension does; an MCP client cannot) may be asked, and only for a value it offered:
   * the board never guesses a model name, and the host applies the change and reports the effective values back through
   * `setAgent({ controls })`. Nothing is written to the project — this is session state, not content.
   */
  applyAgentSetting({ model, thinking } = {}) {
    const controls = this.agent.controls || {};
    if (!controls.model && !controls.thinking) fail('NO_AGENT_CONTROLS', 'This agent host cannot change the model or the thinking level (an MCP client can only answer prompts). Open the board from Pi for that.');
    if (model !== undefined && !controls.model) fail('NO_AGENT_CONTROLS', 'This agent host cannot change the model.');
    if (thinking !== undefined && !controls.thinking) fail('NO_AGENT_CONTROLS', 'This agent host cannot change the thinking level.');
    if (model === undefined && thinking === undefined) fail('INVALID_AGENT_SETTING', 'Send a model, a thinking level, or both.');
    if (model !== undefined && (typeof model !== 'string' || !(controls.model.options || []).some(option => option.id === model))) fail('INVALID_AGENT_SETTING', `Unknown model: ${String(model)}. The host offers ${(controls.model.options || []).map(option => option.id).join(', ') || 'none'}.`);
    if (thinking !== undefined && (typeof thinking !== 'string' || !(controls.thinking.options || []).includes(thinking))) fail('INVALID_AGENT_SETTING', `Unknown thinking level: ${String(thinking)}. The host offers ${(controls.thinking.options || []).join(', ')}.`);
    if (!this.listenerCount('agent-setting')) fail('NO_AGENT', 'No agent is connected to this board.');
    // Only the keys that were asked for: a host must not read "model: undefined" as "clear the model".
    this.emit('agent-setting', { ...(model !== undefined ? { model } : {}), ...(thinking !== undefined ? { thinking } : {}) });
    return { ok: true };
  }

  /** Pi's answer to the conversation, shown in the board history. */
  say({ text, seq } = {}) {
    const reply = typeof text === 'string' ? text.trim() : '';
    if (!reply) return null;
    const message = reply.length > MAX_REPLY ? `${reply.slice(0, MAX_REPLY - 1)}…` : reply;
    const first = message.split('\n').find(line => line.trim()) ?? '';
    return this.record({ actor: 'agent', kind: 'reply', documentId: null, text: first.length > 120 ? `${first.slice(0, 119)}…` : first, message, context: seq ? { replyTo: seq } : undefined });
  }

  /** Ask the extension to abort the running agent turn. */
  stopAgent() {
    if (!this.agent.busy) fail('NOT_BUSY', 'Pi is not working right now.');
    if (!this.listenerCount('stop')) fail('NO_AGENT', 'No agent is connected to this board.');
    this.emit('stop');
    return { ok: true };
  }

  /* ---- export and assets --------------------------------------------------- */



  /** Clean HTML of a whole artboard (standalone page) or of one node (fragment). */
  exportDocument(id, { nodeId } = {}) {
    const entry = this.getEntry(id);
    // Instances are exported as the elements they render.
    const expanded = expandFrame(entry.document, frameId => this.documents.get(frameId)?.document, this.settings).document;
    if (nodeId) {
      if (!Object.hasOwn(entry.document.nodes, nodeId)) fail('NOT_FOUND', `Unknown node: ${nodeId}`);
      return { documentId: id, version: entry.document.version, nodeId, html: exportHtml(expanded, { nodeId, limits: LIMITS }) };
    }
    const compiled = /<style data-divlet-compiled>([\s\S]*?)<\/style>/.exec(entry.html)?.[1] ?? '';
    return { documentId: id, version: entry.document.version, html: exportHtml(expanded, { compiledCss: compiled, limits: LIMITS }), fileName: `${path.basename(entry.htmlPath, '.html')}.html` };
  }

  /** Authored asset URLs always resolve beside the project source, never in generated output. */
  documentDir(documentId) {
    if (documentId) this.getEntry(documentId);
    return this.projectDir;
  }

  /** Local images inside divlet/, as URLs relative to the given document. */
  /** Tokens and css a frame renders with: the project's, then its own. */
  styleContext(documentId) {
    const { document } = this.getEntry(documentId);
    return { tokens: { ...this.settings.tokens, ...document.tokens }, css: [this.settings.css, document.css].filter(Boolean).join('\n') };
  }

  /** What each class does in a frame: Tailwind CSS, the custom rule behind it, or nothing. */
  async explainClasses({ documentId, names }) {
    const list = (Array.isArray(names) ? names : String(names || '').split(/\s+/)).filter(Boolean).slice(0, 200);
    const context = this.styleContext(documentId);
    warmSuggestions(context.tokens, PACKAGE_ROOT);
    return { documentId, classes: await explainClasses({ ...context, names: list, base: PACKAGE_ROOT }) };
  }

  /** Classes to offer while typing in a frame; ones the project already uses come first. */
  async suggestClasses({ documentId, query, limit = 10 }) {
    const counts = new Map();
    for (const entry of this.documents.values()) for (const node of Object.values(entry.document.nodes)) for (const name of (node.className || '').split(/\s+/)) if (name) counts.set(name, (counts.get(name) || 0) + 1);
    const used = [...counts].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    return { documentId, query, items: await suggestClasses({ ...this.styleContext(documentId), query: String(query || '').slice(0, 120), used, limit: Math.min(20, Math.max(1, Number(limit) || 10)), base: PACKAGE_ROOT }) };
  }

  async listAssets({ documentId } = {}) {
    const from = this.documentDir(documentId);
    const found = [];
    const walk = async directory => {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (item.name.startsWith('.') || found.length >= 300) continue;
        const full = path.join(directory, item.name);
        if (item.isDirectory()) {
          if (full === this.outputDir || await fs.lstat(path.join(full, '.divlet-build.json')).then(() => true, () => false)) continue;
          await walk(full);
        }
        else if (item.isFile() && IMAGE_EXTENSIONS.has(path.extname(item.name).toLowerCase())) {
          const stat = await fs.stat(full);
          found.push({ path: path.relative(from, full).split(path.sep).join('/'), file: path.relative(this.projectDir, full).split(path.sep).join('/'), size: stat.size, modified: stat.mtime.toISOString() });
        }
      }
    };
    await walk(this.projectDir);
    found.sort((a, b) => b.modified.localeCompare(a.modified));
    return { documentId: documentId ?? null, assets: found };
  }



  /** Explicit library-only new intent, not an upload retry. HTTP/browser/Pi adapters remain separate. */
  reuseImage(input = {}) { return this._reuseImage(input); }








  /** Publish a new authored image without replacing another upload or a caller-owned file. */
  async saveAsset({ name, data, documentId }) {
    this.assertWritable();
    return this._publishAsset({ name, data, documentId }, () => this.assertWritable());
  }

  async _publishAsset({ name, data, documentId }, admit) {
    const { extension, bytes } = imageUpload(name, data), from = this.documentDir(documentId);
    const directory = path.join(this.projectDir, 'assets');
    const stem = path.basename(String(name), path.extname(String(name))).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
    const sameFile = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
    let directoryStat, stageStat, payloadStat, file, published = false, failure;
    const retained = [];
    const checkDirectory = async (create = false) => {
      await admit();
      if (inside(this.outputDir, directory)) fail('INVALID_ASSET_DIR', 'Authored uploads cannot be stored in generated output.');
      await safeDirectory(directory);
      for (let current = directory; ; current = path.dirname(current)) {
        try { await fs.lstat(path.join(current, '.divlet-build.json')); fail('INVALID_ASSET_DIR', 'Authored uploads cannot be stored in generated output.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (current === path.dirname(current)) break;
      }
      if (create) await safeDirectory(directory, { create: true });
      const stat = await fs.lstat(directory, { bigint: true });
      if (!stat.isDirectory() || directoryStat && !sameFile(stat, directoryStat)) fail('ASSET_CONFLICT', 'The upload directory changed during preparation.');
      directoryStat ??= stat;
    };
    await checkDirectory(true);
    const stage = await fs.mkdtemp(path.join(directory, '.divlet-upload-')), payload = path.join(stage, 'image');
    const checkStage = async () => {
      await checkDirectory();
      await safeDirectory(stage);
      if (!sameFile(await fs.lstat(stage, { bigint: true }), stageStat)) fail('ASSET_CONFLICT', 'The private upload stage changed.');
    };
    const checkPayload = async target => {
      const stat = await fs.lstat(target, { bigint: true });
      if (!stat.isFile() || !sameFile(stat, payloadStat) || stat.size !== BigInt(bytes.length) || !(await readResourceBytes(target)).equals(bytes)) fail('ASSET_CONFLICT', 'Prepared upload bytes or identity changed.');
    };
    try {
      stageStat = await fs.lstat(stage, { bigint: true });
      await checkStage();
      const handle = await fs.open(payload, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o666);
      try { payloadStat = await handle.stat({ bigint: true }); await handle.writeFile(bytes); }
      finally { await handle.close(); }
      for (let n = 1; ; n++) {
        await checkStage(); await checkPayload(payload);
        await admit();
        file = path.join(directory, `${stem}${n === 1 ? '' : '-' + n}${extension}`);
        try { await fs.link(payload, file); published = true; break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; file = undefined; }
      }
      await checkStage(); await checkPayload(file);
    } catch (error) { failure = error; }
    // Inspect an ambiguous link while the private payload still anchors its identity.
    if (failure && file && !published) {
      published = null;
      try {
        await checkDirectory();
        try { await fs.lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; published = false; }
        if (published !== false) { await checkStage(); await checkPayload(file); published = true; }
      } catch { /* A failed inspection is not proof that publication did not happen. */ }
    }
    // Cleanup never follows replaced directories or removes bytes whose custody was lost.
    try {
      await checkStage();
      try { await checkPayload(payload); await fs.unlink(payload); }
      catch (error) { if (error.code !== 'ENOENT') retained.push(payload); }
      try {
        if (!sameFile(await fs.lstat(stage, { bigint: true }), stageStat)) throw new Error('Upload stage replaced.');
        await fs.rmdir(stage);
      } catch (error) { if (error.code !== 'ENOENT') retained.push(stage); }
    } catch { retained.push(stage); }
    if (!failure) {
      try { await checkDirectory(); await checkPayload(file); } catch (error) { failure = error; }
    }
    if (failure) {
      if (published !== false && file) retained.push(file);
      failure.code ??= 'ASSET_WRITE_FAILED';
      failure.details = { ...failure.details, asset: { file: file ? path.relative(this.projectDir, file).split(path.sep).join('/') : null, published, retained: [...new Set(retained)] } };
      throw failure;
    }
    return { path: path.relative(from, file).split(path.sep).join('/'), file: path.relative(this.projectDir, file).split(path.sep).join('/'), size: bytes.length, ...(retained.length ? { retained: [...new Set(retained)] } : {}) };
  }

  /**
   * The board's selection is ephemeral UI state, not a commit: a frame or node that was deleted a moment ago is simply dropped
   * from it (a stale client is not an error); only malformed input is refused.
   */
  setSelection({ ids, nodes }) {
    if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string')) fail('INVALID_SELECTION', 'Selection must be a list of document IDs.');
    const next = { ids: [...new Set(ids.filter(id => this.documents.has(id)))], revision: this.selection.revision + 1 };
    if (nodes) {
      if (!Array.isArray(nodes.nodeIds) || nodes.nodeIds.length > 100 || nodes.nodeIds.some(id => typeof id !== 'string')) fail('INVALID_SELECTION', 'Selected nodes must be a list of node IDs.');
      const entry = this.documents.get(nodes.documentId);
      const alive = entry && next.ids.length === 1 && next.ids[0] === nodes.documentId ? nodes.nodeIds.filter(id => entry.document.nodes[id]) : [];
      if (alive.length) next.selectedNodes = { documentId: nodes.documentId, nodeIds: [...new Set(alive)], version: entry.document.version };
    }
    this.selection = next;
    this.publish();
    return this.info();
  }

  setObservations({ documentId, version, nodes, contentHeight, scrollHeight }) {
    const entry = this.getEntry(documentId);
    // Frames report the render revision they show; a dependency can re-render a frame without a new model version.
    if (version !== entry.render) fail('STALE_PREVIEW', 'Ignoring observations from an older render of this frame.');
    if (!Array.isArray(nodes) || nodes.length > 300) fail('INVALID_OBSERVATIONS', 'Expected at most 300 observed nodes.');
    const clean = nodes.map(node => {
      if (!node || !entry.document.nodes[node.id] || !node.rect || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(node.rect[key]) || Math.abs(node.rect[key]) > 1e7) || node.rect.width < 0 || node.rect.height < 0) fail('INVALID_OBSERVATIONS', 'Invalid observed node geometry.');
      return { id: node.id, rect: { x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height }, overflowX: !!node.overflowX, overflowY: !!node.overflowY };
    });
    const page = {};
    for (const [key, value] of Object.entries({ contentHeight, scrollHeight })) if (Number.isFinite(value) && value >= 0 && value < 1e7) page[key] = Math.round(value);
    this.observations.set(documentId, { documentId, version: entry.document.version, render: entry.render, viewport: { width: entry.document.artboard.width, height: entry.document.artboard.height }, ...page, nodes: clean, receivedAt: new Date().toISOString() });
    return { ok: true };
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearInterval(this.timer);
    this.closePromise = (async () => {
      await this.queue;
      this.closed = true;
      await unregisterBoard({ file: this.projectPath, url: this.url });
      await this.server?.close();
      this.removeAllListeners();
    })();
    return this.closePromise;
  }
}

export async function openRuntime(options = {}) {
  const found = await resolveProject(options.file || options.dir || options.cwd || process.cwd());
  if (found.kind === 'collection') fail('PROJECT_REQUIRED', 'Several project files are available. Open a specific .divlet or .pen file.');
  const runtime = new DivletRuntime({ file: found.file, watch: options.watch !== false, externalFiles: options.externalFiles });
  try {
    return await runtime.start({ ...options, requireSource: found.kind === 'project' });
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
