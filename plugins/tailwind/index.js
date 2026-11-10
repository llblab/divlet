// Entry point only: the Tailwind style engine the core registry loads. The code lives in ./lib.
import { fileURLToPath } from 'node:url';
import { compileClasses, unknownClasses, createClassResourceMapper, customClasses, explainClasses, suggestClasses, warmSuggestions } from './lib/styling.js';
import { applyStyles, declarationClass, propertyOfClass } from './lib/styles.js';
export { createRenderer } from './lib/renderer.ts';

export default {
  id: 'tailwind',
  label: 'Tailwind CSS',
  kind: 'style-engine',
  // Browser side: the inspector's class and layout panels. `entry` is served at plugins/tailwind/<file> from `root`.
  client: { entry: 'panel.js', root: fileURLToPath(new URL('./web/', import.meta.url)) },
  compileClasses, unknownClasses, createClassResourceMapper, customClasses, explainClasses, suggestClasses, warmSuggestions,
  applyStyles, declarationClass, propertyOfClass,
};
