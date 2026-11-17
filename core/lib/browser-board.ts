/*
 * Owns: the static-site composition of the real board — one browser-local copy of a published project, the board's host ports
 * over the browser writer, and the same contract tools exposed to agents through the page's browser MCP provider (and WebMCP
 * when the browser has it). Excludes: the board UI itself (`@divlet/web`), any network service and the Node host's file,
 * output, device-upload, site and conversation capabilities, which are absent here rather than emulated. Declared source bytes
 * require an explicit paired resource policy; the default entry does not select it.
 *
 * Storage policy: the visitor's copy lives in this origin's IndexedDB, keyed by `storageKey` and tied to the fingerprint of the
 * published source it started from. A refused restore retains the record and blocks startup. A changed publication replaces
 * the old baseline only after its source prepares successfully. Nothing is
 * uploaded; a private project is never fetched or paired.
 */
import { BrowserRuntime } from './browser-runtime.ts';
import type { BrowserPreviewProjector, BrowserResourcePolicy } from './browser-runtime.ts';
import { previewDocument } from './browser-preview.ts';
import { installBrowserStyleEngine } from './browser-style-engine.ts';
import type { StyleEngine } from './style-engines.ts';
export { previewDocument, previewBridgeScript } from './browser-preview.ts';
import { inputSchema, forAgent, toolByName } from './tools.ts';
import { DivletError, sameJson } from './validation.ts';
import type { FrameCompiler } from './prepare.ts';
import { createBrowserMcpProvider, exposeBrowserMcp, defineTools, registerWebMcpTools } from '@divlet/web/mcp';
import type { BrowserTool } from '@divlet/web/mcp';
import type { BoardHostComposition } from '@divlet/web/host';

/** Build-time compiled CSS, keyed by the token set it was compiled for (see `scripts/pages-build.mjs`). */
export interface StyleSnapshot { readonly entries: ReadonlyArray<{ readonly tokens: Record<string, string>; readonly candidates: readonly string[]; readonly css: string }> }

export interface BrowserBoardOptions {
  readonly projectUrl: URL;
  readonly stylesUrl: URL;
  readonly storageKey: string;
  readonly file: string;
  readonly version: string;
  /** The static preview bridge script (`previewBridgeScript()` output), served by the same site. */
  readonly bridgeUrl: URL;
  /** Trusted candidate projection for published and restored copies. Does not grant byte access or add capabilities. */
  readonly projectPreview?: BrowserPreviewProjector;
  /** Trusted opt-in source-byte admission/projection for published/restored copies; exclusive with projectPreview, not upload/node-export authority. */
  readonly resourcePolicy?: BrowserResourcePolicy;
  /**
   * A portable style provider the composition bundles (for example Tailwind). It compiles utilities in the page, lowers property
   * edits to its classes, and answers class explanations/suggestions. Absent: the board edits and renders native CSS, and utility
   * classes come from the build-time snapshot or nowhere. Supplied by trusted composition code, never by project data.
   */
  readonly styleEngine?: StyleEngine;
  /** Browser modules (`{ id, module }`) the page serves for the board, such as the engine's class editor. */
  readonly clientPlugins?: ReadonlyArray<{ readonly id: string; readonly module: string }>;
  /** The frame a first visit opens as a readable page (absent: the board fits all frames). */
  readonly entryFrame?: string;
  readonly target?: object;
}

const HOST_KEY = Symbol.for('divlet.board-host/1');
const READ_ONLY = new Set(['divlet_read']);

/**
 * The browser host compiles no utilities: it serves the build-time stylesheet for the frame's token set, and reports a class
 * as unknown when neither that build nor the frame's own CSS mentions it, so new utilities are diagnosed instead of dropped.
 */
export function snapshotCompiler(snapshot: StyleSnapshot): FrameCompiler {
  const pick = (tokens: Record<string, string>) => snapshot.entries.find(entry => sameJson(entry.tokens, tokens)) ?? snapshot.entries[0];
  return {
    compile: tokens => pick(tokens)?.css ?? '',
    unknown: ({ tokens, css, byNode }) => {
      const known = new Set(pick(tokens)?.candidates ?? []);
      const out: Record<string, string[]> = {};
      for (const [id, className] of Object.entries(byNode)) {
        const dead = className.split(/\s+/).filter(name => name && !known.has(name) && !css.includes(`.${name}`));
        if (dead.length) out[id] = dead;
      }
      return out;
    },
  };
}

/** A frame compiler over a portable provider: it compiles exactly the classes a frame uses, in the page. */
export function engineCompiler(engine: StyleEngine): FrameCompiler {
  const compile = engine.compileClasses;
  if (typeof compile !== 'function') throw new TypeError('A browser style engine must be able to compile classes.');
  return {
    compile: (tokens, candidates) => compile.call(engine, tokens, candidates),
    unknown: async input => (engine.unknownClasses ? engine.unknownClasses.call(engine, input) : {}),
  };
}

async function fingerprint(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A tiny IndexedDB key/value store; read failures resolve to "nothing stored", while write/delete failures reject. */
/** The DOM storage surface used here, typed locally: core's compiler profile has no DOM library. */
type Database = { transaction(store: string, mode?: string): any };
function browserStore(name = 'divlet-browser') {
  const open = () => new Promise<Database>((resolve, reject) => {
    const request = (globalThis as any).indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  let db: Promise<Database> | null = null;
  const handle = () => (db ??= open());
  return {
    async get(key: string): Promise<any> {
      try { const store = (await handle()).transaction('projects').objectStore('projects'); return await new Promise((resolve, reject) => { const request = store.get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
      catch { return undefined; }
    },
    async put(key: string, value: unknown): Promise<void> {
      const tx = (await handle()).transaction('projects', 'readwrite');
      tx.objectStore('projects').put(value, key);
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    },
    async delete(key: string): Promise<void> {
      const tx = (await handle()).transaction('projects', 'readwrite');
      tx.objectStore('projects').delete(key);
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    },
  };
}

/** Start the browser host and publish the board composition; resolves once the board can start. */
export async function startBrowserBoard(options: BrowserBoardOptions) {
  const target = options.target ?? globalThis;
  const [published, styles] = await Promise.all([
    fetch(options.projectUrl, { credentials: 'omit' }).then(response => { if (!response.ok) throw new Error(`The project could not be loaded (${response.status}).`); return response.text(); }),
    fetch(options.stylesUrl, { credentials: 'omit' }).then(response => { if (!response.ok) throw new Error(`The project styles could not be loaded (${response.status}).`); return response.json() as Promise<StyleSnapshot>; }),
  ]);
  const base = await fingerprint(published);
  const store = browserStore();
  const stored = await store.get(options.storageKey);
  if (options.styleEngine) installBrowserStyleEngine(options.styleEngine);
  const compiler = options.styleEngine ? engineCompiler(options.styleEngine) : snapshotCompiler(styles);
  const persist = (text: string) => store.put(options.storageKey, { base, text, savedAt: new Date().toISOString() });
  const open = (source: string) => BrowserRuntime.open({ source, file: options.file, projectId: `browser-${base.slice(0, 16)}`, compiler, styleEngine: options.styleEngine, clientPlugins: options.clientPlugins, persist, projectPreview: options.projectPreview, resourcePolicy: options.resourcePolicy, capabilities: { browser: true, assets: false, export: false, ...(options.resourcePolicy !== undefined ? { sourceAssets: true } : {}) } });
  let runtime: BrowserRuntime;
  let restored = false;
  if (stored?.base === base) {
    try {
      if (typeof stored.text !== 'string') throw new DivletError('INVALID_PROJECT', 'The saved browser copy has no project text.');
      runtime = await open(stored.text); restored = true;
    } catch (error: any) {
      const causeCode = typeof error?.code === 'string' ? error.code : error instanceof SyntaxError ? 'INVALID_PROJECT' : 'UNKNOWN';
      throw new DivletError('BROWSER_RESTORE_FAILED', `The saved browser copy could not be opened and was kept unchanged. ${error?.message || error}`, { causeCode });
    }
  } else {
    runtime = await open(published);
    if (stored) await store.delete(options.storageKey).catch(() => {});
  }
  runtime.url = new URL('./', (globalThis as any).location.href).href;

  /* ---- the board's ports ---------------------------------------------------------------------------- */
  const copy = <T>(value: T): T => structuredClone(value);
  const previews = new Map<string, Set<string>>();
  const composition: BoardHostComposition = Object.freeze({
    label: 'browser',
    readSession: Object.freeze({
      readState: async () => copy(runtime.info()),
      readFrame: async (id: string) => copy(runtime.read({ view: 'document', documentId: id })),
      subscribe(listener: (event: any) => void) {
        let active = true;
        queueMicrotask(() => { if (active) listener({ type: 'connection', status: 'connected' }); });
        const stop = runtime.subscribe((type, value) => { if (active) listener({ type, value: copy(value) }); });
        return () => { active = false; stop(); };
      },
    }),
    writer: Object.freeze({
      patch: async (body: any) => copy(await runtime.patch({ ...body, actor: 'user' })),
      edit: async (body: any) => copy(await runtime.edit({ ...body, actor: 'user' })),
      undo: async () => copy(await runtime.undo({ actor: 'user' })),
      redo: async () => copy(await runtime.redo({ actor: 'user' })),
      createArtboard: async (body: any) => copy(await runtime.createArtboard({ ...body, actor: 'user' })),
      deleteArtboard: async (body: any) => copy(await runtime.removeDocument({ ...body, actor: 'user' })),
    }),
    previews: Object.freeze({
      frameUrl(id: string, { bridge }: { bridge: string }) {
        const rendered = runtime.render(id);
        const url = URL.createObjectURL(new Blob([previewDocument(rendered.html, id, rendered.render, bridge, options.bridgeUrl.href)], { type: 'text/html' }));
        if (!previews.has(id)) previews.set(id, new Set());
        previews.get(id)!.add(url);
        return url;
      },
      readRender: async (id: string) => copy(runtime.render(id)),
      release(id: string, url: string) { if (previews.get(id)?.delete(url)) URL.revokeObjectURL(url); },
    }),
    components: Object.freeze({ list: async () => ({ components: copy(runtime.components()) }) }),
    ...(options.styleEngine ? { classes: Object.freeze({
      explain: async (documentId: string, names: readonly string[]) => copy(await runtime.explainClasses({ documentId, names: [...names] })),
      suggest: async (documentId: string, query: string, limit: number) => copy(await runtime.suggestClasses({ documentId, query, limit })),
    }) } : {}),
    exports: Object.freeze({
      page: async (id: string) => copy(await runtime.exportDocument(id)),
      project: async () => ({ text: runtime.source(), fileName: options.file }),
    }),
    historyService: Object.freeze({
      readRecent: async () => copy(runtime.readHistory({ limit: 100 })),
      navigate: async (target: any) => copy(await runtime.navigateHistory({ ...target, actor: 'user' })),
    }),
    // Selection and measurements are shared with the browser writer, so an agent reads what the visitor selected and sees.
    shareSelection: async (selection: any) => copy(runtime.setSelection(copy(selection))),
    publishObservations: async (report: any) => copy(runtime.setObservations(copy(report))),
    ...(options.entryFrame && runtime.documents.has(options.entryFrame) ? { initialView: Object.freeze({ expand: options.entryFrame, title: 'Edit on the board', published: !restored }) } : {}),
  });
  Object.defineProperty(target, HOST_KEY, { value: composition, configurable: false, enumerable: false, writable: false });

  /* ---- the agent surface: the same contract tools ------------------------------------------------- */
  let running = 0;
  const tools: BrowserTool[] = runtime.tools({ aliases: true }).map(tool => ({
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: inputSchema(tool),
    annotations: READ_ONLY.has(toolByName.get(tool.name)!.name) ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } : { readOnlyHint: false, destructiveHint: toolByName.get(tool.name)!.name !== 'divlet_mark', openWorldHint: false },
    async execute(args: Record<string, unknown>) {
      running++;
      runtime.setAgent({ connected: true, busy: true, activity: tool.title ?? tool.name, queued: running - 1 });
      try { return forAgent(await runtime.callTool(tool.name, args)); }
      finally { running--; runtime.setAgent(running ? { busy: true, queued: running - 1 } : { busy: false }); }
    },
  }));
  const registry = defineTools(tools);
  // Browser transports allow only listed tools, and WebMCP requires explicit alias registrations.
  const provider = createBrowserMcpProvider({
    name: 'divlet', title: 'divlet in the browser', version: options.version, tools: registry,
    instructions: `divlet is a layout board for agents. This page holds a browser-local copy of the ${options.file} project (HTML/SVG/CSS frames), stored only in this browser. Read the project with divlet_read, then change it with divlet_patch or divlet_edit using the versions you read; divlet_frame_manage adds or removes frames and divlet_undo reverts. The visitor watches every change live. ${options.styleEngine ? `Utility classes compile in this page (${options.styleEngine.label ?? options.styleEngine.id}); a styles patch ({ property: value }) is written as utilities, replacing the classes that set the same property.` : 'Utility classes are not compiled here: style with the frame css or inline style.'} ${options.resourcePolicy ? 'This composition accepts declared embedded source assets through its trusted projection policy; unsupported resource references may be refused. File/image/font-device upload, sites and opening other projects still need the local divlet host (npx -y @divlet/mcp).' : 'Files, fonts, embedded assets and opening other projects need the local divlet host (npx -y @divlet/mcp).'}`,
  });
  exposeBrowserMcp(provider, target);
  const webmcp = await registerWebMcpTools(registry);
  return { runtime, restored, webmcp: webmcp.registered, base };
}
