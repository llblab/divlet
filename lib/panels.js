/*
 * Inspector panels contributed by plugins. A plugin ships a client module (served at `plugins/<id>/<file>` and listed in the
 * project info as `clientPlugins`) that calls `registerPanel`; the inspector asks the registry for its sections and never
 * names a plugin. With no panel registered the inspector still edits tags, text, attributes and inline style.
 *
 * panel = { id, node?(ctx) → sections, nodes?(ctx) → sections }
 *   node:  one selected element.  ctx = { doc, node, parent, saveClasses(list, label), applyClasses(transform, label, { group?, refresh?, style? }), applyStyles(edits, label, { group?, refresh? }), spacingFocus(focus), measuredBox(id), freshMeasuredBox(id) }
 *   nodes: two or more selected elements. ctx = { doc, nodes, applyClasses(transform, label, options), applyStyles(edits, label, options) }
 *   applyClasses returns the queued commit promise; optional style is an inline patch or async node → patch.
 *   applyStyles commits `styles` edits ({ property: value | null }, or a function (view, node) → edits) for every selected element.
 *   Linked property views may observe completion to refresh inactive controls, never to commit a second copy.
 *   freshMeasuredBox waits for the current render's geometry and refuses if it never arrives.
 * section = { name, title?, content }: with a title the content is a fold, without one it is the bare section.
 * Appearance may expose a [data-inspector-slot="typography"] element; the core inserts native family controls there.
 * Without that slot it prepends them to Appearance; without a provider it owns a minimal Appearance section.
 */
const panels = [];
const readers = [];

export const registerPanel = panel => { if (!panels.some(item => item.id === panel.id)) panels.push(panel); };
/**
 * A representation reader lets the core property controls see styling that is not an inline declaration. Tailwind registers one
 * that turns utility classes into the CSS declarations they stand for: { id, view(className) → { property: value }, variants?(className, property) → [class], properties?(className) → [property] }.
 * `properties` names what an added class sets, so the inspector can remove inline declarations that would defeat it (one authored meaning).
 * Inline declarations override a reader's view (as they do in the cascade). Readers never write: edits go through `styles` patches.
 */
export const registerStyleReader = reader => { if (!readers.some(item => item.id === reader.id)) readers.push(reader); };
export const styleReaders = () => readers;
export const panelSections = (kind, ctx) => panels.flatMap(panel => panel[kind]?.(ctx) ?? []);

/** Load the client modules the server lists for the active plugins; a module that fails to load only loses its own panels. */
export async function loadClientPlugins(list, resolve) {
  for (const item of list || []) {
    try { await Promise.race([import(resolve(item.module)), new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 5s')), 5000))]); }
    catch (error) { console.warn(`Client plugin ${item.id} failed to load:`, error); }
  }
}
