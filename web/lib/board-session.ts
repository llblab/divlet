/* Owns: transport-independent board reads, optional view-state publication and immutable snapshots. No project writer authority. */
export type BoardReadEvent =
  | { type: 'connection'; status: 'connected' | 'offline' }
  | { type: 'state'; value: unknown }
  | { type: 'change'; value: unknown }
  | { type: 'invalid-state' };

/** Payloads are opaque transport data; existing consumers/admission own their model and state checks. */
export interface BoardReadSession {
  readonly readState: () => Promise<unknown>;
  readonly readFrame: (id: string) => Promise<unknown>;
  /** Each subscription owns its cleanup. After cleanup, it delivers no further events. */
  readonly subscribe: (listener: (event: BoardReadEvent) => void) => () => void;
}

/** Optional host capability for sharing ephemeral view selection, not committing project content. Replies are opaque board state. */
export interface BoardSelection {
  readonly ids: readonly string[];
  readonly nodes?: { readonly documentId: string; readonly nodeIds: readonly string[] };
}
export type BoardSelectionPublisher = (selection: BoardSelection) => Promise<unknown>;

/** Frame measurements already bounded by the preview receiver. `version` and `render` both name the shown render revision. */
export interface BoardObservation {
  readonly documentId: string;
  readonly version: number;
  readonly render: number;
  readonly nodes: readonly { readonly id: string; readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }; readonly overflowX?: boolean; readonly overflowY?: boolean }[];
  readonly contentHeight?: number;
  readonly scrollHeight?: number;
}
export type BoardObservationPublisher = (report: BoardObservation) => Promise<unknown>;

/** A host-created snapshot; the caller owns project admission and public-data curation. Not an upload parser. */
export function createSnapshotReadSession({ state, frames }: { state: unknown; frames: ReadonlyMap<string, unknown> }): BoardReadSession {
  const snapshot = structuredClone(state);
  const models = new Map([...frames].map(([id, model]) => [id, structuredClone(model)]));
  return Object.freeze({
    readState: async () => structuredClone(snapshot),
    readFrame: async (id: string) => {
      if (!models.has(id)) throw Object.assign(new Error(`Unknown frame: ${id}`), { code: 'NOT_FOUND' });
      return structuredClone(models.get(id));
    },
    subscribe(listener: (event: BoardReadEvent) => void) {
      let active = true;
      queueMicrotask(() => {
        if (!active) return;
        listener({ type: 'connection', status: 'connected' });
        if (active) listener({ type: 'state', value: structuredClone(snapshot) });
      });
      return () => { active = false; };
    },
  });
}
