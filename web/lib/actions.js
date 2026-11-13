import { keys } from './util.js';
import { store, emit, on, documents, descriptor, edit, commit, undo, toast, newGroup, selectArtboards, selectNodes, cachedModel, freshModel, parentOf, canContain, textChild, request, apiUrl } from './store.js';
import * as canvas from './canvas.js';
import { openMenu } from './menu.js';
import * as clip from './clip.js';
import { newArtboard, duplicateArtboards, deleteArtboards } from './artboards.js';
import { components as componentSource } from './host.js';
export { newArtboard, duplicateArtboards, deleteArtboards };

/* Command facade for the toolbar, keyboard, context menus, inspector and layers.
   Artboard lifecycle commands also serve clipboard without depending on this facade. */

export const SIZES = [['Phone', 390, 844], ['Tablet', 768, 1024], ['Laptop', 1280, 800], ['Desktop', 1440, 900]];
export const PRESETS = [
  ['heading', 'heading', 'Heading'], ['text', 'text', 'Paragraph'], ['button', 'button', 'Button'], ['link', 'link', 'Link'],
  ['image', 'image', 'Image'], ['list', 'list', 'List'], '-',
  ['div', 'box', 'Box'], ['row', 'row', 'Row'], ['grid', 'grid', 'Grid'], ['section', 'artboard', 'Section'],
];
export const insertionPresets = () => PRESETS;
const TAGS = [
  ['Structure', ['div', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside']],
  ['Text', ['h1', 'h2', 'h3', 'h4', 'p', 'span', 'strong', 'em', 'small', 'blockquote', 'code']],
  ['Interactive', ['a', 'button', 'label']],
  ['Lists', ['ul', 'ol', 'li', 'figure', 'figcaption']],
];
const TEXT_PRESETS = new Set(['heading', 'text', 'button', 'link']);
const STRUCTURE = new Set('div section main article header footer nav aside form figure fieldset details dialog ul ol menu dl table tbody thead tfoot tr hgroup search'.split(' '));
const quiet = promise => promise.catch(() => null);
export const modelOf = id => freshModel(id);
const nameOf = id => descriptor(id)?.name || id;

export async function copyText(text, message = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(`${message} · ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`); }
  catch { toast('The clipboard is not available here'); }
}

/** Clean HTML of elements (built from the model) or of a whole artboard (with its compiled CSS). */
export async function copyHtml(documentId, nodeIds) {
  try {
    let text;
    if (nodeIds?.length) {
      const model = await modelOf(documentId);
      const ids = nodeIds.filter(id => model.nodes[id]);
      text = clip.htmlOf(model, ids);
    } else text = (await request(`api/export/${encodeURIComponent(documentId)}`)).html;
    if (!document.hasFocus()) document.querySelector('#viewport')?.focus({ preventScroll: true });
    await navigator.clipboard.writeText(text);
    toast(nodeIds?.length ? 'HTML copied' : `Page HTML copied · ${Math.max(1, Math.round(text.length / 1024))} KB with CSS`);
  } catch (error) { toast(error?.name === 'NotAllowedError' ? 'The clipboard is not available here' : error.message); }
}

/** Save an artboard as a standalone HTML file. */
export function downloadHtml(documentId) {
  const link = document.createElement('a');
  link.href = apiUrl(`api/export/${encodeURIComponent(documentId)}?download=1`);
  const fileName = descriptor(documentId)?.htmlPath?.split(/[\\/]/).at(-1) || `${documentId}.html`;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  toast(`Downloading ${fileName}`);
}



/* ---- artboards ------------------------------------------------------------ */
export const renameArtboard = id => { if (descriptor(id)) { canvas.reveal(id); emit('rename-artboard', id); } };
export const setArtboard = (id, patch, label) => quiet(commit(id, { artboard: patch }, { label }));

export function canFitHeight(id) {
  const doc = descriptor(id);
  const seen = store.observations.get(id);
  return !!(doc && seen?.render === doc.render && seen.contentHeight > 0 && Math.abs(seen.contentHeight - canvas.rectOf(doc).height) > 1);
}
export function fitHeightToContent(id) {
  const seen = store.observations.get(id);
  if (!canFitHeight(id)) { toast(seen?.contentHeight ? 'The artboard already fits its content' : 'Waiting for the page to be measured'); return; }
  return setArtboard(id, { height: Math.min(16384, seen.contentHeight) }, 'fit height to content');
}
export function rotateArtboard(id) {
  const doc = descriptor(id), a = doc && canvas.rectOf(doc);
  if (a) return setArtboard(id, { width: a.height, height: a.width }, 'rotate artboard');
}

export function alignArtboards(ids, axis, mode) {
  const docs = ids.map(descriptor).filter(Boolean).map(doc => ({ ...doc, artboard: canvas.rectOf(doc) }));
  if (docs.length < 2) return;
  const group = newGroup();
  const size = axis === 'x' ? 'width' : 'height';
  const start = Math.min(...docs.map(d => d.artboard[axis]));
  const end = Math.max(...docs.map(d => d.artboard[axis] + d.artboard[size]));
  for (const doc of docs) {
    const a = doc.artboard;
    const target = mode === 'start' ? start : mode === 'end' ? end - a[size] : Math.round((start + end) / 2 - a[size] / 2);
    if (target !== a[axis]) quiet(commit(doc.id, { artboard: { [axis]: target } }, { label: `align ${docs.length} artboards`, group }));
  }
}

export function distributeArtboards(ids, axis) {
  const size = axis === 'x' ? 'width' : 'height';
  const docs = ids.map(descriptor).filter(Boolean).map(doc => ({ ...doc, artboard: canvas.rectOf(doc) })).sort((a, b) => a.artboard[axis] - b.artboard[axis]);
  if (docs.length < 3) { toast('Select at least three artboards to distribute'); return; }
  const first = docs[0].artboard[axis];
  const last = docs.at(-1).artboard[axis] + docs.at(-1).artboard[size];
  const gap = (last - first - docs.reduce((sum, d) => sum + d.artboard[size], 0)) / (docs.length - 1);
  const group = newGroup();
  let cursor = first;
  for (const doc of docs) {
    const target = Math.round(cursor);
    if (target !== doc.artboard[axis]) quiet(commit(doc.id, { artboard: { [axis]: target } }, { label: `distribute ${docs.length} artboards`, group }));
    cursor += doc.artboard[size] + gap;
  }
}

/** Lay artboards out in one row, left to right, top-aligned with an even gap. */
export function tidyArtboards(ids = []) {
  const docs = (ids.length > 1 ? ids.map(descriptor) : documents()).filter(Boolean).map(doc => ({ ...doc, artboard: canvas.rectOf(doc) })).sort((a, b) => a.artboard.x - b.artboard.x || a.artboard.y - b.artboard.y);
  if (docs.length < 2) return;
  const group = newGroup();
  let x = Math.min(...docs.map(d => d.artboard.x));
  const y = Math.min(...docs.map(d => d.artboard.y));
  for (const doc of docs) {
    const a = doc.artboard;
    if (a.x !== x || a.y !== y) quiet(commit(doc.id, { artboard: { x, y } }, { label: `tidy ${docs.length} artboards`, group }));
    x += a.width + 80;
  }
}

/** Visual reading order: rows top to bottom, then left to right. */
function readingOrder() {
  return [...documents()].sort((a, b) => {
    const rowA = Math.round(a.artboard.y / 200);
    const rowB = Math.round(b.artboard.y / 200);
    return rowA - rowB || a.artboard.x - b.artboard.x;
  });
}

export function cycleArtboards(step) {
  const list = readingOrder();
  if (!list.length) return;
  const current = store.selected.size ? list.findIndex(doc => store.selected.has(doc.id)) : -1;
  const next = list[current < 0 ? (step > 0 ? 0 : list.length - 1) : (current + step + list.length) % list.length];
  selectArtboards([next.id]);
  canvas.reveal(next.id);
}

/* ---- nodes ---------------------------------------------------------------- */
const selection = () => (store.node?.nodeIds.length ? store.node : null);

export async function deleteNodes(documentId, ids) {
  const model = await modelOf(documentId);
  const valid = ids.filter(id => model.nodes[id] && id !== model.rootId);
  if (!valid.length) { toast('The page root cannot be deleted. Delete the artboard instead.'); return; }
  const result = await quiet(edit(documentId, { type: 'remove', ids: valid }, { label: valid.length > 1 ? `delete ${valid.length} elements` : undefined }));
  if (result) {
    selectNodes(documentId, []);
    toast(valid.length > 1 ? `${valid.length} elements deleted` : 'Element deleted', { label: 'Undo', run: () => undo() });
  }
}

export async function duplicateNodes(documentId, ids) {
  const model = await modelOf(documentId);
  const valid = ids.filter(id => model.nodes[id] && id !== model.rootId);
  if (!valid.length) { toast('The page root cannot be duplicated. Duplicate the artboard instead.'); return; }
  const result = await quiet(edit(documentId, { type: 'duplicate', ids: valid }));
  if (result?.ids?.length) selectNodes(documentId, result.ids, { reveal: true });
}

export async function moveNode(documentId, id, direction) {
  const derive = model => {
    const parent = parentOf(model, id);
    if (!parent) return null;
    const index = parent.children.indexOf(id) + direction;
    if (index < 0 || index >= parent.children.length) { toast(direction < 0 ? 'Already first in its container' : 'Already last in its container'); return null; }
    return { type: 'move', id, parentId: parent.id, index };
  };
  const op = derive;
  if (op) await quiet(edit(documentId, op, { label: direction < 0 ? `move ${id} up` : `move ${id} down` }));
}

export async function wrapNodes(documentId, ids, spec) {
  const result = await quiet(edit(documentId, { type: 'wrap', ids, ...(spec === undefined ? {} : { spec }) }));
  if (result?.ids?.length) selectNodes(documentId, result.ids);
}

export async function unwrapNode(documentId, id) {
  const result = await quiet(edit(documentId, { type: 'unwrap', id }));
  if (result) selectNodes(documentId, result.ids.slice(0, 50));
}

/**
 * Text typed into an instance: an override on that instance. When the element holds one text
 * node, the override targets that text node (and drops an older element-level text override).
 */
export async function overrideText(documentId, instance, address, content) {
  try {
    const model = await modelOf(documentId);
    const ref = model.nodes[instance];
    if (ref?.type !== 'ref') return;
    const segments = address.split('/');
    let frameId = ref.ref.includes('/') ? ref.ref.split('/')[0] : documentId;
    let component = await modelOf(frameId);
    for (const segment of segments.slice(0, -1)) {
      const nested = component.nodes[segment];
      if (nested?.type !== 'ref') { component = null; break; }
      frameId = nested.ref.includes('/') ? nested.ref.split('/')[0] : frameId;
      component = await modelOf(frameId);
    }
    const target = component?.nodes[segments.at(-1)];
    const only = target?.type === 'element' && target.children.length === 1 && component.nodes[target.children[0]]?.type === 'text' ? target.children[0] : null;
    const prefix = segments.slice(0, -1).map(segment => `${segment}/`).join('');
    const descendants = only ? { [`${prefix}${only}`]: { content }, ...(ref.descendants[address]?.text !== undefined ? { [address]: { text: null } } : {}) } : { [address]: { text: content } };
    await commit(documentId, { nodes: { [instance]: { descendants } } }, { label: `override text of ${instance}` });
  } catch { /* reported by commit */ }
}

/** Mark an element as a component (reusable) or turn it back into a plain element. */
export async function toggleComponent(documentId, id) {
  const model = await modelOf(documentId);
  const node = model.nodes[id];
  if (node?.type !== 'element') return;
  const result = await quiet(commit(documentId, { nodes: { [id]: { reusable: node.reusable ? null : true } } }, { label: node.reusable ? `${id} is no longer a component` : `make ${id} a component` }));
  if (result) toast(node.reusable ? 'No longer a component' : `“${node.metadata?.name || id}” is now a component — insert it anywhere from Add element`);
}

/** Insert an instance of a component next to (or inside) the selection. */
export async function insertInstance(documentId, ref, name) {
  return insertElement(documentId, { ref }, name || 'instance');
}

/** Replace an instance by editable copies of its elements. */
export async function detachInstance(documentId, id) {
  const result = await quiet(edit(documentId, { type: 'detach', id }, { label: `detach ${id}` }));
  if (result) { selectNodes(documentId, [id], { reveal: true }); toast('Detached — the elements are now independent of the component'); }
}

/** Select the component an instance comes from. */
export async function goToComponent(documentId, id) {
  const model = await modelOf(documentId);
  const ref = model.nodes[id];
  if (ref?.type !== 'ref') return;
  const [frameId, nodeId] = ref.ref.includes('/') ? ref.ref.split('/') : [documentId, ref.ref];
  if (!descriptor(frameId)) { toast(`The component’s frame ${frameId} is missing`); return; }
  if (store.mode !== 'select') canvas.setMode('select');
  selectNodes(frameId, [nodeId], { reveal: true });
  canvas.reveal(frameId);
}

export const setTag = (documentId, id, tag) => quiet(commit(documentId, { nodes: { [id]: { tag } } }, { label: `change ${id} to <${tag}>` }));
export const renameLayer = (documentId, id, name) => quiet(commit(documentId, { nodes: { [id]: { metadata: { name: name || null } } } }, { label: name ? `name ${id} “${name}”` : `clear name of ${id}` }));

/** Where a new element goes: inside the selected container, otherwise right after the selected element. */
export async function insertElement(documentId, spec, label) {
  const selected = store.node?.documentId === documentId ? store.node.nodeIds : [];
  const selectedId = selected.at(-1);
  const model = await modelOf(documentId);
  const targetId = store.node?.documentId === documentId ? store.node.nodeIds.at(-1) : null;
  let target = targetId ? model.nodes[targetId] : null;
  if (target?.type === 'text') target = parentOf(model, target.id);
  let op;
  if (!target || target.id === model.rootId) op = { type: 'insert', parentId: model.rootId, spec };
  else if (canContain(target) && STRUCTURE.has(target.tag)) op = { type: 'insert', parentId: target.id, spec };
  else op = { type: 'insert', after: target.id, spec };
  const result = await quiet(edit(documentId, op, { label: `add ${label.toLowerCase()}` }));
  if (!result?.ids?.length) return;
  if (store.mode !== 'select') canvas.setMode('select');
  selectNodes(documentId, result.ids, { reveal: true });
  if (TEXT_PRESETS.has(spec)) canvas.editText(documentId, result.ids[0], result.render);
  return result;
}

export function selectParent() {
  const current = selection();
  if (!current) return false;
  const model = cachedModel(current.documentId);
  if (!model) return false;
  const parent = parentOf(model, current.nodeIds[0]);
  selectNodes(current.documentId, parent ? [parent.id] : [], { reveal: true });
  return true;
}

/** Select the shown artboard's root; a late read cannot take selection back after navigation. */
export async function selectRoot(id) {
  if (store.selected.size !== 1 || !store.selected.has(id) || selection()) return;
  let changed = false;
  const stop = on('selection', () => { changed = true; });
  try {
    const model = await modelOf(id);
    if (changed || !descriptor(id) || model !== cachedModel(id) || store.selected.size !== 1 || !store.selected.has(id) || selection() || store.expanded) return;
    if (store.mode !== 'select') canvas.setMode('select');
    selectNodes(id, [model.rootId]);
  } catch (error) { if (!changed && descriptor(id)) toast(error.message); }
  finally { stop(); }
}

/** Into the selection: its first child element; with `edit`, text-only elements start text editing instead. */
export async function selectChild({ edit: editText = true } = {}) {
  const current = selection();
  if (current) {
    const model = await modelOf(current.documentId);
    const node = model.nodes[current.nodeIds[0]];
    const child = node?.type === 'element' ? node.children.find(id => model.nodes[id]?.type === 'element') : null;
    if (child) selectNodes(current.documentId, [child], { reveal: true });
    else if (editText && textChild(model, node)) canvas.editText(current.documentId, node.id, descriptor(current.documentId)?.render ?? 0);
    return;
  }
  if (store.selected.size !== 1) return;
  return selectRoot([...store.selected][0]);
}

/**
 * Keyboard flow while editing text: Tab / Shift+Tab save and select the next / previous element;
 * Enter in a list item saves it and starts the next one.
 */
export async function stepEdit({ documentId, dir, create, nodeId }) {
  if (create && nodeId) {
    const result = await quiet(edit(documentId, { type: 'insert', after: nodeId, spec: { tag: 'li', text: 'New item' } }, { label: 'add list item' }));
    if (!result?.ids?.length) return;
    selectNodes(documentId, result.ids, { reveal: true });
    canvas.editText(documentId, result.ids[0], result.render);
    return;
  }
  await selectSibling(dir);
}

export async function selectSibling(step) {
  const current = selection();
  if (!current) { cycleArtboards(step); return; }
  const model = await modelOf(current.documentId);
  const parent = parentOf(model, current.nodeIds[0]);
  if (!parent) return;
  const siblings = parent.children.filter(id => model.nodes[id]?.type === 'element');
  const index = siblings.indexOf(current.nodeIds[0]);
  const next = siblings[(index + step + siblings.length) % siblings.length];
  if (next) selectNodes(current.documentId, [next], { reveal: true });
}

/* ---- menus ---------------------------------------------------------------- */
export async function insertMenu(documentId, position) {
  if (!documentId) { toast('Select an artboard first'); return; }
  let components = [];
  try { if (componentSource) components = (await componentSource.list()).components; } catch {}
  openMenu([
    { heading: store.node?.documentId === documentId ? 'Add after or inside the selection' : `Add to “${nameOf(documentId)}”` },
    ...insertionPresets().map(item => (item === '-' ? '-' : { label: item[2], icon: item[1], run: () => insertElement(documentId, item[0], item[2]) })),
    components.length > 0 && '-',
    components.length > 0 && { heading: 'Components' },
    ...components.slice(0, 30).map(component => ({ label: component.name, icon: 'component', hint: component.ref, keys: component.frameId === documentId ? undefined : nameOf(component.frameId), run: () => insertInstance(documentId, component.frameId === documentId ? component.nodeId : component.ref, component.name) })),
  ], { ...position, label: 'Add element', className: 'menu-insert' });
}

export function tagMenu(documentId, id, position) {
  const node = cachedModel(documentId)?.nodes[id];
  if (!node || node.type !== 'element') return;
  const items = [];
  for (const [heading, tags] of TAGS) {
    items.push('-', { heading });
    for (const tag of tags) items.push({ label: `<${tag}>`, checked: tag === node.tag, run: () => tag !== node.tag && setTag(documentId, id, tag) });
  }
  openMenu(items, { ...position, label: 'Change tag', className: 'menu-tags' });
}

/** The actions on an artboard (or on the selected artboards): the context menu lists them all, the inspector's bar fits as many as it can. */
export function artboardItems(id) {
  const ids = store.selected.has(id) ? [...store.selected] : [id];
  const one = ids.length === 1;
  return [
    one && { label: 'Fit height to content', icon: 'hug', disabled: !canFitHeight(id), run: () => fitHeightToContent(id) },
    one && { label: 'Rotate', icon: 'rotate', run: () => rotateArtboard(id) },
    !one && { label: 'Tidy up in a row', icon: 'tidy', run: () => tidyArtboards(ids) },
    '-',
    { label: 'Duplicate', icon: 'copy', keys: keys('Mod+D'), run: () => duplicateArtboards(ids) },
    { label: 'Copy', icon: 'copy', keys: keys('Mod+C'), run: () => { selectArtboards(ids); clip.copySelection(); } },
    one && clip.clipKind() === 'nodes' && { label: 'Paste into', icon: 'paste', keys: keys('Mod+V'), run: () => { selectArtboards([id]); return clip.paste(); } },
    '-',
    one && { label: 'Copy HTML', icon: 'code', run: () => copyHtml(id) },
    one && { label: 'Download HTML', icon: 'download', run: () => downloadHtml(id) },
    one && { label: 'Copy ID', icon: 'hash', run: () => copyText(id, 'Artboard ID copied') },
    '-',
    { label: one ? 'Delete artboard' : `Delete ${ids.length} artboards`, icon: 'trash', keys: 'Del', danger: true, run: () => deleteArtboards(ids) },
  ];
}

export function artboardMenu(id, position) {
  openMenu(artboardItems(id), { ...position, label: 'Artboard' });
}

export async function nodeMenu(documentId, position) {
  const current = selection();
  if (!current || current.documentId !== documentId) return;
  const model = await modelOf(documentId);
  const ids = current.nodeIds.filter(id => model.nodes[id]);
  if (!ids.length) return;
  const node = model.nodes[ids[0]];
  const one = ids.length === 1;
  const isRoot = one && ids[0] === model.rootId;
  const parent = parentOf(model, ids[0]);
  const siblings = parent ? parent.children : [];
  const index = siblings.indexOf(ids[0]);
  const parents = new Set(ids.map(id => parentOf(model, id)?.id));
  openMenu([
    one && parent && { label: 'Select parent', icon: 'parent', keys: keys('Shift+Enter'), run: selectParent },
    one && node.type === 'element' && node.children.some(id => model.nodes[id]?.type === 'element') && { label: 'Select first child', icon: 'child', keys: keys('Enter'), run: selectChild },
    one && textChild(model, node) && { label: 'Edit text', icon: 'text', hint: 'Or double-click the text', run: () => canvas.editText(documentId, node.id, descriptor(documentId)?.render ?? 0) },
    { label: 'Add element…', icon: 'plus', run: () => insertMenu(documentId, position) },
    '-',
    one && node.type === 'element' && !isRoot && { label: node.reusable ? 'Stop being a component' : 'Make component', icon: 'component', run: () => toggleComponent(documentId, node.id) },
    one && node.type === 'ref' && { label: 'Go to component', icon: 'component', run: () => goToComponent(documentId, node.id) },
    one && node.type === 'ref' && Object.keys(node.descendants || {}).length > 0 && { label: 'Reset overrides', icon: 'undo', run: () => quiet(commit(documentId, { nodes: { [node.id]: { descendants: null } } }, { label: `reset overrides of ${node.id}` })) },
    '-',
    !isRoot && parents.size === 1 && { label: one ? 'Wrap in container' : `Wrap ${ids.length} in container`, icon: 'wrap', keys: keys('Mod+G'), hint: store.state?.project?.format === 'pen' ? 'An explicit PEN frame spec is required; automatic grouping is unavailable.' : undefined, run: () => wrapNodes(documentId, ids) },
    one && !isRoot && node.type === 'element' && { label: 'Unwrap', icon: 'unwrap', keys: keys('Mod+Shift+G'), run: () => unwrapNode(documentId, node.id) },
    one && !isRoot && { label: 'Move up', icon: 'arrowUp', keys: keys('Alt+Up'), disabled: index <= 0, run: () => moveNode(documentId, ids[0], -1) },
    one && !isRoot && { label: 'Move down', icon: 'arrowDown', keys: keys('Alt+Down'), disabled: index >= siblings.length - 1, run: () => moveNode(documentId, ids[0], 1) },
    '-',
    !isRoot && { label: 'Duplicate', icon: 'copy', keys: keys('Mod+D'), run: () => duplicateNodes(documentId, ids) },
    !isRoot && { label: 'Copy', icon: 'copy', keys: keys('Mod+C'), run: () => clip.copySelection() },
    !isRoot && { label: 'Cut', icon: 'cut', keys: keys('Mod+X'), run: () => clip.copySelection({ cut: true }) },
    clip.hasClip() && { label: 'Paste', icon: 'paste', keys: keys('Mod+V'), run: () => clip.paste() },
    '-',
    { label: 'Copy HTML', icon: 'code', run: () => copyHtml(documentId, ids) },
    one && { label: 'Copy ID', icon: 'hash', run: () => copyText(ids[0], 'Node ID copied') },
    '-',
    !isRoot && { label: one ? 'Delete' : `Delete ${ids.length} elements`, icon: 'trash', keys: 'Del', danger: true, run: () => deleteNodes(documentId, ids) },
  ], { ...position, label: 'Element' });
}

export function canvasMenu(position, world) {
  const all = documents().map(doc => doc.id);
  openMenu([
    { label: 'New artboard here', icon: 'artboard', keys: 'N', run: () => newArtboard({ x: world.x, y: world.y }) },
    clip.clipKind() === 'artboards' && { label: 'Paste artboards', icon: 'paste', keys: keys('Mod+V'), run: () => { selectArtboards([]); return clip.paste(); } },
    '-',
    { label: 'Zoom to fit all', icon: 'fit', keys: keys('Shift+1'), disabled: !all.length, run: () => canvas.fit(null) },
    { label: 'Zoom to 100%', icon: 'search', keys: '0', run: () => canvas.zoomTo(1) },
    { label: 'Select all artboards', icon: 'select', keys: keys('Mod+A'), disabled: !all.length, run: () => selectArtboards(all) },
    { label: 'Tidy up all artboards', icon: 'tidy', disabled: all.length < 2, run: () => tidyArtboards(all) },
    '-',
    { label: 'Search and commands', icon: 'command', keys: keys('Mod+K'), run: () => emit('palette', true) },
    { label: 'Keyboard shortcuts', icon: 'keyboard', keys: '?', run: () => emit('shortcuts', true) },
  ], { ...position, label: 'Canvas' });
}

/**
 * A grip dragged on the canvas drops an element before or after another one: the same container reorders, a different one moves it.
 * The new index counts the container's children without the moved element, as the move operation expects.
 */
on('reorder', async ({ documentId, nodeId, targetId, after, copy, group: shared, committed }) => {
  // A grip drag reports its insertion point while it moves, so it arrives many times; one group makes it one undo step.
  const group = shared ?? newGroup();
  let id = nodeId;
  // Alt: the copy is what moves (one undo step for both).
  if (copy) {
    const made = await quiet(edit(documentId, { type: 'duplicate', ids: [nodeId] }, { label: `duplicate ${nodeId}`, group }));
    id = made?.ids?.[0];
    if (!id) return;
  }
  // The move names the sibling it goes beside, not an index: repeating the same drop while a drag moves is then a no-op
  // rather than a second, index-relative move of a tree that has already changed.
  const derive = model => {
    const target = model.nodes[targetId], parent = target && parentOf(model, targetId);
    if (!parent || !model.nodes[id]) return null;
    for (let at = target; at; at = parentOf(model, at.id)) if (at.id === id) { toast('An element cannot be moved into itself'); return null; }
    const siblings = parent.children.filter(child => child !== id);
    const index = siblings.indexOf(targetId) + (after ? 1 : 0);
    const current = parentOf(model, id);
    if (current?.id === parent.id && current.children.indexOf(id) === index) return null;
    return after ? { type: 'move', id, after: targetId } : { type: 'move', id, before: targetId };
  };
  const applied = await quiet(edit(documentId, derive, { label: `${copy ? 'copy' : 'move'} ${id} ${after ? 'after' : 'before'} ${targetId}`, group }));
  if (applied) committed?.();
  if (copy) selectNodes(documentId, [id], { reveal: true });
});
