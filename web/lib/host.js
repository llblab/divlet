// @ts-check
// The board's composition point. The native host composes its HTTP/SSE adapters here; an alternative host publishes a complete
// `BoardHostComposition` before the board starts, and then no native route is used or synthesized.
import { createJsonTransport } from './http.js';
import { createHttpReadSession, createHttpSelectionPublisher, createHttpObservationPublisher } from './http-session.js';
import { createHttpHistoryService, createHttpSourceUpdates, createHttpWriter, createHttpPreviews, createHttpComponents } from './http-services.js';

/** @type {import('@divlet/web/host').BoardHostComposition | undefined} */
const composed = /** @type {any} */ (globalThis)[Symbol.for('divlet.board-host/1')];
/** True when the board talks to the local divlet host over its token-scoped routes. */
export const native = !composed;
/** The host's display name, for chrome that says where the project lives. */
export const hostLabel = composed?.label ?? 'local';

export const base = new URL('./', location.href);
export const { apiUrl, request, post } = createJsonTransport(base);
/** @type {import('@divlet/web/session').BoardReadSession} */
export const readSession = composed ? composed.readSession : createHttpReadSession({ request, events: () => new EventSource(apiUrl('events')) });
/** @type {import('@divlet/web/session').BoardSelectionPublisher | undefined} */
export const shareSelection = composed ? composed.shareSelection : createHttpSelectionPublisher(post);
/** @type {import('@divlet/web/session').BoardObservationPublisher | undefined} */
export const publishObservations = composed ? composed.publishObservations : createHttpObservationPublisher(post);
/** @type {import('@divlet/web/host').BoardHistoryService | undefined} */
export const historyService = composed ? composed.historyService : createHttpHistoryService({ request, post });
/** @type {import('@divlet/web/host').BoardSourceUpdates | undefined} */
export const sourceUpdates = composed ? undefined : createHttpSourceUpdates({ request, post });
/** @type {import('@divlet/web/host').BoardWriter} */
export const writer = composed ? composed.writer : createHttpWriter(post);
/** @type {import('@divlet/web/host').BoardPreviews} */
export const previews = composed ? composed.previews : createHttpPreviews({ apiUrl, request });
/** @type {import('@divlet/web/host').BoardComponents | undefined} */
export const components = composed ? composed.components : createHttpComponents(request);
