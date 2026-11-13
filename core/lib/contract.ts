/*
 * The one capability contract of divlet.
 *
 * Every host — the Pi extension, the MCP server, the CLI — offers the same operations with the same semantics, validation
 * rules, revision checks and domain errors. This module owns that contract: the tool list, its parameters in a small
 * host-neutral schema form, the shared result shaping (frames not documents, compact project views, large-frame outlines) and
 * the session that resolves a project to the board that owns it.
 *
 * Hosts translate the representation only: Pi renders the schemas as TypeBox and wraps results in its tool envelope, MCP
 * renders them as JSON Schema and answers with MCP content blocks, and both call `session.call(name, args)`.
 *
 * A session never opens a second writer for a project whose board is already alive: `boards.ts` knows which process owns it,
 * and the tool call is forwarded to that board's token-scoped `api/tool` route, so every client reads the same accepted state,
 * revisions, selection and diagnostics.
 */
import path from 'node:path';
import { launch } from './launch.ts';
import { boardInfo, boardTool, findBoard } from './boards.ts';
import type { BoardEntry } from './boards.ts';
import type { HubLike } from './launch.ts';
import { resolveProject } from './projects.ts';
import { resolveOpenFile } from './import.ts';

export * from './tools.ts';
import { compactProject, toolByName } from './tools.ts';

/** Where a tool call comes from: the client's directory and its abort signal. */
export interface CallContext { cwd?: string; signal?: AbortSignal }
/** A board another process owns, as a client sees it. */
export interface RemoteRuntime { info(): any; refresh(): Promise<any>; close(): Promise<void> }
/** What a host provides to start a board of its own. */
export interface SessionOptions {
  openBoard(options: { file: string; args: Record<string, any>; cwd: string }): Promise<any>;
  cwd?: string;
  attach?: boolean;
  onRuntime?(runtime: any, board: BoardEntry | null): void;
}
/** One client's view of the boards it uses: the adapter's whole API surface. */
export interface Session {
  call(name: string, args?: Record<string, any>, ctx?: CallContext): Promise<any>;
  open(args?: Record<string, any>, ctx?: CallContext): Promise<any>;
  close(): Promise<void>;
  activate(dir: string, file: string): void;
  runtimes: Map<string, any>;
  owners: Map<string, BoardEntry>;
  hubs: Map<string, HubLike>;
  active: Map<string, string | null | undefined>;
  readonly cwd: string;
}

/* ---- sessions: one client's view of the boards it uses --------------------------------------------- */

/** A board owned by another process: only `info()` and `close()` are needed by launch/hub. */
function remoteRuntime(board: BoardEntry, info: any): RemoteRuntime {
  let latest = info;
  return {
    info: () => latest,
    async refresh() { latest = await boardInfo(board); return latest; },
    async close() { /* the owner's board outlives this client */ },
  };
}

/**
 * One client's session: opens projects (or attaches to the board that already owns them), resolves a project for a tool call
 * and forwards the call to whichever board owns it. `openBoard({ file, args, cwd })` starts a board in this process (the host
 * decides how: Pi adds its agent bridge and launcher, the CLI/MCP start a plain board), `onRuntime(runtime, board)` lets a host
 * hook a board it opened.
 */
export function createSession({ openBoard, cwd = process.cwd(), attach = true, onRuntime }: SessionOptions): Session {
  if (typeof openBoard !== 'function') throw new TypeError('createSession needs an openBoard function.');
  const runtimes = new Map();   // project file → runtime started by this process
  const owners = new Map();     // projectId → board owned by another process
  const remoteFiles = new Map(); // project file → that board
  const files = new Map();      // projectId → project file
  const active = new Map();     // client directory → project file
  const hubs = new Map();
  let closed = false;

  const resolve = (value: string, base?: string): string => path.resolve(base || cwd, value || '.');

  /** Remember where a project lives so `projectId` keeps working after the client's directory changes. */
  const remember = (info: any, file: string): any => {
    if (typeof info?.projectId === 'string') { files.set(info.projectId, file); }
    return info;
  };

  /** Open (or reuse, or attach to) the board of one project file. */
  async function boardFor(file: string, args: Record<string, unknown> = {}, ctx: CallContext = {}): Promise<{ runtime: any; board?: BoardEntry }> {
    const key = path.resolve(file);
    // Reaching a project by any route (a tool, the launcher's pick) makes it the project of the directory that asked for it.
    const activateDir = () => active.set(resolve(ctx.cwd ?? cwd), key);
    if (runtimes.has(key)) {
      const runtime = runtimes.get(key);
      remember(runtime.info(), key);
      activateDir();
      return { runtime };
    }
    const known = remoteFiles.get(key);
    if (known) return { runtime: remoteRuntime(known, await boardInfo(known)), board: known };
    const existing = attach ? await findBoard(key).catch(() => null) : null;
    if (existing) {
      const runtime = remoteRuntime(existing, await boardInfo(existing));
      const info = await runtime.info();
      remember(info, key);
      owners.set(info.projectId, existing);
      remoteFiles.set(key, existing);
      activateDir();
      return { runtime, board: existing };
    }
    const runtime = await openBoard({ file: key, args, cwd: ctx.cwd ?? cwd });
    runtimes.set(key, runtime);
    remember(runtime.info(), key);
    activateDir();
    onRuntime?.(runtime, null);
    return { runtime };
  }

  /** Stop treating a board as ours-to-attach-to (its process is gone); the next call opens the project here. */
  function forgetBoard(board: BoardEntry): void {
    for (const [key, value] of remoteFiles) if (value === board) remoteFiles.delete(key);
    for (const [id, value] of owners) if (value === board) owners.delete(id);
  }

  /** The runtime of an open project: by id when the host passes one, else this client's current project. */
  async function runtimeFor({ projectId }: { projectId?: string }, ctx: CallContext = {}): Promise<{ runtime: any; board?: BoardEntry }> {
    if (projectId) {
      for (const runtime of runtimes.values()) if (runtime.info().projectId === projectId) return { runtime };
      const board = owners.get(projectId);
      if (board) return { board, runtime: null };
      const file = files.get(projectId);
      if (file && !runtimes.has(file)) return boardFor(file, {}, ctx);
      throw Object.assign(new Error(`Unknown open divlet project: ${projectId}. Call divlet_open first.`), { code: 'UNKNOWN_PROJECT' });
    }
    const dir = resolve(ctx.cwd ?? cwd);
    const file = active.get(dir);
    if (!file) throw Object.assign(new Error('No divlet project is open for this client directory. Call divlet_open first.'), { code: 'NO_PROJECT' });
    return boardFor(file, {}, ctx);
  }

  /** `divlet_open`: a project opens its board, a collection with several projects opens the launcher. */
  async function open(args: Record<string, any> = {}, ctx: CallContext = {}): Promise<any> {
    const from = resolve(ctx.cwd ?? cwd);
    const target = resolve(args.path || args.cwd || '.', from);
    const opened = await launch(target, {
      hubs,
      externalFiles: args.externalFiles,
      openBoard: async ({ file }) => (await boardFor(file, args, ctx)).runtime,
    });
    active.set(from, null);
    if (opened.kind === 'collection') return { kind: 'collection', launcher: opened.hub.url, collection: opened.collection, projects: opened.projects };
    const runtime = opened.runtime;
    const info = remember(runtime.info(), path.resolve(runtime.info().project.file));
    active.set(from, path.resolve(info.project.file));
    if (args.document) {
      const owner = owners.get(info.projectId);
      if (owner) await boardTool(owner, 'create_frame', { document: args.document });
      else await runtime.create({ document: args.document });
    }
    // The answer is host-neutral data: the runtime itself never crosses the contract (a host that wants it gets it from
    // `onRuntime`, which is how the Pi extension hooks its agent bridge).
    const answer: Record<string, unknown> = { kind: 'project', info: runtime.info() };
    if (opened.imported) answer.imported = opened.imported;
    return answer;
  }

  /** Run one tool. `divlet_open` decides ownership, everything else runs on the board that owns the project. */
  async function call(name: string, args: Record<string, any> = {}, ctx: CallContext = {}): Promise<any> {
    if (closed) throw Object.assign(new Error('This divlet session is closed.'), { code: 'CLOSED' });
    const tool = toolByName.get(name);
    if (!tool) throw Object.assign(new Error(`Unknown tool: ${name}.`), { code: 'UNKNOWN_TOOL' });
    if (tool.kind === 'open') return open(args, ctx);
    const { runtime, board } = await runtimeFor(args ?? {}, ctx);
    if (board) {
      // Older live boards accept the original wire names; both generations resolve them to the same operation.
      try { return await boardTool(board, tool.aliases?.[0] ?? tool.name, args, { signal: ctx.signal }); }
      catch (error) {
        // The owning process is gone (or its board stopped): forget it and open this project here, once.
        const code = (error as { code?: string })?.code;
        if (!(code?.startsWith('HTTP_') || ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(code ?? ''))) throw error;
        forgetBoard(board);
        const fresh = await runtimeFor(args ?? {}, ctx);
        return tool.run?.({ runtime: fresh.runtime }, args ?? {});
      }
    }
    return tool.run?.({ runtime }, args ?? {});
  }

  async function close(): Promise<void> {
    closed = true;
    const boards = [...runtimes.values()];
    runtimes.clear();
    owners.clear();
    files.clear();
    active.clear();
    await Promise.allSettled([...hubs.values()].map((hub) => hub.close()));
    hubs.clear();
    await Promise.allSettled(boards.map((runtime) => runtime.close()));
  }

  /** Point a client directory at a project (a board-driven open, e.g. the user picking a project in the launcher). */
  const activate = (dir: string, file: string): void => { active.set(resolve(dir), path.resolve(file)); };

  return { call, open, close, activate, runtimes, owners, hubs, active, get cwd() { return cwd; } };
}

/** What `divlet_open` answers: the compact project view, or the collection's projects and launcher. */
export const openView = (opened: any): any => opened.kind === 'collection' ? collectionView(opened) : compactProject(opened.info);

/** The collection listing `divlet_open` answers with, in the agent's vocabulary. */
export function collectionView(result: any): Record<string, unknown> {
  return {
    launcher: result.launcher,
    collection: result.collection,
    projects: (result.projects as any[]).map(({ name, file, path: where, frames, modified, error }) => ({ name, file, path: where, frames, modified, ...(error ? { error } : {}) })),
    next: 'Call divlet_open with path set to a project\'s absolute file target, or let the user choose or create one in the launcher.',
  };
}

export { resolveProject, resolveOpenFile };
