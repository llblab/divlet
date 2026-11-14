/** Session-only point identity/lineage. history-replay owns candidates; writers own preparation, stacks and persistence. */
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
