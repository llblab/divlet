// Domain: Browser Tailwind compilation. Owns: explicit candidates and a captured bundled stylesheet graph. Excludes: provider selection/identity, source scanning, inspector and host storage.
import { compile } from 'tailwindcss';
import parseCss from 'postcss/lib/parse';
import type { Root } from 'postcss';
import { themeOf } from './theme.ts';

/** Trusted composition supplies installed CSS bytes, never project-selected paths or fetch callbacks. */
export interface BrowserStylesheets {
  readonly 'index.css': string;
  readonly 'theme.css': string;
  readonly 'preflight.css': string;
  readonly 'utilities.css': string;
}
export type BrowserCompiler = (tokens: Readonly<Record<string, string>>, candidates: readonly string[]) => Promise<string>;
const FILES = ['index.css', 'theme.css', 'preflight.css', 'utilities.css'] as const;
const BASE = 'divlet-tailwind-browser';
function fail(code: string, message: string, cause?: unknown): never { throw Object.assign(new Error(message, { cause }), { code }); }
function checkStylesheet(css: string, compiled: boolean): void {
  let ast: Root;
  try { ast = parseCss(css, { map: false }) as Root; }
  catch (cause) { fail('TAILWIND_BROWSER_STYLESHEET_UNAVAILABLE', 'Browser Tailwind compilation requires parseable bundled CSS.', cause); }
  ast.walkAtRules(rule => {
    if (rule.name.toLowerCase() === 'source') fail('TAILWIND_BROWSER_SOURCE_UNSUPPORTED', 'Browser Tailwind compilation accepts candidates directly, not source directives.');
    if (rule.name.includes('\\') || (compiled && rule.name.toLowerCase() === 'import')) fail('TAILWIND_BROWSER_STYLESHEET_UNAVAILABLE', 'Browser Tailwind compilation cannot use escaped directives or leave unresolved imports.');
  });
}

/** Compiler-only portable slice, not a registered/versioned StyleEngine or a complete browser plugin. */
export function createBrowserCompiler(stylesheets: BrowserStylesheets): BrowserCompiler {
  const files = new Map<string, string>();
  for (const name of FILES) {
    const content = stylesheets[name];
    if (typeof content !== 'string') fail('TAILWIND_BROWSER_STYLESHEET_UNAVAILABLE', `Missing bundled Tailwind stylesheet: ${name}.`);
    checkStylesheet(content, false);
    files.set(name, content);
  }
  return async (tokens, candidates) => {
    // build() is incremental: a fresh compiler prevents one frame/candidate set leaking utilities into another.
    const compiler = await compile(`@import "tailwindcss";\n${themeOf(tokens)}`, {
      base: BASE,
      loadModule: async () => fail('TAILWIND_BROWSER_MODULE_UNAVAILABLE', 'Browser Tailwind compilation does not load JavaScript plugins or config modules.'),
      loadStylesheet: async (id, base) => {
        const name = id === 'tailwindcss' ? 'index.css' : id.startsWith('./') ? id.slice(2) : '';
        const content = files.get(name);
        if (base !== BASE || content === undefined) fail('TAILWIND_BROWSER_STYLESHEET_UNAVAILABLE', 'Browser Tailwind compilation only loads its bundled stylesheet graph.');
        return { path: `${BASE}/${name}`, base: BASE, content };
      },
    });
    if (compiler.sources.length || (compiler.root !== null && compiler.root !== 'none')) fail('TAILWIND_BROWSER_SOURCE_UNSUPPORTED', 'Browser Tailwind compilation requires explicit candidates, not source scanning.');
    const css = compiler.build([...new Set(candidates)].sort());
    // Tailwind leaves remote imports in output instead of calling its loader; never turn them into browser fetches.
    checkStylesheet(css, true);
    return css;
  };
}
