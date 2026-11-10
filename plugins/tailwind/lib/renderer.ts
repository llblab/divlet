// Domain: Versioned Tailwind renderer. Owns: explicit compiler identity and provider-owned resolution. Excludes: legacy defaults and inspector contributions.
import { fileURLToPath } from 'node:url';
import { compileClasses } from './styling.js';
import { rendererVersion } from './identity.ts';

const BASE = fileURLToPath(new URL('./', import.meta.url));

/** Opt-in compiler descriptor. The draft descriptor keeps its ambient-base behavior until the format cutover. */
export function createRenderer() {
  return {
    id: 'tailwind',
    label: 'Tailwind CSS',
    kind: 'style-engine',
    version: rendererVersion(),
    compileClasses(tokens: Record<string, string>, candidates: string[], _base?: string): Promise<string> {
      return compileClasses(tokens, candidates, BASE);
    },
  };
}
