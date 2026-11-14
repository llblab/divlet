// A toolbar that fits itself: every action is a button in one row, and whatever does not fit moves, in order, into a
// trailing "More" dropdown that is rebuilt whenever the available width changes. Nothing is hard-coded about which
// actions overflow; the order of `items` is the priority (the last ones leave first).
import { el, button } from './util.js';
import { openMenu } from './menu.js';

/**
 * items: menu-style entries `{ label, icon, keys, run, disabled, danger, hint, checked }` (falsy entries and '-' are
 * skipped in the row and kept as separators in the dropdown). Returns the bar element.
 */
export function overflowBar(items, { label = 'More' } = {}) {
  const list = items.filter(Boolean);
  const actions = list.filter(item => item !== '-' && !item.heading);
  const bar = el('div', 'actions smart-bar');
  const buttons = actions.map(item => {
    const node = button(item.icon, item.keys ? `${item.label} · ${item.keys}` : item.label, () => item.run?.(), item.danger ? 'danger' : '');
    node.disabled = !!item.disabled;
    return node;
  });
  const more = button('more', label, event => {
    const rest = [];
    let pendingRule = false;
    for (const entry of list) {
      if (entry === '-' || entry.heading) { pendingRule = rest.length > 0; continue; }
      const index = actions.indexOf(entry);
      if (!buttons[index].hidden) continue;
      if (pendingRule) { rest.push('-'); pendingRule = false; }
      rest.push(entry);
    }
    openMenu(rest, { anchor: event.currentTarget, label });
  });
  more.hidden = true;
  more.classList.add('more');
  bar.append(...buttons, more);

  // One read phase (every width with everything shown), then one write phase: no layout thrash while buttons are hidden.
  const fit = () => {
    for (const node of buttons) node.hidden = false;
    more.hidden = false;
    const room = bar.clientWidth;
    if (!room) { more.hidden = true; return; }
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
    const sizes = buttons.map(node => node.getBoundingClientRect().width);
    const moreSize = more.getBoundingClientRect().width;
    const used = count => sizes.slice(0, count).reduce((sum, size, index) => sum + size + (index ? gap : 0), 0);
    let keep = buttons.length;
    // Without the dropdown everything must fit; otherwise drop buttons from the end until the rest and the dropdown do (the first always stays).
    if (used(keep) > room + 0.5) while (keep > 1 && used(keep) + gap + moreSize > room + 0.5) keep--;
    buttons.forEach((node, index) => { node.hidden = index >= keep; });
    more.hidden = keep === buttons.length;
  };
  new ResizeObserver(fit).observe(bar);
  return bar;
}
