// The native board's composition point. Alternate hosts implement the read-session contract, not synthetic HTTP routes.
import { createJsonTransport } from './http.js';
import { createHttpReadSession, createHttpSelectionPublisher, createHttpObservationPublisher } from './http-session.js';
import { createHttpHistoryService, createHttpSourceUpdates } from './http-services.js';

export const base = new URL('./', location.href);
export const { apiUrl, request, post } = createJsonTransport(base);
export const readSession = createHttpReadSession({ request, events: () => new EventSource(apiUrl('events')) });
/** @type {import('@divlet/web/session').BoardSelectionPublisher | undefined} */
export const shareSelection = createHttpSelectionPublisher(post);
/** @type {import('@divlet/web/session').BoardObservationPublisher | undefined} */
export const publishObservations = createHttpObservationPublisher(post);
/** @type {import('@divlet/web/host').BoardHistoryService | undefined} */
export const historyService = createHttpHistoryService({ request, post });
/** @type {import('@divlet/web/host').BoardSourceUpdates | undefined} */
export const sourceUpdates = createHttpSourceUpdates({ request, post });
