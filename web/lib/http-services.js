// @ts-check
/** @typedef {(path: string) => Promise<unknown>} Request */
/** @typedef {(path: string, body: unknown) => Promise<unknown>} Post */

/** @param {{ request: Request, post: Post }} transport @returns {import('@divlet/web/host').BoardHistoryService} */
export function createHttpHistoryService({ request, post }) {
  /** @type {import('@divlet/web/host').BoardHistoryService} */
  const service = {
    readRecent: () => request('api/history?limit=100'),
    navigate: target => post('api/history/navigate', target),
  };
  return Object.freeze(service);
}

/** @param {{ request: Request, post: Post }} transport @returns {import('@divlet/web/host').BoardSourceUpdates} */
export function createHttpSourceUpdates({ request, post }) {
  /** @type {import('@divlet/web/host').BoardSourceUpdates} */
  const service = {
    readStatus: () => request('api/import-status'),
    reimport: () => post('api/reimport', {}),
    openProject: path => post('api/open-project', { path }),
  };
  return Object.freeze(service);
}
