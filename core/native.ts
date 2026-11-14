/* Owns: public provider-free Node host composition. Excludes: bundled defaults, provider isolation and browser hosting. */
import { seedStyleEngines } from './lib/style-engines.ts';
import { seedImporters } from './lib/plugin-registry.ts';

// Choosing this composition is explicit absence only while the process registries are untouched.
seedStyleEngines([]);
seedImporters([]);

export { openRuntime } from './lib/runtime.js';
export { launch, makeHost, resolveOpenFile } from './lib/launch.ts';
export { startServer } from './lib/server.ts';
export { registerStyleEngine, setStyleEngines } from './lib/style-engines.ts';
export type { StyleEngine } from './lib/style-engines.ts';
export { registerImporter, registerExporter } from './lib/plugin-registry.ts';
export type { Importer, Exporter } from './lib/plugin-registry.ts';
