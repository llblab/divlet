// Client entry of the Tailwind plugin: the class editor, and the reader that lets the core property controls see utility classes.
// Layout / Spacing / Border / Effects / Appearance belong to the core inspector (web/lib/properties.js); this module contributes only
// what is specific to the atomic-class representation. Served at `plugins/tailwind/<file>`, so core client modules are imported as
// `../../lib/<file>`.
import { registerPanel, registerStyleReader } from '../../lib/panels.js';
import { classEditor } from './classes.js';
import { classView, variantClasses, propertiesOfClass } from './view.js';

registerStyleReader({ id: 'tailwind', view: (className, context) => classView(className, context), variants: variantClasses, properties: propertiesOfClass });

registerPanel({
  id: 'tailwind',
  node: ctx => [{ name: 'classes', content: classEditor(ctx.doc.id, ctx.node, ctx.saveClasses, { convert: entries => ctx.applyStyles(Object.fromEntries(entries), 'move inline CSS to classes') }) }],
});
