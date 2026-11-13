// The client package owns its assets and portable host ports, not a Node runtime or model writer.
export const clientRoot = new URL('./', import.meta.url);
export { createSnapshotReadSession } from './lib/board-session.ts';
export type { BoardReadSession, BoardReadEvent, BoardSelection, BoardSelectionPublisher, BoardObservation, BoardObservationPublisher } from './lib/board-session.ts';
export type { BoardHistoryService, BoardSourceUpdates } from './lib/board-host.ts';
