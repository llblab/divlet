/*
 * Owns: the host-independent acceptance rules every project writer applies — what counts as an unchanged frame or project,
 * project-field diffs for history, and the expected version/render guards. Excludes: state, persistence and scheduling.
 * The Node runtime and the browser runtime both import these, so a revision or no-op decision cannot differ between hosts.
 */
import { DivletError } from './model.ts';
import type { DocumentModel } from './model.ts';
import type { ProjectSettings } from './project.ts';
import { diffValue, documentStyleSequence, captureHistoryNulls } from './diff.ts';
import type { ValueHistoryPatch } from './diff.ts';
import { sameJson } from './validation.ts';

export const SETTINGS_FIELDS = ['name', 'tokens', 'css', 'metadata', 'outputDir', 'assets'] as const;

export const sameDocument = (a: DocumentModel, b: DocumentModel): boolean => sameJson({ ...a, version: 0 }, { ...b, version: 0 }) && sameJson(documentStyleSequence(a), documentStyleSequence(b));
export const sameSettings = (a: any, b: any): boolean => SETTINGS_FIELDS.every(key => sameJson(a[key], b[key]));
export const settingsPatch = (from: any, to: any): Record<string, unknown> => Object.fromEntries(SETTINGS_FIELDS.map(key => [key, diffValue(from[key], to[key])]).filter(([, value]) => value !== undefined));

/** Project metadata uses the same exact nullable slots as documents; outputDir keeps its normalized-null patch semantics. */
export function settingsHistoryPatch(from: ProjectSettings, to: ProjectSettings): ValueHistoryPatch {
  const nullBlocks = captureHistoryNulls([[from.metadata, to.metadata, ['metadata']]]);
  return { inverse: settingsPatch(to, from), forward: settingsPatch(from, to), ...(nullBlocks.length ? { nullBlocks } : {}) };
}

/** Patches require the read version, including no-ops; lifecycle callers retain the separate optional guard below. */
export function assertPatchVersion(expected: unknown, target: { readonly version: number }, what: 'frame' | 'project' = 'frame'): void {
  if (!Number.isInteger(expected) || expected !== target.version) {
    const recovery = what === 'frame' ? 'Read the frame again and rebuild the change.' : 'Read the project again.';
    throw new DivletError('REVISION_CONFLICT', `Expected ${what} version ${target.version}; received ${expected}. ${recovery}`, { actualVersion: target.version });
  }
}

/**
 * Optional lifecycle guard: a named read point must match; omission accepts whatever is current.
 * Patch admission uses assertPatchVersion instead and never permits an omitted version.
 */
export function assertExpectedVersion(expected: unknown, target: { version: number }, what = 'frame'): void {
  if (expected === undefined) return;
  if (!Number.isInteger(expected) || expected !== target.version) throw new DivletError('REVISION_CONFLICT', `Expected ${what} version ${target.version}; received ${expected}. Read it again and rebuild the change.`, { actualVersion: target.version });
}

/** The rendered page a gesture was made against; a dependent re-render advances it without a version bump. */
export function assertExpectedRender(expected: unknown, entry: { render: number; document: { version: number } }): void {
  if (expected === undefined) return;
  if (!Number.isInteger(expected) || expected !== entry.render) throw new DivletError('RENDER_CONFLICT', `Expected frame render ${entry.render}; received ${expected}. The page changed since it was read; reload the frame and repeat the change.`, { actualRender: entry.render, actualVersion: entry.document.version });
}
