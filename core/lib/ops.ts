/*
 * Structural operations on one frame: remove, duplicate, move, insert, set text, wrap, unwrap, detach an instance and rename.
 * Each one returns a *patch* (node changes plus a few pointers) rather than a new document: the runtime validates the result
 * through `applyDocumentPatch`, so a structural edit and a hand-written patch take the same path and the same undo step.
 *
 * Operations are the product's vocabulary — the Pi tools and the MCP tools name the same ones — so `Operation` is exported and
 * every adapter speaks it instead of inventing its own shape.
 */
import { applyDocumentPatch, DivletError, VOID_TAGS } from './model.ts';
import type { Attrs, DocumentModel, Metadata, Node, NodeId, Style } from './model.ts';
import { diffDocuments } from './diff.ts';
import { htmlToSpecs } from './codec.ts';
import type { NodeSpec } from './codec.ts';
import { expandFrame, parseRef } from './project.ts';
import type { FrameLookup } from './project.ts';

function fail(message: string, code = 'INVALID_OPERATION'): never { throw new DivletError(code, message); }
const ID_BASE = /[^A-Za-z0-9_.:-]/g;

/** One entry of a patch: changed fields of a node, or null to delete it. */
export type NodeChange = Record<string, unknown> | null;
/** What an operation produces: node changes plus the IDs it created or dropped. */
export interface OpsPatch {
  nodes: Record<NodeId, NodeChange>;
  rootId?: NodeId;
  removed?: NodeId[];
  ids?: NodeId[];
  map?: Record<string, string>;
}
/** The structural operations both adapters expose, as `edit_divlet` receives them. */
export type Operation =
  | { type: 'detach'; id: NodeId }
  | { type: 'remove'; id?: NodeId; ids?: NodeId[] }
  | { type: 'duplicate'; id?: NodeId; ids?: NodeId[] }
  | { type: 'move'; id: NodeId; parentId?: NodeId; index?: number; after?: NodeId; before?: NodeId }
  | { type: 'insert'; parentId?: NodeId; index?: number; after?: NodeId; before?: NodeId; spec?: unknown; html?: string }
  | { type: 'text'; id: NodeId; content: string }
  | { type: 'wrap'; id?: NodeId; ids?: NodeId[]; spec?: unknown }
  | { type: 'unwrap'; id: NodeId }
  | { type: 'rename'; id: NodeId; to: string };
/** An insert spec after preset resolution. */
interface ResolvedSpec {
  tag: string;
  className?: string;
  text?: string;
  attrs?: Attrs;
  style?: Style;
  id?: string;
  metadata?: Metadata;
  items?: string[];
  children?: unknown[];
}
/** Where a new node goes: a parent and an index, or beside an anchor. */
interface Position { parentId: NodeId; index: number | undefined }

function parentOf(doc: DocumentModel, id: NodeId): { id: NodeId; children: NodeId[] } | null {
  for (const node of Object.values(doc.nodes)) if (node.type === 'element' && node.children.includes(id)) return node;
  return null;
}

function subtree(doc: DocumentModel, id: NodeId, out: NodeId[] = []): NodeId[] {
  out.push(id);
  const node = doc.nodes[id];
  if (node?.type === 'element') for (const child of node.children) subtree(doc, child, out);
  return out;
}

function need(doc: DocumentModel, id: NodeId): Node {
  const node = doc.nodes[id];
  if (!node) fail(`Unknown node: ${id}`, 'NOT_FOUND');
  return node;
}

export function freshId(taken: Set<string>, base = 'node'): string {
  const stem = String(base).replace(ID_BASE, '-').replace(/^[^A-Za-z]+/, '').replace(/-copy(-\d+)?$/, '').slice(0, 80) || 'node';
  for (let n = 1; ; n++) {
    const id = n === 1 ? `${stem}-copy` : `${stem}-copy-${n}`;
    if (!taken.has(id)) { taken.add(id); return id; }
  }
}

function newId(taken: Set<string>, base: string): string {
  const stem = String(base).replace(ID_BASE, '-').replace(/^[^A-Za-z]+/, '').slice(0, 80) || 'node';
  if (!taken.has(stem)) { taken.add(stem); return stem; }
  for (let n = 2; ; n++) {
    const id = `${stem}-${n}`;
    if (!taken.has(id)) { taken.add(id); return id; }
  }
}

/** Remove nodes (and their subtrees) from a document. */
export function removeNodes(doc: DocumentModel, ids: NodeId[]): OpsPatch {
  const unique = [...new Set(ids)];
  if (!unique.length) fail('Nothing to remove.');
  const nodes: Record<NodeId, NodeChange> = {};
  const doomed = new Set<NodeId>();
  for (const id of unique) {
    need(doc, id);
    if (id === doc.rootId) fail('The root node cannot be removed.');
    for (const gone of subtree(doc, id)) doomed.add(gone);
  }
  for (const gone of doomed) nodes[gone] = null;
  const parents = new Map<NodeId, NodeId[]>();
  for (const id of unique) {
    const parent = parentOf(doc, id);
    if (parent && !doomed.has(parent.id)) parents.set(parent.id, (parents.get(parent.id) ?? parent.children).filter(child => child !== id));
  }
  for (const [parentId, children] of parents) nodes[parentId] = { children };
  return { nodes, removed: [...doomed] };
}

/** Deep-copy a node right after its original. */
export function duplicateNode(doc: DocumentModel, id: NodeId): OpsPatch {
  need(doc, id);
  if (id === doc.rootId) fail('The root node cannot be duplicated.');
  const parent = parentOf(doc, id);
  if (!parent) fail(`#${id} has no parent.`);
  const taken = new Set(Object.keys(doc.nodes));
  const nodes: Record<NodeId, NodeChange> = {};
  const map = new Map<NodeId, NodeId>();
  const copy = (sourceId: NodeId): NodeId => {
    const node = need(doc, sourceId);
    const targetId = freshId(taken, sourceId);
    map.set(sourceId, targetId);
    const clone = structuredClone(node) as Node;
    clone.id = targetId;
    if (clone.type === 'element' && node.type === 'element') clone.children = node.children.map(copy);
    nodes[targetId] = clone as unknown as NodeChange;
    return targetId;
  };
  const rootCopy = copy(id);
  const children = [...parent.children];
  children.splice(children.indexOf(id) + 1, 0, rootCopy);
  nodes[parent.id] = { children };
  return { nodes, ids: [rootCopy], map: Object.fromEntries(map) };
}

/** Move a node to `parentId` at `index` (index counts siblings after removal of the node). */
export function moveNode(doc: DocumentModel, id: NodeId, parentId: NodeId, index: number | undefined): OpsPatch {
  need(doc, id);
  const target = need(doc, parentId);
  if (id === doc.rootId) fail('The root node cannot be moved.');
  if (target.type !== 'element' || VOID_TAGS.has(target.tag)) fail(`${parentId} cannot contain children.`);
  if (subtree(doc, id).includes(parentId)) fail('A node cannot be moved into itself.');
  const from = parentOf(doc, id);
  if (!from) fail(`#${id} has no parent.`);
  const nodes: Record<NodeId, NodeChange> = {};
  const sourceChildren = from.children.filter(child => child !== id);
  const place = (children: NodeId[]): NodeId[] => {
    const next = [...children];
    next.splice(Math.max(0, Math.min(index ?? next.length, next.length)), 0, id);
    return next;
  };
  if (from.id === parentId) nodes[parentId] = { children: place(sourceChildren) };
  else {
    nodes[from.id] = { children: sourceChildren };
    nodes[parentId] = { children: place(target.children) };
  }
  return { nodes };
}

const PRESETS: Record<string, ResolvedSpec> = {
  div: { tag: 'div', className: 'p-4' },
  section: { tag: 'section', className: 'py-8' },
  heading: { tag: 'h2', className: 'text-2xl font-semibold', text: 'Heading' },
  text: { tag: 'p', className: 'text-base leading-7', text: 'Write something.' },
  button: { tag: 'button', className: 'rounded-lg bg-black px-4 py-2 text-white', text: 'Button', attrs: { type: 'button' } },
  image: { tag: 'img', className: 'w-full rounded-lg', attrs: { src: '', alt: '' } },
  link: { tag: 'a', className: 'underline', text: 'Link', attrs: { href: '#' } },
  list: { tag: 'ul', className: 'list-disc pl-6', items: ['First item', 'Second item'] },
  row: { tag: 'div', className: 'flex items-center gap-4' },
  grid: { tag: 'div', className: 'grid grid-cols-2 gap-4' },
};
export const PRESET_NAMES: string[] = Object.keys(PRESETS);
const SPEC_KEYS: ReadonlySet<string> = new Set(['preset', 'tag', 'className', 'text', 'attrs', 'style', 'id', 'metadata', 'items', 'children', 'ref', 'descendants']);
const INSTANCE_KEYS: ReadonlySet<string> = new Set(['ref', 'descendants', 'id', 'metadata']);
const MAX_INSERT_NODES = 1000;
const MAX_SPEC_DEPTH = 32;
const plainObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A preset name, or a spec object (optionally starting from `preset`), resolved to one element spec. */
function resolveSpec(input: unknown): ResolvedSpec {
  const spec = input as any;
  if (typeof spec === 'string' && !PRESETS[spec]) fail(`Unknown element preset: ${spec}. Use one of ${PRESET_NAMES.join(', ')} or { tag, className, text, attrs, style, id, children }.`);
  if (typeof spec !== 'string' && !plainObject(spec)) fail('An insert spec must be a preset name or an object.');
  for (const key of Object.keys(typeof spec === 'string' ? {} : spec)) if (!SPEC_KEYS.has(key)) fail(`Unsupported insert spec field: ${key}`);
  const presetName: string | undefined = typeof spec === 'string' ? spec : spec.preset;
  const base: ResolvedSpec = (presetName !== undefined ? PRESETS[presetName] : { tag: '' }) as ResolvedSpec;
  if (!base) fail(`Unknown element preset: ${String(presetName)}. Use one of ${PRESET_NAMES.join(', ')}.`);
  const preset: ResolvedSpec = typeof spec === 'string' ? { ...base } : { ...base, ...spec };
  delete (preset as any).preset;
  if (typeof preset.tag !== 'string' || !preset.tag) fail('An insert spec needs a tag.');
  if (preset.text !== undefined && typeof preset.text !== 'string') fail('spec.text must be a string');
  if (preset.className !== undefined && typeof preset.className !== 'string') fail('spec.className must be a string');
  if (preset.id !== undefined && typeof preset.id !== 'string') fail('spec.id must be a string');
  for (const key of ['attrs', 'style', 'metadata'] as const) if (preset[key] !== undefined && !plainObject(preset[key])) fail(`spec.${key} must be an object`);
  if (preset.items !== undefined && (!Array.isArray(preset.items) || preset.items.some(item => typeof item !== 'string'))) fail('spec.items must be an array of strings');
  if (preset.children !== undefined && !Array.isArray(preset.children)) fail('spec.children must be an array of specs or strings');
  return preset;
}

/** Build the nodes of one spec (and its nested children) into `nodes`; returns the new element id. */
function buildSpec(spec: unknown, taken: Set<string>, nodes: Record<NodeId, any>, budget: { left: number }, depth = 0): NodeId {
  if (depth > MAX_SPEC_DEPTH) fail('The insert spec is nested too deeply.');
  if (plainObject(spec) && spec.ref !== undefined) {
    // An instance of a component: { ref: "frameId/nodeId", descendants?: { nodeId: { text | className | … } } }
    for (const key of Object.keys(spec)) if (!INSTANCE_KEYS.has(key)) fail(`An instance spec takes ref, descendants, id and metadata (not ${key}).`);
    if (--budget.left < 0) fail(`One insert can create at most ${MAX_INSERT_NODES} nodes.`);
    const { node: target } = parseRef(spec.ref, 'frame');
    const id = newId(taken, spec.id || target);
    nodes[id] = { id, type: 'ref', ref: spec.ref, descendants: structuredClone(spec.descendants ?? {}), metadata: structuredClone(spec.metadata ?? {}) };
    return id;
  }
  const preset = resolveSpec(spec);
  const count = (): void => { if (--budget.left < 0) fail(`One insert can create at most ${MAX_INSERT_NODES} nodes.`); };
  count();
  const id = newId(taken, preset.id || preset.tag);
  const node: any = { id, type: 'element', tag: preset.tag, attrs: structuredClone(preset.attrs ?? {}), className: preset.className ?? '', style: structuredClone(preset.style ?? {}), metadata: structuredClone(preset.metadata ?? {}), children: [] };
  const isVoid = VOID_TAGS.has(preset.tag);
  if (isVoid && (preset.items?.length || preset.children?.length)) fail(`<${preset.tag}> cannot contain children.`);
  const text = (content: string): void => {
    count();
    const textId = newId(taken, `${id}-text`);
    nodes[textId] = { id: textId, type: 'text', content, metadata: {} };
    node.children.push(textId);
  };
  if (preset.text !== undefined && !isVoid) text(preset.text);
  for (const [n, item] of (preset.items ?? []).entries()) {
    count();
    count();
    const itemId = newId(taken, `${id}-item-${n + 1}`);
    const textId = newId(taken, `${itemId}-text`);
    nodes[textId] = { id: textId, type: 'text', content: item, metadata: {} };
    nodes[itemId] = { id: itemId, type: 'element', tag: 'li', attrs: {}, className: '', style: {}, metadata: {}, children: [textId] };
    node.children.push(itemId);
  }
  for (const child of preset.children ?? []) {
    if (typeof child === 'string') text(child);
    else node.children.push(buildSpec(child, taken, nodes, budget, depth + 1));
  }
  nodes[id] = node;
  return id;
}

/** Parent id and index for a position next to `anchorId`, counted without `movingId`. */
function besideAnchor(doc: DocumentModel, anchorId: NodeId, after: boolean, movingId?: NodeId): Position {
  need(doc, anchorId);
  if (anchorId === doc.rootId) fail('Nothing can be placed beside the root node; use parentId instead.');
  if (anchorId === movingId) fail('A node cannot be placed beside itself.');
  const parent = parentOf(doc, anchorId);
  if (!parent) fail(`#${anchorId} has no parent.`);
  const siblings = parent.children.filter(child => child !== movingId);
  return { parentId: parent.id, index: siblings.indexOf(anchorId) + (after ? 1 : 0) };
}

/**
 * Insert new elements into `parentId`. `spec` is a preset name, a spec object (with optional
 * nested `children`: specs or plain strings for text), or an array of those placed in order.
 */
export function insertNode(doc: DocumentModel, parentId: NodeId, index: number | undefined, spec: unknown = 'div'): OpsPatch {
  const target = need(doc, parentId);
  if (target.type === 'ref') fail(`${parentId} is an instance; add content to its component instead, or detach it first.`);
  if (target.type !== 'element' || VOID_TAGS.has(target.tag)) fail(`${parentId} cannot contain children.`);
  const specs = Array.isArray(spec) ? spec : [spec];
  if (!specs.length) fail('Nothing to insert.');
  const taken = new Set(Object.keys(doc.nodes));
  const nodes: Record<NodeId, any> = {};
  const budget = { left: MAX_INSERT_NODES };
  const ids = specs.map(item => buildSpec(item, taken, nodes, budget));
  const children = [...target.children];
  children.splice(index == null ? children.length : Math.max(0, Math.min(index, children.length)), 0, ...ids);
  nodes[parentId] = { children };
  return { nodes, ids };
}

/** Set the text of an element with a single text child, or of a text node. */
export function setText(doc: DocumentModel, id: NodeId, content: unknown): OpsPatch {
  const node = need(doc, id);
  if (typeof content !== 'string') fail('content must be a string');
  if (node.type === 'text') return { nodes: { [id]: { content } } };
  if (node.type === 'ref') fail(`${id} is an instance of ${node.ref}. Change its text with an override (patch nodes.${id}.descendants.<textNodeId>.content) or detach it first.`);
  if (VOID_TAGS.has(node.tag)) fail(`${id} has no text.`);
  const texts = node.children.filter(child => need(doc, child).type === 'text');
  const only = texts[0];
  if (texts.length === 1 && node.children.length === 1 && only) return { nodes: { [only]: { content } } };
  if (!node.children.length) {
    const taken = new Set(Object.keys(doc.nodes));
    const textId = newId(taken, `${id}-text`);
    return { nodes: { [textId]: { id: textId, type: 'text', content, metadata: {} }, [id]: { children: [textId] } } };
  }
  fail(`${id} mixes text and elements; edit one text node directly.`);
}

/** Wrap one node, or several siblings, in a new container placed where the first of them was. */
export function wrapNodes(doc: DocumentModel, ids: NodeId[], spec: unknown = { tag: 'div', className: '' }): OpsPatch {
  const unique = [...new Set(ids)];
  if (!unique.length) fail('Nothing to wrap.');
  for (const id of unique) {
    need(doc, id);
    if (id === doc.rootId) fail('The root node cannot be wrapped.');
  }
  const first = unique[0] as NodeId;
  const parent = parentOf(doc, first);
  if (!parent) fail(`#${first} has no parent.`);
  if (unique.some(id => parentOf(doc, id)?.id !== parent.id)) fail('Only siblings can be wrapped together.');
  const preset = resolveSpec(typeof spec === 'string' && !PRESETS[spec] ? { tag: spec } : spec);
  if (VOID_TAGS.has(preset.tag)) fail(`<${preset.tag}> cannot contain children.`);
  const ordered = parent.children.filter(child => unique.includes(child));
  const taken = new Set(Object.keys(doc.nodes));
  const id = newId(taken, preset.id || (preset.tag === 'div' ? 'group' : preset.tag));
  const children = parent.children.filter(child => !unique.includes(child));
  // The container takes the place of the first wrapped sibling in document order, not in the order the IDs were given.
  const anchor = ordered[0] as NodeId;
  children.splice(parent.children.indexOf(anchor), 0, id);
  const node = { id, type: 'element', tag: preset.tag, attrs: structuredClone(preset.attrs ?? {}), className: preset.className ?? '', style: structuredClone(preset.style ?? {}), metadata: structuredClone(preset.metadata ?? {}), children: ordered };
  return { nodes: { [id]: node, [parent.id]: { children } }, ids: [id] };
}

/** Replace an element by its own children. */
export function unwrapNode(doc: DocumentModel, id: NodeId): OpsPatch {
  const node = need(doc, id);
  if (id === doc.rootId) fail('The root node cannot be unwrapped.');
  if (node.type !== 'element') fail('Only elements can be unwrapped.');
  const parent = parentOf(doc, id);
  if (!parent) fail(`#${id} has no parent.`);
  const children = [...parent.children];
  children.splice(children.indexOf(id), 1, ...node.children);
  return { nodes: { [id]: null, [parent.id]: { children } }, ids: [...node.children], removed: [id] };
}

/**
 * Replace an instance by ordinary nodes: its component with the overrides applied, as editable
 * elements. The instance keeps its ID, so references to it stay valid.
 */
export function detachInstance(doc: DocumentModel, id: NodeId, frame: FrameLookup | null): OpsPatch {
  const node = need(doc, id);
  if (node.type !== 'ref') fail(`${id} is not an instance.`);
  const expanded = expandFrame(doc, frame, null).document;
  const taken = new Set(Object.keys(doc.nodes));
  const ids = new Map<NodeId, NodeId>([[id, id]]);
  const walk = (partId: NodeId): void => {
    const part = expanded.nodes[partId];
    if (part?.type === 'element') part.children.forEach(walk);
    if (partId !== id) ids.set(partId, newId(taken, (partId.split(':').at(-1) ?? partId).replace(/\.t\d+$/, '-text')));
  };
  walk(id);
  const nodes: Record<NodeId, any> = {};
  for (const [partId, newIdValue] of ids) {
    const part = structuredClone(expanded.nodes[partId]) as Node;
    part.id = newIdValue;
    if (part.type === 'element') part.children = part.children.map(child => ids.get(child) as NodeId);
    nodes[newIdValue] = part;
  }
  nodes[id] = { ...nodes[id], ref: null, descendants: null };
  return { nodes, ids: [id] };
}

/** Duplicate several nodes; each copy lands right after its original. */
function duplicateMany(doc: DocumentModel, ids: NodeId[]): OpsPatch {
  const unique = [...new Set(ids)];
  if (!unique.length) fail('Nothing to duplicate.');
  if (unique.length === 1) return duplicateNode(doc, unique[0] as NodeId);
  let work = doc;
  const created: NodeId[] = [];
  for (const id of unique) {
    if (!Object.hasOwn(work.nodes, id)) continue;
    const { ids: copies, map, ...patch } = duplicateNode(work, id);
    work = applyDocumentPatch(work, patch);
    created.push(...(copies ?? []));
  }
  return { ...(diffDocuments(doc, work) as { nodes: Record<NodeId, NodeChange> }), ids: created };
}

const NODE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;

/**
 * Give a node another ID. Everything in the frame that points at it follows: the parent's children,
 * the root, instances of it (`ref`) and the override addresses that pass through it. A node that
 * belongs to a component used by other frames keeps its ID: their instances address it by name.
 */
function renameNode(doc: DocumentModel, id: NodeId, to: string, usedBy: string[] = []): OpsPatch {
  const node = need(doc, id);
  if (typeof to !== 'string' || !NODE_ID.test(to)) fail(`“${to}” is not a valid ID. Start with a letter; letters, digits, - _ . : only (up to 96 characters).`);
  if (to === id) fail('The ID is already that.');
  if (Object.hasOwn(doc.nodes, to)) fail(`This frame already has a node #${to}.`);
  const parents = new Map<NodeId, NodeId>();
  for (const item of Object.values(doc.nodes)) if (item.type === 'element') for (const child of item.children) parents.set(child, item.id);
  let inComponent = false;
  for (let current: NodeId | undefined = id; current; current = parents.get(current)) if (need(doc, current).type === 'element' && (need(doc, current) as { reusable?: true }).reusable) inComponent = true;
  if (inComponent && usedBy.length) fail(`#${id} is part of a component used in ${usedBy.slice(0, 4).join(', ')}; their instances address it by this ID. Detach those instances first, or keep the ID.`);
  const nodes: Record<NodeId, NodeChange> = { [id]: null, [to]: { ...structuredClone(node), id: to } };
  const parent = parents.get(id);
  if (parent) {
    const parentNode = need(doc, parent);
    if (parentNode.type === 'element') nodes[parent] = { children: parentNode.children.map(child => (child === id ? to : child)) };
  }
  const here = doc.id;
  for (const item of Object.values(doc.nodes)) {
    if (item.type !== 'ref') continue;
    const change: Record<string, unknown> = {};
    if (item.ref === id) change.ref = to;
    else if (item.ref === `${here}/${id}`) change.ref = `${here}/${to}`;
    const keys = Object.keys(item.descendants || {}).filter(key => key.split('/').includes(id));
    if (keys.length) {
      const descendants: Record<string, unknown> = {};
      for (const key of keys) {
        descendants[key] = null;
        descendants[key.split('/').map(part => (part === id ? to : part)).join('/')] = structuredClone(item.descendants[key]);
      }
      change.descendants = descendants;
    }
    if (Object.keys(change).length) nodes[item.id] = { ...(nodes[item.id] as Record<string, unknown> | undefined ?? {}), ...change };
  }
  const patch: OpsPatch = { nodes, ids: [to] };
  if (doc.rootId === id) patch.rootId = to;
  return patch;
}

const position = (doc: DocumentModel, op: { parentId?: NodeId; index?: number; after?: NodeId; before?: NodeId }, movingId?: NodeId): Position => {
  if (op.after != null || op.before != null) return besideAnchor(doc, (op.after ?? op.before) as NodeId, op.after != null, movingId);
  return { parentId: op.parentId ?? doc.rootId, index: op.index };
};

/** Apply one operation to a frame, returning the patch that produces it. */
export function applyOperation(doc: DocumentModel, op: Operation, { frame = null, usedBy = [] }: { frame?: FrameLookup | null; usedBy?: string[] } = {}): { patch: OpsPatch } {
  switch (op?.type) {
    case 'detach': return { patch: detachInstance(doc, op.id, frame) };
    case 'remove': return { patch: removeNodes(doc, op.ids ?? [op.id as NodeId]) };
    case 'duplicate': return { patch: duplicateMany(doc, op.ids ?? [op.id as NodeId]) };
    case 'move': {
      const { parentId, index } = position(doc, op, op.id);
      const target = need(doc, parentId);
      const fallback = target.type === 'element' ? target.children.filter(child => child !== op.id).length : 0;
      return { patch: moveNode(doc, op.id, parentId, index ?? fallback) };
    }
    case 'insert': {
      const { parentId, index } = position(doc, op);
      return { patch: insertNode(doc, parentId, index, op.html !== undefined ? htmlToSpecs(op.html) : op.spec) };
    }
    case 'text': return { patch: setText(doc, op.id, op.content) };
    case 'wrap': return { patch: wrapNodes(doc, op.ids ?? [op.id as NodeId], op.spec) };
    case 'unwrap': return { patch: unwrapNode(doc, op.id) };
    case 'rename': return { patch: renameNode(doc, op.id, op.to, usedBy) };
    default: return fail(`Unknown operation: ${(op as { type?: string })?.type}. Use insert, move, duplicate, remove, text, wrap, unwrap, rename or detach.`);
  }
}

/** Convert an operation result into a document patch plus metadata. */
export function operationPatch(doc: DocumentModel, op: Operation, context?: { frame?: FrameLookup | null; usedBy?: string[] }): { patch: Omit<OpsPatch, 'removed' | 'ids' | 'map'>; removed?: NodeId[]; ids?: NodeId[]; map?: Record<string, string> } {
  const { patch } = applyOperation(doc, op, context);
  const { removed, ids, map, ...rest } = patch;
  return { patch: rest, removed, ids, map };
}

export type { NodeSpec };
