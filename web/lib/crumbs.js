// The path of what is selected — artboard › container › … › element — as buttons that re-point the
// selection. Shown in the bottom-centre bar (crumbbar.js); the Agent composer states its own one-line scope.
import { el, icon } from './util.js';
import { cachedModel, loadModel, descriptor, ancestorsOf, selectNodes, selectArtboards } from './store.js';
import { openMenu } from './menu.js';
import { selectRoot } from './actions.js';

/**
 * Fill the bottom path for `ctx` ({ ids, nodes? }). A selected artboard collapses to its root-entry icon;
 * selecting that root opens the path. Container crumbs select ancestors; the artboard crumb folds it again.
 * `after()` runs after activation; `repaint()` is called when element data arrives late.
 */
export function pathInto(container, ctx, { after, repaint, all = false } = {}) {
  const model = ctx.nodes ? cachedModel(ctx.nodes.documentId) : null;
  if (ctx.nodes && !model) loadModel(ctx.nodes.documentId).then(() => repaint?.()).catch(() => {});
  const crumb = (label, run, tip, className = '') => {
    const item = el('button', `crumb ${className}`.trim(), label);
    item.type = 'button';
    if (tip) item.dataset.tip = tip;
    item.addEventListener('click', () => { run(); after?.(); });
    return item;
  };
  const sep = () => el('i', 'crumb-sep');
  if (!ctx.nodes) {
    if (ctx.ids.length === 1) {
      const root = crumb('', () => selectRoot(ctx.ids[0]), `Select root element · ${descriptor(ctx.ids[0])?.name || ctx.ids[0]}`, 'root-entry');
      root.setAttribute('aria-label', 'Select root element');
      root.append(icon('inspect'));
      container.append(root);
    } else container.append(crumb(`${ctx.ids.length} artboards`, () => {}, 'These artboards', 'current'));
    return;
  }
  const { documentId, nodeIds } = ctx.nodes;
  const home = crumb('', () => selectArtboards([documentId]), 'Select the whole artboard', 'home');
  home.append(icon('artboard'), el('span', '', descriptor(documentId)?.name || documentId));
  container.append(home);
  const first = nodeIds[0];
  const path = model ? ancestorsOf(model, first) : [];
  const labelOf = (id, last) => {
    const node = model?.nodes[id];
    if (!node) return `#${id}`;
    const tag = node.type === 'text' ? 'text' : node.type === 'ref' ? 'instance' : node.tag;
    return last ? `${tag}#${id}` : (node.metadata?.name || tag);
  };
  // A long path keeps the artboard, an ellipsis that lists the rest, and the last three — unless the bar scrolls (`all`).
  const shown = !all && path.length > 3 ? path.slice(-3) : path;
  if (!all && path.length > 3) {
    const hidden = path.slice(0, -3);
    const more = crumb('…', () => openMenu(hidden.map(id => ({ label: labelOf(id), run: () => selectNodes(documentId, [id], { reveal: true }) })), { anchor: more, label: 'Containers' }), hidden.map(id => labelOf(id)).join(' › '));
    container.append(sep(), more);
  }
  for (const id of shown) container.append(sep(), crumb(labelOf(id), () => selectNodes(documentId, [id], { reveal: true }), `Select this container · #${id}`));
  container.append(sep(), crumb(labelOf(first, true), () => {}, 'The selected element', 'current'));
  if (nodeIds.length > 1) container.append(el('span', 'ask-more', `+${nodeIds.length - 1}`));
}

/** What the path is made from, so a bar only repaints when it would look different. */
export function pathKey(ctx) {
  if (!ctx) return '';
  const model = ctx.nodes ? cachedModel(ctx.nodes.documentId) : null;
  const names = ctx.nodes && model ? [...ctx.nodes.nodeIds, ...ancestorsOf(model, ctx.nodes.nodeIds[0])].map(id => model.nodes[id]?.metadata?.name ?? model.nodes[id]?.tag) : null;
  return JSON.stringify([ctx, !!model, names, (ctx.nodes ? [ctx.nodes.documentId] : ctx.ids).map(id => descriptor(id)?.name)]);
}
