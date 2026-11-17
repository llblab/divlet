/* Owns: the browser model's style-lowering binding. Excludes: any provider bootstrap, compiler or UI. With no installed engine the
   core's native inline-CSS path applies; a composition that bundles a portable provider installs it once, before the board starts. */
import type { StyleEngine } from './style-engines.ts';
import { browserStyleEngine } from './browser-style-engine.ts';

export const applyStyles: NonNullable<StyleEngine['applyStyles']> = (className, styles, options) => {
  const engine = browserStyleEngine();
  const lower = engine?.applyStyles;
  if (typeof lower === 'function') return lower.call(engine, className, styles, options);
  throw Object.assign(new Error('No style engine is installed, so applyStyles is unavailable (the project still renders with its own CSS).'), { code: 'NO_STYLE_ENGINE' });
};
