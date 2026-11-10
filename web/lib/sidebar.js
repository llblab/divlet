import { $, uiScale } from './util.js';
import { emit } from './store.js';

/* The left sidebar hosts three panes: Layers, History (changes only) and Agent (the conversation with Pi).
   Their tabs sit under it and never go away: the active tab is lit, and pressing it again (or Esc) folds the
   sidebar, so a tab both switches and hides. */
const panel = $('#sidebar');
const buttons = { layers: $('#open-layers'), activity: $('#open-history'), agent: $('#open-agent') };
const panes = { layers: $('#layers'), activity: $('#activity'), agent: $('#agent') };
const LABELS = { layers: 'Layers', activity: 'History', agent: 'Agent' };
let current = 'layers';

export const tab = () => current;
export const isOpen = name => !panel.hidden && (!name || current === name);
export const widthSize = () => (panel.hidden ? 'wide' : panel.getBoundingClientRect().width / uiScale() < 265 ? 'tiny' : panel.getBoundingClientRect().width / uiScale() < 320 ? 'narrow' : 'wide');

export function show(name = current) {
  current = name;
  panel.hidden = false;
  for (const [key, pane] of Object.entries(panes)) pane.hidden = key !== name;
  panel.setAttribute('aria-label', LABELS[name]);
  paint();
  emit('sidebar', { open: true, tab: name });
}

export function close() {
  if (panel.hidden) return;
  const was = current;
  panel.hidden = true;
  paint();
  emit('sidebar', { open: false, tab: was });
}

/**
 * The sidebar is resizable, so how much room its content has is a property of the panel, not of the viewport: a media query
 * cannot see it. `data-sidebar` on the document tells the panes how tight they are, and the width event lets text adapt
 * (the composer's placeholder and key hints are length-sensitive).
 */
const inspector = $('#inspector');

/**
 * The pinned chrome has two looks, chosen by the panels themselves: with every panel folded it floats over the canvas (frosted,
 * translucent); as soon as a panel is open the chrome belongs to one opaque body, so the pills and the dock turn solid. `none`,
 * `left`, `right` or `both` says which side is open.
 */
function paintPanels() {
  const left = !panel.hidden, right = !!inspector && !inspector.hidden;
  const state = left && right ? 'both' : left ? 'left' : right ? 'right' : 'none';
  if (document.documentElement.dataset.panels !== state) document.documentElement.dataset.panels = state;
}
new MutationObserver(paintPanels).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
if (inspector) new MutationObserver(paintPanels).observe(inspector, { attributes: true, attributeFilter: ['hidden'] });

function measure() {
  // Density thresholds are interface pixels, not the scaled screen pixels returned by the rectangle.
  const width = panel.hidden ? 0 : panel.getBoundingClientRect().width / uiScale();
  // The sidebar's own floor is 240px (resize.js), so the steps live inside that range: tiny 240–264, narrow 265–319.
  const size = width && width < 265 ? 'tiny' : width && width < 320 ? 'narrow' : 'wide';
  if (document.documentElement.dataset.sidebar !== size) {
    document.documentElement.dataset.sidebar = size;
    emit('sidebar-width', { size, width });
  }
}
new ResizeObserver(measure).observe(panel);
// The folded activity plaque belongs to the tab footer; phone sheets/breadcrumbs stay above its real height.
const footer = $('#sidebar-foot');
new ResizeObserver(() => {
  const extra = Math.max(0, footer.offsetHeight - $('#side-tabs').offsetHeight);
  document.documentElement.style.setProperty('--agent-float-h', `${extra}px`);
}).observe(footer);

/** Toggle a pane: opening it, switching to it, or folding the sidebar when it is already showing. */
export function toggle(name) {
  if (isOpen(name)) close();
  else show(name);
}

function paint() {
  for (const [name, button] of Object.entries(buttons)) {
    button?.classList.toggle('on', isOpen(name));
    button?.setAttribute('aria-selected', String(isOpen(name)));
  }
  document.body.classList.toggle('has-sidebar', !panel.hidden);
  document.body.classList.toggle('has-ask', isOpen('agent'));
}
