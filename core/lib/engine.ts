/*
 * The style engine seam. The core speaks plain HTML/CSS; everything that turns utility classes into CSS, explains or suggests
 * classes and converts CSS declarations to classes goes through the registered style engine (see plugins.js; Tailwind is the
 * engine that ships in `plugins/tailwind`). Core modules import these functions, never the engine's package.
 *
 * The engine is a plugin, so the seam is the one place that states what a plugin must provide: `StyleEngine` is the contract,
 * every capability is optional (the core degrades for a plain-CSS host), and each exported function declares its own signature
 * here so callers stay typed no matter which engine is registered.
 */
import tailwind from '../../plugins/tailwind/index.js';
import type { Style, StyleOptions } from './model.ts';

/** What one explanation says about a class: a utility with its CSS, a rule of the project's own CSS, a marker, or nothing. */
export interface ClassExplanation { kind: 'utility' | 'custom' | 'marker' | 'unknown'; lines: string[]; color?: string; custom?: string }
/** One suggestion for the class editor. */
export interface ClassSuggestion { name: string; kind: 'used' | 'utility' | 'variant'; hint?: string; color?: string }
export interface ClassContext { tokens: Record<string, string>; css?: string; base?: string }
/** A map from class name to the CSS rules that class brings (the project's own CSS). */
export type CustomClasses = Map<string, unknown[]>;
/** Rewrites the resources a class refers to; `null` when the class has nothing to rewrite. */
export type ClassResourceMapper = (className: string) => Promise<string | null>;
export interface ClassResourceOptions {
  tokens?: Record<string, string>;
  numericTokens?: Record<string, string>;
  rewriteValue: (value: string, closed: boolean) => Promise<string>;
  onRename: (from: string, to: string) => void;
  onNumericReference?: (name: string) => void;
  onVariableDefinition?: (name: string) => void;
}

/** Everything a style engine may provide. All of it is optional: without an engine the core still renders and edits, with plain CSS. */
export interface StyleEngine {
  id: string;
  label?: string;
  kind?: string;
  /** Browser modules this engine contributes: `entry` is served at `plugins/<id>/<entry>` from `root`. */
  client?: { entry: string; root: string };
  compileClasses?: (tokens: Record<string, string>, candidates: string[], base?: string) => Promise<string>;
  unknownClasses?: (context: ClassContext & { byNode: Record<string, string> }) => Promise<Record<string, string[]>>;
  createClassResourceMapper?: (options: ClassResourceOptions) => Promise<ClassResourceMapper>;
  customClasses?: (css: string) => CustomClasses;
  explainClasses?: (context: ClassContext & { names: string[] }) => Promise<Record<string, ClassExplanation>>;
  suggestClasses?: (context: ClassContext & { query: string; used?: string[]; limit?: number }) => Promise<ClassSuggestion[]>;
  warmSuggestions?: (tokens: Record<string, string>, base?: string) => void;
  /** Declarations (`{ property: value }`) → class string, replacing the classes that set the same property. */
  applyStyles?: (className: string, styles: Style, options?: StyleOptions & { colorOf?: (value: string) => string | null }) => string;
  /** One declaration → class(es). */
  declarationClass?: (property: string, value: string, colorOf?: (value: string) => string | null, options?: { scale?: boolean }) => string;
  propertyOfClass?: (name: string, colourNames?: ReadonlySet<string>) => string | null;
}

const engines: StyleEngine[] = [tailwind as StyleEngine];
/** The active style engine: the first registered (Tailwind ships with the package). Engines carry no core imports, so this seam never cycles. */
export const styleEngine = (): StyleEngine => engines[0] as StyleEngine;
/** Browser modules the active plugins contribute: `{ id, module }`, the module being a path under the board's token URL. */
export const clientPlugins = (): Array<{ id: string; module: string }> => engines.filter(engine => engine.client).map(engine => ({ id: engine.id, module: `plugins/${engine.id}/${engine.client?.entry}` }));
/** The file of a plugin's client directory (null when the plugin or file is unknown); the name is already validated as a plain file name. */
export const clientPluginFile = (id: string, file: string): string | null => { const root = engines.find(engine => engine.id === id)?.client?.root; return root ? root + file : null; };
export const registerStyleEngine = (engine: StyleEngine): void => { if (!engines.some(item => item.id === engine.id)) engines.push(engine); };

/** Replace the registered engines (tests and hosts that run the core with plain CSS pass an empty list). */
export const setStyleEngines = (list: StyleEngine[]): void => { engines.length = 0; engines.push(...list); };

/**
 * `fallback` is what the core does without an engine: read-side features (compiling, explaining, suggesting) degrade to
 * "no utility CSS, nothing known"; write-side features that need an engine (declarative styles, static export) fail clearly.
 */
function through<Args extends unknown[], Result>(name: keyof StyleEngine, fallback?: (...args: Args) => Result): (...args: Args) => Result {
  return (...args: Args): Result => {
    const engine = styleEngine();
    const capability = engine?.[name];
    // The registered engine's capability is a different member of the union per call; the exported signature is what callers see.
    if (typeof capability === 'function') return (capability as unknown as (...args: Args) => Result).apply(engine, args);
    if (fallback) return fallback(...args);
    throw Object.assign(new Error(`No style engine is installed, so ${String(name)} is unavailable (the project still renders with its own CSS).`), { code: 'NO_STYLE_ENGINE' });
  };
}

export const compileClasses = through<Parameters<NonNullable<StyleEngine['compileClasses']>>, Promise<string>>('compileClasses', async () => '');
export const unknownClasses = through<Parameters<NonNullable<StyleEngine['unknownClasses']>>, Promise<Record<string, string[]>>>('unknownClasses', async () => ({}));
export const createClassResourceMapper = through<Parameters<NonNullable<StyleEngine['createClassResourceMapper']>>, Promise<ClassResourceMapper>>('createClassResourceMapper');
export const customClasses = through<Parameters<NonNullable<StyleEngine['customClasses']>>, CustomClasses>('customClasses', () => new Map());
export const explainClasses = through<Parameters<NonNullable<StyleEngine['explainClasses']>>, Promise<Record<string, ClassExplanation>>>('explainClasses', async () => ({}));
export const suggestClasses = through<Parameters<NonNullable<StyleEngine['suggestClasses']>>, Promise<ClassSuggestion[]>>('suggestClasses', async () => []);
export const warmSuggestions = through<Parameters<NonNullable<StyleEngine['warmSuggestions']>>, void>('warmSuggestions', () => {});
export const applyStyles = through<Parameters<NonNullable<StyleEngine['applyStyles']>>, string>('applyStyles');
export const declarationClass = through<Parameters<NonNullable<StyleEngine['declarationClass']>>, string>('declarationClass');
export const propertyOfClass = through<Parameters<NonNullable<StyleEngine['propertyOfClass']>>, string | null>('propertyOfClass');
