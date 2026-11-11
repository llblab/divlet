// @ts-check
/** @typedef {(path: string) => Promise<unknown>} Request */
/** @typedef {(path: string, body: unknown) => Promise<unknown>} Post */

/** @param {{ request: Request, post: Post }} transport @returns {import('../../core/lib/board-host.ts').BoardHistoryService} */
export function createHttpHistoryService({ request, post }) {
  /** @type {import('../../core/lib/board-host.ts').BoardHistoryService} */
  const service = {
    readRecent: () => request('api/history?limit=100'),
    navigate: target => post('api/history/navigate', target),
  };
  return Object.freeze(service);
}

/** @param {{ request: Request, post: Post }} transport @returns {import('../../core/lib/board-host.ts').BoardSourceUpdates} */
export function createHttpSourceUpdates({ request, post }) {
  /** @type {import('../../core/lib/board-host.ts').BoardSourceUpdates} */
  const service = {
    readStatus: () => request('api/import-status'),
    reimport: () => post('api/reimport', {}),
    openProject: path => post('api/open-project', { path }),
  };
  return Object.freeze(service);
}
