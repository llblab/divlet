// Domain: Portable Tailwind provider. Owns: the complete browser-capable style engine over one captured renderer source: compilation,
// declaration ↔ utility lowering, explanation and suggestions. Excludes: source/identity discovery, registry selection, any Node
// built-in or network load, and the inspector UI.
import { __unstable__loadDesignSystem } from 'tailwindcss';
import type { StyleEngine, ClassExplanation, ClassSuggestion } from '../../../core/lib/style-engines.ts';
import { captureStylesheets, createCompiler, refuseModule } from './compiler.ts';
import { themeOf } from './theme.ts';
import type { RendererSource } from './renderer-source.ts';
import { customClasses, explainWith, unknownWith, catalogOf, suggestWith } from './design-tools.js';
import { applyStyles, declarationClass, propertyOfClass } from './styles.js';

const CACHE_SIZE = 16;
type Design = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;

/**
 * The browser provider for a trusted captured renderer source (the composition binds the source to the compiler build it bundles).
 * One design system per theme is loaded lazily from the captured stylesheets and kept for explanations and suggestions.
 */
export function createBrowserProvider(source: RendererSource): StyleEngine & { version: string } {
  const compile = createCompiler(source.stylesheets);
  const captured = captureStylesheets(source.stylesheets);
  const designs = new Map<string, { design: Promise<Design>; catalog?: Promise<ReturnType<typeof catalogOf>> }>();
  const slot = (tokens: Readonly<Record<string, string>>) => {
    const theme = themeOf(tokens);
    let item = designs.get(theme);
    if (item) { designs.delete(theme); designs.set(theme, item); return item; }
    const design = __unstable__loadDesignSystem(`@import "tailwindcss";\n${theme}`, { base: captured.base, loadModule: refuseModule, loadStylesheet: captured.loadStylesheet });
    item = { design };
    designs.set(theme, item);
    // A theme that does not compile must not poison a newer slot.
    design.catch(() => { if (designs.get(theme) === item) designs.delete(theme); });
    while (designs.size > CACHE_SIZE) designs.delete(designs.keys().next().value as string);
    return item;
  };
  const catalog = (tokens: Readonly<Record<string, string>>) => { const item = slot(tokens); return (item.catalog ??= item.design.then(catalogOf)); };
  return Object.freeze({
    id: 'tailwind',
    label: 'Tailwind CSS',
    kind: 'style-engine',
    version: source.version,
    compileClasses: (tokens, candidates) => compile(tokens, candidates),
    unknownClasses: async ({ tokens, css, byNode }) => (Object.values(byNode).some(value => /\S/.test(value)) ? unknownWith(await slot(tokens).design, { css: css ?? '', byNode }) : {}),
    customClasses: css => customClasses(css),
    explainClasses: async ({ tokens, css, names }) => explainWith(await slot(tokens).design, { css: css ?? '', names }) as Record<string, ClassExplanation>,
    suggestClasses: async ({ tokens, query, used, limit }) => suggestWith(await catalog(tokens), { query, used, limit }) as ClassSuggestion[],
    warmSuggestions: tokens => { catalog(tokens).catch(() => {}); },
    applyStyles: applyStyles as StyleEngine['applyStyles'],
    declarationClass: declarationClass as StyleEngine['declarationClass'],
    propertyOfClass: propertyOfClass as StyleEngine['propertyOfClass'],
  } satisfies StyleEngine & { version: string });
}
