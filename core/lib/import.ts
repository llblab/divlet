/*
 * Native HTML admission and foreign importer plugins share bounded reading and non-overwriting publication:
 * `<name>.divlet` holds the converted frames and the generated HTML cache lives in `.divlet/<name>/`. The input file stays
 * exactly as it was; all further editing happens in the Divlet project. An existing `<name>.divlet` is never overwritten —
 * it is simply opened.
 */
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { importerFor, importExtensions, pageExtensions } from './plugin-registry.ts';
import type { Importer, ReadSource } from './plugin-registry.ts';
import { convertHtml, decodePage, summarizeHtml, isHtmlSource, HTML_EXTENSIONS } from './html-import.ts';
import { SOURCE_LIMITS } from './model.ts';
import { readProject, writeProject } from './project.ts';
import { prepareFrame, frameMetadata } from './render.ts';
import type { FrameEntry } from './render.ts';
import { buildStatic } from './static.js';
import { OutputStore } from './output.ts';
import type { Metadata } from './model.ts';

/** What a project records about the file it was converted from. */
export interface ImportProvenance { source: string; format: string; sha256: string; bytes: number }
/** The result of making a source openable: the Divlet project and the counts of what was written (zero when it already existed). */
export interface ImportResult { file: string; created: boolean; frames: number; utilities: number; arbitrary: number }
/** Whether the file a project came from still matches the bytes that were imported. */
export interface ImportStatus { source: string; changed: boolean }

/** Operations shared by native admission and foreign importers; native HTML is not registered as a plugin. */
type SourceReader = Pick<Importer, 'id' | 'convert' | 'page' | 'summarize' | 'detach'>;
const htmlSource: SourceReader = {
  id: 'html',
  convert: (bytes, context) => convertHtml(new TextDecoder().decode(bytes), context),
  page: (bytes, context) => decodePage(new TextDecoder().decode(bytes), context),
  summarize: bytes => summarizeHtml(new TextDecoder().decode(bytes)),
};

/** Native sources take precedence; foreign formats remain behind the importer registry. */
export const sourceFor = async (file: string, read: ReadSource): Promise<SourceReader | null> => isHtmlSource(file) ? htmlSource : importerFor(file, read);
/** Native pages and any foreign formats with an explicit one-page admission capability. */
export const pageSourceExtensions = (): Set<string> => new Set([...HTML_EXTENSIONS, ...pageExtensions()]);
/** HTML opens only by explicit path; it is never offered as a project in folder listings. */
export const isImportable = (file: string, { all = false }: { all?: boolean } = {}): boolean => isHtmlSource(file) ? all : importExtensions({ all }).has(path.extname(file).toLowerCase());
export const importedName = (file: string): string => path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.divlet`);

const provenanceOf = (name: string, importer: SourceReader, bytes: Uint8Array): ImportProvenance => ({ source: name, format: importer.id, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });

/** Read one bounded regular file, refusing links and files that change while they are read. */
const readBounded: ReadSource = async (file: string): Promise<Uint8Array> => {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error(`${path.basename(file)} is not a regular file.`), { code: 'IMPORT_UNSAFE' });
    if (stat.size > SOURCE_LIMITS.bytes) throw Object.assign(new Error(`${path.basename(file)} is larger than the ${SOURCE_LIMITS.bytes >> 20} MiB source limit.`), { code: 'TOO_LARGE' });
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Object.assign(new Error(`${path.basename(file)} changed while it was being read.`), { code: 'IMPORT_CHANGED' });
    return buffer;
  } finally { await handle.close(); }
}

/** Validate the converted native source and its complete owned-output plan before publishing a new source. */
async function nativeImportText(text: string, file: string, projectDir: string): Promise<string> {
  let native: unknown;
  try { native = JSON.parse(text); } catch { throw Object.assign(new Error('The imported project is not valid JSON.'), { code: 'INVALID_PROJECT' }); }
  const project = readProject(native), output = new OutputStore(file, project.settings.outputDir);
  const canonical = writeProject(project.settings, project.frames);
  const lookup = new Map(project.frames.map(frame => [frame.id, frame])), entries = new Map<string, FrameEntry>();
  for (const frame of project.frames) entries.set(frame.id, { ...await prepareFrame(frame, { settings: project.settings, lookup: id => lookup.get(id) }), htmlPath: path.join(output.directory, `${frame.id}.html`) });
  const plan = await (buildStatic as unknown as (options: Record<string, unknown>) => Promise<{ files: Map<string, string | Buffer>; mediaTypes?: Map<string, string> }>)({ projectDir, frames: new Map([...entries].map(([id, entry]) => [id, entry.fileHtml])), ...(Object.keys(project.settings.assets ?? {}).length ? { assets: project.settings.assets, nativeAssets: true } : {}) });
  for (const [id, entry] of entries) { entry.fileHtml = String(plan.files.get(`${id}.html`)); plan.files.set(`${id}.meta.json`, frameMetadata(entry, entries, file)); }
  await output.preflight(plan.files, [], { mediaTypes: plan.mediaTypes ?? new Map() });
  return canonical;
}

/**
 * Return the Divlet project that stands for `source`, converting it on first use.
 * `{ file, created, frames, utilities, arbitrary }`: converted frame count plus legacy utility/arbitrary-class counters.
 * CSS-native importers leave class-normalization counts at zero; existing projects report zero counts.
 */
export async function importSource(input: string, importer?: SourceReader): Promise<ImportResult> {
  const source = path.resolve(input);
  const file = importedName(source);
  const existing: ImportResult = { file, created: false, frames: 0, utilities: 0, arbitrary: 0 };
  const occupied = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (occupied) return existing;
  const chosen = importer ?? await sourceFor(source, readBounded);
  if (!chosen) throw Object.assign(new Error(`${path.basename(source)} is not a format divlet can import.`), { code: 'INVALID_PROJECT' });
  const bytes = await readBounded(source);
  let converted;
  try { converted = chosen.convert(bytes, { name: path.basename(source, path.extname(source)), provenance: provenanceOf(path.basename(source), chosen, bytes) }); }
  catch (error) { throw error instanceof SyntaxError ? Object.assign(new Error(`${path.basename(source)} is not valid JSON.`), { code: 'INVALID_PROJECT' }) : error; }
  const canonical = await nativeImportText(converted.text, file, path.dirname(source));
  // Exclusive publication: a concurrent open or an author-created file wins, and is then simply used.
  try { await fs.writeFile(file, canonical, { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return existing; throw error; }
  const stats = converted.stats ?? {};
  return { file, created: true, frames: stats.frames ?? 0, utilities: stats.utilities ?? 0, arbitrary: stats.arbitrary ?? 0 };
}

/**
 * Whether the source this project was converted from still matches what was imported: `{ source, changed }`, or null when the
 * project did not come from an import (or its source is gone). Only the recorded sha256 is compared; nothing is rewritten.
 */
export async function importStatus(projectFile: string, metadata: Metadata | null | undefined): Promise<ImportStatus | null> {
  const record = (metadata as any)?.import;
  if (typeof record?.source !== 'string' || typeof record.sha256 !== 'string' || record.source !== path.basename(record.source)) return null;
  const source = path.join(path.dirname(projectFile), record.source);
  try { return { source: record.source, changed: createHash('sha256').update(await readBounded(source)).digest('hex') !== record.sha256 }; }
  catch { return null; }
}

/** Convert the source again into a NEW project beside it (`<name>-2.divlet`, `-3`, ...); existing projects are never touched. */
export async function importAgain(projectFile: string, metadata: Metadata | null | undefined): Promise<{ file: string; frames: number }> {
  const record = (metadata as any)?.import;
  if (typeof record?.source !== 'string' || record.source !== path.basename(record.source)) throw Object.assign(new Error('This project was not imported from a file.'), { code: 'INVALID_PROJECT' });
  const source = path.join(path.dirname(projectFile), record.source);
  const importer = await sourceFor(source, readBounded);
  if (!importer) throw Object.assign(new Error(`${record.source} is not a format divlet can import.`), { code: 'INVALID_PROJECT' });
  const bytes = await readBounded(source);
  const stem = path.basename(source, path.extname(source));
  const converted = importer.convert(bytes, { name: stem, provenance: provenanceOf(record.source, importer, bytes) });
  for (let n = 2; n < 1000; n++) {
    const file = path.join(path.dirname(source), `${stem}-${n}.divlet`);
    if (await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) continue;
    const canonical = await nativeImportText(converted.text, file, path.dirname(source));
    try { await fs.writeFile(file, canonical, { flag: 'wx' }); return { file, frames: converted.stats?.frames ?? 0 }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  throw Object.assign(new Error('Too many re-imports beside the source.'), { code: 'INVALID_TARGET' });
}

/** Admit native HTML or a foreign source; foreign sources squatting on a `.divlet` name are detached by their importer. */
export async function resolveOpenFile(file: string): Promise<ImportResult> {
  const importer = await sourceFor(file, readBounded);
  // "Nothing to convert": the file opens as itself, and no project was created.
  const asIs: ImportResult = { file, created: false, frames: 0, utilities: 0, arbitrary: 0 };
  if (!importer) return asIs;
  let source = file;
  if (path.extname(file).toLowerCase() === '.divlet') {
    try { source = await importer.detach?.(file) ?? file; } catch { return asIs; }
  }
  // A source that cannot be converted (invalid or unsupported) opens as itself, with diagnostics; nothing is created.
  try { return await importSource(source, importer); }
  catch {
    if (source === file) return asIs;
    try { await fs.link(source, file); await fs.unlink(source); } catch { /* keep the moved source */ }
    return asIs;
  }
}
