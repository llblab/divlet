/*
 * Owns: stateless, host-independent frame preparation — validation, component expansion, the preview and file HTML, the
 * HTML round-trip check and dependency list. Excludes: choosing a style compiler (the host injects `compile`/`unknown`),
 * runtime state, metadata hashing and publication. `render.ts` composes it with the Node style engine.
 */
import postcss from 'postcss';
import { validateDocument, DivletError, LIMITS, documentLimits } from './model.ts';
import type { DocumentModel, Limits } from './model.ts';
import { expandFrame, instancesOf } from './project.ts';
import type { FrameLookup, ProjectSettings } from './project.ts';
import { encodeHtml, decodeHtml, renderFile } from './codec.ts';
import { sameJson, withinUtf8Budget } from './validation.ts';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const sameDocument = (a: DocumentModel, b: DocumentModel): boolean => sameJson({ ...a, version: 0 }, { ...b, version: 0 });
function fail(code: string, message: string): never { throw new DivletError(code, message); }

/** What preparing a frame produces: the validated document, the preview page, the generated file, its dependencies and the
 *  classes that do nothing. Nothing here is state: a caller decides what to publish. */
export interface PreparedFrame { document: DocumentModel; html: string; fileHtml: string; uses: string[]; unknown: Record<string, string[]> }
/** The style compiler a host provides: compiled CSS for the expanded frame's tokens and class candidates, and the classes that do nothing. */
export interface FrameCompiler {
  compile(tokens: Record<string, string>, candidates: string[]): Promise<string> | string;
  unknown(input: { tokens: Record<string, string>; css: string; byNode: Record<string, string> }): Promise<Record<string, string[]>> | Record<string, string[]>;
}
export interface PrepareWithOptions { lookup?: FrameLookup; settings?: ProjectSettings | null; limits?: Limits; compiler: FrameCompiler }

function checkAtRules(css: string): void {
  const tree = postcss.parse(css || '', { map: false });
  const allowed = new Set(['media', 'supports', 'layer', 'keyframes', '-webkit-keyframes', 'font-face', 'container', 'property', 'starting-style', 'scope']);
  tree.walkAtRules(rule => {
    if (!allowed.has(rule.name.toLowerCase())) fail('UNSUPPORTED_CSS', `CSS @${rule.name} is not allowed in a divlet project. Build directives and imports are disabled.`);
  });
  if (/<\/style/i.test(css)) fail('UNSUPPORTED_CSS', 'A style element closing sequence is not allowed in authored CSS.');
}

export async function prepareFrameWith(input: unknown, { lookup = () => undefined, settings = null, limits = LIMITS, compiler }: PrepareWithOptions): Promise<PreparedFrame> {
  documentLimits(limits);
  const document = validateDocument(input, { limits });
  const expanded = expandFrame(document, lookup, settings, { limits });
  checkAtRules(expanded.document.css);
  const candidates = [...new Set(Object.values(expanded.document.nodes).flatMap(node => (node.type === 'element' ? node.className : '').split(/\s+/)).filter(Boolean))];
  const compiledCss = await compiler.compile(expanded.document.tokens, candidates);
  const instances = new Map(instancesOf(document).map(item => [item.id, `${item.frame}/${item.node}`]));
  const html = encodeHtml(expanded.document, { compiledCss, parts: expanded.parts, instances, limits });
  if (!withinUtf8Budget(html, MAX_FILE_BYTES)) fail('FILE_TOO_LARGE', 'The rendered frame exceeds the 4 MiB limit.');
  const decoded = decodeHtml(html, { previous: expanded.document, limits });
  if (!sameDocument(expanded.document, decoded)) fail('UNREPRESENTABLE_HTML', 'The frame does not survive HTML parsing unchanged (check element nesting); the last valid preview was retained.');
  const own = Object.fromEntries(Object.values(document.nodes).flatMap(node => (node.type === 'element' && node.className ? [[node.id, node.className] as [string, string]] : [])));
  const unknown = await compiler.unknown({ tokens: expanded.document.tokens, css: expanded.document.css, byNode: own });
  return { document, html, fileHtml: renderFile(expanded.document, { compiledCss, parts: expanded.parts, instances, limits }), uses: expanded.uses, unknown };
}
