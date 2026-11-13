// Domain: Frame rendering. Owns: stateless preparation/public metadata. Excludes: runtime state and source/output publication.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { LIMITS } from './model.ts';
import type { DocumentModel, Limits, NodeId } from './model.ts';
import { storedFrame } from './project.ts';
import type { FrameLookup, ProjectSettings } from './project.ts';
import { compileClasses, unknownClasses } from './engine.ts';
import { prepareFrameWith } from './prepare.ts';
import type { FrameCompiler, PreparedFrame } from './prepare.ts';
export type { PreparedFrame, FrameCompiler } from './prepare.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export interface PrepareOptions { lookup?: FrameLookup; settings?: ProjectSettings | null; limits?: Limits }
/** One frame as the runtime stores it: the source of a rendered page and where its generated file lives. */
export interface FrameEntry { document: DocumentModel; html: string; fileHtml: string; htmlPath: string; uses: string[] }

/** The Node composition: the installed style engine compiles each frame's classes. */
const engineCompiler: FrameCompiler = {
  compile: (tokens, candidates) => compileClasses(tokens, candidates, PACKAGE_ROOT),
  unknown: input => unknownClasses({ ...input, base: PACKAGE_ROOT }),
};

export function prepareFrame(input: unknown, { lookup = () => undefined, settings = null, limits = LIMITS }: PrepareOptions = {}): Promise<PreparedFrame> {
  return prepareFrameWith(input, { lookup, settings, limits, compiler: engineCompiler });
}

/** The `meta.json` beside a generated page: what it was built from, what it depends on and the hashes that detect a rebuild. */
export function frameMetadata(entry: FrameEntry, entries: ReadonlyMap<NodeId, FrameEntry>, projectFile: string): string {
  const doc = entry.document;
  const depends = [...new Set(entry.uses.map(key => key.split('/')[0] as string))].filter(id => id !== doc.id).sort();
  return JSON.stringify({
    schemaVersion: 1,
    frame: doc.id,
    name: doc.name,
    version: doc.version,
    project: path.relative(path.dirname(entry.htmlPath), projectFile).split(path.sep).join('/'),
    html: path.basename(entry.htmlPath),
    components: Object.values(doc.nodes).filter(node => node.type === 'element' && node.reusable).map(node => node.id),
    instances: Object.fromEntries(Object.values(doc.nodes).filter(node => node.type === 'ref').map(node => [node.id, node.ref.includes('/') ? node.ref : `${doc.id}/${node.ref}`])),
    uses: entry.uses,
    usedBy: [...entries.values()].filter(item => item.document.id !== doc.id && item.uses.some(key => key.startsWith(`${doc.id}/`))).map(item => item.document.id),
    dependencies: Object.fromEntries(depends.map(id => [id, entries.get(id)?.document.version ?? null])),
    hashes: { frame: digest(JSON.stringify(storedFrame(doc))), html: digest(entry.fileHtml) },
  }, null, 2) + '\n';
}
