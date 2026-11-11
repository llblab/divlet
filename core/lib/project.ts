/*
 * Source ownership stays in one JSON file, <name>.divlet.
 * The document is { schemaVersion: 1, name, version, tokens, css, metadata, outputDir, frames }.
 *
 * A legacy frame is the ID-addressed node tree of one artboard. Any element marked
 * `reusable: true` is a component; a node `{ type: "ref", ref: "frameId/nodeId" }` is an
 * instance of it, with `descendants` overrides addressed by component node IDs (joined by
 * "/" to reach into nested instances), following the Pencil .pen conventions.
 */
import path from 'node:path';
import {
  DivletError, validateDocument, SOURCE_LIMITS, LIMITS, PROJECTION_LIMITS, documentLimits, validateTokens, validateCss,
  validateMetadata, string, merge, REF,
} from './model.ts';
import type { Attrs, DocumentModel, Limits, Metadata, Node, NodeId, Override, Style } from './model.ts';

export const PROJECT_SCHEMA = 1;
const MAX_FRAMES = SOURCE_LIMITS.roots;
const PROJECT_KEYS: ReadonlySet<string> = new Set(['schemaVersion', 'name', 'version', 'tokens', 'css', 'metadata', 'outputDir', 'frames']);
const FIELDS = ['name', 'tokens', 'css', 'metadata', 'outputDir'];
const MAX_EXPANDED_NODES = 4000;
const MAX_INSTANCE_DEPTH = 12;

/** Project-level fields: everything a project holds besides its frames. */
export interface ProjectSettings {
  name: string;
  version: number;
  tokens: Record<string, string>;
  css: string;
  metadata: Metadata;
  /** Relative build destination, or null for the default `.divlet/<source stem>/`. */
  outputDir: string | null;
}
/** A project file as read from disk: its settings and its frames. */
export interface ProjectFile { settings: ProjectSettings; frames: DocumentModel[] }
/** A component definition found in a frame, with the text parts an instance may override. */
export interface ComponentInfo { ref: string; frameId: NodeId; nodeId: NodeId; name: string; tag: string; texts: Array<{ id: NodeId; content: string }> }
/** An instance in a frame: its node ID and the component it renders. */
export interface InstanceInfo { id: NodeId; ref: string; frame: NodeId; node: NodeId }
/** Where a generated part came from: the instance that produced it and the component address inside it. */
export interface ExpandedPart { instance: NodeId; address: string }
export interface ExpandedFrame { document: DocumentModel; parts: Map<NodeId, ExpandedPart>; uses: string[]; instances: NodeId[] }
export type FrameLookup = (id: NodeId) => DocumentModel | undefined;
/** The expansion tree: a frame's nodes with addresses (`key`) instead of stable IDs, before validation makes it a document. */
interface PartText { key: string; type: 'text'; content: string; metadata: Metadata }
interface PartElement { key: string; type: 'element'; tag: string; attrs: Attrs; className: string; style: Style; metadata: Metadata; children: string[] }
type Part = PartText | PartElement;

/** A domain error with its own code; declared as a function so its `never` return narrows a preceding guard. */
function fail(code: string, message: string, details?: unknown): never { throw new DivletError(code, message, details); }
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A frame as the document validator sees it (frames are stored without schemaVersion). */
export const frameDocument = (frame: unknown): DocumentModel => validateDocument({ schemaVersion: 1, ...(frame as object) });
/** A frame as stored in the project file. */
export function storedFrame(document: DocumentModel): Omit<DocumentModel, 'schemaVersion'> {
  const { schemaVersion, ...frame } = document;
  return frame;
}

/** Project-level fields (everything but frames), validated. */
export function validateSettings(source: unknown = {}): ProjectSettings {
  if (!isObject(source)) fail('INVALID_PROJECT', 'Project settings must be an object');
  const input = source;
  let name: string;
  try { name = string(input.name ?? 'Untitled project', 'Project name', 512); }
  catch (error) { const cause = error as DivletError; fail('INVALID_PROJECT', cause.message, cause.details); }
  const version = input.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) fail('INVALID_PROJECT', 'Project version must be a positive integer');
  const outputDir = input.outputDir ?? null;
  if (outputDir !== null && (typeof outputDir !== 'string' || !outputDir.trim() || outputDir.length > 2048 || /[\\\u0000-\u001f]/.test(outputDir) || path.posix.isAbsolute(outputDir) || path.win32.isAbsolute(outputDir) || /^[a-z]:/i.test(outputDir))) fail('INVALID_OUTPUT_DIR', 'outputDir must be a relative directory path, or null for the default.');
  return {
    name,
    version,
    tokens: validateTokens(input.tokens ?? {}),
    css: validateCss(input.css ?? ''),
    metadata: validateMetadata(input.metadata ?? {}, 'project metadata'),
    outputDir: outputDir as string | null,
  };
}

/** Patch project settings, including the relative output directory, with divlet merge rules. */
export function patchSettings(settings: ProjectSettings, patch: unknown): ProjectSettings {
  if (!isObject(patch)) fail('INVALID_PATCH', 'A project patch must be an object');
  for (const key of Object.keys(patch)) {
    if (!FIELDS.includes(key)) fail('INVALID_PATCH', key === 'nodes' || key === 'artboard' || key === 'rootId' ? `${key} belongs to a frame; pass frameId to patch a frame.` : `Unsupported project field: ${key}. A project patch may change name, tokens, css, metadata and outputDir.`);
  }
  return validateSettings(merge(settings, patch));
}

/** Read a project source without expansion; legacy frame projects remain available during the runtime transition. */
export function readProject(source: unknown): ProjectFile {
  if (!isObject(source)) fail('INVALID_PROJECT', 'A .divlet project must be a JSON object');
  const input = source;
  if (typeof input.version === 'string') fail('UNSUPPORTED_SOURCE', 'This file is a foreign source (for example PEN), not a Divlet project. Open it through divlet, which converts it.');
  for (const key of Object.keys(input)) if (!PROJECT_KEYS.has(key)) fail('INVALID_PROJECT', `Unsupported project field: ${key}. Put application data under metadata.`);
  if (input.schemaVersion !== PROJECT_SCHEMA) fail('INVALID_PROJECT', `schemaVersion must be ${PROJECT_SCHEMA}`);
  if (!Array.isArray(input.frames)) fail('INVALID_PROJECT', 'frames must be an array');
  if (input.frames.length > MAX_FRAMES) fail('INVALID_PROJECT', `A project can hold at most ${MAX_FRAMES} frames`);
  const settings = validateSettings(input);
  const frames: DocumentModel[] = [];
  const seen = new Set<NodeId>();
  for (const [index, frame] of (input.frames as unknown[]).entries()) {
    if (!isObject(frame)) fail('INVALID_PROJECT', `frames[${index}] must be an object`);
    let document: DocumentModel;
    try { document = frameDocument(frame); }
    catch (error) { const cause = error as DivletError; fail(cause.code || 'INVALID_PROJECT', `Frame ${typeof frame.id === 'string' ? frame.id : `#${index}`}: ${cause.message}`, cause.details); }
    if (seen.has(document.id)) fail('INVALID_PROJECT', `Duplicate frame id: ${document.id}`);
    seen.add(document.id);
    frames.push(document);
  }
  const lookup = new Map(frames.map(frame => [frame.id, frame]));
  for (const frame of frames) expandFrame(frame, id => lookup.get(id), settings);
  return { settings, frames };
}

/** Serialize the project source, or the legacy settings/frames pair during the runtime transition. */
export function writeProject(settings: ProjectSettings, frames: DocumentModel[]): string {
  if (!Array.isArray(frames)) fail('INVALID_PROJECT', 'A Divlet project is written from its settings and frames.');
  if (frames.length > MAX_FRAMES) fail('INVALID_PROJECT', `A project can hold at most ${MAX_FRAMES} frames`);
  return JSON.stringify({ schemaVersion: PROJECT_SCHEMA, name: settings.name, version: settings.version, tokens: settings.tokens, css: settings.css, metadata: settings.metadata, ...(settings.outputDir !== null && settings.outputDir !== undefined ? { outputDir: settings.outputDir } : {}), frames: frames.map(storedFrame) }, null, 2) + '\n';
}

export { PROJECTION_LIMITS } from './model.ts';

/* ---- components and instances -------------------------------------------- */

export function parseRef(ref: string, hostFrameId: string): { frame: string; node: string } {
  if (typeof ref !== 'string' || !REF.test(ref)) fail('INVALID_REF', `Invalid component reference: ${ref}`);
  const at = ref.indexOf('/');
  return at < 0 ? { frame: hostFrameId, node: ref } : { frame: ref.slice(0, at), node: ref.slice(at + 1) };
}

/** Every component in the given frames: where it lives, its name and the text parts an instance can override. */
export function listComponents(frames: DocumentModel[]): ComponentInfo[] {
  const out: ComponentInfo[] = [];
  for (const frame of frames) {
    for (const node of Object.values(frame.nodes)) {
      if (node.type !== 'element' || !node.reusable) continue;
      const texts: Array<{ id: string; content: string }> = [];
      const walk = (id: NodeId): void => {
        const item = frame.nodes[id];
        if (!item) return;
        if (item.type === 'text') texts.push({ id, content: item.content.slice(0, 80) });
        else if (item.type === 'element') item.children.forEach(walk);
      };
      walk(node.id);
      const named = typeof node.metadata?.name === 'string' && node.metadata.name.trim() ? node.metadata.name.trim() : node.id;
      out.push({ ref: `${frame.id}/${node.id}`, frameId: frame.id, nodeId: node.id, name: named, tag: node.tag, texts: texts.slice(0, 20) });
    }
  }
  return out;
}

/** Instances in a frame: ref node id → "frame/node" of its component. */
export function instancesOf(frame: DocumentModel): InstanceInfo[] {
  return Object.values(frame.nodes).filter(node => node.type === 'ref').map(node => ({ id: node.id, ref: node.ref, ...parseRef(node.ref, frame.id) }));
}

/**
 * Apply one instance override to a cloned part. `makeText` gives an element its text when the override sets `text`; an override
 * that names a field the target cannot hold fails with the address, because a silent no-op would look like a bug in the board.
 */
function applyOverride(node: Part, override: Override, where: string, makeText: (node: PartElement, content: string, label: string) => void): void {
  if (node.type === 'text') {
    for (const key of Object.keys(override)) if (key !== 'content' && key !== 'metadata') fail('INVALID_OVERRIDE', `${where} is text; override its content (not ${key}).`);
    if (override.content !== undefined) node.content = override.content;
    if (override.metadata !== undefined) node.metadata = merge(node.metadata, override.metadata);
    return;
  }
  if (override.content !== undefined) fail('INVALID_OVERRIDE', `${where} is an element; use text to replace its text, or address its text node.`);
  if (override.tag !== undefined) node.tag = override.tag;
  if (override.className !== undefined) node.className = override.className;
  for (const key of ['style', 'attrs', 'metadata'] as const) if (override[key] !== undefined) node[key] = merge(node[key], override[key]);
  if (override.text !== undefined) makeText(node, override.text, where);
}

/**
 * Expand every instance of a frame into real nodes. Returns a validated document that the
 * renderer can encode, the generated part IDs (part id → { instance, address }), and the
 * components the frame depends on ("frame/node", transitively).
 */
export function expandFrame(frame: DocumentModel, lookup: FrameLookup | null, settings: ProjectSettings | null, { limits = LIMITS }: { limits?: Limits } = {}): ExpandedFrame {
  documentLimits(limits);
  const maxNodes = limits === LIMITS ? MAX_EXPANDED_NODES : limits.nodes;
  const uses = new Set<string>();
  // The expansion is validated into a document at the end; until then it holds addresses in `key`, not stable IDs.
  const out: Record<NodeId, any> = {};
  const parts = new Map<NodeId, ExpandedPart>();
  const taken = new Set<string>(Object.keys(frame.nodes));
  let count = 0;
  const bump = (): void => { if (++count > maxNodes) fail('TOO_LARGE', `Frame ${frame.id} expands to more than ${maxNodes} nodes.`); };
  const resolveFrame = (id: string): DocumentModel | undefined => (id === frame.id ? frame : lookup?.(id));

  /** Instantiate the component of `refNode` (declared in frame `hostId`): a map of address → cloned part. */
  function instantiate(refNode: Extract<Node, { type: 'ref' }>, hostId: string, stack: string[], where: string): { rootKey: string; nodes: Map<string, Part> } {
    const { frame: frameId, node: nodeId } = parseRef(refNode.ref, hostId);
    const source = resolveFrame(frameId);
    const key = `${frameId}/${nodeId}`;
    if (!source) fail('INVALID_REF', `${where} uses ${refNode.ref}, but there is no frame ${frameId}.`);
    const root = source.nodes[nodeId];
    if (!root) fail('INVALID_REF', `${where} uses ${refNode.ref}, but frame ${frameId} has no node ${nodeId}.`);
    if (root.type !== 'element' || !root.reusable) fail('INVALID_REF', `${where} uses ${refNode.ref}, which is not a component. Mark the element with "reusable": true first.`);
    if (stack.includes(key)) fail('COMPONENT_CYCLE', `Component cycle: ${[...stack, key].join(' → ')}`);
    if (stack.length >= MAX_INSTANCE_DEPTH) fail('TOO_DEEP', `Instances are nested more than ${MAX_INSTANCE_DEPTH} levels deep at ${where}.`);
    uses.add(key);
    const nodes = new Map<string, Part>();
    let textSeed = 0;
    const makeText = (node: PartElement, content: string, label: string): void => {
      const texts = node.children.filter(child => nodes.get(child)?.type === 'text');
      if (node.children.length === 1 && texts.length === 1) { (nodes.get(texts[0] as string) as PartText).content = content; return; }
      if (node.children.length) fail('INVALID_OVERRIDE', `${label} mixes text and elements; address one of its text nodes with content instead.`);
      const id = `${node.key}#t${++textSeed}`;
      nodes.set(id, { key: id, type: 'text', content, metadata: {} });
      node.children = [id];
    };
    // Clone the definition; nested instances become address-prefixed subtrees.
    const clone = (id: NodeId, prefix: string): string => {
      const item = source.nodes[id] as Node;
      const address = prefix + id;
      if (item.type === 'ref') {
        const nested = instantiate(item, source.id, [...stack, key], `${where} → ${address}`);
        for (const [nestedAddress, node] of nested.nodes) {
          const full = nestedAddress === nested.rootKey ? address : `${address}/${nestedAddress}`;
          node.key = full;
          if (node.type === 'element') node.children = node.children.map(child => (child === nested.rootKey ? address : `${address}/${child}`));
          nodes.set(full, node);
        }
        nodes.set(`${address}/${nested.rootKey}`, nodes.get(address) as Part);
        return address;
      }
      if (item.type === 'text') { nodes.set(address, { key: address, type: 'text', content: item.content, metadata: structuredClone(item.metadata) }); return address; }
      const node: PartElement = { key: address, type: 'element', tag: item.tag, attrs: structuredClone(item.attrs), className: item.className, style: structuredClone(item.style), metadata: structuredClone(item.metadata), children: [] };
      nodes.set(address, node);
      node.children = item.children.map(child => clone(child, prefix));
      return address;
    };
    clone(nodeId, '');
    for (const [address, override] of Object.entries(refNode.descendants ?? {})) {
      const target = nodes.get(address);
      if (!target) fail('INVALID_OVERRIDE', `${where} overrides ${address}, which is not a node of ${refNode.ref}. Read the component (read_divlet view:components) for its node IDs.`);
      applyOverride(target, override, `${where} → ${address}`, makeText);
    }
    return { rootKey: nodeId, nodes };
  }

  function emit(id: NodeId, stack: string[]): string {
    const node = frame.nodes[id] as Node;
    bump();
    if (node.type === 'text') { out[id] = structuredClone(node); return id; }
    if (node.type === 'element') {
      const { reusable, ...element } = structuredClone(node);
      out[id] = element;
      element.children = node.children.map(child => emit(child, stack));
      return id;
    }
    const instance = instantiate(node, frame.id, stack, `${frame.id}/${id}`);
    const idOf = new Map<Part, string>();
    const visit = (key: string): string => {
      const part = instance.nodes.get(key) as Part;
      const known = idOf.get(part);
      if (known) return known;
      let partId = id;
      if (key !== instance.rootKey) {
        bump();
        partId = `${id}:${key.replaceAll('/', ':').replaceAll('#', '.')}`;
        if (partId.length > 96 || taken.has(partId)) { let n = 1; do { partId = `${id.slice(0, 80)}:p${n++}`; } while (taken.has(partId)); }
        taken.add(partId);
        parts.set(partId, { instance: id, address: key });
      }
      idOf.set(part, partId);
      if (part.type === 'text') out[partId] = { id: partId, type: 'text', content: part.content, metadata: part.metadata };
      else {
        out[partId] = { id: partId, type: 'element', tag: part.tag, attrs: part.attrs, className: part.className, style: part.style, metadata: key === instance.rootKey ? { ...part.metadata, ...node.metadata } : part.metadata, children: [] };
        out[partId].children = part.children.map(visit);
      }
      return partId;
    };
    return visit(instance.rootKey);
  }

  const rootId = emit(frame.rootId, []);
  const tokens = { ...(settings?.tokens || {}), ...frame.tokens };
  const css = [settings?.css, frame.css].filter(Boolean).join('\n');
  let document: DocumentModel;
  try { document = validateDocument({ ...frame, schemaVersion: 1, rootId, nodes: out, tokens, css }, { limits }); }
  catch (error) {
    const cause = error as DivletError;
    fail(cause.code || 'INVALID_DOCUMENT', parts.size ? `Frame ${frame.id} with its instances expanded: ${cause.message}` : cause.message, cause.details);
  }
  return { document, parts, uses: [...uses].sort(), instances: instancesOf(frame).map(item => item.id) };
}

/** Frames whose rendering depends on `frameId` (they use one of its components, directly or not). */
export function dependentsOf(frameId: string, usesByFrame: Map<string, string[]>): string[] {
  const out: string[] = [];
  for (const [id, uses] of usesByFrame) if (id !== frameId && uses.some(key => key.startsWith(`${frameId}/`))) out.push(id);
  return out;
}
