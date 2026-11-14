/** Session lineage and read-only traversal/navigation planning. Replay candidates and writer authority stay separate. */
import { DivletError } from './validation.ts';

export type HistoryDirection = 'undo' | 'redo';
export type HistoryBoundary = 'opened' | 'untracked' | 'nonlinear' | 'retained';
export interface HistoryNavigation {
  pointId: string;
  expectedPoint: string;
  actor?: string;
}
export interface HistoryPoint {
  readonly id: string;
  readonly seq: number | null;
  readonly firstSeq: number | null;
  readonly label: string;
  readonly boundary?: Exclude<HistoryBoundary, 'retained'>;
}
export interface HistoryTimeline {
  current: string;
  index: number;
  points: HistoryPoint[];
  boundary: HistoryBoundary;
  pastLimited: boolean;
  futureLimited: boolean;
}
export type HistoryNavigationRequest = Readonly<Pick<HistoryNavigation, 'pointId' | 'expectedPoint'>>;
/** Only the trusted writer snapshot's addressable segment is needed for target planning. */
export interface HistoryNavigationTimeline {
  readonly current: string;
  readonly index: number;
  readonly points: readonly { readonly id: string }[];
}
export type HistoryNavigationPlan = Readonly<{ changed: false } | { changed: true; direction: HistoryDirection; steps: number }>;

/** Validate addresses before the writer reads its timeline; actor and queue ownership stay with the host. */
export function validateHistoryNavigation(pointId: unknown, expectedPoint: unknown): HistoryNavigationRequest {
  if (typeof pointId !== 'string' || !pointId || typeof expectedPoint !== 'string' || !expectedPoint) throw new DivletError('INVALID_QUERY', 'pointId and expectedPoint must be nonempty state point IDs.');
  return { pointId, expectedPoint };
}

/** Resolve validated addresses against the current snapshot inside the writer queue; no stacks or points are moved. */
export function planHistoryNavigation(timeline: HistoryNavigationTimeline, { pointId, expectedPoint }: HistoryNavigationRequest): HistoryNavigationPlan {
  if (expectedPoint !== timeline.current) throw new DivletError('HISTORY_CONFLICT', 'History changed since it was read. Read the current timeline before navigating.');
  const index = timeline.points.findIndex(point => point.id === pointId);
  if (index < 0) throw new DivletError('HISTORY_POINT_UNAVAILABLE', 'That state point is no longer on the retained current history segment.');
  const delta = index - timeline.index;
  return !delta ? { changed: false } : { changed: true, direction: delta < 0 ? 'undo' : 'redo', steps: Math.abs(delta) };
}

/** Session items need only their frame addresses for selection; their replay payload remains opaque here. */
export interface HistoryAddressedItem {
  readonly type: string;
  readonly documentId?: string;
  readonly documentIds?: readonly string[];
}
export interface HistoryTraversalEntry {
  readonly label?: unknown;
  readonly items: readonly HistoryAddressedItem[];
}
export interface HistoryTraversalOptions { readonly documentId?: string; readonly steps?: unknown }
export interface HistoryTraversalPlan<Entry> {
  /** Descending source-stack indexes, safe to remove only after acceptance. */
  readonly indexes: readonly number[];
  /** Original entries in actual traversal order; identity belongs to HistoryLine. */
  readonly entries: readonly Entry[];
  /** Group composition order before the candidate kernel reverses an Undo's items. */
  readonly ordered: readonly Entry[];
  readonly label: unknown;
}

/** Select without mutating stacks or lineage. The writer supplies its retained traversal bound. */
export function planHistoryTraversal<Entry extends HistoryTraversalEntry>(stack: readonly Entry[], direction: HistoryDirection, { documentId, steps = 1 }: HistoryTraversalOptions, limit: number): HistoryTraversalPlan<Entry> {
  if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 1 || steps > limit) throw new DivletError('INVALID_QUERY', `steps must be an integer from 1 to ${limit}.`);
  const indexes: number[] = [];
  for (let index = stack.length - 1; index >= 0 && indexes.length < steps; index--) if (!documentId || stack[index]!.items.some(item => item.documentId === documentId || item.documentIds?.includes(documentId))) indexes.push(index);
  if (indexes.length < steps) throw new DivletError('NOTHING_TO_UNDO', steps === 1 ? `Nothing to ${direction}.` : `Not enough history to ${direction} ${steps} steps.`);
  const entries = indexes.map(index => stack[index]!);
  return { indexes, entries, ordered: direction === 'undo' ? [...entries].reverse() : entries, label: steps === 1 ? entries[0]!.label : `${direction} ${steps} steps` };
}

interface PointInfo {
  seq: number | null;
  firstSeq?: number | null;
  label: unknown;
  boundary?: Exclude<HistoryBoundary, 'retained'>;
}
interface Edge { before: HistoryPoint | null; after: HistoryPoint }

export class HistoryLine {
  private current: HistoryPoint;
  private readonly edges = new WeakMap<object, Edge>();
  private readonly makeId: () => string;

  constructor(makeId: () => string) {
    this.makeId = makeId;
    this.current = this.point({ seq: null, label: 'Opened project', boundary: 'opened' });
  }

  get currentId(): string { return this.current.id; }

  private point(info: PointInfo): HistoryPoint {
    const label = typeof info.label === 'string' && info.label ? [...info.label].slice(0, 160).join('') : 'Edit project';
    return Object.freeze({ id: this.makeId(), seq: info.seq, firstSeq: info.firstSeq ?? info.seq, label, ...(info.boundary ? { boundary: info.boundary } : {}) });
  }

  reset(info: PointInfo): void {
    this.current = this.point({ ...info, boundary: info.boundary ?? 'untracked' });
  }

  /** Capture only after acceptance. Extending a live group invalidates its previous partial endpoint. */
  accept(entry: object, info: PointInfo, merged: boolean): void {
    const previous = this.edges.get(entry);
    const before = merged ? previous?.after === this.current ? previous.before : null : this.current;
    const after = this.point({ ...info, firstSeq: merged && previous ? previous.after.firstSeq : info.firstSeq });
    this.edges.set(entry, { before, after });
    this.current = after;
  }

  /** Entries are in actual replay order, newest matching stack entry first. Nonlinear replay starts a fresh segment. */
  move(entries: readonly object[], direction: HistoryDirection, info: PointInfo): void {
    let point: HistoryPoint | null = this.current;
    for (const entry of entries) {
      const edge = this.edges.get(entry);
      const from = direction === 'undo' ? edge?.after : edge?.before;
      const to = direction === 'undo' ? edge?.before : edge?.after;
      if (!from || !to || from !== point) { point = null; break; }
      point = to;
    }
    if (point) this.current = point;
    else this.reset({ ...info, boundary: 'nonlinear' });
  }

  /** Derived from the runtime's existing stacks; no second replay stack or retained content snapshots. */
  snapshot(undo: readonly object[], redo: readonly object[]): HistoryTimeline {
    const past = [this.current], future: HistoryPoint[] = [];
    let point = this.current;
    for (let i = undo.length - 1; i >= 0; i--) {
      const edge = this.edges.get(undo[i]!);
      if (!edge?.before || edge.after !== point) break;
      past.push(edge.before);
      point = edge.before;
    }
    past.reverse();
    point = this.current;
    for (let i = redo.length - 1; i >= 0; i--) {
      const edge = this.edges.get(redo[i]!);
      if (!edge || edge.before !== point) break;
      future.push(edge.after);
      point = edge.after;
    }
    const pastLimited = past.length - 1 < undo.length;
    return {
      current: this.current.id,
      index: past.length - 1,
      points: [...past, ...future].map(item => ({ ...item })),
      boundary: past[0]!.boundary ?? (pastLimited ? 'nonlinear' : 'retained'),
      pastLimited,
      futureLimited: future.length < redo.length,
    };
  }
}
