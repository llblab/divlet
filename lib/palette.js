import { $, el, icon, keys } from './util.js';
import { native } from './host.js';
import { store, on, documents, descriptor, cachedModel, loadModel, selectArtboards, selectNodes, undo, redo, textChild, parentOf } from './store.js';
import * as canvas from './canvas.js';
import * as actions from './actions.js';
import * as sidebar from './sidebar.js';
import * as help from './help.js';
import * as shortcuts from './shortcuts.js';
import * as project from './project.js';
import * as ask from './ask.js';
import * as clip from './clip.js';

/* Search and commands (Ctrl K): every action of the board, the artboards and the elements
   of the selected artboard in one list; free text can go straight to Pi. */

const scrim = $('#palette');
const dialog = scrim.querySelector('.dialog');
const field = el('label', 'palette-field');
const input = el('input', 'palette-input');
input.type = 'text';
input.placeholder = 'Search commands, artboards and layers…';
input.autocomplete = 'off';
input.spellcheck = false;
input.dataset.key = 'palette';
input.setAttribute('role', 'combobox');
input.setAttribute('aria-expanded', 'true');
input.setAttribute('aria-controls', 'palette-list');
input.setAttribute('aria-label', 'Search commands');
field.append(icon('search'), input, el('kbd', '', 'Esc'));
const list = el('div', 'palette-list');
list.id = 'palette-list';
list.setAttribute('role', 'listbox');
const foot = el('div', 'palette-foot');
foot.append(el('span', '', '↑↓ to move'), el('span', '', `${keys('Enter')} to run`), el('span', 'grow'), el('span', 'palette-count'));
dialog.append(field, list, foot);

let shown = [];
let active = 0;
let returnFocus = null;
const MENU_SPOT = () => ({ x: Math.round(innerWidth / 2 - 110), y: Math.round(Math.min(innerHeight * 0.22, 180)) });

export const isOpen = () => !scrim.hidden;

/* ---- what can be run right now -------------------------------------------- */
function commands() {
  const out = [];
  const add = (group, label, run, extra = {}) => { if (extra.when !== false) out.push({ group, label, run, icon: extra.icon, keys: extra.keys, hint: extra.hint, words: extra.words || '' }); };
  const node = store.node?.nodeIds.length ? store.node : null;
  const single = store.selected.size === 1 ? [...store.selected][0] : null;
  const multi = store.selected.size > 1 ? [...store.selected] : null;
  const agentReady = ask.available();

  if (node) {
    const model = cachedModel(node.documentId);
    const target = model?.nodes[node.nodeIds[0]];
    const one = node.nodeIds.length === 1;
    const isRoot = one && target?.id === model?.rootId;
    const group = 'Element';
    add(group, 'Edit text', () => canvas.editText(node.documentId, target.id, descriptor(node.documentId)?.render ?? 0), { icon: 'text', when: !!(one && model && textChild(model, target)) });
    add(group, 'Select parent', () => actions.selectParent(), { icon: 'parent', keys: keys('Shift+Enter'), when: !!(one && model && parentOf(model, target?.id)) });
    add(group, 'Select first child', () => actions.selectChild(), { icon: 'child', keys: keys('Enter'), when: !!(one && target?.type === 'element' && target.children.some(id => model.nodes[id]?.type === 'element')) });
    add(group, 'Change tag…', () => actions.tagMenu(node.documentId, target.id, MENU_SPOT()), { icon: 'tag', when: !!(one && target?.type === 'element') });
    add(group, target?.reusable ? 'Stop being a component' : 'Make component', () => actions.toggleComponent(node.documentId, target.id), { icon: 'component', words: 'reusable symbol', when: !!(one && target?.type === 'element' && !isRoot) });
    add(group, 'Go to component', () => actions.goToComponent(node.documentId, target.id), { icon: 'component', when: !!(one && target?.type === 'ref') });
    add(group, 'Detach instance', () => actions.detachInstance(node.documentId, target.id), { icon: 'unwrap', when: !!(one && target?.type === 'ref') });
    for (const preset of actions.insertionPresets()) if (preset !== '-') add(group, `Add ${preset[2].toLowerCase()}`, () => actions.insertElement(node.documentId, preset[0], preset[2]), { icon: preset[1], words: 'insert new element', when: store.state?.project?.format !== 'pen' || store.state.project.capabilities.nodeOperations?.includes('insert') });
    add(group, 'Wrap in container', () => actions.wrapNodes(node.documentId, node.nodeIds), { icon: 'wrap', keys: keys('Mod+G'), when: !isRoot });
    add(group, 'Unwrap', () => actions.unwrapNode(node.documentId, target.id), { icon: 'unwrap', keys: keys('Mod+Shift+G'), when: !!(one && !isRoot && target?.type === 'element') });
    add(group, 'Move up', () => actions.moveNode(node.documentId, target.id, -1), { icon: 'arrowUp', keys: keys('Alt+Up'), when: one && !isRoot });
    add(group, 'Move down', () => actions.moveNode(node.documentId, target.id, 1), { icon: 'arrowDown', keys: keys('Alt+Down'), when: one && !isRoot });
    add(group, 'Duplicate', () => actions.duplicateNodes(node.documentId, node.nodeIds), { icon: 'copy', keys: keys('Mod+D'), when: !isRoot });
    add(group, 'Copy', () => clip.copySelection(), { icon: 'copy', keys: keys('Mod+C'), when: !isRoot });
    add(group, 'Cut', () => clip.copySelection({ cut: true }), { icon: 'cut', keys: keys('Mod+X'), when: !isRoot });
    add(group, 'Paste', () => clip.paste(), { icon: 'paste', keys: keys('Mod+V'), when: clip.hasClip() });
    add(group, 'Copy HTML', () => actions.copyHtml(node.documentId, node.nodeIds), { icon: 'code', words: 'export markup code' });
    add(group, 'Zoom to element', () => canvas.fitNode(node.documentId, node.nodeIds[0]), { icon: 'fit', keys: 'F' });
    add(group, 'Copy ID', () => actions.copyText(node.nodeIds[0], 'Node ID copied'), { icon: 'hash', when: one });
    add(group, one ? 'Delete element' : `Delete ${node.nodeIds.length} elements`, () => actions.deleteNodes(node.documentId, node.nodeIds), { icon: 'trash', keys: 'Del', when: !isRoot });
  } else if (single) {
    const doc = descriptor(single);
    const group = 'Artboard';
    add(group, 'Select root element', () => actions.selectChild(), { icon: 'inspect', keys: keys('Enter'), words: 'inspect elements child' });
    add(group, 'Rename', () => actions.renameArtboard(single), { icon: 'pencil', keys: 'R' });
    add(group, 'Expand and browse', () => canvas.openExpanded(single), { icon: 'expand', keys: 'E' });
    add(group, 'Zoom to artboard', () => canvas.fit([single]), { icon: 'fit', keys: 'F' });
    add(group, 'Fit height to content', () => actions.fitHeightToContent(single), { icon: 'hug', when: actions.canFitHeight(single) });
    add(group, 'Rotate', () => actions.rotateArtboard(single), { icon: 'rotate', words: 'swap width height orientation' });
    for (const [name, width] of actions.SIZES) add(group, `Set width to ${width} (${name})`, () => actions.setArtboard(single, { width }, `width ${width}`), { icon: 'artboard', words: 'resize device breakpoint', when: doc?.artboard.width !== width });
    add(group, 'Duplicate artboard', () => actions.duplicateArtboards([single]), { icon: 'copy', keys: keys('Mod+D') });
    add(group, 'Copy artboard', () => clip.copySelection(), { icon: 'copy', keys: keys('Mod+C') });
    add(group, 'Paste into artboard', () => clip.paste(), { icon: 'paste', keys: keys('Mod+V'), when: clip.clipKind() === 'nodes' });
    add(group, 'Copy HTML', () => actions.copyHtml(single), { icon: 'code', words: 'export markup code page' });
    add(group, 'Download HTML', () => actions.downloadHtml(single), { icon: 'download', words: 'export save file' });
    add(group, 'Copy ID', () => actions.copyText(single, 'Artboard ID copied'), { icon: 'hash' });
    add(group, 'Delete artboard', () => actions.deleteArtboards([single]), { icon: 'trash', keys: 'Del' });
  } else if (multi) {
    const group = `${multi.length} artboards`;
    for (const [label, axis, mode, name] of [['Align left edges', 'x', 'start', 'alignL'], ['Align horizontal centers', 'x', 'center', 'alignCH'], ['Align right edges', 'x', 'end', 'alignR'], ['Align top edges', 'y', 'start', 'alignT'], ['Align vertical centers', 'y', 'center', 'alignCV'], ['Align bottom edges', 'y', 'end', 'alignB']]) add(group, label, () => actions.alignArtboards(multi, axis, mode), { icon: name });
    add(group, 'Distribute horizontally', () => actions.distributeArtboards(multi, 'x'), { icon: 'distH', when: multi.length > 2 });
    add(group, 'Distribute vertically', () => actions.distributeArtboards(multi, 'y'), { icon: 'distV', when: multi.length > 2 });
    add(group, 'Tidy up in a row', () => actions.tidyArtboards(multi), { icon: 'tidy' });
    add(group, 'Zoom to selection', () => canvas.fit(multi), { icon: 'fit', keys: 'F' });
    add(group, 'Duplicate artboards', () => actions.duplicateArtboards(multi), { icon: 'copy', keys: keys('Mod+D') });
    add(group, `Delete ${multi.length} artboards`, () => actions.deleteArtboards(multi), { icon: 'trash', keys: 'Del' });
  }

  const board = 'Board';
  const head = store.state?.history;
  add(board, 'Ask the agent…', () => ask.toggle(true), { icon: 'sparkle', keys: 'A', when: agentReady, words: 'agent request prompt about selection pi' });
  add(board, 'New artboard', () => actions.newArtboard(), { icon: 'artboard', keys: 'N' });
  for (const [name, width, height] of actions.SIZES) add(board, `New ${name.toLowerCase()} artboard`, () => actions.newArtboard({ width, height, name }), { icon: 'artboard', hint: `${width} × ${height}`, words: 'create device' });
  add(board, head?.undoLabel ? `Undo ${head.undoLabel}` : 'Undo', () => undo(), { icon: 'undo', keys: keys('Mod+Z'), when: !!head?.canUndo });
  add(board, head?.redoLabel ? `Redo ${head.redoLabel}` : 'Redo', () => redo(), { icon: 'redo', keys: keys('Mod+Shift+Z'), when: !!head?.canRedo });
  add(board, 'Paste artboards', () => clip.paste(), { icon: 'paste', keys: keys('Mod+V'), when: clip.clipKind() === 'artboards' && !store.selected.size });
  add(board, 'Fit everything', () => canvas.fit(null), { icon: 'fit', keys: keys('Shift+1'), when: documents().length > 0, words: 'zoom' });
  add(board, 'Zoom to 100%', () => canvas.zoomTo(1), { icon: 'search', keys: '0' });
  add(board, 'Zoom in', () => canvas.zoomAt(1.25, undefined, undefined, { animate: true }), { icon: 'plus', keys: '+' });
  add(board, 'Zoom out', () => canvas.zoomAt(1 / 1.25, undefined, undefined, { animate: true }), { icon: 'minus', keys: '−' });
  add(board, 'Select all artboards', () => selectArtboards(documents().map(doc => doc.id)), { icon: 'select', keys: keys('Mod+A'), when: documents().length > 0 });
  add(board, 'Tidy up all artboards', () => actions.tidyArtboards(documents().map(doc => doc.id)), { icon: 'tidy', when: documents().length > 1 });
  add(board, 'Select tool', () => canvas.setMode('select'), { icon: 'select', keys: 'V', words: 'mode move artboards elements inspect' });
  add(board, 'Interact with the page', () => canvas.setMode('interact'), { icon: 'play', keys: 'P', words: 'tool mode click page play' });
  add(board, sidebar.isOpen('layers') ? 'Hide layers' : 'Show layers', () => sidebar.toggle('layers'), { icon: 'layers', keys: 'L' });
  add(board, sidebar.isOpen('activity') ? 'Hide history' : 'Show history', () => sidebar.toggle('activity'), { icon: 'chat', keys: 'H', words: 'activity log changes replies' });
  add(board, 'Open the site', () => window.open(store.state.site.url, '_blank', 'noopener'), { icon: 'site', when: !!store.state?.site, words: 'markdown pages' });
  add(board, 'Open project…', () => project.show('open'), { icon: 'folder', keys: keys('Mod+O'), words: 'switch folder load', when: native });
  add(board, 'Save a copy as…', () => project.show('save'), { icon: 'download', keys: keys('Mod+Shift+S'), words: 'save as copy export project folder', when: native && project.canShowCopy() });
  for (const percent of help.UI_SIZES) add(board, `Interface size ${percent}%`, () => help.setUiSize(percent), { icon: 'search', words: 'scale zoom text bigger smaller ui' });
  add(board, 'Keyboard shortcuts', () => shortcuts.toggle(true), { icon: 'keyboard', keys: '?', words: 'keys hotkeys help' });
  add(board, 'Settings', () => help.toggle(true), { icon: 'gear', keys: keys('Mod') + ' ,', words: 'preferences theme interface size' });
  for (const [value, name, label] of [['auto', 'auto', 'Theme: auto'], ['light', 'sun', 'Theme: light'], ['dark', 'moon', 'Theme: dark']]) add(board, label, () => help.setTheme(value), { icon: name, words: 'appearance color scheme' });
  return out;
}

function artboardItems() {
  return documents().map(doc => ({ group: 'Artboards', label: doc.name || doc.id, hint: `${Math.round(doc.artboard.width)} × ${Math.round(doc.artboard.height)}`, icon: 'artboard', words: doc.id, run: () => { selectArtboards([doc.id]); canvas.reveal(doc.id); } }));
}

/** Open an element everywhere at once: on the canvas (its artboard comes into view) and in the Layers tree. */
function openElement(documentId, nodeId) {
  if (store.mode !== 'select') canvas.setMode('select');
  if (!store.selected.has(documentId) || store.selected.size !== 1) selectArtboards([documentId]);
  canvas.reveal(documentId);
  selectNodes(documentId, [nodeId], { reveal: true });
  sidebar.show('layers');
}

/** Elements of every artboard whose model is loaded (the palette loads them when it opens). */
function elementItems() {
  const out = [];
  const many = documents().length > 1;
  for (const doc of documents()) {
    const model = cachedModel(doc.id);
    if (!model) continue;
    let count = 0;
    for (const node of Object.values(model.nodes)) {
      if (node.type !== 'element' && node.type !== 'ref') continue;
      const where = many ? `${doc.name || doc.id} › #${node.id}` : `#${node.id}`;
      const run = () => openElement(doc.id, node.id);
      if (node.type === 'ref') { out.push({ group: 'Elements', label: `instance · ${node.metadata?.name || node.ref}`, hint: where, icon: 'instance', words: `${node.id} ${node.ref} component ${doc.name}`, run }); continue; }
      const text = textChild(model, node)?.content.replace(/\s+/g, ' ').trim() ?? '';
      const name = typeof node.metadata?.name === 'string' ? node.metadata.name : '';
      out.push({ group: 'Elements', label: `${node.tag}${name ? ` · ${name}` : text ? ` · ${text.slice(0, 60)}` : ''}`, hint: where, icon: 'inspect', words: `${node.id} ${node.className} ${text} ${doc.name}`, run });
      if (++count >= 600) break;
    }
  }
  return out;
}

/* ---- matching ------------------------------------------------------------- */
function score(query, item) {
  const text = `${item.label} ${item.hint || ''} ${item.words} ${item.group}`.toLowerCase();
  const label = item.label.toLowerCase();
  let total = 0;
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = label.indexOf(word);
    if (at >= 0) { total += 40 - Math.min(at, 20) + (at === 0 || /[\s·(“#<-]/.test(label[at - 1]) ? 25 : 0); continue; }
    if (text.includes(word)) { total += 12; continue; }
    let from = 0;
    let gained = 0;
    for (const ch of word) {
      const found = label.indexOf(ch, from);
      if (found < 0) return 0;
      gained += found === from ? 2 : 1;
      from = found + 1;
    }
    total += gained;
  }
  return total;
}

function build(query) {
  const all = [...commands(), ...artboardItems(), ...elementItems()];
  const trimmed = query.trim();
  let result;
  if (!trimmed) {
    const selectionGroup = all.filter(item => item.group !== 'Board' && item.group !== 'Artboards' && item.group !== 'Elements');
    result = [...selectionGroup.slice(0, 14), ...all.filter(item => item.group === 'Board'), ...all.filter(item => item.group === 'Artboards')];
  }
  let strong = false;
  if (trimmed) {
    const scored = all.map(item => ({ item, value: score(trimmed, item) })).filter(entry => entry.value > 0).sort((a, b) => b.value - a.value).slice(0, 60);
    result = scored.map(entry => entry.item);
    // Every word found in the best label: that command is what was meant.
    strong = !!scored[0] && scored[0].value >= trimmed.split(/\s+/).length * 30;
  }
  if (trimmed && ask.available()) {
    const askItem = { group: 'Agent', label: `Ask the agent: “${trimmed.length > 70 ? `${trimmed.slice(0, 69)}…` : trimmed}”`, icon: 'sparkle', keys: keys('Mod+Enter'), words: 'pi', ask: true, run: () => ask.submit(trimmed) };
    const sentence = trimmed.split(/\s+/).length >= 3;
    if (!result.length || (sentence && !strong)) result.unshift(askItem); else result.push(askItem);
  }
  return result;
}

function paint() {
  const query = input.value;
  shown = build(query);
  active = Math.min(active, Math.max(0, shown.length - 1));
  list.replaceChildren();
  let group = null;
  shown.forEach((item, index) => {
    if (!query.trim() && item.group !== group) { group = item.group; list.append(el('div', 'palette-group', group)); }
    const row = el('button', `palette-item${index === active ? ' on' : ''}${item.ask ? ' pal-ask' : ''}`);
    row.type = 'button';
    row.id = `palette-item-${index}`;
    row.tabIndex = -1;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === active));
    row.append(icon(item.icon || 'chevron'), el('span', 'palette-label', item.label));
    if (item.hint) row.append(el('span', 'palette-hint', item.hint));
    if (query.trim() && !item.ask) row.append(el('span', 'palette-tag', item.group));
    if (item.keys) row.append(el('span', 'menu-keys', item.keys));
    row.addEventListener('pointermove', () => { if (active !== index) { active = index; mark(); } });
    row.addEventListener('click', () => run(index));
    list.append(row);
  });
  if (!shown.length) list.append(el('div', 'quiet', ask.available() ? 'Nothing found. Type a full sentence to ask Pi.' : 'Nothing found.'));
  foot.querySelector('.palette-count').textContent = shown.length ? `${shown.length} result${shown.length === 1 ? '' : 's'}` : '';
  mark();
}

function mark() {
  for (const row of list.querySelectorAll('.palette-item')) {
    const on = row.id === `palette-item-${active}`;
    row.classList.toggle('on', on);
    row.setAttribute('aria-selected', String(on));
    if (on) row.scrollIntoView({ block: 'nearest' });
  }
  input.setAttribute('aria-activedescendant', shown.length ? `palette-item-${active}` : '');
}

function run(index) {
  const item = shown[index];
  if (!item) return;
  toggle(false, { restore: !item.ask });
  requestAnimationFrame(() => { try { const result = item.run(); result?.catch?.(() => {}); } catch (error) { console.error(error); } });
}

export function toggle(open = scrim.hidden, { restore = true } = {}) {
  if (open === !scrim.hidden) { if (open) input.focus(); return; }
  if (open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.value = '';
    active = 0;
    scrim.hidden = false;
    paint();
    input.focus();
    // Every artboard's elements are searchable: load the models that are not here yet.
    for (const doc of documents()) if (!cachedModel(doc.id)) loadModel(doc.id).then(() => { if (isOpen()) paint(); }).catch(() => {});
  } else {
    scrim.hidden = true;
    if (restore) {
      if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus({ preventScroll: true });
      else $('#viewport').focus({ preventScroll: true });
    }
  }
}

input.addEventListener('input', () => { active = 0; paint(); });
input.addEventListener('keydown', event => {
  event.stopPropagation();
  const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[event.key];
  if (step) { event.preventDefault(); if (shown.length) { active = Math.max(0, Math.min(shown.length - 1, active + step)); mark(); } }
  else if (event.key === 'Home' && !input.value) { event.preventDefault(); active = 0; mark(); }
  else if (event.key === 'End' && !input.value) { event.preventDefault(); active = Math.max(0, shown.length - 1); mark(); }
  else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); const index = shown.findIndex(item => item.ask); if (index >= 0) run(index); }
  else if (event.key === 'Enter') { event.preventDefault(); run(active); }
  else if (event.key === 'Escape') { event.preventDefault(); toggle(false); }
  else if (event.key === 'Tab') event.preventDefault();
});
scrim.addEventListener('pointerdown', event => { if (event.target === scrim) toggle(false); });
scrim.addEventListener('keydown', event => event.stopPropagation());
on('state', () => { if (isOpen()) paint(); });
