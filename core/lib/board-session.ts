/* Owns: the board's transport-independent read-side contract and immutable snapshot reader. No I/O or writer authority. */
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
