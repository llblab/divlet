// Domain: Versioned Tailwind renderer. Owns: explicit compiler identity and provider-owned resolution. Excludes: legacy defaults and inspector contributions.
import { rendererSource } from './identity.ts';
import { createRendererFromSource } from './renderer-profile.ts';

/** Opt-in compiler descriptor. The draft descriptor keeps its ambient-base behavior until the format cutover. */
export function createRenderer() {
  return createRendererFromSource(rendererSource());
}
