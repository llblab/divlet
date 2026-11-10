// Domain: Frame rendering. Owns: stateless preparation/public metadata. Excludes: runtime state and source/output publication.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import postcss from 'postcss';
import { validateDocument, DivletError, LIMITS, documentLimits } from './model.ts';
import type { DocumentModel, Limits, NodeId } from './model.ts';
import { expandFrame, instancesOf, storedFrame } from './project.ts';
import type { FrameLookup, ProjectSettings } from './project.ts';
import { encodeHtml, decodeHtml, renderFile } from './codec.ts';
import { compileClasses, unknownClasses } from './engine.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const sameDocument = (a: DocumentModel, b: DocumentModel): boolean => isDeepStrictEqual({ ...a, version: 0 }, { ...b, version: 0 });
function fail(code: string, message: string): never { throw new DivletError(code, message); }

/** What preparing a frame produces: the validated document, the preview page, the generated file, its dependencies and the
 *  classes that do nothing. Nothing here is state: a caller decides what to publish. */
export interface PreparedFrame { document: DocumentModel; html: string; fileHtml: string; uses: string[]; unknown: Record<string, string[]> }
export interface PrepareOptions { lookup?: FrameLookup; settings?: ProjectSettings | null; limits?: Limits }
/** One frame as the runtime stores it: the source of a rendered page and where its generated file lives. */
export interface FrameEntry { document: DocumentModel; html: string; fileHtml: string; htmlPath: string; uses: string[] }

function checkAtRules(css: string): void {
  const tree = postcss.parse(css || '');
  const allowed = new Set(['media', 'supports', 'layer', 'keyframes', '-webkit-keyframes', 'font-face', 'container', 'property', 'starting-style', 'scope']);
  tree.walkAtRules(rule => {
    if (!allowed.has(rule.name.toLowerCase())) fail('UNSUPPORTED_CSS', `CSS @${rule.name} is not allowed in a divlet project. Build directives and imports are disabled.`);
  });
  if (/<\/style/i.test(css)) fail('UNSUPPORTED_CSS', 'A style element closing sequence is not allowed in authored CSS.');
}

export async function prepareFrame(input: unknown, { lookup = () => undefined, settings = null, limits = LIMITS }: PrepareOptions = {}): Promise<PreparedFrame> {
  documentLimits(limits);
  const document = validateDocument(input, { limits });
  const expanded = expandFrame(document, lookup, settings, { limits });
  checkAtRules(expanded.document.css);
  const candidates = [...new Set(Object.values(expanded.document.nodes).flatMap(node => (node.type === 'element' ? node.className : '').split(/\s+/)).filter(Boolean))];
  const compiledCss = await compileClasses(expanded.document.tokens, candidates, PACKAGE_ROOT);
  const instances = new Map(instancesOf(document).map(item => [item.id, `${item.frame}/${item.node}`]));
  const html = encodeHtml(expanded.document, { compiledCss, parts: expanded.parts, instances, limits });
  if (Buffer.byteLength(html) > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', 'The rendered frame exceeds the 4 MiB limit.');
  const decoded = decodeHtml(html, { previous: expanded.document, limits });
  if (!sameDocument(expanded.document, decoded)) fail('UNREPRESENTABLE_HTML', 'The frame does not survive HTML parsing unchanged (check element nesting); the last valid preview was retained.');
  const own = Object.fromEntries(Object.values(document.nodes).flatMap(node => (node.type === 'element' && node.className ? [[node.id, node.className] as [string, string]] : [])));
  const unknown = await unknownClasses({ tokens: expanded.document.tokens, css: expanded.document.css, byNode: own, base: PACKAGE_ROOT });
  return { document, html, fileHtml: renderFile(expanded.document, { compiledCss, parts: expanded.parts, instances, limits }), uses: expanded.uses, unknown };
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
