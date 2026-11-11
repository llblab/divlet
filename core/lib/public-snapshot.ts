/*
 * Owns: build-side projection of an intentionally public prepared HTML page into read-only inspection data.
 * Excludes: source-project publication, secret scanning, resource/provenance validation, preview rendering and UI write gates.
 */
import { createHash } from 'node:crypto';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { decodeHtml } from './codec.ts';
import { DivletError, validateDocument } from './model.ts';
import type { Artboard, DocumentModel } from './model.ts';
import { object, keys, string } from './validation.ts';

export interface PublicFrameDescriptor {
  id: string;
  name: string;
  version: number;
  render: number;
  artboard: Artboard;
  viewUrl: string;
}
export interface PublicSnapshotState {
  projectId: string;
  stateVersion: 1;
  revision: 0;
  project: {
    name: string;
    version: 1;
    format: 'divlet';
    capabilities: { properties: false; settings: false; frames: false; saveAs: false };
  };
  documents: PublicFrameDescriptor[];
  selection: { ids: string[]; revision: 0 };
  diagnostics: never[];
  work: never[];
  clientPlugins: never[];
}
export interface PublicPageSnapshot {
  state: PublicSnapshotState;
  frames: ReadonlyMap<string, DocumentModel>;
}

function fail(message: string): never { throw new DivletError('INVALID_PUBLIC_SNAPSHOT', message); }

/** No filesystem/absolute URLs or private route/query parameters in the one-page presentation descriptor. */
function publicPageHref(input: unknown): string {
  const href = string(input, 'Public page href', 256);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.html$/i.test(href)) fail('The public page href must be a sibling HTML filename without a path, query or fragment.');
  return href;
}

/**
 * Input HTML must already be selected for public publication. Geometry is a deliberate public viewport, not recovered source
 * geometry. The resulting flattened inspection model must never replace/re-render the prepared page or the authored project.
 */
export function createPublicPageSnapshot(input: unknown): PublicPageSnapshot {
  const raw = object(input, 'Public snapshot');
  keys(raw, new Set(['html', 'name', 'artboard', 'href']), 'public snapshot');
  const name = string(raw.name, 'Public demo name', 512);
  const href = publicPageHref(raw.href);
  const html: unknown = raw.html;
  if (typeof html !== 'string') fail('Prepared public page HTML must be a string.');
  // The strict codec supplies HTML/size/model admission. Its fallback identities are presentation identities only.
  const decoded = decodeHtml(html, { fallbackId: 'index' });
  const pending: DefaultTreeAdapterMap['node'][] = [parse(html)];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if ('tagName' in node && node.tagName === 'script') fail('A prepared public snapshot page must not contain scripts, including editor metadata scripts.');
    if ('childNodes' in node) pending.push(...node.childNodes);
  }
  decoded.metadata = {};
  for (const node of Object.values(decoded.nodes)) node.metadata = {};
  const frame = validateDocument({ ...decoded, id: 'index', version: 1, artboard: raw.artboard });
  const projectId = `public-${createHash('sha256').update(href).update('\0').update(html).digest('hex').slice(0, 16)}`;
  const state: PublicSnapshotState = {
    projectId, stateVersion: 1, revision: 0,
    project: { name, version: 1, format: 'divlet', capabilities: { properties: false, settings: false, frames: false, saveAs: false } },
    documents: [{ id: frame.id, name: frame.name, version: frame.version, render: 1, artboard: structuredClone(frame.artboard), viewUrl: href }],
    selection: { ids: [frame.id], revision: 0 }, diagnostics: [], work: [], clientPlugins: [],
  };
  return { state, frames: new Map([[frame.id, frame]]) };
}
