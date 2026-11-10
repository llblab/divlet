import { $, el, icon, button, pressGuard } from './util.js';
import { store, on, documents, loadModel, cachedModel, edit, selectArtboards, selectNodes, parentMap, canContain, textChild } from './store.js';
import { reveal, postToFrame } from './canvas.js';
import { insertMenu, artboardMenu, nodeMenu, newArtboard, renameLayer } from './actions.js';
import * as sidebar from './sidebar.js';

const panel = $('#layers');
const collapsed = new Set();
let dragged = null;
let token = 0;
let renaming = null;
let lastSelectionKey = '';

export const isOpen = () => sidebar.isOpen('layers');

/**
 * The Layers pane always has an artboard to show: opening it (or losing the selected artboard to an undo, a delete or another
 * client) selects the one that was chosen before if it still exists, else the first artboard. Only a project without artboards
 * has nothing selected here — that is the one honest empty state.
 */
let lastChosen = null;
const keepAnArtboardSelected = () => {
  if (!isOpen()) return false;
  const list = documents();
  if (!list.length) { lastChosen = null; return false; }
  if (store.selected.size) {
    lastChosen = store.selected.has(lastChosen) ? lastChosen : [...store.selected][0];
    return false;
  }
  const next = list.find(doc => doc.id === lastChosen) ?? list[0];
  lastChosen = next.id;
  selectArtboards([next.id]);
  return true;
};
export function toggle(force) {
  if (force === undefined) sidebar.toggle('layers');
  else if (force) sidebar.show('layers');
  else if (isOpen()) sidebar.close();
}

const label = (model, node) => {
  const name = node.metadata?.name;
  if (typeof name === 'string' && name.trim()) return { text: name.trim(), named: true };
  if (node.type === 'ref') {
    // An instance reads best by the text it overrides first ("Pro", "Sign up").
    const first = Object.values(node.descendants || {}).map(item => item.content ?? item.text).find(value => typeof value === 'string' && value.trim());
    return { text: first ? first.replace(/\s+/g, ' ').trim() : '', named: false };
  }
  const text = textChild(model, node);
  return { text: text ? text.content.replace(/\s+/g, ' ').trim() : '', named: false };
};

function rowKeydown(event, row) {
  const rows = [...panel.querySelectorAll('.row-item')];
  const index = rows.indexOf(row);
  const go = target => { if (!target) return; event.preventDefault(); target.focus(); target.click(); };
  if (event.key === 'ArrowDown') { event.stopPropagation(); go(rows[index + 1]); }
  else if (event.key === 'ArrowUp') { event.stopPropagation(); go(rows[index - 1]); }
  else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.stopPropagation();
    event.preventDefault();
    const twist = row.querySelector('.twist:not(.none)');
    const open = twist?.classList.contains('open');
    if (event.key === 'ArrowRight' && twist && !open) twist.click();
    else if (event.key === 'ArrowLeft' && twist && open) twist.click();
    else if (event.key === 'ArrowRight') go(rows[index + 1]);
    else if (row.dataset.parent) go(panel.querySelector(`.row-item[data-node-id="${CSS.escape(row.dataset.parent)}"]`));
    else if (row.classList.contains('node')) go(panel.querySelector('.board.row-item.on, .board.row-item'));
  } else if (event.key === 'F2' || (event.key === 'Enter' && event.altKey)) { event.preventDefault(); event.stopPropagation(); row.dispatchEvent(new MouseEvent('dblclick')); }
}

function inlineRename(host, value, save) {
  renaming = host;
  const input = el('input', 'row-rename');
  input.value = value;
  input.setAttribute('aria-label', 'Name');
  host.replaceChildren(input);
  input.focus();
  input.select();
  let finished = false;
  const done = commitIt => {
    if (finished) return;
    finished = true;
    renaming = null;
    if (commitIt && input.value.trim() !== value) save(input.value.trim());
    render();
  };
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') done(true);
    else if (event.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true));
  input.addEventListener('click', event => event.stopPropagation());
}

function tree(doc, model) {
  const list = el('div', 'tree');
  list.setAttribute('role', 'group');
  const selectedNodes = store.node?.documentId === doc.id ? new Set(store.node.nodeIds) : new Set();
  const parents = parentMap(model);
  const ancestors = new Set();
  for (const id of selectedNodes) for (let p = parents.get(id); p; p = parents.get(p)) ancestors.add(p);
  const walk = (id, depth) => {
    const node = model.nodes[id];
    if (!node) return;
    const textOnly = !!textChild(model, node) && node.type === 'element';
    const hasKids = node.type === 'element' && node.children.length > 0 && !textOnly;
    const isCollapsed = hasKids && collapsed.has(`${doc.id}/${id}`) && !ancestors.has(id);
    const line = el('div', `node row-item${selectedNodes.has(id) ? ' on' : ''}`);
    line.style.setProperty('--depth', String(depth));
    line.dataset.nodeId = id;
    line.dataset.documentId = doc.id;
    if (parents.get(id)) line.dataset.parent = parents.get(id);
    line.tabIndex = selectedNodes.has(id) ? 0 : -1;
    line.setAttribute('role', 'treeitem');
    line.setAttribute('aria-selected', String(selectedNodes.has(id)));
    if (hasKids) line.setAttribute('aria-expanded', String(!isCollapsed));
    line.draggable = id !== model.rootId;
    const twist = el('span', `twist${hasKids ? (isCollapsed ? '' : ' open') : ' none'}`);
    if (hasKids) {
      twist.append(icon('chevron'));
      twist.addEventListener('click', event => { event.stopPropagation(); const key = `${doc.id}/${id}`; if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); render(); });
    }
    const caption = label(model, node);
    const nameHost = el('span', `snip${caption.named ? ' named' : ''}`, caption.text);
    const tagName = el('span', `tagname${node.type === 'text' ? ' is-text' : node.type === 'ref' ? ' is-instance' : ''}`, node.type === 'text' ? 'T' : node.type === 'ref' ? '' : node.tag);
    if (node.type === 'ref') tagName.append(icon('instance'), document.createTextNode(node.ref.split('/').pop()));
    line.append(twist, tagName, nameHost);
    if (node.type === 'element' && node.reusable) { const mark = icon('component', 'icon component-dot'); line.append(mark); line.classList.add('is-component'); }
    line.dataset.tip = node.type === 'ref' ? `${node.id} · instance of ${node.ref}` : node.reusable ? `${node.id} · component` : node.id;
    line.addEventListener('click', event => {
      if (renaming) return;
      const current = store.node?.documentId === doc.id ? store.node.nodeIds : [];
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      selectNodes(doc.id, additive ? (current.includes(id) ? current.filter(item => item !== id) : [...current, id]) : [id], { reveal: true });
    });
    line.addEventListener('dblclick', event => {
      event.stopPropagation();
      if (node.type === 'text') return;
      inlineRename(nameHost, typeof node.metadata?.name === 'string' ? node.metadata.name : caption.text, value => renameLayer(doc.id, id, value));
    });
    line.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (!selectedNodes.has(id)) selectNodes(doc.id, [id], { reveal: true });
      nodeMenu(doc.id, { x: event.clientX, y: event.clientY });
    });
    line.addEventListener('keydown', event => rowKeydown(event, line));
    line.addEventListener('mouseenter', () => postToFrame(doc.id, { type: 'divlet:hover', nodeId: id }));
    line.addEventListener('mouseleave', () => postToFrame(doc.id, { type: 'divlet:hover', nodeId: null }));
    line.addEventListener('dragstart', event => { dragged = { documentId: doc.id, id }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); line.classList.add('dragging'); });
    line.addEventListener('dragend', () => { dragged = null; line.classList.remove('dragging'); clearDrop(); if (pending) schedule(); });
    line.addEventListener('dragover', event => {
      if (!dragged || dragged.documentId !== doc.id || dragged.id === id) return;
      const zone = dropZone(event, line, node, model);
      if (!zone) return;
      event.preventDefault();
      clearDrop();
      line.classList.add(`drop-${zone}`);
    });
    line.addEventListener('dragleave', () => line.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    line.addEventListener('drop', event => {
      event.preventDefault();
      clearDrop();
      if (!dragged || dragged.documentId !== doc.id || dragged.id === id) return;
      const zone = dropZone(event, line, node, model);
      if (zone) dropNode(doc.id, model, dragged.id, id, zone);
      dragged = null;
    });
    list.append(line);
    if (hasKids && !isCollapsed) for (const child of node.children) walk(child, depth + 1);
  };
  walk(model.rootId, 0);
  return list;
}

function dropZone(event, line, node, model) {
  const rect = line.getBoundingClientRect();
  const y = (event.clientY - rect.top) / rect.height;
  if (canContain(node) && !textChild(model, node) && y > 0.28 && y < 0.72) return 'inside';
  if (node.id === model.rootId) return canContain(node) ? 'inside' : null;
  return y < 0.5 ? 'before' : 'after';
}

function clearDrop() {
  for (const node of panel.querySelectorAll('.drop-before, .drop-after, .drop-inside')) node.classList.remove('drop-before', 'drop-after', 'drop-inside');
}

function dropNode(documentId, model, id, targetId, zone) {
  const op = zone === 'inside' ? { type: 'move', id, parentId: targetId } : { type: 'move', id, [zone]: targetId };
  edit(documentId, op, { label: `move ${id}` }).then(() => selectNodes(documentId, [id])).catch(() => {});
}

/** One artboard in the list on top: a name, lit when selected. Choosing it draws its tree below. */
function boardRow(doc, model) {
  const item = el('div', `board row-item${store.selected.has(doc.id) ? ' on' : ''}`);
  item.dataset.documentId = doc.id;
  item.tabIndex = store.selected.has(doc.id) && !store.node ? 0 : -1;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', String(store.selected.has(doc.id)));
  item.append(icon('artboard'), el('span', 'name', doc.name || doc.id));
  item.dataset.tip = `${doc.name || doc.id} · ${Math.round(doc.artboard.width)} × ${Math.round(doc.artboard.height)}`;
  // Dropping a layer on the artboard row moves it into the root element.
  if (model) {
    item.addEventListener('dragover', event => {
      if (!dragged || dragged.documentId !== doc.id) return;
      event.preventDefault();
      clearDrop();
      item.classList.add('drop-inside');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-inside'));
    item.addEventListener('drop', event => {
      event.preventDefault();
      clearDrop();
      if (dragged && dragged.documentId === doc.id) dropNode(doc.id, model, dragged.id, model.rootId, 'inside');
      dragged = null;
    });
  }
  item.addEventListener('click', event => {
    if (renaming) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey) selectArtboards(store.selected.has(doc.id) ? [...store.selected].filter(id => id !== doc.id) : [doc.id], { additive: !store.selected.has(doc.id) });
    else selectArtboards([doc.id]);
    reveal(doc.id);
  });
  item.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (!store.selected.has(doc.id)) selectArtboards([doc.id]);
    artboardMenu(doc.id, { x: event.clientX, y: event.clientY });
  });
  item.addEventListener('keydown', event => rowKeydown(event, item));
  return item;
}

let pending = false;
const pressing = pressGuard(panel, () => { if (pending) render(); });

export async function render() {
  if (!isOpen() || renaming) return;
  if (keepAnArtboardSelected()) return;
  if (pressing() || dragged) { pending = true; return; }
  pending = false;
  const mine = ++token;
  const single = store.selected.size === 1 ? [...store.selected][0] : null;
  let model = null;
  if (single) {
    model = cachedModel(single);
    if (!model) { try { model = await loadModel(single); } catch {} if (mine !== token) return; }
  }
  // Block 1: the artboards (a select-like list, about seven rows high); block 2: the tree of the chosen one.
  const listHead = el('div', 'panel-head');
  listHead.append(el('span', 'caption', 'Artboards'), el('span', 'grow'), button('artboard', 'New artboard · N', () => newArtboard(), 'mini'));
  const list = el('div', 'board-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Artboards');
  for (const doc of documents()) list.append(boardRow(doc, doc.id === single ? model : null));
  if (!documents().length) list.append(el('div', 'quiet', 'No artboards yet'));
  const treeHead = el('div', 'panel-head');
  const add = button('plus', 'Add element', event => insertMenu(single, { anchor: event.currentTarget }), 'mini');
  add.id = 'layers-add';
  add.disabled = !single;
  // The chosen artboard is already lit right above: naming it here again only costs a line of narrow panel. One word, and the
  // tree below is unambiguous.
  treeHead.append(el('span', 'caption', 'Elements'), el('span', 'grow'), add);
  const body = el('div', 'panel-body');
  body.setAttribute('role', 'tree');
  body.setAttribute('aria-label', 'Elements');
  if (single && model) body.append(tree(documents().find(doc => doc.id === single), model));
  else body.append(el('div', 'quiet', documents().length ? (store.selected.size > 1 ? 'Select one artboard to see its elements' : 'Choose an artboard above, or on the canvas') : ''));
  const focusKey = panel.contains(document.activeElement) && document.activeElement.classList.contains('row-item') ? 'row' : null;
  const scroll = panel.querySelector('.panel-body')?.scrollTop ?? 0;
  const listScroll = panel.querySelector('.board-list')?.scrollTop ?? 0;
  panel.replaceChildren(listHead, list, treeHead, body);
  body.scrollTop = scroll;
  list.scrollTop = listScroll;
  const selected = body.querySelector('.node.on') || list.querySelector('.board.on');
  if (focusKey === 'row') (selected || body.querySelector('.row-item') || list.querySelector('.row-item'))?.focus({ preventScroll: true });
  const selectionKey = `${[...store.selected].join(',')}|${store.node?.nodeIds.join(',') || ''}`;
  if (selectionKey !== lastSelectionKey) {
    // The chosen artboard comes to the top of its list when it is not in view; the chosen element scrolls into its tree.
    const row = list.querySelector('.board.on');
    if (row && (row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)) list.scrollTop = Math.max(0, row.offsetTop - 3);
    body.querySelector('.node.on')?.scrollIntoView({ block: 'nearest' });
  }
  lastSelectionKey = selectionKey;
}

const schedule = (() => { let frame = 0; return () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); }; })();
// The invariant holds the moment the selection changes, not one frame later: a cleared selection returns to the remembered
// artboard here, so nothing that reads the board between two frames can observe "nothing selected while Layers is open".
on('selection', () => { keepAnArtboardSelected(); schedule(); });
on('state', schedule);
on('model', schedule);
on('sidebar', ({ open, tab }) => { if (open && tab === 'layers') { keepAnArtboardSelected(); render(); } });
on('hover-node', hover => {
  for (const row of panel.querySelectorAll('.node.hover')) row.classList.remove('hover');
  if (!hover) return;
  panel.querySelector(`.node[data-document-id="${CSS.escape(hover.documentId)}"][data-node-id="${CSS.escape(hover.nodeId)}"]`)?.classList.add('hover');
});
