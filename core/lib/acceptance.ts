/*
 * Owns: the host-independent acceptance rules every project writer applies — what counts as an unchanged frame or project,
 * project-field diffs for history, and the expected version/render guards. Excludes: state, persistence and scheduling.
 * The Node runtime and the browser runtime both import these, so a revision or no-op decision cannot differ between hosts.
 */
import { DivletError } from './model.ts';
import { diffValue } from './diff.ts';
import { sameJson } from './validation.ts';

export const SETTINGS_FIELDS = ['name', 'tokens', 'css', 'metadata', 'outputDir', 'assets'] as const;

export const sameDocument = (a: any, b: any): boolean => sameJson({ ...a, version: 0 }, { ...b, version: 0 });
export const sameSettings = (a: any, b: any): boolean => SETTINGS_FIELDS.every(key => sameJson(a[key], b[key]));
export const settingsPatch = (from: any, to: any): Record<string, unknown> => Object.fromEntries(SETTINGS_FIELDS.map(key => [key, diffValue(from[key], to[key])]).filter(([, value]) => value !== undefined));

/**
 * A caller that names the state it read gets a refusal instead of silently overwriting a change it
 * never saw (AGENTS.md, "Validated commits"). Omitted means the caller accepted whatever is current.
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
