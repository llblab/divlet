// The path of the selection, always bottom centre between the left column and the toolbar. When that span is narrow the path
// wraps onto more lines; on a phone the sidebars simply sit on top of it.
import { $, el, uiScale } from './util.js';
import { store, on } from './store.js';
import { pathInto, pathKey } from './crumbs.js';

const bar = $('#crumbs');
const track = el('div', 'crumbs-track');
bar.append(track);
const tabs = $('#side-tabs');
const dock = $('#dock');
const MIN_WIDTH = 90;
let shown = '';

function context() {
  const ids = [...store.selected];
  if (!ids.length) return null;
  const node = store.node;
  if (node?.nodeIds.length && ids.length === 1 && node.documentId === ids[0]) return { ids, nodes: { documentId: node.documentId, nodeIds: [...node.nodeIds] } };
  return { ids };
}

/** Fit the bar between the tabs and the toolbar; with no room at all it hides rather than overlap them. */
function place() {
  if (bar.hidden) return;
  // The tabs live in the sidebar footer; compare viewport rectangles, not offsets from different parents.
  const a = tabs.getBoundingClientRect(), b = dock.getBoundingClientRect(), scale = uiScale();
  const sameRow = Math.abs(a.bottom - b.bottom) / scale < 24;
  const left = (sameRow ? a.right / scale : 0) + 10;
  const width = b.left / scale - 10 - left;
  bar.style.left = `${left}px`;
  bar.style.width = `${Math.max(0, width)}px`;
  bar.classList.toggle('cramped', width < MIN_WIDTH);
}

function paint() {
  const ctx = store.expanded ? null : context();
  if (!ctx) { bar.hidden = true; shown = ''; track.replaceChildren(); return; }
  const key = pathKey(ctx);
  bar.hidden = false;
  if (key !== shown || !track.childElementCount) {
    shown = key;
    track.replaceChildren();
    pathInto(track, ctx, { all: true, repaint: () => { shown = ''; paint(); } });
  }
  place();
}

for (const name of ['selection', 'model', 'state', 'expanded', 'sidebar']) on(name, paint);
addEventListener('resize', place);
new ResizeObserver(place).observe(dock);
new ResizeObserver(place).observe(tabs);
paint();
