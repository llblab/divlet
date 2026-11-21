// The keyboard shortcuts, read-only: ? or Ctrl+K → Keyboard shortcuts. Settings has only settings.
import { $, el, icon, keys } from './util.js';
import { on } from './store.js';

const scrim = el('div', 'scrim chrome');
scrim.id = 'shortcuts';
scrim.hidden = true;
const dialog = el('section', 'dialog shortcuts-dialog');
dialog.setAttribute('role', 'dialog');
dialog.setAttribute('aria-modal', 'true');
dialog.setAttribute('aria-labelledby', 'shortcuts-title');
scrim.append(dialog);
($('#ui') || document.body).append(scrim);
let returnFocus = null;

const GROUPS = [
  ['Pi and search', [
    ['Ask the agent about the selection', 'A'], ['Send the request', keys('Enter')], ['Previous requests', '↑ in the Agent tab'],
    ['Search everything', keys('Mod+K')], ['Ask the agent from the search', keys('Mod+Enter')],
  ]],
  ['Canvas', [
    ['Pan', 'Scroll · Space+drag'], ['Zoom', `${keys('Mod')}+scroll · pinch`], ['Zoom in / out', '+ / −'],
    ['Zoom to 100%', '0'], ['Fit everything', keys('Shift+1')], ['Zoom to selection', `F · ${keys('Shift+2')}`],
  ]],
  ['Tools', [['Select', 'V'], ['Interact with the page', 'P'], ['Expand and browse', 'E']]],
  ['Selection', [
    ['Element', 'Click'], ['Add to selection', `${keys('Shift')}+click`], ['Artboards', 'Drag on canvas'],
    ['Child · edit text', keys('Enter')], ['Parent, up to the artboard', `${keys('Escape')} · ${keys('Shift+Enter')}`],
    ['Walk the tree', '↑ ↓ siblings · ← parent · → child'], ['Next / previous (also while editing)', 'Tab · ⇧ Tab'], ['New list item (while editing one)', keys('Enter')], ['All artboards', keys('Mod+A')],
  ]],
  ['Editing', [
    ['Undo / redo', `${keys('Mod+Z')} · ${keys('Mod+Shift+Z')}`], ['Duplicate', keys('Mod+D')], ['Delete', 'Del'],
    ['Copy, cut, paste', `${keys('Mod+C')} ${keys('Mod+X')} ${keys('Mod+V')}`], ['Add an image', 'Drop or paste'],
    ['Wrap / unwrap', `${keys('Mod+G')} · ${keys('Mod+Shift+G')}`], ['Reorder element', `${keys('Alt+Up')} ${keys('Alt+Down')}`],
    ['Edit text', 'Double-click'], ['Move artboard', `Drag · arrows`], ['Rename artboard', 'R'],
    ['Margin / padding of the selection', 'Drag a green or orange pill'], ['Move an element', 'Drag its grip (top-left corner) onto another element'], ['Copy while moving', `${keys('Alt')} on drop`], ['Resize an element', 'Drag the square at its bottom-right corner'], ['… all sides · opposite sides · 1px', `${keys('Shift')} · ${keys('Mod')} · ${keys('Alt')}`], ['Resize: width only · height only', `${keys('Shift')} · ${keys('Mod')}`],
    ['New artboard', 'N'], ['Cancel a drag', keys('Escape')], ['More actions', `Right-click · ${keys('Shift+F10')}`],
  ]],
  ['Panels', [['Layers', 'L'], ['History', 'H'], ['Keyboard shortcuts', '?'], ['Settings', `${keys('Mod')} ,`], ['Interface size', `${keys('Mod+Alt')} + / −`], ['Open / save a project', `${keys('Mod+O')} · ${keys('Mod+Shift+S')}`]]],
];


export const isOpen = () => !scrim.hidden;

function render() {
  const head = el('div', 'dialog-head');
  const title = el('h2', '', 'Keyboard shortcuts');
  title.id = 'shortcuts-title';
  const close = el('button', 'tool mini');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.dataset.tip = 'Close · Esc';
  close.append(icon('close'));
  close.addEventListener('click', () => toggle(false));
  head.append(title, close);
  const grid = el('div', 'shortcut-grid');
  for (const [name, rows] of GROUPS) {
    const group = el('section', 'shortcut-group');
    group.append(el('h3', '', name));
    const list = el('dl');
    for (const [what, how] of rows) list.append(el('dt', '', what), el('dd', '', how));
    group.append(list);
    grid.append(group);
  }
  const foot = el('div', 'dialog-foot');
  foot.append(el('span', 'caption', 'Shortcuts follow the key, not the keyboard layout. Right-click anything for its actions.'));
  dialog.replaceChildren(head, grid, foot);
}

export function toggle(force) {
  const open = force ?? scrim.hidden;
  if (open === !scrim.hidden) return;
  if (open) {
    returnFocus = document.activeElement;
    render();
    scrim.hidden = false;
    dialog.querySelector('button')?.focus({ preventScroll: true });
  } else {
    scrim.hidden = true;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    else $('#viewport').focus({ preventScroll: true });
  }
}

scrim.addEventListener('pointerdown', event => { if (event.target === scrim) toggle(false); });
scrim.addEventListener('keydown', event => {
  event.stopPropagation();
  if (event.key === 'Escape' || event.key === '?') { event.preventDefault(); toggle(false); }
  if (event.key === 'Tab') { event.preventDefault(); dialog.querySelector('button')?.focus(); }
});
on('shortcuts', value => toggle(value));
