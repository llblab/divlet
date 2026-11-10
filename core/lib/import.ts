/*
 * Opening a foreign source (any registered importer: see plugins.ts) converts it into a Divlet project beside it:
 * `<name>.divlet` holds the converted frames and the generated HTML cache lives in `.divlet/<name>/`. The foreign file stays
 * exactly as it was; all further editing happens in the Divlet project. An existing `<name>.divlet` is never overwritten —
 * it is simply opened.
 */
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { importerFor, importExtensions } from './plugins.ts';
import type { Importer, ReadSource } from './plugins.ts';
import { SOURCE_LIMITS } from './model.ts';
import type { Metadata } from './model.ts';

/** What a project records about the file it was converted from. */
export interface ImportProvenance { source: string; format: string; sha256: string; bytes: number }
/** The result of making a source openable: the Divlet project and the counts of what was written (zero when it already existed). */
export interface ImportResult { file: string; created: boolean; frames: number; utilities: number; arbitrary: number }
/** Whether the file a project came from still matches the bytes that were imported. */
export interface ImportStatus { source: string; changed: boolean }

/** Whether an importer recognises `file`; `all` includes formats that are not listed as projects in folders (opened by path only). */
export const isImportable = (file: string, { all = false }: { all?: boolean } = {}): boolean => importExtensions({ all }).has(path.extname(file).toLowerCase());
export const importedName = (file: string): string => path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.divlet`);

const provenanceOf = (name: string, importer: Importer, bytes: Uint8Array): ImportProvenance => ({ source: name, format: importer.id, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });

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

/**
 * Return the Divlet project that stands for `source`, converting it on first use.
 * `{ file, created, frames, utilities, arbitrary }`: counts of converted frames and of Tailwind utility / arbitrary-property
 * classes written (zero for an existing project).
 */
export async function importSource(input: string, importer?: Importer): Promise<ImportResult> {
  const source = path.resolve(input);
  const file = importedName(source);
  const existing: ImportResult = { file, created: false, frames: 0, utilities: 0, arbitrary: 0 };
  const occupied = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (occupied) return existing;
  const chosen = importer ?? await importerFor(source, readBounded);
  if (!chosen) throw Object.assign(new Error(`${path.basename(source)} is not a format divlet can import.`), { code: 'INVALID_PROJECT' });
  const bytes = await readBounded(source);
  let converted;
  try { converted = chosen.convert(bytes, { name: path.basename(source, path.extname(source)), provenance: provenanceOf(path.basename(source), chosen, bytes) }); }
  catch (error) { throw error instanceof SyntaxError ? Object.assign(new Error(`${path.basename(source)} is not valid JSON.`), { code: 'INVALID_PROJECT' }) : error; }
  // Exclusive publication: a concurrent open or an author-created file wins, and is then simply used.
  try { await fs.writeFile(file, converted.text, { flag: 'wx' }); }
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
  const importer = await importerFor(source, readBounded);
  if (!importer) throw Object.assign(new Error(`${record.source} is not a format divlet can import.`), { code: 'INVALID_PROJECT' });
  const bytes = await readBounded(source);
  const stem = path.basename(source, path.extname(source));
  const converted = importer.convert(bytes, { name: stem, provenance: provenanceOf(record.source, importer, bytes) });
  for (let n = 2; n < 1000; n++) {
    const file = path.join(path.dirname(source), `${stem}-${n}.divlet`);
    try { await fs.writeFile(file, converted.text, { flag: 'wx' }); return { file, frames: converted.stats?.frames ?? 0 }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  throw Object.assign(new Error('Too many re-imports beside the source.'), { code: 'INVALID_TARGET' });
}

/** Make `file` ready to open: a foreign source (or a foreign source squatting on a `.divlet` name) is converted; anything else is returned as is. */
export async function resolveOpenFile(file: string): Promise<ImportResult> {
  const importer = await importerFor(file, readBounded);
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
