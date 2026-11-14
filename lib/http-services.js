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

/** @param {Post} post @returns {import('@divlet/web/host').BoardWriter} */
export function createHttpWriter(post) {
  /** @type {import('@divlet/web/host').BoardWriter} */
  const writer = {
    patch: body => post('api/patch', body),
    edit: body => post('api/edit', body),
    undo: body => post('api/undo', body),
    redo: body => post('api/redo', body),
    createArtboard: body => post('api/artboards', body),
    deleteArtboard: body => post('api/artboards/delete', body),
  };
  return Object.freeze(writer);
}

/**
 * @param {{ apiUrl: (path: string) => string, request: (path: string, options?: RequestInit) => Promise<unknown> }} transport
 * @returns {import('@divlet/web/host').BoardPreviews}
 */
export function createHttpPreviews({ apiUrl, request }) {
  /** @type {import('@divlet/web/host').BoardPreviews} */
  const previews = {
    frameUrl: (id, { revision, bridge }) => apiUrl(`preview/${encodeURIComponent(id)}?${revision ? `revision=${revision}&` : ''}bridge=${bridge}`),
    readRender: (id, { signal } = {}) => request(`api/render/${encodeURIComponent(id)}`, signal ? { signal } : {}),
  };
  return Object.freeze(previews);
}

/** @param {Request} request @returns {import('@divlet/web/host').BoardExports} */
export const createHttpExports = request => Object.freeze({ page: (/** @type {string} */ id) => request(`api/export/${encodeURIComponent(id)}`) });

/** @param {Request} request @returns {import('@divlet/web/host').BoardComponents} */
export const createHttpComponents = request => Object.freeze({ list: () => request('api/components') });
