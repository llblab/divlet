/*
 * Open whatever a path points at: a project opens on its board; a collection with exactly one
 * project opens that one; otherwise the launcher lists them. Shared by the CLI and the Pi
 * extension, which differ only in how a board is started (`openBoard`).
 */
import path from 'node:path';
import { resolveProject } from './projects.ts';
import { startHub } from './hub.ts';
import { resolveOpenFile } from './import.ts';
import type { ImportResult } from './import.ts';

export { resolveOpenFile } from './import.ts';

/** Options a host needs to open a project on its board; grants belong to the uniquely selected source only. */
export interface OpenBoardOptions { file: string; externalFiles?: string[] }
/** How a host starts a board of its own: the CLI and the Pi extension each provide one. */
export type OpenBoard<Runtime> = (options: OpenBoardOptions) => Promise<Runtime>;
/** A board the host can ask questions of, whatever it is. */
export interface BoardRuntime { info(): { url: string } }
/** The launcher serving a collection for as long as the program runs. */
export interface HubLike { url: string }

/** One open outcome: a project on its board, or a collection with its launcher and the projects it lists. */
export type Launched<Runtime> =
  | { kind: 'project'; runtime: Runtime; imported?: { from: string; to: string; frames: number; utilities: number; arbitrary: number } }
  | { kind: 'collection'; hub: HubLike; projects: any[]; collection: string };

/**
 * `openBoard({ file, externalFiles? })` starts (or reuses) a board and returns its runtime;
 * explicit grants go only to the uniquely selected source, never a deferred launcher selection.
 * `hubs` is a Map the caller keeps so one launcher serves a collection for as long as it runs.
 */
export async function launch<Runtime extends BoardRuntime>(target: string, { openBoard, hubs = new Map<string, HubLike>(), externalFiles }: { openBoard: OpenBoard<Runtime>; hubs?: Map<string, HubLike>; externalFiles?: string[] }): Promise<Launched<Runtime>> {
  const root = path.resolve(target);
  const found = await resolveProject(root);
  const projects: any[] = (found as { projects?: any[] }).projects ?? [];
  const single = projects.length === 1 ? projects[0] : undefined;
  const file = found.kind === 'project' || found.kind === 'new' ? found.file : single && !(single as { error?: unknown }).error ? single.file : null;
  if (file) {
    const project: ImportResult = await resolveOpenFile(file);
    const runtime = await openBoard({ file: project.file, ...(externalFiles !== undefined ? { externalFiles } : {}) });
    return {
      kind: 'project',
      runtime,
      ...(project.created ? { imported: { from: file, to: project.file, frames: project.frames, utilities: project.utilities, arbitrary: project.arbitrary } } : {}),
    };
  }
  // Collection selection never needs a separate resource approval step.
  let hub = hubs.get(found.dir);
  if (!hub) {
    hub = await startHub({ collection: found.dir, root, open: async (file: string) => (await openBoard({ file: (await resolveOpenFile(file)).file })).info().url });
    hubs.set(found.dir, hub);
  }
  return { kind: 'collection', hub, projects, collection: found.dir };
}

/**
 * What a running board can ask of the program that started it: open another path (a project
 * opens its board, a collection opens the launcher) and return the address to go to.
 */
export function makeHost<Runtime extends BoardRuntime>({ openBoard, hubs }: { openBoard: OpenBoard<Runtime>; hubs: Map<string, HubLike> }) {
  const urlOf = (opened: Launched<Runtime>): string => (opened.kind === 'project' ? opened.runtime.info().url : opened.hub.url);
  return {
    async open(target: string): Promise<{ url: string; kind: 'project' | 'collection' }> {
      const opened = await launch(target, { openBoard, hubs });
      return { url: urlOf(opened), kind: opened.kind };
    },
    async openDir(dir: string): Promise<string> {
      return urlOf(await launch(dir, { openBoard, hubs }));
    },
    openFile: async (file: string): Promise<string> => (await openBoard({ file: (await resolveOpenFile(file)).file })).info().url,
  };
}
