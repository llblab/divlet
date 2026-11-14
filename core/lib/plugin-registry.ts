/* Owns: provider-free importer/exporter contracts, selection and Node dispatch. Excludes: concrete defaults and host bootstrap. */
import path from 'node:path';
import type { DocumentModel } from './model.ts';
import type { ProjectSettings } from './project.ts';

/**
 * The bytes of a foreign source. A `Uint8Array`, not Node's `Buffer`: a plugin contract should not require Node's type
 * definitions (the runtime hands it a Buffer at runtime, which is a Uint8Array). Decode with `new TextDecoder().decode(bytes)`.
 */
export type SourceBytes = Uint8Array;
/** Read a source file (bounded, no links); the importer decides what a file is from its bytes. */
export type ReadSource = (file: string) => Promise<SourceBytes>;

/** Conversion counts, including structured counts of content lost during conversion. */
export interface ConversionStats {
  frames?: number;
  nodes?: number;
  utilities?: number;
  arbitrary?: number;
  [key: string]: number | Record<string, number> | undefined;
}
/** What a plugin returns when it converts one file into a whole project. */
export interface ConvertResult { text: string; stats?: ConversionStats }
/** One file turned into one frame (a page dropped into a project folder). */
export interface PageResult { document: DocumentModel; dropped?: string[] | Record<string, number> }
/** A launcher card, computed without converting. */
export interface ImportSummary { name?: string; frames: number; frameNames?: string[] }

/** The importer contract: a foreign format is one codec behind this interface. */
export interface Importer {
  id: string;
  label: string;
  /** File names the plugin recognises. */
  extensions: string[];
  /** Do not offer files of this kind as projects in folder listings (they open only by path). */
  listed?: false;
  /** Also sniff `.divlet` files that hold a foreign source. */
  claims(file: string, read: ReadSource): Promise<boolean>;
  /** Free a squatted `.divlet` name by moving the foreign source aside. */
  detach?(file: string): Promise<string>;
  /** The Divlet project JSON text and counts. */
  convert(bytes: SourceBytes, context: { name: string; provenance: unknown }): ConvertResult;
  /** One file → one frame. */
  page?(bytes: SourceBytes, context: { fallbackId: string; source?: string }): PageResult;
  summarize?(bytes: SourceBytes): ImportSummary;
}

/** The exporter contract: a codec from a Divlet project to another format. */
export interface Exporter {
  id: string;
  label: string;
  /** Suggested file extension of the result. */
  extension: string;
  mime: string;
  /** `project` is the validated project settings, `frames` the stored frame documents. */
  export(input: { project: ProjectSettings; frames: Array<Omit<DocumentModel, 'schemaVersion'>> }): Promise<ExportedBytes> | ExportedBytes;
}
/** What an exporter returns: text or bytes, under the name it suggests. */
export interface ExportedBytes { name: string; bytes: string | Uint8Array }
/** What an export produced: a safe file name, the bytes and the MIME type to serve them with. */
export interface ExportFile { name: string; bytes: Uint8Array; mime: string }

// Undefined is untouched; any initialized list, including empty, is an explicit composition choice.
let importers: Importer[] | undefined;
/** Composition-only defaults. Host registration or an explicit empty seed is never overwritten. */
export const seedImporters = (defaults: Importer[]): void => { importers ??= [...defaults]; };
const exporters: Exporter[] = [];

export const registerExporter = (exporter: Exporter): void => {
  const fields = exporter as unknown as Record<string, unknown>;
  for (const key of ['id', 'label', 'extension', 'mime']) if (typeof fields?.[key] !== 'string' || !fields[key]) throw new TypeError(`An exporter needs a ${key}.`);
  if (typeof exporter.export !== 'function') throw new TypeError(`Exporter ${exporter.id} needs an export function.`);
  const known = exporters.find(item => item.id === exporter.id);
  if (known && known !== exporter) throw new Error(`An exporter with id "${exporter.id}" is already registered.`);
  if (!known) exporters.push(exporter);
};
export const exporterList = (): Array<Pick<Exporter, 'id' | 'label' | 'extension' | 'mime'>> => exporters.map(({ id, label, extension, mime }) => ({ id, label, extension, mime }));

/** Run one exporter; the result is `{ name, bytes, mime }` with `bytes` as a Uint8Array (text results are encoded as UTF-8). */
export async function exportAs(id: string, input: Parameters<Exporter['export']>[0]): Promise<ExportFile> {
  const exporter = exporters.find(item => item.id === id);
  if (!exporter) throw Object.assign(new Error(`No exporter "${id}" is installed.`), { code: 'UNKNOWN_EXPORTER' });
  const result = await exporter.export(input);
  const bytes = typeof result?.bytes === 'string' ? Buffer.from(result.bytes, 'utf8') : result?.bytes;
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw Object.assign(new Error(`Exporter ${id} returned no bytes.`), { code: 'EXPORT_FAILED' });
  const stem = String(result.name || 'export').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  const base = stem.endsWith(exporter.extension) ? stem.slice(0, -exporter.extension.length) : stem;
  return { name: base.slice(0, 120) + exporter.extension, bytes: Buffer.from(bytes), mime: exporter.mime };
}

export const registerImporter = (importer: Importer): void => { importers ??= []; if (!importers.some(item => item.id === importer.id)) importers.push(importer); };
export const importerList = (): Importer[] => [...(importers ?? [])];
/** Foreign page-provider extensions; the core source dispatcher adds native HTML separately. */
export const pageExtensions = (): Set<string> => new Set((importers ?? []).filter(importer => typeof importer.page === 'function').flatMap(importer => importer.extensions));
/** File extensions of every registered foreign format (they are listed as projects and imported on open). */
export const importExtensions = ({ all = false }: { all?: boolean } = {}): Set<string> => new Set((importers ?? []).filter(importer => all || importer.listed !== false).flatMap(importer => importer.extensions));

/** The importer that claims `file`, or null (Divlet projects and unknown files are nobody's). */
export async function importerFor(file: string, read: ReadSource): Promise<Importer | null> {
  const extension = path.extname(file).toLowerCase();
  for (const importer of importers ?? []) if (importer.extensions.includes(extension) || await importer.claims(file, read).catch(() => false)) return importer;
  return null;
}
