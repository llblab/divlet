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

/** The board's project writes. Each method takes the request body the native route takes and resolves with its accepted result. */
export interface BoardWriter {
  readonly patch: (body: unknown) => Promise<unknown>;
  readonly edit: (body: unknown) => Promise<unknown>;
  readonly undo: (body: unknown) => Promise<unknown>;
  readonly redo: (body: unknown) => Promise<unknown>;
  readonly createArtboard: (body: unknown) => Promise<unknown>;
  readonly deleteArtboard: (body: unknown) => Promise<unknown>;
}

/** Where frame previews come from: an iframe address carrying the bridge token, and later renders delivered over its channel. */
export interface BoardPreviews {
  readonly frameUrl: (id: string, options: { readonly revision?: number; readonly bridge: string }) => string;
  readonly readRender: (id: string, options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
  /** Called when a preview iframe is discarded, so a host can release what `frameUrl` allocated. */
  readonly release?: (id: string, url: string) => void;
}

/** Clean standalone HTML of one frame (`{ html, fileName }`), for Copy/Download HTML. */
export interface BoardExports {
  readonly page: (id: string) => Promise<unknown>;
  /** The whole project source (`{ text, fileName }`), where the host's copy is not already a file the user owns. */
  readonly project?: () => Promise<unknown>;
}

/** The project's reusable components, for insertion menus. Absent hosts offer no component insertion list. */
export interface BoardComponents { readonly list: () => Promise<unknown> }

/**
 * A complete alternative composition, published before the board starts at `globalThis[Symbol.for('divlet.board-host/1')]`.
 * Absent members are absent capabilities; nothing falls back to the native HTTP routes. `label` names the host in the chrome.
 */
export interface BoardHostComposition {
  readonly label: string;
  readonly readSession: import('./board-session.ts').BoardReadSession;
  readonly writer: BoardWriter;
  readonly previews: BoardPreviews;
  readonly components?: BoardComponents;
  readonly exports?: BoardExports;
  readonly historyService?: BoardHistoryService;
  readonly shareSelection?: import('./board-session.ts').BoardSelectionPublisher;
  readonly publishObservations?: import('./board-session.ts').BoardObservationPublisher;
  /**
   * What a visitor with no saved view of this project sees first: `expand` opens that frame as a readable page, and `title`
   * names the way back to the board. Absent: the board fits all frames, as the native host does.
   */
  readonly initialView?: { readonly expand: string; readonly title?: string };
}
