/* Independent source-file discovery and browsing; filesystem metadata never grants resource authority. */
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_SCHEMA, validateSettings, writeProject } from './project.ts';
import { importedName, isImportable } from './import.ts';
import { importerFor } from './plugins.ts';
import { buildStatic } from './static.js';
import { prepareFrame, frameMetadata } from './render.ts';
import type { FrameEntry, PreparedFrame } from './render.ts';
import { OutputStore, safeDirectory } from './output.ts';
import { SOURCE_LIMITS, createDemoDocument } from './model.ts';
import type { DocumentModel, Metadata } from './model.ts';

export const PROJECT_FILE = 'project.divlet';
export const CONFIG_FILE = 'divlet.config.json';
const COLLECTIONS = ['Designs', 'designs'];
const MAX_READ = SOURCE_LIMITS.bytes;
const MAX_LABEL = 512;
const exists = async (file: string) => { try { return await fs.stat(file); } catch { return null; } };
const isDirectory = async (dir: string): Promise<boolean> => !!(await exists(dir))?.isDirectory();
export const isProjectFile = (file: string): boolean => path.extname(file).toLowerCase() === '.divlet' || isImportable(file);

/** One project as a collection list shows it: a card, or an entry that says why the file could not be read. */
export interface ProjectEntry {
  name: string;
  file: string;
  dir: string;
  /** Path relative to the collection root, with forward slashes. */
  path: string;
  frames: number;
  /** ISO modification time, or '' when unreadable. */
  modified: string;
  frameNames?: string[];
  error?: string;
}
/** What a target path turned out to be. */
export type ResolvedProject =
  | { kind: 'project'; file: string; dir: string }
  | { kind: 'new'; file: string; dir: string }
  | { kind: 'collection'; dir: string; projects: ProjectEntry[] };
/** A folder listing for the browser's path picker. */
export interface PathInspection {
  requested: string;
  path: string;
  directory: string;
  parent: string | null;
  missing: string;
  dirs: Array<{ name: string; project: boolean; collection: boolean }>;
  files: Array<{ name: string; file: string; project: true }>;
  kind: string;
  projects: number;
  home: string;
}


export async function readConfig(root: string): Promise<{ projects?: string }> {
  try {
    const config = JSON.parse(await fs.readFile(path.join(root, CONFIG_FILE), 'utf8'));
    return typeof config?.projects === 'string' && config.projects && !path.isAbsolute(config.projects) && !config.projects.split(/[\\/]/).includes('..') ? { projects: config.projects } : {};
  } catch { return {}; }
}

export async function collectionDir(root: string): Promise<string | null> {
  const { projects } = await readConfig(root);
  for (const name of projects ? [projects] : COLLECTIONS) {
    const dir = path.join(root, name);
    if (await isDirectory(dir)) return dir;
  }
  return null;
}

async function summarize(file: string, from: string): Promise<ProjectEntry> {
  const entry: ProjectEntry = { name: path.basename(file, path.extname(file)), file, dir: path.dirname(file), path: path.relative(from, file).split(path.sep).join('/'), frames: 0, modified: '' };
  try {
    // A listed regular file can be replaced before opening. Never follow links or block on a FIFO.
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw Object.assign(new Error(), { code: 'SUMMARY_UNSAFE' });
      entry.modified = stat.mtime.toISOString();
      if (stat.size > MAX_READ) throw Object.assign(new Error(), { code: 'SUMMARY_TOO_LARGE' });
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw Object.assign(new Error(), { code: 'SUMMARY_CHANGED' });
      bytes = buffer.subarray(0, length);
    } finally { await handle.close(); }
    const importer = await importerFor(file, async () => bytes);
    let roots: any[], name: unknown;
    if (importer?.summarize) {
      // A foreign source is summarized by its importer, without converting it.
      const card = importer.summarize(bytes);
      if (card.name) name = card.name;
      entry.frames = card.frames; entry.frameNames = card.frameNames;
    } else {
      const input = JSON.parse(bytes.toString('utf8'));
      // Retain lightweight legacy metadata; a summary is not full render/edit validation.
      if (input?.schemaVersion !== PROJECT_SCHEMA || !Array.isArray(input.frames)) throw new Error();
      roots = input.frames; name = input.name;
      entry.frames = roots.length;
      entry.frameNames = roots.slice(0, 4).map(frame => (typeof frame?.name === 'string' && frame.name.trim() || typeof frame?.id === 'string' && frame.id || '').slice(0, MAX_LABEL));
    }
    if (typeof name === 'string' && name.trim()) entry.name = name.trim().slice(0, MAX_LABEL);
  } catch (error) {
    // Parser, validator and I/O messages may quote credentials or opaque source values.
    const code = (error as NodeJS.ErrnoException).code;
    const reason = error instanceof SyntaxError ? 'is not valid JSON' : code === 'SUMMARY_TOO_LARGE' ? 'is too large (32 MiB limit)' : code === 'SUMMARY_CHANGED' ? 'changed while being read; reload the collection' : code === 'SUMMARY_UNSAFE' || code?.startsWith('E') ? 'could not be read safely' : 'is not a supported project source';
    entry.error = `${path.basename(file)} ${reason}.`;
  }
  return entry;
}

async function filesIn(dir: string): Promise<string[]> {
  try {
    const items = await fs.readdir(dir, { withFileTypes: true });
    const names = new Set(items.map(item => item.name));
    // A foreign source that already has its Divlet project beside it is listed once, as that project.
    return items.filter(item => item.isFile() && isProjectFile(item.name) && !(isImportable(item.name) && names.has(path.basename(importedName(item.name))))).map(item => path.join(dir, item.name));
  } catch { return []; }
}

/** Direct project files and project files in immediate child directories. */
export async function listProjects(collection: string, from: string = collection): Promise<ProjectEntry[]> {
  collection = path.resolve(collection);
  const files = await filesIn(collection);
  try {
    for (const item of await fs.readdir(collection, { withFileTypes: true })) {
      if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') files.push(...await filesIn(path.join(collection, item.name)));
    }
  } catch { /* An unreadable collection has no children. */ }
  // Bound simultaneous buffers and canonical graphs even in collections of large native files.
  const found = [];
  for (const file of files.sort()) found.push(await summarize(file, from));
  return found.sort((a, b) => b.modified.localeCompare(a.modified));
}

export async function resolveProject(target: string): Promise<ResolvedProject> {
  const root = path.resolve(target);
  const stat = await exists(root);
  if ((path.extname(root).toLowerCase() === '.divlet' || isImportable(root, { all: true })) && !stat?.isDirectory()) {
    if (!stat && path.extname(root) !== '.divlet') throw Object.assign(new Error(`Project file does not exist: ${root}. New projects use .divlet.`), { code: 'NOT_FOUND' });
    return { kind: stat?.isFile() ? 'project' : 'new', file: root, dir: path.dirname(root) };
  }
  const direct = await filesIn(root);
  if (direct.length === 1) return { kind: 'project', file: direct[0] as string, dir: root };
  if (direct.length > 1) return { kind: 'collection', dir: root, projects: await listProjects(root, root) };
  const collection = await collectionDir(root);
  if (collection) return { kind: 'collection', dir: collection, projects: await listProjects(collection, root) };
  const projects = await listProjects(root, root);
  if (projects.length) return { kind: 'collection', dir: root, projects };
  return { kind: 'new', file: path.join(root, PROJECT_FILE), dir: root };
}

export async function createProject(collection: string, name: unknown): Promise<string> {
  const title = String(name || '').trim().slice(0, 80);
  if (!title) throw Object.assign(new Error('A project needs a name.'), { code: 'INVALID_NAME' });
  const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'project';
  for (let n = 1; ; n++) {
    const file = path.resolve(collection, `${slug}${n === 1 ? '' : `-${n}`}.divlet`);
    try { return await initProject(file, title); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}

export function expandPath(input: unknown, base: string = process.cwd()): string {
  const text = String(input ?? '').trim();
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith(`~${path.sep}`)) return path.join(os.homedir(), text.slice(2));
  return path.resolve(base, text || '.');
}

export async function inspectPath(input: unknown, base?: string): Promise<PathInspection> {
  const requested = expandPath(input, base);
  let target = requested;
  let stat = await exists(target);
  let missing = '';
  while (!stat && path.dirname(target) !== target) { missing = path.join(path.basename(target), missing); target = path.dirname(target); stat = await exists(target); }
  const selectedFile = stat?.isFile() && !missing;
  const directory = stat?.isFile() ? path.dirname(target) : target;
  const dirs: PathInspection['dirs'] = [];
  const files: PathInspection['files'] = (await filesIn(directory)).map(file => ({ name: path.basename(file), file, project: true as const }));
  try {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith('.') || item.name === 'node_modules') continue;
      const count = (await filesIn(path.join(directory, item.name))).length;
      dirs.push({ name: item.name, project: count === 1, collection: count > 1 });
    }
  } catch { /* Unreadable: an empty list. */ }
  dirs.sort((a, b) => Number(b.project) - Number(a.project) || a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  const found: { kind: string; projects?: unknown[] } = missing ? { kind: 'missing' } : await resolveProject(requested);
  return { requested, path: selectedFile ? requested : directory, directory, parent: selectedFile ? directory : path.dirname(directory) === directory ? null : path.dirname(directory), missing, dirs: dirs.slice(0, 300), files: files.slice(0, 300), kind: found.kind, projects: (found as { projects?: unknown[] }).projects?.length ?? 0, home: os.homedir() };
}

/**
 * Publish a new Divlet project (HTML elements with Tailwind classes, tokens and CSS). `createDemo` adds the starter frame.
 * Output ownership is checked under the output lock before the source is published exclusively (`wx`).
 */
export async function initProject(file: string, name?: string | null, createDemo = false): Promise<string> {
  file = path.resolve(file);
  if (path.extname(file) !== '.divlet') throw new Error('New project paths must end in .divlet. Existing .pen files are converted when opened.');
  if (typeof createDemo !== 'boolean') throw Object.assign(new Error('The starter choice must be boolean.'), { code: 'INVALID_PROJECT' });
  const title = name === undefined || name === null ? undefined : String(name).trim().slice(0, 80) || undefined;
  const settings = validateSettings(title === undefined ? {} : { name: title }), documents = createDemo ? [createDemoDocument()] : [];
  const text = writeProject(settings, documents), projectDir = path.dirname(file);
  await safeDirectory(projectDir, { create: true });
  let occupied;
  try { occupied = await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (occupied) throw Object.assign(new Error('The project file already exists.'), { code: 'EEXIST' });
  const output = new OutputStore(file, settings.outputDir), entries = new Map<string, FrameEntry>();
  for (const document of documents) entries.set(document.id, { ...await prepareFrame(document, { settings }), htmlPath: path.join(output.directory, `${document.id}.html`) });
  const frameFiles = new Map([...entries.keys()].map(id => [id, `${id}.html`]));
  for (const [id, entry] of entries) entry.htmlPath = path.join(output.directory, frameFiles.get(id) as string);
  // `static` is not converted yet, so its option object is passed as it stands; the build validates its own inputs.
  const generation = await (buildStatic as unknown as (options: Record<string, unknown>) => Promise<{ files: Map<string, string> }>)({ projectDir, frameFiles, frames: new Map([...entries].map(([id, entry]) => [id, entry.fileHtml])), previews: new Map([...entries].map(([id, entry]) => [id, entry.html])), externalFiles: [] });
  for (const [id, entry] of entries) {
    const filename = frameFiles.get(id) as string;
    entry.fileHtml = String(generation.files.get(filename));
    generation.files.set(filename.slice(0, -5) + '.meta.json', frameMetadata(entry, entries, file));
  }
  await output.preflight(generation.files);
  await output.withLock(async () => {
    await output.preflight(generation.files);
    await safeDirectory(projectDir);
    await fs.writeFile(file, text, { flag: 'wx' });
  });
  return file;
}
