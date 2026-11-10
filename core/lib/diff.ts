/*
 * Patches and summaries: the smallest change between two documents, the check that a change still applies to the values it
 * expects, and the human sentence a history row shows. Used by undo/redo, by the runtime's commit path and by the browser.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Artboard, DocumentModel, Node, NodeId } from './model.ts';

const PATCH_KEYS = ['name', 'artboard', 'rootId', 'tokens', 'css', 'metadata', 'nodes'] as const;
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
    const change = diffValue(from[key], to[key]);
    if (change !== undefined) patch[key] = change;
  }
  return patch;
}

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
  for (const key of ['name', 'artboard', 'rootId', 'tokens', 'css', 'metadata'] as const) if (!isDeepStrictEqual((from as any)?.[key], (to as any)?.[key])) fields.push(key);
  const added: NodeId[] = [];
  const removed: NodeId[] = [];
  const changed: Record<NodeId, string[]> = {};
  const before: Record<NodeId, any> = (from?.nodes || {}) as Record<NodeId, any>;
  const after: Record<NodeId, any> = (to?.nodes || {}) as Record<NodeId, any>;
  for (const id of Object.keys(after)) {
    if (!Object.hasOwn(before, id)) added.push(id);
    else if (!isDeepStrictEqual(before[id], after[id])) {
      changed[id] = [...Object.keys(after[id]), ...Object.keys(before[id])].filter((key, index, all) => all.indexOf(key) === index && !isDeepStrictEqual(before[id][key], after[id][key]));
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
  for (const key of ['tokens', 'css', 'metadata'] as const) if (fields.includes(key)) parts.push(key);
  return { fields, artboard, nodes: { added, removed, changed }, touched: count, text: parts.join(' · ') || 'no change' };
}

/** IDs of nodes that were added or modified (for client highlighting). */
export function touchedNodeIds(summary: ChangeSummary): NodeId[] {
  return [...summary.nodes.added, ...Object.keys(summary.nodes.changed)];
}
