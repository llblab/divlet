/* Owns: optional host services for history and native source updates. Excludes: read-session authority and I/O implementation. */

/** A history reader need not have authority to restore project state. Payload admission remains with the consumer. */
export interface BoardHistoryService {
  readonly readRecent: () => Promise<unknown>;
  readonly navigate?: (target: { pointId: string; expectedPoint: string }) => Promise<unknown>;
}

/** Native source-update workflow, including the actions offered by its notification. Absent in static compositions. */
export interface BoardSourceUpdates {
  readonly readStatus: () => Promise<unknown>;
  readonly reimport: () => Promise<unknown>;
  readonly openProject: (path: string) => Promise<unknown>;
}
