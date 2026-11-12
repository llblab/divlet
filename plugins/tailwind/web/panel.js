// Client entry of the Tailwind plugin: the inspector's class editor and the Layout / Spacing / Effects folds.
// Served at `plugins/tailwind/<file>`, so core client modules are imported as `../../lib/<file>`.
import { registerPanel } from '../../lib/panels.js';
import { cachedModel } from '../../lib/store.js';
import { classEditor } from './classes.js';
import { layoutSections } from './layout.js';

const folds = (nodes, ctx) => layoutSections(nodes, { readMeasured: () => nodes.length === 1 ? ctx.freshMeasuredBox(nodes[0].id) : null, parent: ctx.parent ?? null, apply: ctx.applyClasses, spacingFocus: ctx.spacingFocus, measured: nodes.length === 1 ? ctx.measuredBox?.(nodes[0].id) ?? null : null, tokens: Object.entries(cachedModel(ctx.doc.id)?.tokens || {}).filter(([name]) => /^--color-[a-z0-9-]+$/i.test(name)) })
  .map(([name, title, content]) => ({ name, title, content }));

registerPanel({
  id: 'tailwind',
  node: ctx => [{ name: 'classes', content: classEditor(ctx.doc.id, ctx.node, ctx.saveClasses) }, ...folds([ctx.node], ctx)],
  nodes: ctx => folds(ctx.nodes, ctx),
});
