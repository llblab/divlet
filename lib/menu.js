import { el, icon, clamp, uiScale } from './util.js';

/**
 * One floating menu at a time: context menus, the insert menu and small pickers.
 * Items: { label, icon?, keys?, run, disabled?, danger?, checked? } or '-' for a separator,
 * or { heading } for a section title.
 */
let current = null;

export const menuOpen = () => !!current;
export const menuAnchor = () => current?.anchor ?? null;

export function closeMenu({ restoreFocus = true } = {}) {
  if (!current) return;
  const { node, cleanup, returnFocus, anchor } = current;
  current = null;
  cleanup();
  node.remove();
  if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  anchor?.dispatchEvent?.(new CustomEvent('divlet:menu-close', { bubbles: true }));
}

export function openMenu(items, { x, y, anchor, label = 'Menu', className = '' } = {}) {
  // Pressing the control that opened the menu again closes it (no close-and-reopen flicker).
  if (anchor && current?.anchor === anchor) { closeMenu(); return null; }
  closeMenu({ restoreFocus: false });
  const visible = items.filter(Boolean);
  if (!visible.length) return null;
  const node = el('div', `menu ${className}`.trim());
  node.setAttribute('role', 'menu');
  node.setAttribute('aria-label', label);
  const buttons = [];
  let previousSeparator = true;
  for (const item of visible) {
    if (item === '-') {
      if (!previousSeparator) node.append(el('div', 'menu-sep'));
      previousSeparator = true;
      continue;
    }
    previousSeparator = false;
    if (item.heading) { node.append(el('div', 'menu-heading', item.heading)); continue; }
    const entry = el('button', `menu-item${item.danger ? ' danger' : ''}${item.checked ? ' checked' : ''}`);
    entry.type = 'button';
    entry.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (item.checked !== undefined) entry.setAttribute('aria-checked', String(!!item.checked));
    entry.disabled = !!item.disabled;
    entry.append(item.icon ? icon(item.icon) : el('span', 'icon-space'), el('span', 'menu-label', item.label));
    if (item.keys) entry.append(el('span', 'menu-keys', item.keys));
    if (item.hint) entry.title = item.hint;
    entry.addEventListener('click', event => {
      event.stopPropagation();
      closeMenu();
      try { const result = item.run?.(); result?.catch?.(() => {}); } catch (error) { console.error(error); }
    });
    node.append(entry);
    buttons.push(entry);
  }
  if (node.lastElementChild?.classList.contains('menu-sep')) node.lastElementChild.remove();
  document.body.append(node);

  // Position next to the anchor or at the pointer, always inside the viewport.
  const scale = uiScale();
  const w = node.offsetWidth * scale;
  const h = node.offsetHeight * scale;
  let left = x ?? 0;
  let top = y ?? 0;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    left = r.left;
    top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = r.top - h - 6;
  } else if (top + h > innerHeight - 8) top = Math.max(8, top - h);
  node.style.left = `${clamp(left, 8, innerWidth - w - 8)}px`;
  node.style.top = `${clamp(top, 8, innerHeight - h - 8)}px`;

  const enabled = () => buttons.filter(button => !button.disabled);
  const move = step => {
    const list = enabled();
    if (!list.length) return;
    const index = list.indexOf(document.activeElement);
    list[(index + step + list.length) % list.length].focus();
  };
  const onKey = event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Home') { event.preventDefault(); enabled()[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); enabled().at(-1)?.focus(); }
    else if (event.key === 'Tab') { event.preventDefault(); closeMenu(); }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      const match = enabled().find(button => button.textContent.trim().toLowerCase().startsWith(event.key.toLowerCase()));
      match?.focus();
    }
  };
  // A press on the anchor is left to its click, which toggles the menu; any other outside press dismisses it.
  const outside = event => { if (!node.contains(event.target) && !anchor?.contains?.(event.target)) closeMenu({ restoreFocus: false }); };
  const dismiss = event => { if (!(event?.type === 'wheel' && node.contains(event.target))) closeMenu({ restoreFocus: false }); };
  node.addEventListener('keydown', onKey);
  node.addEventListener('contextmenu', event => event.preventDefault());
  const timer = setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  window.addEventListener('blur', dismiss);
  window.addEventListener('resize', dismiss);
  window.addEventListener('wheel', dismiss, { passive: true });
  current = {
    node,
    anchor: anchor ?? null,
    returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    cleanup() {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('wheel', dismiss);
    },
  };
  (enabled()[0] || node).focus({ preventScroll: true });
  return node;
}
