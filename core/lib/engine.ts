/* Owns: the legacy public style facade and synchronous bundled-default composition. Registry policy lives in style-engines.ts. */
import tailwind from '../../plugins/tailwind/index.js';
import { seedStyleEngines } from './style-engines.ts';
import type { StyleEngine } from './style-engines.ts';

seedStyleEngines([tailwind as StyleEngine]);

export type {
  StyleInput, StyleEngineRequirement, StyleEngine, ResolvedStyleEngine,
  ClassExplanation, ClassSuggestion, ClassContext, CustomClasses, ClassResourceMapper, ClassResourceOptions,
} from './style-engines.ts';
export {
  styleEngine, clientPlugins, clientPluginFile, registerStyleEngine, setStyleEngines, resolveStyleEngine,
  compileClasses, unknownClasses, createClassResourceMapper, customClasses, explainClasses, suggestClasses,
  warmSuggestions, applyStyles, declarationClass, propertyOfClass,
} from './style-engines.ts';
