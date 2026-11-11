import { store, documents, descriptor, edit, toast, cachedModel, loadModel, selectNodes, parentOf, canContain, apiUrl } from './store.js';
import * as canvas from './canvas.js';
import { duplicateArtboards } from './artboards.js';

/* Copy, cut and paste of elements and artboards, plus images from the clipboard or a drop.
   The system clipboard receives clean HTML; the board keeps a lossless copy (names, metadata,
   IDs as hints) and uses it whenever the clipboard still holds what the board put there. */

const STRUCTURE = new Set('div section main article header footer nav aside form figure fieldset details dialog ul ol menu dl table tbody thead tfoot tr hgroup search blockquote'.split(' '));
const VOID = new Set('area br col hr img input source track wbr'.split(' '));
const INLINE = new Set('a abbr b bdi bdo br cite code data dfn em i img input kbd label mark q s samp small span strong sub sup time u var wbr'.split(' '));
let clip = null;

export const hasClip = () => !!clip;
export const clipKind = () => clip?.kind ?? null;

const escapeText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeAttribute = value => escapeText(value).replaceAll('"', '&quot;');

/** A node and its subtree as an insert spec that keeps names, classes, styles and metadata. */
export function toSpec(model, id, top = true) {
  const node = model.nodes[id];
  if (node.type === 'text') return top ? { tag: 'span', text: node.content } : node.content;
  const spec = { tag: node.tag, id: node.id };
  if (node.className) spec.className = node.className;
  for (const key of ['attrs', 'style', 'metadata']) if (Object.keys(node[key] || {}).length) spec[key] = structuredClone(node[key]);
  if (node.children.length) spec.children = node.children.map(child => toSpec(model, child, false));
  return spec;
}

/** Readable HTML of nodes without divlet bookkeeping (what other apps receive). */
export function htmlOf(model, ids) {
  const open = node => {
    const attrs = Object.entries(node.attrs).map(([key, value]) => `${key}="${escapeAttribute(value)}"`);
    if (node.className) attrs.push(`class="${escapeAttribute(node.className)}"`);
    const style = Object.entries(node.style).map(([key, value]) => `${key}: ${value}`).join('; ');
    if (style) attrs.push(`style="${escapeAttribute(style)}"`);
    return `<${node.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  };
  const inline = id => {
    const node = model.nodes[id];
    if (node.type === 'text') return escapeText(node.content);
    if (VOID.has(node.tag)) return open(node);
    return `${open(node)}${node.children.map(inline).join('')}</${node.tag}>`;
  };
  const block = (id, depth) => {
    const node = model.nodes[id];
    const pad = '  '.repeat(depth);
    if (node.type === 'text') return node.content.trim() ? pad + escapeText(node.content) : '';
    const inlineOnly = node.children.every(child => model.nodes[child].type === 'text' || INLINE.has(model.nodes[child].tag));
    if (VOID.has(node.tag) || !node.children.length || inlineOnly) return pad + inline(id);
    return `${pad}${open(node)}\n${node.children.map(child => block(child, depth + 1)).filter(Boolean).join('\n')}\n${pad}</${node.tag}>`;
  };
  return ids.map(id => block(id, 0)).join('\n') + '\n';
}

/** Selected node IDs without the root and without nodes whose ancestor is also selected, in tree order. */
function topLevel(model, ids) {
  const chosen = new Set(ids.filter(id => model.nodes[id] && id !== model.rootId));
  const parents = new Map();
  for (const node of Object.values(model.nodes)) if (node.type === 'element') for (const child of node.children) parents.set(child, node.id);
  const order = [];
  const walk = id => { order.push(id); const node = model.nodes[id]; if (node.type === 'element') node.children.forEach(walk); };
  walk(model.rootId);
  return order.filter(id => {
    if (!chosen.has(id)) return false;
    for (let p = parents.get(id); p; p = parents.get(p)) if (chosen.has(p)) return false;
    return true;
  });
}

async function writeSystem(text, event) {
  if (event?.clipboardData) {
    event.clipboardData.setData('text/plain', text);
    event.clipboardData.setData('text/html', text);
    event.preventDefault();
    return true;
  }
  try {
    // A key forwarded from a preview frame leaves the board document unfocused.
    if (!document.hasFocus()) document.querySelector('#viewport')?.focus({ preventScroll: true });
    await navigator.clipboard.writeText(text);
    return true;
  } catch { return false; }
}

/**
 * Copy (or cut) the selection. With a DOM copy/cut `event` the clipboard is written synchronously
 * when the model is cached; returns false when there is nothing to copy so the browser default runs.
 */
export function copySelection({ event, cut = false } = {}) {
  const node = store.node?.nodeIds.length ? store.node : null;
  if (node) {
    const model = cachedModel(node.documentId);
    if (!model) {
      // The newest model is still on its way (e.g. right after a paste): finish once it is here.
      event?.preventDefault();
      loadModel(node.documentId).then(() => copySelection({ cut })).catch(error => toast(error.message));
      return true;
    }
    const ids = topLevel(model, node.nodeIds);
    if (!ids.length) { toast('The page root cannot be copied. Copy the artboard instead.'); event?.preventDefault(); return true; }
    const text = htmlOf(model, ids);
    clip = { kind: 'nodes', documentId: node.documentId, specs: ids.map(id => toSpec(model, id)), text, count: ids.length, preferInternal: false };
    const current = clip;
    const written = writeSystem(text, event);
    Promise.resolve(written).then(ok => { if (!ok && clip === current) current.preferInternal = true; });
    const what = ids.length === 1 ? `<${model.nodes[ids[0]].tag ?? 'text'}>` : `${ids.length} elements`;
    if (cut) {
      edit(node.documentId, { type: 'remove', ids }, { label: `cut ${what}` }).then(() => {
        selectNodes(node.documentId, []);
        toast(`Cut ${what} — paste with ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} V`);
      }).catch(() => {});
    } else toast(`Copied ${what}`);
    return true;
  }
  if (store.selected.size) {
    const ids = [...store.selected];
    clip = { kind: 'artboards', ids, text: null, count: ids.length, preferInternal: true };
    event?.preventDefault();
    toast(ids.length === 1 ? `Copied “${descriptor(ids[0])?.name || ids[0]}”` : `Copied ${ids.length} artboards`);
    return true;
  }
  return false;
}

/** Where pasted content goes: inside a selected container, after a selected element, or at the end of the page. */
async function target() {
  const node = store.node?.nodeIds.length ? store.node : null;
  const documentId = node?.documentId ?? (store.selected.size === 1 ? [...store.selected][0] : null);
  if (!documentId) return null;
  const model = cachedModel(documentId) || await loadModel(documentId);
  let anchor = node ? model.nodes[node.nodeIds.at(-1)] : null;
  if (anchor?.type === 'text') anchor = parentOf(model, anchor.id);
  if (!anchor || anchor.id === model.rootId) return { documentId, place: { parentId: model.rootId } };
  if (canContain(anchor) && STRUCTURE.has(anchor.tag)) return { documentId, place: { parentId: anchor.id } };
  return { documentId, place: { after: anchor.id } };
}

const looksLikeHtml = text => /^\s*<([a-z][\w-]*)[\s>/][\s\S]*>\s*$/i.test(text) && /<\/[a-z][\w-]*\s*>|\/>\s*$|<(img|br|hr|input)\b/i.test(text);

async function insert(op, label) {
  const spot = await target();
  if (!spot) { toast('Select an artboard or an element to paste into'); return null; }
  const result = await edit(spot.documentId, { type: 'insert', ...spot.place, ...op }, { label }).catch(() => null);
  if (!result?.ids?.length) return null;
  if (store.mode !== 'select') canvas.setMode('select');
  selectNodes(spot.documentId, result.ids, { reveal: true });
  canvas.flashNodes(spot.documentId, result.render, result.ids);
  return result;
}

/**
 * Paste. `text` comes from a paste event (or is undefined for a key forwarded by a preview frame,
 * where only the board's own clipboard is available). `files` may carry images.
 */
export async function paste({ text, files } = {}) {
  const images = [...(files || [])].filter(file => file.type.startsWith('image/'));
  if (images.length) return addImages(images);
  const normalize = value => value?.replace(/\r\n?/g, '\n');
  const own = clip && (clip.preferInternal || text === undefined || normalize(text) === normalize(clip.text));
  if (own && clip.kind === 'artboards') {
    const alive = clip.ids.filter(id => descriptor(id));
    if (!alive.length) { toast('The copied artboards no longer exist'); return null; }
    return duplicateArtboards(alive);
  }
  if (own && clip.kind === 'nodes') return insert({ spec: clip.specs }, clip.count > 1 ? `paste ${clip.count} elements` : 'paste element');
  const value = (text ?? '').trim();
  if (!value) { toast('The clipboard is empty — copy elements with Ctrl C first'); return null; }
  if (looksLikeHtml(value)) return insert({ html: value }, 'paste HTML');
  const paragraphs = value.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean).slice(0, 50);
  return insert({ spec: paragraphs.map(content => ({ preset: 'text', text: content })) }, paragraphs.length > 1 ? `paste ${paragraphs.length} paragraphs` : 'paste text');
}

/* ---- images --------------------------------------------------------------- */
async function upload(file, documentId) {
  const name = file.name && /\.[a-z0-9]+$/i.test(file.name) ? file.name : `pasted.${(file.type.split('/')[1] || 'png').replace('svg+xml', 'svg').replace('jpeg', 'jpg')}`;
  const response = await fetch(apiUrl(`api/assets?name=${encodeURIComponent(name)}&documentId=${encodeURIComponent(documentId)}`), { method: 'POST', headers: { 'Content-Type': file.type || 'image/png' }, body: file });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Upload failed (${response.status})`);
  return { ...body, alt: name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ') };
}

/** Upload images into divlet/assets/ and add an <img> for each at the paste/drop target. */
export async function addImages(files, documentId) {
  if (documentId && !(store.selected.size === 1 && store.selected.has(documentId))) {
    const { selectArtboards } = await import('./store.js');
    selectArtboards([documentId]);
  }
  const spot = await target();
  if (!spot) { toast('Select an artboard first, or drop the image onto one'); return null; }
  try {
    const saved = [];
    for (const file of files.slice(0, 12)) saved.push(await upload(file, spot.documentId));
    toast(saved.length === 1 ? `Added ${saved[0].file}` : `Added ${saved.length} images to divlet/assets`);
    return insert({ spec: saved.map(item => ({ tag: 'img', className: 'block max-w-full h-auto', attrs: { src: item.path, alt: item.alt } })) }, saved.length > 1 ? `add ${saved.length} images` : 'add image');
  } catch (error) { toast(error.message); return null; }
}

/** Text selected where the shortcut happens (e.g. in History) keeps the browser's own copy. */
const copiesText = event => {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || !selection.toString()) return false;
  const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
  return !!anchor && event.target instanceof Node && event.target.contains(anchor) && event.target !== document.querySelector('#viewport');
};

export const isEditable = target => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || !!target?.isContentEditable;

document.addEventListener('copy', event => { if (!isEditable(event.target) && !store.expanded && !copiesText(event)) copySelection({ event }); });
document.addEventListener('cut', event => { if (!isEditable(event.target) && !store.expanded && !copiesText(event)) copySelection({ event, cut: true }); });
document.addEventListener('paste', event => {
  if (isEditable(event.target) || store.expanded || !documents().length) return;
  event.preventDefault();
  paste({ text: event.clipboardData?.getData('text/plain') ?? '', files: event.clipboardData?.files });
});
