// Domain: Portable Tailwind descriptor. Owns: compiler-only profile construction from trusted source. Excludes: identity discovery/attestation, project admission, registry defaults and inspector.
import { createCompiler } from './compiler.ts';
import type { RendererSource } from './renderer-source.ts';

/** Composition supplies a matching compiler build and source; this is not a project-data or hostile-host identity verifier. */
export function createRendererFromSource(source: RendererSource) {
  const version = source.version, compile = createCompiler(source.stylesheets);
  return Object.freeze({
    id: 'tailwind',
    label: 'Tailwind CSS',
    kind: 'style-engine',
    version,
    compileClasses(tokens: Record<string, string>, candidates: string[], _base?: string): Promise<string> {
      return compile(tokens, candidates);
    },
  });
}
