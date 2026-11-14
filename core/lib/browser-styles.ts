/* Owns: the browser model's explicit missing style-lowering capability. No compiler/provider bootstrap or UI. */
import type { StyleEngine } from './style-engines.ts';

export const applyStyles: NonNullable<StyleEngine['applyStyles']> = () => {
  throw Object.assign(new Error('No style engine is installed, so applyStyles is unavailable (the project still renders with its own CSS).'), { code: 'NO_STYLE_ENGINE' });
};
