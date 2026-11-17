// Domain: Portable Tailwind compilation. Owns: explicit candidates and a captured stylesheet graph. Excludes: provider selection/identity, source scanning, inspector and host storage.
import { compile } from 'tailwindcss';
import parseCss from 'postcss/lib/parse';
import type { Root } from 'postcss';
import { themeOf } from './theme.ts';

import { STYLESHEETS } from './renderer-source.ts';
import type { RendererStylesheets } from './renderer-source.ts';

export type ClassCompiler = (tokens: Readonly<Record<string, string>>, candidates: readonly string[]) => Promise<string>;
const BASE = 'divlet-tailwind-compiler';
function fail(code: string, message: string, cause?: unknown): never { throw Object.assign(new Error(message, { cause }), { code }); }
function checkStylesheet(css: string, compiled: boolean): void {
  let ast: Root;
  try { ast = parseCss(css, { map: false }) as Root; }
  catch (cause) { fail('TAILWIND_COMPILER_STYLESHEET_UNAVAILABLE', 'Tailwind compilation requires parseable bundled CSS.', cause); }
  ast.walkAtRules(rule => {
    if (rule.name.toLowerCase() === 'source') fail('TAILWIND_COMPILER_SOURCE_UNSUPPORTED', 'Tailwind compilation accepts candidates directly, not source directives.');
    if (rule.name.includes('\\') || (compiled && rule.name.toLowerCase() === 'import')) fail('TAILWIND_COMPILER_STYLESHEET_UNAVAILABLE', 'Tailwind compilation cannot use escaped directives or leave unresolved imports.');
  });
}

/** Check and capture the trusted installed stylesheets once; the returned loader serves only that graph. */
export function captureStylesheets(stylesheets: RendererStylesheets): { base: string; loadStylesheet: (id: string, base: string) => Promise<{ path: string; base: string; content: string }> } {
  const files = new Map<string, string>();
  for (const name of STYLESHEETS) {
    const content = stylesheets[name];
    if (typeof content !== 'string') fail('TAILWIND_COMPILER_STYLESHEET_UNAVAILABLE', `Missing bundled Tailwind stylesheet: ${name}.`);
    checkStylesheet(content, false);
    files.set(name, content);
  }
  return {
    base: BASE,
    loadStylesheet: async (id, base) => {
      const name = id === 'tailwindcss' ? 'index.css' : id.startsWith('./') ? id.slice(2) : '';
      const content = files.get(name);
      if (base !== BASE || content === undefined) fail('TAILWIND_COMPILER_STYLESHEET_UNAVAILABLE', 'Tailwind compilation only loads its bundled stylesheet graph.');
      return { path: `${BASE}/${name}`, base: BASE, content: content as string };
    },
  };
}
export const refuseModule = async (): Promise<never> => fail('TAILWIND_COMPILER_MODULE_UNAVAILABLE', 'Tailwind compilation does not load JavaScript plugins or config modules.');

/** Capture trusted installed CSS once; callers choose the profile/host and admit tokens/candidates. */
export function createCompiler(stylesheets: RendererStylesheets): ClassCompiler {
  const captured = captureStylesheets(stylesheets);
  return async (tokens, candidates) => {
    // build() is incremental: a fresh compiler prevents one frame/candidate set leaking utilities into another.
    const compiler = await compile(`@import "tailwindcss";\n${themeOf(tokens)}`, { base: captured.base, loadModule: refuseModule, loadStylesheet: captured.loadStylesheet });
    if (compiler.sources.length || (compiler.root !== null && compiler.root !== 'none')) fail('TAILWIND_COMPILER_SOURCE_UNSUPPORTED', 'Tailwind compilation requires explicit candidates, not source scanning.');
    const css = compiler.build([...new Set(candidates)].sort());
    // Tailwind leaves remote imports in output instead of calling its loader; never turn them into browser fetches.
    checkStylesheet(css, true);
    return css;
  };
}
