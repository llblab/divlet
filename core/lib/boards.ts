/*
 * Which process owns a project's board.
 *
 * A board is the single writer of its project file: it holds the accepted state, the revisions, the selection and the
 * diagnostics, and every client that reaches it (a browser, Pi, an MCP client) sees the same ones. A client process that
 * finds a live board for the project file attaches to it over its token-scoped HTTP API instead of opening a second writer,
 * which is what keeps concurrent clients consistent without a second coordination protocol.
 *
 * The registry is one small JSON file per project, named by the hash of the absolute project path, in a per-user state
 * directory. An entry carries the board URL (which contains its access token, so only the same user and only a reader of this
 * directory can use it) and the owner's pid; an entry whose process is gone is stale and is removed on read.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What a live board announces about itself. */
export interface BoardEntry {
  /** Absolute project file the board owns. */
  file: string;
  /** Token-scoped board URL: it carries the access token, so it is as private as the registry file. */
  url: string;
  projectId: string;
  pid: number;
  startedAt: string;
}
/** A request to a board's own API. */
export interface BoardRequestOptions { method?: string; body?: unknown; signal?: AbortSignal }
/** A domain error as the board reported it, keeping its code and details. */
export interface BoardError extends Error { code: string; details?: unknown }

const stateDir = (): string => process.env.PI_DIVLET_STATE_DIR || path.join(os.homedir(), '.divlet', 'boards');

/** The registry file of one project; the hash keeps any path (and its length) out of the file name. */
const entryFile = async (projectFile: string): Promise<string> => {
  const key = createHash('sha256').update(path.resolve(projectFile)).digest('hex').slice(0, 24);
  return path.join(stateDir(), `${key}.json`);
};

const alive = (pid: unknown): boolean => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Announce this process's board for `projectFile` (called once its server is listening). */
export async function registerBoard({ file, url, projectId }: { file: string; url: string; projectId: string }): Promise<BoardEntry> {
  const target = await entryFile(file);
  const entry: BoardEntry = { file: path.resolve(file), url, projectId, pid: process.pid, startedAt: new Date().toISOString() };
  try {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(entry, null, 2), { mode: 0o600 });
    await fs.rename(temporary, target);
  } catch { /* a read-only home still leaves the board working for its own client */ }
  return entry;
}

/** Withdraw this board's entry, but only if it is still ours (a later owner may have taken it over). */
export async function unregisterBoard({ file, url }: { file: string; url: string }): Promise<boolean> {
  const target = await entryFile(file);
  try {
    const entry = JSON.parse(await fs.readFile(target, 'utf8')) as Partial<BoardEntry>;
    if (entry?.url !== url) return false;
    await fs.rm(target, { force: true });
    return true;
  } catch { return false; }
}

/** The live board for `projectFile`, or null. A stale entry (its process is gone) is removed first. */
export async function findBoard(projectFile: string): Promise<BoardEntry | null> {
  const target = await entryFile(projectFile);
  let entry: Partial<BoardEntry>;
  try { entry = JSON.parse(await fs.readFile(target, 'utf8')) as Partial<BoardEntry>; } catch { return null; }
  if (!entry || typeof entry.url !== 'string' || !alive(entry.pid)) { await fs.rm(target, { force: true }).catch(() => {}); return null; }
  if (entry.file !== path.resolve(projectFile)) return null;
  return entry as BoardEntry;
}

/** Every live board this user has announced (diagnostics; also the list `divlet boards` prints). */
export async function listBoards(): Promise<BoardEntry[]> {
  let names: string[];
  try { names = await fs.readdir(stateDir()); } catch { return []; }
  const out: BoardEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(stateDir(), name);
    try {
      const entry = JSON.parse(await fs.readFile(file, 'utf8')) as BoardEntry;
      if (alive(entry?.pid)) out.push(entry); else await fs.rm(file, { force: true });
    } catch { await fs.rm(file, { force: true }).catch(() => {}); }
  }
  return out.sort((a, b) => String(a.file).localeCompare(String(b.file)));
}

/** One request to a board's token-scoped API; a domain error keeps its code and details. */
export async function boardRequest(board: BoardEntry, route: string, { method = 'GET', body, signal }: BoardRequestOptions = {}): Promise<any> {
  const response = await fetch(new URL(route, board.url), {
    method,
    signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: any;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const error = new Error(payload?.message || `The board answered ${response.status}.`) as BoardError;
    error.code = payload?.error || `HTTP_${response.status}`;
    if (payload?.details !== undefined) error.details = payload.details;
    throw error;
  }
  return payload;
}

/** The project state of a board, as its own client would see it. */
export const boardInfo = (board: BoardEntry, options?: BoardRequestOptions): Promise<any> => boardRequest(board, 'api/project', options);

/** Run one shared tool on the board that owns the project (the same contract runs there) and return its result. */
export async function boardTool(board: BoardEntry, name: string, args: unknown, options?: BoardRequestOptions): Promise<any> {
  const payload = await boardRequest(board, 'api/tool', { method: 'POST', body: { name, args }, ...options });
  return payload?.result;
}
