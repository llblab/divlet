// @ts-check
/** @typedef {import('../../core/lib/board-session.ts').BoardReadSession} BoardReadSession */
/** @typedef {import('../../core/lib/board-session.ts').BoardReadEvent} BoardReadEvent */
/** @typedef {import('../../core/lib/board-session.ts').BoardSelectionPublisher} BoardSelectionPublisher */
/** @typedef {import('../../core/lib/board-session.ts').BoardObservationPublisher} BoardObservationPublisher */
/** @typedef {{ addEventListener: (name: string, listener: (event: unknown) => void) => void, close: () => void }} ReadStream */

/** Native ephemeral-selection adapter; absence of this capability means browser-local selection.
 * @param {(path: string, body: unknown) => Promise<unknown>} post
 * @returns {BoardSelectionPublisher}
 */
export const createHttpSelectionPublisher = post => selection => post('api/selection', selection);

/** @param {(path: string, body: unknown) => Promise<unknown>} post @returns {BoardObservationPublisher} */
export const createHttpObservationPublisher = post => report => post('api/observations', report);

/**
 * Native HTTP/SSE adapter. Parsing belongs here; model acceptance and bootstrap/plugin ordering stay with the board.
 * @param {{ request: (path: string) => Promise<unknown>, events: () => ReadStream }} options
 * @returns {BoardReadSession}
 */
export function createHttpReadSession({ request, events }) {
  return Object.freeze({
    readState: () => request('api/project'),
    /** @param {string} id */
    readFrame: id => request(`api/documents/${encodeURIComponent(id)}`),
    /** @param {(event: BoardReadEvent) => void} listener */
    subscribe(listener) {
      const source = events();
      let active = true;
      /** @param {BoardReadEvent} event */
      const emit = event => { if (active) listener(event); };
      source.addEventListener('open', () => emit({ type: 'connection', status: 'connected' }));
      source.addEventListener('error', () => emit({ type: 'connection', status: 'offline' }));
      for (const type of /** @type {const} */ (['state', 'change'])) source.addEventListener(type, event => {
        let value;
        const data = event && typeof event === 'object' && 'data' in event ? event.data : undefined;
        try { value = JSON.parse(typeof data === 'string' ? data : ''); }
        catch { if (type === 'state') emit({ type: 'invalid-state' }); return; }
        emit({ type, value });
      });
      return () => { if (!active) return; active = false; source.close(); };
    },
  });
}
