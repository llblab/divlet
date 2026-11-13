/*
 * Owns: the static-site composition of the real board — one browser-local copy of a published project, the board's host ports
 * over the browser writer, and the same contract tools exposed to agents through the page's browser MCP provider (and WebMCP
 * when the browser has it). Excludes: the board UI itself (`@divlet/web`), any network service and the Node host's file,
 * output, asset, font, site and conversation capabilities, which are absent here rather than emulated.
 *
 * Storage policy: the visitor's copy lives in this origin's IndexedDB, keyed by `storageKey` and tied to the fingerprint of the
 * published source it started from. When the publication changes, the copy starts again from the new source. Nothing is
 * uploaded; a private project is never fetched or paired.
 */
import { BrowserRuntime } from './browser-runtime.ts';
import { inputSchema, forAgent } from './tools.ts';
import { sameJson } from './validation.ts';
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
  readonly target?: object;
}

const HOST_KEY = Symbol.for('divlet.board-host/1');
const READ_ONLY = new Set(['read_divlet']);

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

async function fingerprint(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A tiny IndexedDB key/value store; every failure resolves to "nothing stored" so storage problems never block opening. */
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

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The preview page of one frame: the rendered HTML, a meta CSP and the static preview bridge with its arguments in a meta tag.
 * A blob preview inherits the board page's CSP, so the bridge is a same-site script file rather than an inline script.
 */
export function previewDocument(html: string, id: string, render: number, bridge: string, bridgeUrl: string): string {
  const token = /^[a-f0-9-]{36}$/i.test(bridge) ? bridge : '';
  const csp = `default-src 'none'; img-src data: https: blob:; media-src data: https:; style-src 'unsafe-inline'; font-src data: https:; script-src ${bridgeUrl}; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}"><meta name="divlet-bridge" content="${escapeAttribute(JSON.stringify({ id, render, token }))}">`;
  return html.replace(/<head([^>]*)>/i, `<head$1>${meta}`).replace(/<\/body>(\s*<\/html>\s*)?$/i, `<script src="${escapeAttribute(bridgeUrl)}"></script></body>$1`);
}

/** The static bridge file: the trusted serialized preview bridge, started with the arguments its page carries. */
export function previewBridgeScript(bridgeSource: string): string {
  return `(()=>{const m=document.querySelector('meta[name="divlet-bridge"]');if(!m)return;const a=JSON.parse(m.content);(${bridgeSource})(a.id,a.render,a.token,false,false);})();\n`;
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
  const compiler = snapshotCompiler(styles);
  const persist = (text: string) => store.put(options.storageKey, { base, text, savedAt: new Date().toISOString() });
  const open = (source: string) => BrowserRuntime.open({ source, file: options.file, projectId: `browser-${base.slice(0, 16)}`, compiler, persist, capabilities: { browser: true, assets: false, export: false } });
  let runtime: BrowserRuntime;
  let restored = false;
  if (stored?.base === base && typeof stored.text === 'string') {
    try { runtime = await open(stored.text); restored = true; }
    catch { await store.delete(options.storageKey).catch(() => {}); runtime = await open(published); }
  } else {
    if (stored) await store.delete(options.storageKey).catch(() => {});
    runtime = await open(published);
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
    historyService: Object.freeze({
      readRecent: async () => copy(runtime.readHistory({ limit: 100 })),
      navigate: async (target: any) => copy(await runtime.navigateHistory({ ...target, actor: 'user' })),
    }),
    // Selection and measurements are shared with the browser writer, so an agent reads what the visitor selected and sees.
    shareSelection: async (selection: any) => copy(runtime.setSelection(copy(selection))),
    publishObservations: async (report: any) => copy(runtime.setObservations(copy(report))),
  });
  Object.defineProperty(target, HOST_KEY, { value: composition, configurable: false, enumerable: false, writable: false });

  /* ---- the agent surface: the same contract tools ------------------------------------------------- */
  let running = 0;
  const tools: BrowserTool[] = runtime.tools().map(tool => ({
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: inputSchema(tool),
    annotations: READ_ONLY.has(tool.name) ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } : { readOnlyHint: false, destructiveHint: tool.name !== 'mark_divlet', openWorldHint: false },
    async execute(args: Record<string, unknown>) {
      running++;
      runtime.setAgent({ connected: true, busy: true, activity: tool.title ?? tool.name, queued: running - 1 });
      try { return forAgent(await runtime.callTool(tool.name, args)); }
      finally { running--; runtime.setAgent(running ? { busy: true, queued: running - 1 } : { busy: false }); }
    },
  }));
  const registry = defineTools(tools);
  const provider = createBrowserMcpProvider({
    name: 'divlet', title: 'divlet in the browser', version: options.version, tools: registry,
    instructions: `divlet is a layout board for agents. This page holds a browser-local copy of the ${options.file} project (HTML/SVG/CSS frames), stored only in this browser. Read the project with read_divlet, then change it with patch_divlet or edit_divlet using the versions you read; frame_divlet adds or removes frames and undo_divlet reverts. The visitor watches every change live. Utility classes are not compiled here: style with the frame css or inline style. Files, fonts, embedded assets and opening other projects need the local divlet host (npx -y @divlet/mcp).`,
  });
  exposeBrowserMcp(provider, target);
  const webmcp = await registerWebMcpTools(registry);
  return { runtime, restored, webmcp: webmcp.registered, base };
}
