/*
 * The document vocabulary: what a frame is made of, what a patch may say, and the one validator both sides trust. Every other
 * module names these types; nothing here imports the runtime, the server or the browser.
 *
 * `validateDocument`/`applyDocumentPatch` take `unknown` because documents arrive from files, HTTP bodies and other clients; what
 * they return is the accepted model. Their internals work on unchecked records — that is the boundary, and it is the only place
 * allowed to trust nothing.
 */
import { applyStyles } from './engine.ts';
import postcss from 'postcss';

/** A JSON value as it may be stored in metadata, overrides and tokens. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
/** Free-form per-node information: names, intent, notes. Validated as JSON, never interpreted by the core. */
export type Metadata = { [key: string]: Json };
/** Declarations of one element: CSS property → value. */
export type Style = Record<string, string>;
/** Override declarations may delete a property with null. */
export type StyleOverrides = Record<string, string | null>;
/** Ordered CSS contracts; the admitted Style fields remain maps until the versioned cutover. */
export type { CssDeclaration, CssDeclarationOperation } from './declarations.ts';
/** HTML attributes of one element. */
export type Attrs = Record<string, string>;
export type NodeId = string;
/** Artboard geometry and size on the board (not the page). */
export interface Artboard { x: number; y: number; width: number; height: number }
/** Validation budgets; `LIMITS` for authored documents, `PROJECTION_LIMITS` for expanded projections. */
export interface Limits { nodes: number; depth: number; bytes: number; text: number; instanceDepth?: number }
/** Budgets for foreign sources (importers), which are larger but still bounded. */
export interface SourceLimits { bytes: number; nodes: number; depth: number; roots: number }

/** What an instance may change inside its component: the same fields a node patch may set, keyed by component node ID. */
export interface Override {
  tag?: string;
  className?: string;
  style?: StyleOverrides;
  attrs?: Record<string, string | null>;
  metadata?: Metadata;
  /** The instance's single text child. */
  text?: string;
  /** A text node's content, when the addressed node is text. */
  content?: string;
}
export interface ElementNode {
  id: NodeId;
  type: 'element';
  tag: string;
  attrs: Attrs;
  className: string;
  style: Style;
  metadata: Metadata;
  children: NodeId[];
  /** Set on a component definition (and its instances render it). */
  reusable?: true;
}
export interface TextNode { id: NodeId; type: 'text'; content: string; metadata: Metadata }
export interface RefNode { id: NodeId; type: 'ref'; ref: string; descendants: Record<string, Override>; metadata: Metadata }
export type Node = ElementNode | TextNode | RefNode;
/** An accepted frame: what `validateDocument` returns and what every tool and patch speaks. */
export interface DocumentModel {
  schemaVersion: 1;
  id: NodeId;
  name: string;
  version: number;
  artboard: Artboard;
  rootId: NodeId;
  tokens: Record<string, string>;
  css: string;
  metadata: Metadata;
  nodes: Record<NodeId, Node>;
}
/** A node as `inspectDocument` projects it: the stored node plus where it sits. */
export type ProjectedNode = Node & { parentId: NodeId | null; ancestors: NodeId[]; childNodes?: ProjectedNode[] };
export interface InspectQuery { ids?: NodeId[]; query?: string; depth?: number; limit?: number }
export interface InspectResult { documentId: NodeId; version: number; rootId: NodeId; total: number; truncated: boolean; nodes: ProjectedNode[] }
/** Declarative styles and the class patch they become. */
export interface StyleOptions { colourNames?: ReadonlySet<string> }

/** A domain error with a stable code: adapters show `message`, callers branch on `code`. */
export class DivletError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DivletError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const LIMITS: Readonly<Limits> = Object.freeze({ nodes: 2000, depth: 64, bytes: 2 * 1024 * 1024, text: 262144 });
export const PROJECTION_LIMITS: Readonly<Limits> = Object.freeze({ nodes: 100000, bytes: 64 * 1024 * 1024, depth: 128, text: 262144, instanceDepth: 32 });
// Profiles are selected by internal callers, never serialized document metadata or numeric overrides.
export function documentLimits(limits: Limits = LIMITS): Limits {
  if (limits !== LIMITS && limits !== PROJECTION_LIMITS) throw new DivletError('INVALID_LIMIT', 'Document validation requires an existing caller-owned limits profile.');
  return limits;
}
export const VOID_TAGS: ReadonlySet<string> = new Set('area br col hr img input source track wbr'.split(' '));
export const SVG_TAGS: ReadonlySet<string> = new Set('svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask pattern filter feGaussianBlur use symbol title desc'.split(' '));
export const HTML_TAGS: ReadonlySet<string> = new Set('a abbr address article aside b bdi bdo blockquote br button caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr i img input ins kbd label legend li main mark menu meter nav ol optgroup option output p picture pre progress q rp rt ruby s samp section select small source span strong sub summary sup table tbody td textarea tfoot th thead time tr track u ul var video audio wbr'.split(' '));
/** Whether a tag can be stored in a divlet document (SVG tags only inside <svg>). */
export const supportsTag = (tag: string, inSvg = false): boolean => (inSvg ? SVG_TAGS.has(tag) : HTML_TAGS.has(tag) || tag === 'svg');
const BLOCK_TAGS: ReadonlySet<string> = new Set('address article aside blockquote details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section summary table ul'.split(' '));
const TABLE_CHILDREN: Readonly<Record<string, readonly string[]>> = { table: ['caption', 'colgroup', 'thead', 'tbody', 'tfoot'], thead: ['tr'], tbody: ['tr'], tfoot: ['tr'], tr: ['td', 'th'], colgroup: ['col'] };
const CONTENT_CHILDREN: Readonly<Record<string, readonly string[]>> = { ...TABLE_CHILDREN, select: ['option', 'optgroup'], optgroup: ['option'] };
// One authored table grammar defines both child content and required parent contexts.
const TABLE_PARENTS = new Map<string, string[]>();
for (const [parent, children] of Object.entries(TABLE_CHILDREN)) {
  for (const child of children) TABLE_PARENTS.set(child, [...(TABLE_PARENTS.get(child) ?? []), parent]);
}
const BAD_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
export const ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;
const TOKEN = /^--[A-Za-z_][A-Za-z0-9_-]*$/;
const DOC_KEYS: ReadonlySet<string> = new Set('schemaVersion id name version artboard rootId tokens css metadata nodes'.split(' '));
const ELEMENT_KEYS: ReadonlySet<string> = new Set('id type tag attrs className style metadata children reusable'.split(' '));
const TEXT_KEYS: ReadonlySet<string> = new Set('id type content metadata'.split(' '));
const REF_KEYS: ReadonlySet<string> = new Set('id type ref descendants metadata'.split(' '));
const OVERRIDE_KEYS: ReadonlySet<string> = new Set('tag className style attrs metadata text content'.split(' '));
/** "nodeId" (same frame) or "frameId/nodeId". */
export const REF = /^(?:[A-Za-z][A-Za-z0-9_.:-]{0,95}\/)?[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;
/** Node IDs joined by "/" where the path crosses nested instances. */
const ADDRESS = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}(?:\/[A-Za-z][A-Za-z0-9_.:-]{0,95}){0,15}$/;

/** An object as it arrives: unchecked. Validation is what turns it into a typed node or document. */
type Unchecked = Record<string, any>;
/** Look up an unchecked record entry that a preceding check has already proved present. */
const at = <T>(record: Record<string, T>, key: string): T => record[key] as T;

export function fail(message: string, details?: unknown, code = 'INVALID_DOCUMENT'): never {
  throw new DivletError(code, message, details);
}

export function object(value: unknown, label: string): Unchecked {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`);
  return value as Unchecked;
}

export function string(value: unknown, label: string, max = 65536): string {
  if (typeof value !== 'string' || value.length > max) fail(`${label} must be a string of at most ${max} characters`);
  if (value.includes('\0') || !value.isWellFormed()) fail(`${label} contains an unrepresentable character`);
  return value.replace(/\r\n?/g, '\n');
}

export function keys(value: Unchecked, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`Unsupported ${label} field: ${key}`);
}

export function json(value: unknown, label = 'value', depth = 0, preserveKeys = false, maxDepth = 80): void {
  if (depth > maxDepth) fail(`${label} is too deeply nested`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) json(entry, label, depth + 1, preserveKeys, maxDepth);
    return;
  }
  const record = object(value, label);
  for (const [key, entry] of Object.entries(record)) {
    if (!preserveKeys && BAD_KEYS.has(key)) fail(`Unsafe property name: ${key}`);
    json(entry, label, depth + 1, preserveKeys, maxDepth);
  }
}

export const SOURCE_LIMITS: Readonly<SourceLimits> = Object.freeze({ bytes: 32 * 1024 * 1024, nodes: 10000, depth: 64, roots: 200 });

export function validateCss(css: unknown, limits: Limits = LIMITS): string {
  let text = string(css, 'css', documentLimits(limits) === LIMITS ? LIMITS.text : limits.bytes);
  text = text.replace(/\r\n?/g, '\n');
  if (/<\/style/i.test(text)) fail('CSS cannot contain a closing style tag');
  let ast: postcss.Root;
  try { ast = postcss.parse(text); } catch (error) { throw new DivletError('INVALID_CSS', (error as { reason?: string; message: string }).reason || (error as Error).message); }
  ast.walkAtRules(rule => {
    if (/^(import|plugin|config|source|tailwind|reference)$/i.test(rule.name)) fail(`Unsupported CSS build directive: @${rule.name}`, undefined, 'UNSUPPORTED_CSS');
  });
  if (/expression\s*\(|javascript\s*:/i.test(text)) fail('Executable CSS is not supported', undefined, 'UNSUPPORTED_CSS');
  return text;
}

export function metadata(value: unknown, label: string): Metadata {
  const record = object(value, label);
  json(record, label);
  const maxLength = 65536;
  if (JSON.stringify(record).length > maxLength) fail(`${label} exceeds ${maxLength} serialized UTF-16 code units`);
  return structuredClone(record) as Metadata;
}

export function safeAttribute(name: string, value: string, nodeId: string): void {
  if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name) || /^on/i.test(name)) fail(`Unsupported attribute ${name} on ${nodeId}`);
  if (/^(data-divlet-|style$|class$|srcdoc$)/i.test(name)) fail(`Reserved attribute ${name} on ${nodeId}`);
  string(value, `attribute ${name}`, 65536);
  if (/^(href|src|action|formaction|poster|xlink:href)$/i.test(name)) {
    const compact = value.replace(/[\u0000-\u0020\u007f]+/g, '');
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1]?.toLowerCase();
    if (scheme && !['http', 'https', 'mailto', 'tel'].includes(scheme)) fail(`Unsupported URL scheme in ${name} on ${nodeId}`);
  }
}

/** Normalized inline style; `nullable` keeps null values (deletions inside overrides). */
export function validStyle(input: unknown, id: string, nullable?: false): Style;
export function validStyle(input: unknown, id: string, nullable: true): StyleOverrides;
export function validStyle(input: unknown, id: string, nullable = false): Style | StyleOverrides {
  const style = structuredClone(object(input, `${id}.style`)) as Record<string, unknown>;
  for (const [property, value] of Object.entries(style)) {
    if (!TOKEN.test(property) && !/^[a-z][a-z0-9-]*$/.test(property)) fail(`Invalid CSS property: ${property}`);
    if (value === null && nullable) continue;
    string(value, `${id}.style.${property}`, 16384);
    validateCss(`a{${property}:${value}}`);
    const stylesheet = postcss.parse(`a{${property}:${value}}`);
    const parsed = stylesheet.first as postcss.Rule;
    const declaration = parsed.nodes[0] as postcss.Declaration | undefined;
    if (stylesheet.nodes.length !== 1 || parsed.nodes.length !== 1 || declaration?.type !== 'decl' || declaration.prop !== property) fail(`CSS value escapes its declaration: ${property}`);
    const value2 = declaration.value;
    style[property] = `${value2}${declaration.important ? ' !important' : ''}`.replace(/\r\n?/g, '\n');
  }
  return style as Style;
}

/** Instance overrides: address → partial node (tag, className, style, attrs, metadata, text or content). */
function validOverrides(input: unknown, id: string): Record<string, Override> {
  const overrides = structuredClone(object(input, `${id}.descendants`)) as Record<string, Unchecked>;
  for (const [address, rawOverride] of Object.entries(overrides)) {
    if (!ADDRESS.test(address)) fail(`Invalid override address on ${id}: ${address}. Use a node ID of the component, or IDs joined by "/" to reach into a nested instance.`);
    const override = object(rawOverride, `${id}.descendants.${address}`);
    for (const key of Object.keys(override)) if (!OVERRIDE_KEYS.has(key)) fail(`Unsupported override field ${key} on ${id} → ${address}. Overrides may set tag, className, style, attrs, metadata, text or content.`);
    if (override.tag !== undefined && (typeof override.tag !== 'string' || (!HTML_TAGS.has(override.tag) && !SVG_TAGS.has(override.tag)))) fail(`Unsupported tag in override ${id} → ${address}: ${override.tag}`);
    for (const key of ['className', 'text', 'content'] as const) if (override[key] !== undefined) override[key] = string(override[key], `${id} → ${address}.${key}`, LIMITS.text);
    if (override.style !== undefined) override.style = validStyle(override.style, `${id} → ${address}`, true);
    if (override.attrs !== undefined) {
      const attrs = object(override.attrs, `${id} → ${address}.attrs`);
      for (const [name, value] of Object.entries(attrs)) if (value !== null) safeAttribute(name, value as string, `${id} → ${address}`);
    }
    if (override.metadata !== undefined) override.metadata = metadata(override.metadata, `${id} → ${address}.metadata`);
  }
  return overrides as Record<string, Override>;
}

function validateParent(parent: ElementNode, child: Node, nodes: Record<NodeId, Unchecked>, ancestors: NodeId[]): void {
  const tag = child.type === 'element' ? child.tag : null;
  if (parent.tag === 'textarea' && (child.type !== 'text' || parent.children.length > 1)) fail('textarea supports at most one text child');
  const tagOf = (id: NodeId) => at(nodes, id).tag as string | undefined;
  if (tag && BLOCK_TAGS.has(tag) && ancestors.some(id => tagOf(id) === 'p')) fail('A paragraph cannot contain block elements');
  if (/^h[1-6]$/.test(tag ?? '') && ancestors.some(id => /^h[1-6]$/.test(tagOf(id) ?? ''))) fail('A heading cannot contain another heading');
  if (tag === 'a' && ancestors.some(id => tagOf(id) === 'a')) fail('Links cannot be nested');
  if (tag === 'button' && ancestors.some(id => tagOf(id) === 'button')) fail('Buttons cannot be nested');
  if (tag === 'form' && ancestors.some(id => tagOf(id) === 'form')) fail('Forms cannot be nested');
  const allowed = CONTENT_CHILDREN[parent.tag];
  if (allowed) {
    const text = child.type === 'text' ? child.content : '';
    const nonWhitespace = Object.hasOwn(TABLE_CHILDREN, parent.tag) ? /[^\t\n\f\r ]/.test(text) : text.trim() !== '';
    if (tag ? !allowed.includes(tag) : nonWhitespace) fail(`Unsupported child of ${parent.tag}`);
  }
  if (parent.tag === 'option' && tag) fail('option supports text only');
  if (tag === 'li' && !['ul', 'ol', 'menu'].includes(parent.tag)) fail('li must be a direct child of a list');
  if (tag !== null && ['dt', 'dd'].includes(tag) && parent.tag !== 'dl') fail(`${tag} must be a direct child of dl`);
}

export function validateDocument(input: unknown, { limits = LIMITS }: { limits?: Limits } = {}): DocumentModel {
  documentLimits(limits);
  const raw = object(input, 'document');
  json(raw, 'document');
  if (Buffer.byteLength(JSON.stringify(raw)) > limits.bytes) fail(`Document exceeds ${limits.bytes / 1024 / 1024} MiB`);
  keys(raw, DOC_KEYS, 'document');
  if (raw.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) fail('Document id must be a safe identifier');
  string(raw.name, 'name', 512);
  if (!Number.isSafeInteger(raw.version) || raw.version < 1) fail('version must be a positive integer');
  const artboard = object(raw.artboard, 'artboard');
  keys(artboard, new Set(['x', 'y', 'width', 'height']), 'artboard');
  for (const key of ['x', 'y', 'width', 'height']) if (!Number.isFinite(artboard[key])) fail(`artboard.${key} must be finite`);
  if (artboard.width < 1 || artboard.height < 1 || artboard.width > 16384 || artboard.height > 16384) fail('Artboard dimensions must be between 1 and 16384');
  if (Math.abs(artboard.x) > 1e7 || Math.abs(artboard.y) > 1e7) fail('Artboard coordinates are out of range');
  const rawNodes = object(raw.nodes, 'nodes');
  const entries = Object.entries(rawNodes);
  if (!entries.length || entries.length > limits.nodes) fail(`Document must contain 1–${limits.nodes} nodes`);
  if (typeof raw.rootId !== 'string' || !Object.hasOwn(rawNodes, raw.rootId)) fail('rootId must reference an existing node');
  const nodes: Record<NodeId, Unchecked> = {};
  for (const [id, rawNode] of entries) {
    const node = object(rawNode, `node ${id}`);
    if (!ID.test(id) || node.id !== id) fail(`Node id/key mismatch or unsafe id: ${id}`);
    if (node.type === 'text') {
      keys(node, TEXT_KEYS, `text ${id}`);
      nodes[id] = { id, type: 'text', content: string(node.content, `${id}.content`, LIMITS.text), metadata: metadata(node.metadata ?? {}, `${id}.metadata`) };
      continue;
    }
    if (node.type === 'ref') {
      keys(node, REF_KEYS, `instance ${id}`);
      if (typeof node.ref !== 'string' || !REF.test(node.ref)) fail(`${id}.ref must name a component as "nodeId" (same frame) or "frameId/nodeId"`);
      nodes[id] = { id, type: 'ref', ref: node.ref, descendants: validOverrides(node.descendants ?? {}, id), metadata: metadata(node.metadata ?? {}, `${id}.metadata`) };
      continue;
    }
    if (node.type !== 'element') fail(`Unsupported node type on ${id}: use element, text or ref`);
    keys(node, ELEMENT_KEYS, `element ${id}`);
    if (node.reusable !== undefined && typeof node.reusable !== 'boolean') fail(`${id}.reusable must be true or false`);
    if (!HTML_TAGS.has(node.tag) && !SVG_TAGS.has(node.tag)) fail(`Unsupported tag on ${id}: ${node.tag}`);
    const attrs = structuredClone(object(node.attrs ?? {}, `${id}.attrs`)) as Attrs;
    for (const [name, value] of Object.entries(attrs)) {
      safeAttribute(name, value, id);
      attrs[name] = string(value, `attribute ${name}`);
    }
    const style = validStyle(node.style ?? {}, id);
    const children = node.children ?? [];
    if (!Array.isArray(children) || children.some(child => typeof child !== 'string')) fail(`${id}.children must be an array of IDs`);
    if (VOID_TAGS.has(node.tag) && children.length) fail(`Void element ${node.tag} cannot have children`);
    nodes[id] = { id, type: 'element', tag: node.tag, attrs: structuredClone(attrs), className: string(node.className ?? '', `${id}.className`, 32768), style: structuredClone(style), metadata: metadata(node.metadata ?? {}, `${id}.metadata`), children: [...children] };
    if (node.reusable) nodes[id].reusable = true;
  }
  if (at(nodes, raw.rootId).type !== 'element') fail('Document root must be an element');
  const seen = new Set<NodeId>();
  function visit(id: NodeId, ancestors: NodeId[] = []): void {
    if (!Object.hasOwn(nodes, id)) fail(`Unknown child node: ${id}`);
    if (ancestors.length > limits.depth) fail('Tree exceeds maximum depth');
    if (seen.has(id)) fail(`Cycle or multiple parents for node: ${id}`);
    seen.add(id);
    const node = at(nodes, id);
    if (node.type === 'element') {
      const inSvg = ancestors.some(parentId => at(nodes, parentId).tag === 'svg');
      if (node.tag !== 'svg' && SVG_TAGS.has(node.tag) && !HTML_TAGS.has(node.tag) && !inSvg) fail(`SVG element ${node.tag} must be inside svg`);
      if (inSvg && !SVG_TAGS.has(node.tag)) fail(`Unsupported HTML element inside SVG: ${node.tag}`);
      const parents = TABLE_PARENTS.get(node.tag);
      if (parents) {
        const parentId = ancestors.at(-1);
        if (!parentId || !parents.includes(at(nodes, parentId).tag)) fail(`${node.tag} must be a direct child of ${parents.join(', ')}`);
      }
      if (!inSvg && node.tag !== 'svg') {
        const normalized: Attrs = {};
        for (const [name, value] of Object.entries(node.attrs)) {
          const key = name.toLowerCase();
          if (Object.hasOwn(normalized, key)) fail(`Duplicate normalized attribute: ${key}`);
          normalized[key] = value as string;
        }
        node.attrs = normalized;
      }
      for (const child of node.children) {
        // Instances are checked once expanded, when their component's tags are known.
        const childNode = nodes[child];
        if (childNode && childNode.type !== 'ref') validateParent(node as ElementNode, childNode as Node, nodes, [...ancestors, id]);
        visit(child, [...ancestors, id]);
      }
    }
  }
  visit(raw.rootId);
  if (seen.size !== entries.length) fail('All nodes must be reachable from rootId');
  const tokens = validateTokens(raw.tokens ?? {});
  return {
    schemaVersion: 1,
    id: raw.id,
    name: string(raw.name, 'name', 512),
    version: raw.version,
    artboard: { x: artboard.x, y: artboard.y, width: artboard.width, height: artboard.height },
    rootId: raw.rootId,
    tokens: structuredClone(tokens),
    css: validateCss(raw.css ?? '', limits),
    metadata: metadata(raw.metadata ?? {}, 'metadata'),
    nodes: nodes as Record<NodeId, Node>,
  };
}

/** CSS custom properties (`--name`) mapped to values. */
export function validateTokens(input: unknown): Record<string, string> {
  const tokens = structuredClone(object(input, 'tokens')) as Record<string, unknown>;
  for (const [name, value] of Object.entries(tokens)) {
    if (!TOKEN.test(name)) fail(`Invalid token name: ${name}. Tokens are CSS custom properties such as --accent.`);
    string(value, `token ${name}`, 16384);
    validateCss(`:root{${name}:${value}}`);
    const stylesheet = postcss.parse(`:root{${name}:${value}}`);
    const declarations = (stylesheet.first as postcss.Rule).nodes;
    const declaration = declarations[0] as postcss.Declaration | undefined;
    if (stylesheet.nodes.length !== 1 || declarations.length !== 1 || declaration?.type !== 'decl' || declaration.prop !== name) fail(`Token value escapes its declaration: ${name}`);
    tokens[name] = `${declaration.value}${declaration.important ? ' !important' : ''}`.replace(/\r\n?/g, '\n');
  }
  return tokens as Record<string, string>;
}

/** Validate a JSON object (metadata-like). */
export const validateMetadata = (value: unknown, label: string): Metadata => metadata(value, label);

export function merge(target: unknown, patch: unknown): any {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch);
  const result: Unchecked = target && typeof target === 'object' && !Array.isArray(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = merge(result[key], value);
  }
  return result;
}

/** Theme colour names from token maps (`--color-brand` → `brand`); a `bg-<name>` or `text-<name>` class then owns a colour. */
export const colourNames = (...tokenMaps: Array<Record<string, string> | undefined | null>): Set<string> => new Set(tokenMaps.flatMap(tokens => Object.keys(tokens || {})).flatMap(name => {
  const match = /^--color-(.+)$/.exec(name);
  return match?.[1] ? [match[1]] : [];
}));

/**
 * `nodes.<id>.styles = { property: value }` declares CSS and becomes Tailwind classes: each property replaces the class that set it
 * (null removes it); a `className` given in the same node patch is the starting point.
 */
function withStyles(base: DocumentModel, patch: Unchecked, options: StyleOptions = {}): Unchecked {
  if (!patch.nodes || typeof patch.nodes !== 'object') return patch;
  let nodes = patch.nodes as Unchecked;
  for (const [id, value] of Object.entries(nodes)) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'styles')) continue;
    const node = base.nodes[id];
    if (!node || node.type !== 'element') fail(`styles apply to an element: ${id}`);
    const { styles, ...rest } = value as Unchecked;
    nodes = { ...nodes, [id]: { ...rest, className: applyStyles(Object.hasOwn(rest, 'className') ? rest.className : node.className, styles, options) } };
  }
  return nodes === patch.nodes ? patch : { ...patch, nodes };
}

export function applyDocumentPatch(document: unknown, patch: unknown, options: StyleOptions = {}): DocumentModel {
  const base = validateDocument(document);
  const rawPatch = object(patch, 'patch');
  json(rawPatch, 'patch');
  keys(rawPatch, new Set('name artboard tokens css metadata rootId nodes'.split(' ')), 'patch');
  return validateDocument(merge(base, withStyles(base, rawPatch, options)));
}

export function inspectDocument(document: unknown, { ids, query, depth = 1, limit = 80 }: InspectQuery = {}, { limits = LIMITS }: { limits?: Limits } = {}): InspectResult {
  const doc = validateDocument(document, { limits });
  if (!Number.isInteger(depth) || depth < 0 || depth > 8 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new DivletError('INVALID_QUERY', 'depth must be 0–8 and limit 1–200');
  const parent: Record<NodeId, NodeId> = {};
  for (const node of Object.values(doc.nodes)) if (node.type === 'element') for (const child of node.children) parent[child] = node.id;
  const search = query == null ? null : String(query).toLocaleLowerCase();
  let selected: Node[] = ids ? ids.map(id => {
    if (!Object.hasOwn(doc.nodes, id)) throw new DivletError('NOT_FOUND', `Unknown node: ${id}`);
    return at(doc.nodes, id);
  }) : search ? Object.values(doc.nodes).filter(node => JSON.stringify(node).toLocaleLowerCase().includes(search)) : [at(doc.nodes, doc.rootId)];
  const total = selected.length;
  selected = selected.slice(0, limit);
  let budget = limit;
  function project(node: Node, remaining: number): ProjectedNode {
    budget--;
    const copy = structuredClone(node) as ProjectedNode;
    copy.parentId = parent[node.id] ?? null;
    copy.ancestors = [];
    for (let id: NodeId | undefined = parent[node.id]; id; id = parent[id]) copy.ancestors.unshift(id);
    if (node.type === 'element' && remaining && budget > 0) {
      const childNodes: ProjectedNode[] = [];
      for (const id of node.children) {
        if (budget <= 0) break;
        childNodes.push(project(at(doc.nodes, id), remaining - 1));
      }
      copy.childNodes = childNodes;
    }
    return copy;
  }
  return { documentId: doc.id, version: doc.version, rootId: doc.rootId, total, truncated: total > selected.length, nodes: selected.map(node => project(node, depth)) };
}

export function createDemoDocument(): DocumentModel {
  const nodes: Record<NodeId, Unchecked> = {};
  function element(id: NodeId, tag: string, className: string, children: NodeId[], extra: Unchecked = {}): NodeId {
    nodes[id] = { id, type: 'element', tag, className, children, ...extra };
    return id;
  }
  function text(id: NodeId, content: string): NodeId {
    nodes[id] = { id, type: 'text', content };
    return id;
  }
  // A starter worth keeping: warm paper, one deep-green hero block and three soft colour cards in a bento layout.
  // No lines or rules anywhere — shape and colour do the separating. Colours: --surface (paper), --accent (gold).
  element('root', 'main', 'grid min-h-screen grid-cols-1 content-start gap-4 bg-(--surface) p-5 font-sans text-[#1d1b16] antialiased sm:grid-cols-12 sm:gap-5 sm:p-8', ['nav', 'hero', 'cards', 'footer']);
  element('nav', 'header', 'flex items-center justify-between sm:col-span-12', ['brand', 'status']);
  element('brand', 'div', "text-lg font-semibold tracking-tight before:mr-2.5 before:inline-block before:size-5 before:rounded-md before:bg-(--accent) before:align-[-4px] before:content-['']", [text('brand-text', 'divlet / studio')]);
  element('status', 'span', 'rounded-full bg-[#1d1b16] px-4 py-1.5 text-xs font-medium text-[#f4efe6]', [text('status-text', 'A little space for big ideas')]);
  element('hero', 'section', 'flex min-h-[26rem] flex-col rounded-[2rem] bg-[#123524] p-7 text-[#f6f0e3] sm:col-span-7 sm:p-9', ['eyebrow', 'title', 'description', 'cta'], { metadata: { intent: 'A welcoming hero. Keep the title the strongest visual element.' } });
  element('eyebrow', 'p', 'mb-7 w-fit rounded-full bg-white/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-[#e9d9b0]', [text('eyebrow-text', 'YOUR NEXT GOOD IDEA')]);
  element('title', 'h1', 'mb-3 pb-2 text-[42px] font-semibold leading-[1.1] tracking-[-0.04em] sm:text-[48px]', [text('title-text', 'Make room for\nsomething new.')], { style: { 'white-space': 'pre-line' } });
  element('description', 'p', 'mb-8 max-w-sm text-[15px] leading-6 text-[#b9cdbd]', [text('description-text', 'Shape a thought, explore a direction, and watch it become real. Your agent handles the details. You keep the vision.')]);
  element('cta', 'button', 'mt-auto w-fit rounded-full bg-(--accent) px-6 py-3.5 text-sm font-semibold text-[#1d1b16] transition duration-200 hover:-translate-y-0.5 hover:bg-[#e8cc93] active:translate-y-0', [text('cta-text', 'Start exploring  ↗')], { attrs: { type: 'button' }, metadata: { purpose: 'primary-action', note: 'A static prototype button; no application behavior is attached.' } });
  element('cards', 'section', 'grid grid-cols-1 gap-4 sm:col-span-5 sm:gap-5', ['card-one', 'card-two', 'card-three']);
  for (const [id, title, detail, number, tint] of [['card-one', 'A clear direction', 'Start with what matters.', '01', 'bg-[#e3d4ff]'], ['card-two', 'Small iterations', 'Make one good change.', '02', 'bg-[#ffd9c4]'], ['card-three', 'A living canvas', 'See every idea take shape.', '03', 'bg-[#cbe7d4]']] as const) {
    element(id, 'article', `grid grid-cols-[auto_1fr] items-center gap-x-5 rounded-[1.5rem] ${tint} px-6 py-5 transition duration-200 hover:-translate-y-0.5`, [`${id}-number`, `${id}-title`, `${id}-detail`]);
    element(`${id}-number`, 'p', 'row-span-2 text-[44px] font-semibold leading-[1.3] tracking-[-0.05em] text-[#1d1b16]/80', [text(`${id}-number-text`, number)]);
    element(`${id}-title`, 'h2', 'self-end text-base font-semibold tracking-tight', [text(`${id}-title-text`, title)]);
    element(`${id}-detail`, 'p', 'text-[13px] leading-5 text-[#1d1b16]/65', [text(`${id}-detail-text`, detail)]);
  }
  element('footer', 'footer', 'flex flex-wrap items-center justify-between gap-4 px-1 pt-1 text-xs text-[#6f6859] sm:col-span-12', ['footer-left-wrap', 'footer-right-wrap']);
  element('footer-left-wrap', 'span', '', [text('footer-left', 'Built with Pi. Rendered by the web.')]);
  element('footer-right-wrap', 'span', 'font-mono tracking-wider', [text('footer-right', 'MODEL ↔ HTML')]);
  return validateDocument({ schemaVersion: 1, id: 'welcome', name: 'A space for ideas', version: 1, artboard: { x: 80, y: 100, width: 860, height: 620 }, rootId: 'root', tokens: { '--accent': '#d7b474', '--surface': '#f4efe6' }, css: '', metadata: { intent: 'An editable starter artboard. Select it on the board, then ask Pi to change its layout or text.' }, nodes });
}
