// Owns structural rendering requirements. Excludes provider resolution, loading, installation and project activation.
import { DivletError, ID, object, fail } from './validation.ts';
import type { ProjectRequirements } from './model.ts';

const REQUIREMENT_FIELDS: ReadonlySet<string> = new Set(['styleEngine']);
const RENDERER_FIELDS: ReadonlySet<string> = new Set(['id', 'version']);

function record(input: unknown, label: string, allowed: ReadonlySet<string>): Record<string, unknown> {
  const value: Record<string, unknown> = object(input, label);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) fail(`Unsupported ${label} field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${label} must contain only enumerable JSON data fields`);
  }
  return value;
}

/** Opt-in structural decoding only; an explicit empty object means native CSS, never an inferred/default renderer. */
export function validateRequirements(input: unknown): ProjectRequirements {
  try {
    const value = record(input, 'requires', REQUIREMENT_FIELDS);
    if (!Object.hasOwn(value, 'styleEngine')) return {};
    const renderer = record(value.styleEngine, 'requires.styleEngine', RENDERER_FIELDS);
    if (!Object.hasOwn(renderer, 'id') || !Object.hasOwn(renderer, 'version')) fail('requires.styleEngine must declare id and version');
    const id = renderer.id, version = renderer.version;
    if (typeof id !== 'string' || !ID.test(id)) fail('requires.styleEngine.id must be a safe identifier');
    if (typeof version !== 'string' || version.length < 1 || version.length > 128 || /[^\x20-\x7e]/.test(version)) fail('requires.styleEngine.version must be a nonempty printable ASCII identity of at most 128 characters');
    return { styleEngine: { id, version } };
  } catch (error) {
    if (error instanceof DivletError) throw new DivletError('INVALID_PROJECT', error.message, error.details);
    throw error;
  }
}
