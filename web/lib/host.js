// The native board's composition point. Alternate hosts implement the read-session contract, not synthetic HTTP routes.
import { createJsonTransport } from './http.js';
import { createHttpReadSession } from './http-session.js';

export const base = new URL('./', location.href);
export const { apiUrl, request, post } = createJsonTransport(base);
export const readSession = createHttpReadSession({ request, events: () => new EventSource(apiUrl('events')) });
