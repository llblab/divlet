/*
 * Inspector panels contributed by plugins. A plugin ships a client module (served at `plugins/<id>/<file>` and listed in the
 * project info as `clientPlugins`) that calls `registerPanel`; the inspector asks the registry for its sections and never
 * names a plugin. With no panel registered the inspector still edits tags, text, attributes and inline style.
 *
 * panel = { id, node?(ctx) → sections, nodes?(ctx) → sections }
 *   node:  one selected element.  ctx = { doc, node, parent, saveClasses(list, label), applyClasses(transform, label, { group?, refresh?, style? }), spacingFocus(focus), measuredBox(id), freshMeasuredBox(id) }
 *   nodes: two or more selected elements. ctx = { doc, nodes, applyClasses(transform, label, options) }
 *   applyClasses derives from queued accepted nodes; optional style is an inline patch or async node → patch.
 *   freshMeasuredBox waits for the current render's geometry and refuses if it never arrives.
 * section = { name, title?, content }: with a title the content is a fold, without one it is the bare section.
 */
const panels = [];

export const registerPanel = panel => { if (!panels.some(item => item.id === panel.id)) panels.push(panel); };
export const panelSections = (kind, ctx) => panels.flatMap(panel => panel[kind]?.(ctx) ?? []);

/** Load the client modules the server lists for the active plugins; a module that fails to load only loses its own panels. */
export async function loadClientPlugins(list, resolve) {
  for (const item of list || []) {
    try { await Promise.race([import(resolve(item.module)), new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 5s')), 5000))]); }
    catch (error) { console.warn(`Client plugin ${item.id} failed to load:`, error); }
  }
}
