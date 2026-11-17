/* Owns: the browser composition's installed style provider slot. Excludes: any provider, compiler or UI. A separate module so the
   browser model port (browser-styles.ts) keeps exactly the bindings of the Node port it replaces. */
import type { StyleEngine } from './style-engines.ts';

let installed: StyleEngine | undefined;
/** Composition-only: select the portable provider whose declaration → utility lowering the browser model uses. Undefined clears. */
export const installBrowserStyleEngine = (engine: StyleEngine | undefined): void => { installed = engine; };
export const browserStyleEngine = (): StyleEngine | undefined => installed;
