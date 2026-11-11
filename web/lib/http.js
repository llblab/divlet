// @ts-check
/** JSON transport for the native board's existing routes; no state, cache or accepted-model authority. */
/** @param {URL} base @param {typeof fetch} [fetcher] */
export function createJsonTransport(base, fetcher = (...args) => fetch(...args)) {
  /** @param {string} path */
  const apiUrl = path => new URL(path, base).href;
  /** @param {string} path @param {RequestInit} [options] @returns {Promise<unknown>} */
  async function request(path, options = {}) {
    const response = await fetcher(apiUrl(path), { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const body = /** @type {any} */ (await response.json().catch(() => ({})));
    if (!response.ok) throw Object.assign(new Error(body.message || body.error?.message || body.error || `Request failed (${response.status})`), { code: body.error, details: body.details, status: response.status });
    return body;
  }
  /** @param {string} path @param {unknown} body */
  const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });
  return { apiUrl, request, post };
}
