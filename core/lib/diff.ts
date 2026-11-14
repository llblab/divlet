/*
 * Patches and summaries: the smallest change between two documents, the check that a change still applies to the values it
 * expects, and the human sentence a history row shows. Used by undo/redo, by the runtime's commit path and by the browser.
 */
import { sameJson as isDeepStrictEqual } from './validation.ts';
import type { Artboard, DocumentModel, Node, NodeId } from './model.ts';
import type { CssDeclarationOperation } from './declarations.ts';

const PATCH_KEYS = ['name', 'head', 'artboard', 'rootId', 'tokens', 'css', 'metadata', 'nodes'] as const;
const plain = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A patch in divlet's merge semantics: objects merge, arrays replace, null removes. */
export type ValuePatch = Record<string, any>;

/**
 * Smallest patch (in the divlet merge semantics: objects merge, arrays replace,
 * null removes) that turns `from` into `to`; undefined when they are equal.
 */
export function diffValue(from: unknown, to: unknown): ValuePatch | undefined {
  if (isDeepStrictEqual(from, to)) return undefined;
  if (!plain(to) || !plain(from)) return structuredClone(to) as ValuePatch;
  const patch: ValuePatch = {};
  for (const key of Object.keys(from)) if (!Object.hasOwn(to, key)) patch[key] = null;
  for (const key of Object.keys(to)) {
    const change = diffValue(from[key], to[key]);
    if (change !== undefined) patch[key] = change;
  }
  return patch;
}

/** Check only the values a change would overwrite, including entire deleted subtrees. */
export function matchesPatch(current: unknown, expected: unknown, change: unknown): boolean {
  if (plain(change) && plain(expected)) return Object.keys(change).every(key => matchesPatch((current as any)?.[key], expected[key], change[key]));
  return expected === null ? current === undefined : isDeepStrictEqual(current, expected);
}

/** Patch turning document `from` into document `to` (ignores id, schemaVersion and version). */
export function diffDocuments(from: DocumentModel, to: DocumentModel): ValuePatch {
  const patch: ValuePatch = {};
  for (const key of PATCH_KEYS) {
    const change = key === 'head' && Object.hasOwn(from, key) && !Object.hasOwn(to, key) ? null : diffValue(from[key], to[key]);
    if (change !== undefined) patch[key] = change;
  }
  return patch;
}

/** Ordered snapshots of native fields only; node/address record order and opaque metadata remain unordered. */
function nodeStyleSequence(node: Node | undefined): Array<readonly [string | null, readonly CssDeclarationOperation[]]> {
  if (node?.type === 'element') return [[null, Object.entries(node.style)]];
  if (node?.type !== 'ref') return [];
  return Object.keys(node.descendants).sort().flatMap(address => {
    const style = node.descendants[address]!.style;
    return style === undefined ? [] : [[address, Object.entries(style)] as const];
  });
}

export function documentStyleSequence(document: DocumentModel): Array<readonly [string, string | null, readonly CssDeclarationOperation[]]> {
  return Object.keys(document.nodes).sort().flatMap(id => nodeStyleSequence(document.nodes[id]).map(([address, entries]) => [id, address, entries] as const));
}

/** A trusted session record, not a patch field or a persisted document representation. */
export interface HistoryStyleBlock {
  readonly nodeId: string;
  readonly address: string | null;
  readonly before: readonly CssDeclarationOperation[] | undefined;
  readonly after: readonly CssDeclarationOperation[] | undefined;
}
/** Whole-node lifecycle data must not interpret nullable metadata or override fields as sparse deletions. */
export interface HistoryNodeBlock {
  readonly nodeId: string;
  readonly before: Node | undefined;
  readonly after: Node | undefined;
}
export interface DocumentHistoryPatch { inverse: ValuePatch; forward: ValuePatch; styleBlocks?: readonly HistoryStyleBlock[]; nodeBlocks?: readonly HistoryNodeBlock[] }

/** Check exact lifecycle/style snapshots first; their sparse encoding cannot guard stored nulls or declaration order. */
export function matchesDocumentHistoryPatch(current: DocumentModel, item: DocumentHistoryPatch, undoing: boolean): boolean {
  const expected = undoing ? item.forward : item.inverse, change = undoing ? item.inverse : item.forward;
  const styleBlocks = item.styleBlocks ?? [], nodeBlocks = item.nodeBlocks ?? [];
  if (nodeBlocks.some(block => !sameNode(current.nodes[block.nodeId], block[undoing ? 'after' : 'before']))) return false;
  if (styleBlocks.some(block => !isDeepStrictEqual(readStyleBlock(current, block.nodeId, block.address), block[undoing ? 'after' : 'before']))) return false;
  if (!styleBlocks.length && !nodeBlocks.length) return matchesPatch(current, expected, change);
  const paths = new Set([...nodeBlocks.map(block => JSON.stringify(['nodes', block.nodeId])), ...styleBlocks.map(block => JSON.stringify(['nodes', block.nodeId, ...(block.address === null ? ['style'] : ['descendants', block.address, 'style'])]))]);
  function matches(value: unknown, prior: unknown, patch: unknown, path: string[]): boolean {
    if (paths.has(JSON.stringify(path))) return true;
    if (plain(patch) && plain(prior)) return Object.keys(patch).every(key => matches((value as any)?.[key], prior[key], patch[key], [...path, key]));
    return matchesPatch(value, prior, patch);
  }
  return matches(current, expected, change, []);
}

export function readStyleBlock(document: DocumentModel, nodeId: string, address: string | null): readonly CssDeclarationOperation[] | undefined {
  const node = document.nodes[nodeId];
  const style = address === null ? node?.type === 'element' ? node.style : undefined : node?.type === 'ref' ? node.descendants[address]?.style : undefined;
  return style === undefined ? undefined : Object.entries(style);
}

/** Node lifecycle and native style blocks carry exact data; edits within retained nodes keep sparse per-field guards. */
export function documentHistoryPatch(from: DocumentModel, to: DocumentModel): DocumentHistoryPatch {
  const forward = diffDocuments(from, to), inverse = diffDocuments(to, from);
  const nodeBlocks: HistoryNodeBlock[] = [];
  for (const nodeId of new Set([...Object.keys(from.nodes), ...Object.keys(to.nodes)])) {
    if (Object.hasOwn(from.nodes, nodeId) !== Object.hasOwn(to.nodes, nodeId)) nodeBlocks.push({ nodeId, before: structuredClone(from.nodes[nodeId]), after: structuredClone(to.nodes[nodeId]) });
  }
  const lifecycle = new Set(nodeBlocks.map(block => block.nodeId));
  const locations = new Map([...documentStyleSequence(from), ...documentStyleSequence(to)].filter(([id]) => !lifecycle.has(id)).map(([id, address]) => [JSON.stringify([id, address]), [id, address] as const]));
  const styleBlocks: HistoryStyleBlock[] = [];
  for (const [nodeId, address] of locations.values()) {
    const before = readStyleBlock(from, nodeId, address), after = readStyleBlock(to, nodeId, address);
    if (!isDeepStrictEqual(before, after)) styleBlocks.push({ nodeId, address, before, after });
  }
  return { forward, inverse, ...(styleBlocks.length ? { styleBlocks } : {}), ...(nodeBlocks.length ? { nodeBlocks } : {}) };
}

function sameNodeField(before: any, after: any, key: string): boolean {
  if (!isDeepStrictEqual(before[key], after[key])) return false;
  if (key === 'style' && before.type === 'element' && after.type === 'element') return isDeepStrictEqual(Object.entries(before.style), Object.entries(after.style));
  if (key === 'descendants' && before.type === 'ref' && after.type === 'ref') return isDeepStrictEqual(nodeStyleSequence(before), nodeStyleSequence(after));
  return true;
}
const sameNode = (before: Node | undefined, after: Node | undefined): boolean => isDeepStrictEqual(before, after) && isDeepStrictEqual(nodeStyleSequence(before), nodeStyleSequence(after));

const describe = (node: Node): string => (node.type === 'text' ? 'text' : node.type === 'ref' ? 'instance' : node.tag);

/** What a transition changed, as the history row and the agent's account of it. */
export interface ChangeSummary {
  /** Top-level document fields that changed. */
  fields: string[];
  artboard: Partial<Record<keyof Artboard, [number | undefined, number | undefined]>>;
  nodes: { added: NodeId[]; removed: NodeId[]; changed: Record<NodeId, string[]> };
  /** How many nodes were added, removed or changed. */
  touched: number;
  /** One sentence for a person. */
  text: string;
}

/**
 * Human- and agent-readable account of what a transition changed.
 * `fields` lists top-level document fields; `nodes` is keyed by change kind.
 */
export function summarizeChange(from: DocumentModel | null | undefined, to: DocumentModel | null | undefined): ChangeSummary {
  const fields: string[] = [];
  for (const key of ['name', 'head', 'artboard', 'rootId', 'tokens', 'css', 'metadata'] as const) if (!isDeepStrictEqual((from as any)?.[key], (to as any)?.[key])) fields.push(key);
  const added: NodeId[] = [];
  const removed: NodeId[] = [];
  const changed: Record<NodeId, string[]> = {};
  const before: Record<NodeId, any> = (from?.nodes || {}) as Record<NodeId, any>;
  const after: Record<NodeId, any> = (to?.nodes || {}) as Record<NodeId, any>;
  for (const id of Object.keys(after)) {
    if (!Object.hasOwn(before, id)) added.push(id);
    else if (!sameNode(before[id], after[id])) {
      changed[id] = [...Object.keys(after[id]), ...Object.keys(before[id])].filter((key, index, all) => all.indexOf(key) === index && !sameNodeField(before[id], after[id], key));
    }
  }
  for (const id of Object.keys(before)) if (!Object.hasOwn(after, id)) removed.push(id);
  const artboard: ChangeSummary['artboard'] = {};
  for (const key of ['x', 'y', 'width', 'height'] as const) if (from?.artboard?.[key] !== to?.artboard?.[key]) artboard[key] = [from?.artboard?.[key], to?.artboard?.[key]];
  const count = added.length + removed.length + Object.keys(changed).length;
  const parts: string[] = [];
  if (Object.keys(artboard).length) {
    const moved = 'x' in artboard || 'y' in artboard;
    const resized = 'width' in artboard || 'height' in artboard;
    if (moved) parts.push(`moved to ${to?.artboard.x}, ${to?.artboard.y}`);
    if (resized) parts.push(`resized to ${to?.artboard.width}×${to?.artboard.height}`);
  }
  if (fields.includes('name')) parts.push(`renamed “${to?.name}”`);
  if (added.length) parts.push(`+${added.length} ${added.length === 1 ? describe(after[added[0] as NodeId]) : 'nodes'}`);
  if (removed.length) parts.push(`−${removed.length} ${removed.length === 1 ? describe(before[removed[0] as NodeId]) : 'nodes'}`);
  if (Object.keys(changed).length) {
    const ids = Object.keys(changed);
    const keys = [...new Set(ids.flatMap(id => changed[id] ?? []))];
    parts.push(ids.length === 1 ? `${ids[0]}: ${keys.join(', ')}` : `${ids.length} nodes: ${keys.join(', ')}`);
  }
  for (const key of ['head', 'tokens', 'css', 'metadata'] as const) if (fields.includes(key)) parts.push(key);
  return { fields, artboard, nodes: { added, removed, changed }, touched: count, text: parts.join(' · ') || 'no change' };
}

/** IDs of nodes that were added or modified (for client highlighting). */
export function touchedNodeIds(summary: ChangeSummary): NodeId[] {
  return [...summary.nodes.added, ...Object.keys(summary.nodes.changed)];
}
