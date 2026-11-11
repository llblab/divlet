import { $, $$, el, icon, clamp, round } from './util.js';
import { store, emit, on, documents, descriptor, request, post, apiUrl, commit, edit, idle, undo, newGroup, selectArtboards, selectNodes, toast, viewState, saveViewState } from './store.js';

const PREFETCH_TARGET = 8;
const OVERSCAN = 550;
// A frame drawn narrower than this on screen shows its cached picture instead of the live page (when the server can make one).
const LOD_WIDTH = 260;
const MIN_K = 0.04;
const MAX_K = 4;
const MIN_SIZE = 80;
const WIDTH_PRESETS = [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const viewport = $('#viewport');
const stage = $('#stage');
const guides = $('#guides');
const marquee = $('#marquee');
const badge = $('#hover-badge');

export const camera = { x: 0, y: 0, k: 1 };
export const entries = new Map();
const overrides = new Map();
const pendingOverrides = new Map();
let frameScheduled = false;
let spaceDown = false;
let snapDisabled = false;
let gesture = null;
let initialFit = false;
let animation = 0;
const pointers = new Map();
const tap = { time: 0, x: 0, y: 0, key: null };

/** Our own double-click detection: pointer capture retargets native dblclick events, and it also covers double-tap. */
function doubleTap(event, key) {
  const double = key === tap.key && event.timeStamp - tap.time < 420 && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 8;
  Object.assign(tap, double ? { time: 0, key: null } : { time: event.timeStamp, x: event.clientX, y: event.clientY, key });
  return double;
}

/* ---- geometry ------------------------------------------------------------- */
export const rectOf = doc => (overrides.has(doc.id) ? overrides.get(doc.id) : doc.artboard);
const screenRect = rect => ({ x: camera.x + rect.x * camera.k, y: camera.y + rect.y * camera.k, width: rect.width * camera.k, height: rect.height * camera.k });
const worldPoint = (clientX, clientY) => { const b = viewport.getBoundingClientRect(); return { x: (clientX - b.left - camera.x) / camera.k, y: (clientY - b.top - camera.y) / camera.k }; };

function place(entry) {
  if (store.expanded?.entry === entry) return;
  const rect = rectOf(entry.doc);
  const s = screenRect(rect);
  entry.el.style.transform = `translate(${s.x}px, ${s.y}px)`;
  entry.el.style.width = `${s.width}px`;
  entry.el.style.height = `${s.height}px`;
  entry.body.style.width = `${rect.width}px`;
  entry.body.style.height = `${rect.height}px`;
  entry.body.style.transform = `scale(${camera.k})`;
  syncLod(entry, s.width);
}

/*
 * Far zoom: each frame photographs itself (the bridge rasterizes the page in the browser, nothing is fetched from the server)
 * and the board keeps the picture; a frame drawn narrower than LOD_WIDTH shows it instead of the live page, which stays loaded
 * but is not painted. Zoom in, select or expand and the same page is simply shown again, so nothing reloads or flashes.
 * Pictures are taken one at a time while the browser is idle, as soon as a page has rendered.
 */
const captureQueue = [];
let capturing = null;
function queueCapture(entry) {
  if (!entry.port || entry.shot?.render >= entry.doc.render || captureQueue.includes(entry)) return;
  captureQueue.push(entry);
  pumpCapture();
}
function pumpCapture() {
  if (capturing) return;
  const entry = captureQueue.shift();
  if (!entry) return;
  capturing = entry;
  (window.requestIdleCallback ?? (run => setTimeout(run, 60)))(() => {
    if (!entry.port || !entry.loaded) { finishCapture(entry); return; }
    entry.port.postMessage({ type: 'divlet:capture' });
    entry.captureTimer = setTimeout(() => finishCapture(entry), 8000);
  }, { timeout: 2000 });
}
function finishCapture(entry) {
  clearTimeout(entry.captureTimer);
  if (capturing === entry) capturing = null;
  pumpCapture();
}
function receiveShot(entry, data) {
  if (data.blob instanceof Blob && data.version >= (entry.shot?.render ?? 0)) {
    if (entry.shot) URL.revokeObjectURL(entry.shot.url);
    entry.shot = { render: data.version, url: URL.createObjectURL(data.blob) };
    syncLod(entry);
    if (entry.shot.render < entry.doc.render) queueCapture(entry);
  }
  finishCapture(entry);
}

function syncLod(entry, screenWidth = entry.el.getBoundingClientRect().width) {
  const show = !store.expanded && !store.selected.has(entry.doc.id) && !entry.name.querySelector('input') && screenWidth < LOD_WIDTH && !!entry.iframe && !!entry.shot;
  if (show) {
    const image = entry.shotImage ??= Object.assign(new Image(), { className: 'frame-snapshot', alt: '', draggable: false });
    if (image.dataset.url !== entry.shot.url) { image.dataset.url = entry.shot.url; image.src = entry.shot.url; }
    if (!image.isConnected) entry.body.insertBefore(image, entry.cover);
  } else if (entry.shotImage?.isConnected) entry.shotImage.remove();
  entry.el.classList.toggle('lod', show);
}

function paintGrid() {
  let step = 24 * camera.k;
  while (step < 14) step *= 2;
  stage.style.setProperty('--canvas-scale', String(camera.k));
  viewport.style.setProperty('--grid', `${step}px`);
  viewport.style.setProperty('--gx', `${camera.x % step}px`);
  viewport.style.setProperty('--gy', `${camera.y % step}px`);
  $('#zoom-value').textContent = `${Math.round(camera.k * 100)}%`;
}

const persist = (() => { let timer; return () => { clearTimeout(timer); timer = setTimeout(() => { if (store.state) saveViewState(store.state.projectId, { ...camera }); }, 250); }; })();

export function applyCamera() {
  hideBadge();
  for (const entry of entries.values()) place(entry);
  paintGrid();
  scheduleFrames();
  persist();
  emit('camera', camera);
}

export function setCamera(next) {
  camera.k = clamp(next.k ?? camera.k, MIN_K, MAX_K);
  camera.x = next.x ?? camera.x;
  camera.y = next.y ?? camera.y;
  applyCamera();
}

function animateTo(target) {
  cancelAnimationFrame(animation);
  if (reduceMotion.matches) return setCamera(target);
  const from = { ...camera };
  const start = performance.now();
  const duration = 360;
  const step = now => {
    const t = clamp((now - start) / duration, 0, 1);
    const e = 1 - (1 - t) ** 3;
    // interpolate in log-space so zoom feels even
    const k = Math.exp(Math.log(from.k) + (Math.log(target.k) - Math.log(from.k)) * e);
    setCamera({ k, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e });
    if (t < 1) animation = requestAnimationFrame(step);
  };
  animation = requestAnimationFrame(step);
}

export function zoomAt(factor, clientX, clientY, { animate = false } = {}) {
  const bounds = viewport.getBoundingClientRect();
  const px = (clientX ?? bounds.left + bounds.width / 2) - bounds.left;
  const py = (clientY ?? bounds.top + bounds.height / 2) - bounds.top;
  const k = clamp(camera.k * factor, MIN_K, MAX_K);
  const ratio = k / camera.k;
  const target = { k, x: px - (px - camera.x) * ratio, y: py - (py - camera.y) * ratio };
  if (animate) animateTo(target);
  else { cancelAnimationFrame(animation); setCamera(target); }
}

export function zoomTo(k, { animate = true } = {}) {
  const bounds = viewport.getBoundingClientRect();
  zoomAt(k / camera.k, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, { animate });
}

function boundsOf(docs) {
  if (!docs.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const doc of docs) {
    const r = rectOf(doc);
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The part of the canvas not covered by floating panels (in viewport coordinates). */
function safeArea() {
  const b = viewport.getBoundingClientRect();
  const area = { left: 0, top: 0, right: b.width, bottom: b.height };
  if (b.width < 720) return area;
  for (const id of ['sidebar', 'inspector']) {
    const node = document.getElementById(id);
    if (!node || node.hidden) continue;
    const r = node.getBoundingClientRect();
    if (r.left - b.left < b.width / 2) area.left = Math.max(area.left, r.right - b.left);
    else area.right = Math.min(area.right, r.left - b.left);
  }
  if (area.right - area.left < 320) return { left: 0, top: 0, right: b.width, bottom: b.height };
  return area;
}

/** Frame a world rectangle in the free part of the canvas; `label` reserves room for artboard names. */
function fitRect(b, { animate = true, maxZoom = 1, label = 28 } = {}) {
  const area = safeArea();
  const width = area.right - area.left;
  const height = area.bottom - area.top;
  const narrow = viewport.clientWidth < 720;
  const padX = narrow ? 24 : 72;
  const padTop = 64;
  const padBottom = narrow ? 150 : 96;
  const k = clamp(Math.min((width - padX * 2) / b.width, (height - padTop - padBottom) / (b.height + label)), MIN_K, Math.max(maxZoom, MIN_K));
  const target = { k, x: area.left + (width - b.width * k) / 2 - b.x * k, y: area.top + padTop + (height - padTop - padBottom - (b.height + label) * k) / 2 - b.y * k + label * k };
  if (animate) animateTo(target);
  else setCamera(target);
}

/**
 * After a panel opens: if it covers the selected artboards, bring them into the free part of the canvas. They are panned
 * when they fit there and framed when they do not; nothing moves when the selection is already in the clear.
 */
export function revealSelection() {
  const docs = [...store.selected].map(descriptor).filter(Boolean);
  const b = boundsOf(docs);
  if (!b) return;
  const area = safeArea();
  const pad = 24;
  const left = b.x * camera.k + camera.x, right = (b.x + b.width) * camera.k + camera.x;
  if (left >= area.left && right <= area.right) return;
  if ((right - left) + 2 * pad > area.right - area.left) { fitRect(b); return; }
  const dx = left < area.left ? area.left + pad - left : area.right - pad - right;
  animateTo({ k: camera.k, x: camera.x + dx, y: camera.y });
}

export function fit(ids, options) {
  const docs = (ids?.length ? ids.map(descriptor) : documents()).filter(Boolean);
  const b = boundsOf(docs);
  if (b) fitRect(b, options);
}

/** Zoom to one element of a page using the geometry measured in its frame. */
export function fitNode(documentId, nodeId) {
  const doc = descriptor(documentId);
  const seen = store.observations.get(documentId);
  const node = seen?.nodes.find(item => item.id === nodeId);
  if (!doc) return;
  if (!node || node.rect.width < 1 || node.rect.height < 1) return fit([documentId]);
  const a = rectOf(doc);
  const x = clamp(a.x + node.rect.x, a.x, a.x + a.width - 1);
  const y = clamp(a.y + node.rect.y, a.y, a.y + a.height - 1);
  const width = Math.max(1, Math.min(node.rect.width, a.x + a.width - x));
  const height = Math.max(1, Math.min(node.rect.height, a.y + a.height - y));
  const pad = 24;
  fitRect({ x: x - pad, y: y - pad, width: width + pad * 2, height: height + pad * 2 }, { maxZoom: 2, label: 0 });
}

/** True when at least part of an artboard is on screen. */
function anyVisible() {
  const b = viewport.getBoundingClientRect();
  return documents().some(doc => { const s = screenRect(rectOf(doc)); return s.x + s.width > 0 && s.x < b.width && s.y + s.height > 0 && s.y < b.height; });
}

export const focusArtboard = (id, options) => fit([id], options);

/** Bring an artboard into view: pan if it fits at the current zoom, zoom out only if it must. */
export function reveal(id) {
  const doc = descriptor(id);
  if (!doc || store.expanded) return;
  const r = rectOf(doc);
  const s = screenRect(r);
  const area = safeArea();
  const top = area.top + 52;
  const bottom = area.bottom - 76;
  if (s.x >= area.left + 12 && s.x + s.width <= area.right - 12 && s.y - 28 >= top && s.y + s.height <= bottom) return;
  if (s.width > area.right - area.left - 48 || s.height + 28 > bottom - top) return fit([id], { maxZoom: camera.k });
  const cx = (area.left + area.right) / 2;
  const cy = (top + bottom) / 2;
  animateTo({ k: camera.k, x: cx - (r.x + r.width / 2) * camera.k, y: cy - (r.y + r.height / 2 - 14) * camera.k });
}

/* ---- artboards ------------------------------------------------------------ */
function createArtboard(doc) {
  const wrapper = el('section', 'artboard');
  wrapper.dataset.artboardId = doc.id;
  const label = el('div', 'ab-label');
  const name = el('span', 'ab-name');
  const size = el('span', 'ab-size');
  const expand = el('button', 'ab-expand');
  expand.type = 'button';
  expand.dataset.tip = 'Expand · E';
  expand.setAttribute('aria-label', 'Expand artboard');
  expand.append(icon('expand'));
  const more = el('button', 'ab-more');
  more.type = 'button';
  more.dataset.tip = 'More';
  more.setAttribute('aria-label', 'Artboard actions');
  more.append(icon('more'));
  const error = el('span', 'ab-error');
  error.textContent = '!';
  error.setAttribute('role', 'img');
  error.setAttribute('aria-label', 'Preview unavailable');
  error.title = 'Preview unavailable';
  label.append(error, name, size, expand, more);
  const body = el('div', 'ab-body');
  const placeholder = el('div', 'frame-placeholder');
  const cover = el('div', 'frame-cover');
  body.append(placeholder, cover);
  const handles = el('div', 'ab-handles');
  for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const handle = el('span', `ab-handle h-${dir}`);
    handle.dataset.dir = dir;
    handles.append(handle);
  }
  wrapper.append(label, body, handles);
  stage.append(wrapper);
  const entry = { el: wrapper, label, name, size, expand, more, body, placeholder, cover, doc, iframe: null, loaded: false, renderedVersion: 0, awaitingVersion: 0, pendingFetch: false, abort: null, reportTimer: null, latestReport: null, deliveryGeneration: 0, expectedNavigationVersion: 0, pendingFlash: null, pendingEdit: null };
  expand.addEventListener('click', event => { event.stopPropagation(); openExpanded(entry.doc.id, expand); });
  more.addEventListener('click', event => {
    event.stopPropagation();
    if (!store.selected.has(entry.doc.id)) selectArtboards([entry.doc.id]);
    emit('context', { kind: 'artboard', id: entry.doc.id, anchor: more });
  });
  for (const control of [expand, more]) control.addEventListener('pointerdown', event => event.stopPropagation());
  wrapper.inert = !!store.expanded;
  entries.set(doc.id, entry);
  visibility.observe(wrapper);
  return entry;
}

function renameArtboard(entry) {
  if (entry.name.querySelector('input')) return;
  const input = el('input', 'ab-rename');
  input.value = entry.doc.name || entry.doc.id;
  input.setAttribute('aria-label', 'Artboard name');
  entry.name.replaceChildren(input);
  input.focus();
  input.select();
  const done = save => {
    if (!input.isConnected) return;
    document.removeEventListener('pointerdown', outside, true);
    const value = input.value.trim();
    entry.name.textContent = entry.doc.name || entry.doc.id;
    if (save && value && value !== entry.doc.name) commit(entry.doc.id, { name: value }, { label: `rename to “${value}”` }).catch(() => {});
    if (document.activeElement === document.body) viewport.focus({ preventScroll: true });
  };
  // A field that lost focus without a blur (a board shortcut, a click on the canvas) must not stay open: while it is open the
  // label's own press types into it instead of dragging the artboard.
  const outside = event => { if (!input.contains(event.target)) done(true); };
  document.addEventListener('pointerdown', outside, true);
  input.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') done(true); else if (event.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
  input.addEventListener('pointerdown', event => event.stopPropagation());
}

/** Type the size above an artboard: `390 × 800`, `1280` (width only) or `16:9` (height from the width). */
function editSize(entry) {
  if (entry.size.querySelector('input')) return;
  const doc = entry.doc;
  const input = el('input', 'ab-rename ab-size-input');
  input.value = `${doc.artboard.width} × ${doc.artboard.height}`;
  input.setAttribute('aria-label', 'Artboard size, width × height');
  input.dataset.tip = '390 × 800 · 1280 · 16:9';
  entry.size.replaceChildren(input);
  entry.size.style.opacity = '1';
  input.focus();
  input.select();
  let finished = false;
  const done = save => {
    if (finished || !input.isConnected) return;
    finished = true;
    const text = input.value.trim().toLowerCase();
    entry.size.style.opacity = '';
    entry.size.textContent = `${round(rectOf(entry.doc).width)} × ${round(rectOf(entry.doc).height)}`;
    if (save) {
      const pair = /^(\d+(?:\.\d+)?)\s*[x×*,]\s*(\d+(?:\.\d+)?)$/.exec(text);
      const ratio = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(text);
      const single = /^(\d+(?:\.\d+)?)$/.exec(text);
      let next = null;
      if (pair) next = { width: Math.round(Number(pair[1])), height: Math.round(Number(pair[2])) };
      else if (ratio && Number(ratio[1]) > 0) next = { height: Math.round(doc.artboard.width * Number(ratio[2]) / Number(ratio[1])) };
      else if (single) next = { width: Math.round(Number(single[1])) };
      else if (text) toast('Type a size like 390 × 800, a width like 1280, or a ratio like 16:9');
      if (next && Object.entries(next).some(([key, value]) => value >= 1 && value <= 16384 && value !== doc.artboard[key])) commit(doc.id, { artboard: next }, { label: 'resize artboard', expectedVersion: doc.version, expectedRender: doc.render }).catch(() => {});
    }
    if (document.activeElement === document.body) viewport.focus({ preventScroll: true });
  };
  input.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') done(true); else if (event.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
  input.addEventListener('pointerdown', event => event.stopPropagation());
}

/** Where an element's lower-left corner is on screen (for a menu opened from the keyboard), or the artboard's. */
export function anchorPoint(documentId, nodeId) {
  const entry = entries.get(documentId);
  if (!entry) return { x: innerWidth / 2, y: innerHeight / 2 };
  const frame = entry.iframe?.getBoundingClientRect() ?? entry.el.getBoundingClientRect();
  const rect = nodeId ? store.observations.get(documentId)?.nodes.find(item => item.id === nodeId)?.rect : null;
  if (!rect) return { x: frame.left + 24, y: frame.top + 24 };
  return { x: Math.min(frame.right - 8, frame.left + rect.x * camera.k + 8), y: Math.min(frame.bottom - 8, frame.top + (rect.y + rect.height) * camera.k + 4) };
}

export function reconcileArtboards() {
  const current = new Set(documents().map(doc => doc.id));
  for (const [id, entry] of entries) {
    if (current.has(id)) continue;
    visibility.unobserve(entry.el);
    unmount(entry);
    entry.el.remove();
    entries.delete(id);
    overrides.delete(id);
    pendingOverrides.delete(id);
    store.observations.delete(id);
  }
  for (const doc of documents()) {
    const entry = entries.get(doc.id) || createArtboard(doc);
    entry.doc = doc;
    const pending = pendingOverrides.get(doc.id);
    if (pending && doc.version >= pending.version) { pendingOverrides.delete(doc.id); overrides.delete(doc.id); }
    if (!entry.name.querySelector('input')) entry.name.textContent = doc.name || doc.id;
    if (!entry.size.querySelector('input')) entry.size.textContent = `${round(rectOf(doc).width)} × ${round(rectOf(doc).height)}`;
    entry.el.setAttribute('aria-label', doc.name || doc.id);
    entry.expand.setAttribute('aria-label', `Expand ${doc.name || doc.id}`);
    entry.more.setAttribute('aria-label', `Actions for ${doc.name || doc.id}`);
    entry.el.classList.toggle('selected', store.selected.has(doc.id));
    place(entry);
    if (entry.iframe) { entry.iframe.title = `${doc.name || doc.id} preview`; updateFrame(entry); }
  }
  if (!initialFit && documents().length && viewport.clientWidth) {
    initialFit = true;
    const saved = viewState(store.state.projectId);
    if (saved && Number.isFinite(saved.k) && Number.isFinite(saved.x) && Number.isFinite(saved.y)) setCamera(saved);
    else fit(null, { animate: false });
  }
  updateHandles();
  applyCamera();
}

export function updateSelectionClasses(detail) {
  for (const [id, entry] of entries) entry.el.classList.toggle('selected', store.selected.has(id));
  updateHandles();
  for (const entry of entries.values()) syncNodeSelection(entry, detail?.reveal);
  scheduleFrames();
}

function updateHandles() {
  const single = store.selected.size === 1 ? [...store.selected][0] : null;
  for (const [id, entry] of entries) entry.el.classList.toggle('sole', id === single);
}

/* ---- frames --------------------------------------------------------------- */
export const postToFrame = (id, message) => entries.get(id)?.port?.postMessage(message);

function setFrameStatus(entry, value) {
  entry.el.dataset.status = value;
  entry.el.dataset.renderedVersion = String(entry.renderedVersion);
}

/** Where the agent says it is working: the whole artboard glows, or elements inside the page do. */
export function syncWork(entry) {
  const marks = (store.state?.work || []).filter(item => item.documentId === entry.doc.id);
  const whole = marks.some(item => !item.nodeIds.length);
  entry.el.classList.toggle('working', whole);
  const note = marks.find(item => item.note)?.note;
  if (note) entry.el.dataset.work = note; else delete entry.el.dataset.work;
  if (!entry.iframe || !entry.loaded) return;
  const ids = [...new Set(marks.flatMap(item => item.nodeIds))];
  entry.port?.postMessage({ type: 'divlet:work', nodeIds: store.expanded ? [] : ids });
}

function syncNodeSelection(entry, reveal = false) {
  if (!entry.iframe || !entry.loaded) return;
  const ids = store.node?.documentId === entry.doc.id ? store.node.nodeIds : [];
  entry.port?.postMessage({ type: 'divlet:select', nodeIds: ids, reveal: reveal && ids.length > 0 });
}

/** Start inline text editing of a node once its frame shows `version`. */
export function editText(documentId, nodeId, version = 0) {
  const entry = entries.get(documentId);
  if (!entry || store.expanded) return;
  if (store.mode !== 'select') setMode('select');
  reveal(documentId);
  entry.pendingEdit = { version, nodeId };
  deliverEdit(entry);
}

function deliverEdit(entry) {
  const pending = entry.pendingEdit;
  if (!pending || !entry.iframe || !entry.port || !entry.loaded || entry.renderedVersion < pending.version) return;
  entry.pendingEdit = null;
  entry.iframe.focus();
  entry.port?.postMessage({ type: 'divlet:edit', nodeId: pending.nodeId });
}

const needsEagerLoad = entry => store.expanded?.entry === entry || store.selected.has(entry.doc.id);

function inspectFlag() { return !store.expanded && store.mode === 'select'; }

function mount(entry, { revision = false } = {}) {
  if (entry.iframe) return;
  const frame = document.createElement('iframe');
  frame.title = `${entry.doc.name || entry.doc.id} preview`;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.dataset.documentId = entry.doc.id;
  frame.id = `divlet-preview-${entry.doc.id}`;
  entry.bridgeToken = crypto.randomUUID();
  frame.referrerPolicy = 'no-referrer';
  // The browser owns when an off-screen page loads; frames are never torn down and rebuilt by scrolling or zooming.
  frame.loading = needsEagerLoad(entry) ? 'eager' : 'lazy';
  frame.src = apiUrl(`preview/${encodeURIComponent(entry.doc.id)}?${revision ? `revision=${entry.doc.render}&` : ''}bridge=${entry.bridgeToken}`);
  frame.addEventListener('load', () => {
    if (entry.iframe !== frame) return;
    entry.loaded = true;
    paintLiveCount();
    entry.port?.postMessage({ type: 'divlet:inspect', enabled: inspectFlag() });
    syncNodeSelection(entry);
    syncWork(entry);
    if (store.expanded?.entry === entry) return;
    updateFrame(entry);
  });
  entry.iframe = frame;
  entry.loaded = false;
  entry.renderedVersion = 0;
  entry.awaitingVersion = 0;
  entry.expectedNavigationVersion = entry.doc.render;
  entry.deliveryGeneration++;
  setFrameStatus(entry, 'loading');
  entry.placeholder.hidden = false;
  entry.body.insertBefore(frame, entry.cover);
  place(entry);
}

function dropGhost(entry) {
  clearTimeout(entry.ghostTimer);
  entry.ghostTimer = null;
  entry.ghost?.remove();
  entry.ghost = null;
}

function unmount(entry) {
  dropGhost(entry);
  entry.shotImage?.remove();
  if (entry.shot) URL.revokeObjectURL(entry.shot.url);
  entry.shot = null;
  clearTimeout(entry.captureTimer);
  if (!entry.iframe) return;
  entry.deliveryGeneration++;
  entry.abort?.abort();
  entry.abort = null;
  entry.port?.close();
  entry.iframe.remove();
  Object.assign(entry, { iframe: null, port: null, bridgeToken: null, loaded: false, renderedVersion: 0, awaitingVersion: 0, pendingFetch: false, latestReport: null });
  clearTimeout(entry.reportTimer);
  entry.reportTimer = null;
  entry.placeholder.hidden = false;
  setFrameStatus(entry, 'sleeping');
}

async function updateFrame(entry) {
  // While a pill is being dragged the page shows its own inline preview; delivering a render would replace the DOM under
  // the pointer. The model still moves (the drag commits live) and this frame catches up when the drag ends.
  if (gesture?.type === 'space' && gesture.id === entry.doc.id) return;
  if (store.expanded?.entry === entry || !entry.iframe || !entry.port || !entry.loaded || entry.pendingFetch || entry.awaitingVersion >= entry.doc.render || entry.renderedVersion >= entry.doc.render) return;
  const frame = entry.iframe;
  const generation = entry.deliveryGeneration;
  entry.pendingFetch = true;
  entry.abort = new AbortController();
  setFrameStatus(entry, 'updating');
  try {
    const rendered = await request(`api/render/${encodeURIComponent(entry.doc.id)}`, { signal: entry.abort.signal });
    if (entry.iframe !== frame || generation !== entry.deliveryGeneration || store.expanded?.entry === entry || rendered.documentId !== entry.doc.id || rendered.render < entry.renderedVersion) return;
    entry.awaitingVersion = rendered.render;
    entry.port?.postMessage({ type: 'divlet:update', documentId: entry.doc.id, version: rendered.render, html: rendered.html });
  } catch (error) {
    if (error.name !== 'AbortError' && entry.iframe === frame && generation === entry.deliveryGeneration) setFrameStatus(entry, 'error');
  } finally {
    if (entry.iframe === frame && generation === entry.deliveryGeneration) { entry.pendingFetch = false; entry.abort = null; }
  }
}

export function scheduleFrames() {
  if (frameScheduled) return;
  frameScheduled = true;
  requestAnimationFrame(() => {
    frameScheduled = false;
    // Every artboard owns one long-lived iframe; the browser defers loading and painting of off-screen ones.
    // Only frames the user is working with are promoted to an immediate load.
    for (const entry of entries.values()) {
      if (!entry.iframe) mount(entry);
      if (needsEagerLoad(entry) && entry.iframe.loading !== 'eager') entry.iframe.loading = 'eager';
      syncLod(entry);
    }
    paintLiveCount();
  });
}

/** Loaded frames over total; repainted whenever a frame finishes loading, not only when the schedule runs. */
function paintLiveCount() {
  let loaded = 0;
  for (const entry of entries.values()) if (entry.loaded) loaded++;
  $('#live-count').textContent = `${loaded}/${entries.size}`;
  emit('frames', { live: loaded, total: entries.size });
}

const visibility = new IntersectionObserver(scheduleFrames, { root: viewport, rootMargin: `${OVERSCAN}px` });
let lastSize = '';
new ResizeObserver(() => {
  scheduleFrames();
  emit('viewport');
  const size = `${viewport.clientWidth}x${viewport.clientHeight}`;
  // After the window changes size, bring the work back if it ended up entirely off screen.
  if (initialFit && lastSize && size !== lastSize && documents().length && !store.expanded && !anyVisible()) fit(null, { animate: false });
  lastSize = size;
}).observe(viewport);

/* ---- mode ----------------------------------------------------------------- */
function hideBadge() {
  if (badge.hidden) return;
  badge.hidden = true;
  emit('hover-node', null);
}

function showBadge(entry, node) {
  if (!node || store.mode !== 'select' || store.expanded || !entry.iframe) { hideBadge(); return; }
  const frame = entry.iframe.getBoundingClientRect();
  const v = viewport.getBoundingClientRect();
  const x = frame.left - v.left + node.rect.x * camera.k;
  const y = frame.top - v.top + node.rect.y * camera.k;
  badge.replaceChildren(el('b', '', node.tag), el('span', '', node.nodeId), el('i', '', `${Math.round(node.rect.width)} × ${Math.round(node.rect.height)}`));
  badge.hidden = false;
  const w = badge.offsetWidth;
  badge.style.left = `${clamp(x, 4, v.width - w - 4)}px`;
  badge.style.top = `${y - 26 < 4 ? y + 4 : y - 26}px`;
  emit('hover-node', { documentId: entry.doc.id, nodeId: node.nodeId });
}

/** Two tools: `select` (artboards and elements, the default) and `interact` (use the page itself). */
export function setMode(next) {
  if (next !== 'interact') next = 'select';
  hideBadge();
  clearHover();
  store.mode = next;
  viewport.classList.remove('mode-select', 'mode-interact');
  viewport.classList.add(`mode-${next}`);
  for (const entry of entries.values()) entry.port?.postMessage({ type: 'divlet:inspect', enabled: !store.expanded && next === 'select' });
  emit('mode', next);
}

/* ---- pointing into pages ---------------------------------------------------- */
// The board keeps the pointer over artboards; the page answers what is under it.
const framePoint = (entry, event) => {
  const frame = entry.iframe?.getBoundingClientRect();
  if (!frame || !entry.loaded) return null;
  return { x: (event.clientX - frame.left) / camera.k, y: (event.clientY - frame.top) / camera.k };
};
let hoverEntry = null;
let hoverFrame = 0;
function clearHover() {
  cancelAnimationFrame(hoverFrame);
  if (hoverEntry) postToFrame(hoverEntry.doc.id, { type: 'divlet:hover-at', x: null, y: null });
  hoverEntry = null;
}
function hoverAt(entry, event) {
  if (hoverEntry && hoverEntry !== entry) clearHover();
  hoverEntry = entry;
  const point = { clientX: event.clientX, clientY: event.clientY };
  cancelAnimationFrame(hoverFrame);
  hoverFrame = requestAnimationFrame(() => {
    const at = framePoint(entry, point);
    if (at) postToFrame(entry.doc.id, { type: 'divlet:hover-at', ...at });
  });
}
function pickAt(entry, event, additive) {
  // A frame that is only a thumbnail at this zoom: a click brings it up close, where its live page takes over.
  if (!additive && !store.selected.has(entry.doc.id) && entry.el.classList.contains('lod')) { selectArtboards([entry.doc.id]); fit([entry.doc.id], { animate: true }); return; }
  const at = framePoint(entry, event);
  if (!at) { selectArtboards([entry.doc.id]); return; }
  if (!store.selected.has(entry.doc.id) || store.selected.size > 1) selectArtboards([entry.doc.id], { keepNode: store.node?.documentId === entry.doc.id });
  postToFrame(entry.doc.id, { type: 'divlet:pick', ...at, additive: !!additive && store.node?.documentId === entry.doc.id });
}
function editAt(entry, event) {
  const at = framePoint(entry, event);
  if (!at) return;
  entry.iframe.focus();
  postToFrame(entry.doc.id, { type: 'divlet:edit-at', ...at });
}

/* ---- expanded interactive view -------------------------------------------- */
function setChromeInert(active, entry) {
  for (const node of $$('.chrome')) node.inert = active;
  for (const item of entries.values()) { item.el.inert = active && item !== entry; item.label.inert = active; }
}

function cancelDelivery(entry) {
  entry.deliveryGeneration++;
  entry.abort?.abort();
  Object.assign(entry, { abort: null, pendingFetch: false, awaitingVersion: 0, latestReport: null });
  clearTimeout(entry.reportTimer);
  entry.reportTimer = null;
}

export function openExpanded(documentId, focusTarget) {
  const entry = entries.get(documentId);
  if (!entry || store.expanded) return;
  store.expanded = { entry, mode: store.mode, focusTarget, camera: { ...camera } };
  cancelDelivery(entry);
  store.node = null;
  selectArtboards([documentId]);
  setMode('interact');
  entry.el.classList.add('expanded');
  entry.el.style.cssText = '';
  entry.body.style.cssText = '';
  mount(entry);
  entry.iframe.style.width = '';
  entry.iframe.style.height = '';
  const site = store.state?.site;
  const viewUrl = site?.templateId === documentId ? site.url : entry.doc.viewUrl;
  if (viewUrl) {
    // Browsing is a public document, not an editable preview with links that need a second mode switch.
    entry.port?.close();
    entry.port = null;
    entry.bridgeToken = crypto.randomUUID();
    entry.loaded = false;
    entry.iframe.src = viewUrl;
  } else entry.port?.postMessage({ type: 'divlet:inspect', enabled: false });
  const overlay = $('#expanded-preview');
  overlay.hidden = false;
  overlay.setAttribute('aria-owns', entry.iframe.id);
  $('#expanded-title').textContent = entry.doc.name || entry.doc.id;
  setChromeInert(true, entry);
  document.body.classList.add('is-expanded');
  $('#expanded-back').focus({ preventScroll: true });
  scheduleFrames();
  emit('expanded', true);
}

export function closeExpanded({ reset = true } = {}) {
  const previous = store.expanded;
  if (!previous) return;
  const entry = previous.entry;
  store.expanded = null;
  $('#expanded-preview').hidden = true;
  $('#expanded-preview').removeAttribute('aria-owns');
  entry.el.classList.remove('expanded');
  setChromeInert(false, entry);
  document.body.classList.remove('is-expanded');
  cancelDelivery(entry);
  store.observations.delete(entry.doc.id);
  store.models.delete(entry.doc.id);
  entry.loaded = false;
  entry.renderedVersion = 0;
  entry.expectedNavigationVersion = entry.doc.render;
  setMode(previous.mode);
  if (reset && entry.iframe) {
    // Double-buffer: the interacted page stays on screen as a ghost until a fresh, authenticated frame has painted.
    const ghost = entry.iframe;
    entry.port?.close();
    entry.port = null;
    entry.iframe = null;
    entry.ghost?.remove();
    entry.ghost = ghost;
    ghost.classList.add('frame-ghost');
    ghost.removeAttribute('id');
    ghost.removeAttribute('data-document-id');
    ghost.tabIndex = -1;
    ghost.setAttribute('aria-hidden', 'true');
    mount(entry, { revision: true });
    place(entry);
    ghost.style.width = entry.iframe.style.width;
    ghost.style.height = entry.iframe.style.height;
    clearTimeout(entry.ghostTimer);
    entry.ghostTimer = setTimeout(() => dropGhost(entry), 4000);
  } else place(entry);
  Object.assign(camera, previous.camera);
  applyCamera();
  if (previous.focusTarget?.isConnected) previous.focusTarget.focus({ preventScroll: true });
  else viewport.focus({ preventScroll: true });
  scheduleFrames();
  emit('expanded', false);
}

/* ---- observations from frames --------------------------------------------- */
const validFiles = files => (Array.isArray(files) ? files.filter(file => file instanceof File && file.type.startsWith('image/')).slice(0, 12) : []);
const validNodes = nodes => (Array.isArray(nodes) ? nodes.slice(0, 300).filter(node => typeof node.id === 'string' && node.rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(node.rect[key]))) : []);

function queueObservation(entry, report) {
  if (store.expanded?.entry === entry) return;
  entry.latestReport = report;
  if (entry.reportTimer) return;
  entry.reportTimer = setTimeout(() => {
    entry.reportTimer = null;
    const latest = entry.latestReport;
    entry.latestReport = null;
    if (!latest || !entry.iframe || store.expanded?.entry === entry) return;
    post('api/observations', latest).catch(() => {});
  }, 180);
}

export function flashNodes(documentId, version, nodeIds) {
  const entry = entries.get(documentId);
  if (!entry?.iframe || !nodeIds?.length) return;
  if (entry.renderedVersion >= version) postToFrame(documentId, { type: 'divlet:flash', nodeIds });
  else entry.pendingFlash = { version, nodeIds };
}

let handleKey = () => false;
export const setKeyHandler = fn => { handleKey = fn; };

window.addEventListener('message', event => {
  const entry = [...entries.values()].find(item => item.iframe?.contentWindow === event.source);
  const data = event.data;
  if (!entry || !data || typeof data !== 'object') return;
  if (data.type === 'divlet:connect' && data.bridgeToken === entry.bridgeToken && event.ports[0]) {
    const frame = entry.iframe;
    const port = event.ports[0];
    entry.port?.close();
    entry.port = port;
    port.onmessage = message => {
      if (entry.iframe === frame && entry.port === port) handlePreviewMessage(entry, message.data);
    };
    port.start();
    port.postMessage({ type: 'divlet:writable', enabled: store.state?.project?.capabilities?.properties === true });
    port.postMessage({ type: 'divlet:inspect', enabled: inspectFlag() });
    port.postMessage({ type: 'divlet:handles-enabled', enabled: editHandles() });
    syncNodeSelection(entry);
    syncWork(entry);
  } else if (store.expanded?.entry === entry) {
    if (data.type === 'divlet:escape') closeExpanded();
    else if (data.type === 'divlet:site-ready' && store.state?.site) entry.iframe.contentWindow.postMessage({ type: 'divlet:site-state', site: { version: store.state.site.version } }, '*');
  }
});

/**
 * Play: a link in one artboard names a page of the project. When that page is another artboard's, reveal it, select it and
 * take its page to the fragment (a plain page link lands at the top, like a navigation would). The frames stay loaded; nothing
 * is swapped, and a link to no artboard says so rather than leave for a missing file.
 */
function followLink(entry, href) {
  const base = entry.doc.viewUrl;
  if (!base) return;
  const page = url => { try { return url.origin + decodeURIComponent(url.pathname); } catch { return url.origin + url.pathname; } };
  let target;
  try { target = new URL(href, new URL(base, location.href)); } catch { return; }
  const destination = [...entries.values()].find(item => item.doc.viewUrl && page(new URL(item.doc.viewUrl, location.href)) === page(target));
  if (!destination) {
    const name = page(target).split('/').pop() || target.pathname;
    toast(`“${name.length > 60 ? name.slice(0, 57) + '…' : name}” is not an artboard of this project`);
    return;
  }
  const id = destination.doc.id;
  if (id !== entry.doc.id) { selectArtboards([id]); reveal(id); }
  const message = { type: 'divlet:scroll-to', fragment: target.hash };
  if (destination.port && destination.loaded) destination.port.postMessage(message);
  else destination.pendingScroll = message;
}

function handlePreviewMessage(entry, data) {
  if (!data || typeof data !== 'object') return;
  if (store.expanded?.entry === entry) {
    if (data.type === 'divlet:escape') closeExpanded();
    return;
  }
  if (data.type === 'divlet:link' && typeof data.href === 'string' && data.href.length <= 2048) { followLink(entry, data.href); return; }
  if (data.type === 'divlet:wheel' && Number.isFinite(data.deltaY)) {
    const frame = entry.iframe.getBoundingClientRect();
    const px = frame.left + (Number(data.clientX) || 0) * camera.k;
    const py = frame.top + (Number(data.clientY) || 0) * camera.k;
    zoomAt(Math.exp(-clamp(data.deltaY * (data.deltaMode === 1 ? 16 : 1), -120, 120) * 0.0022), px, py);
    return;
  }
  if (data.type === 'divlet:key') { handleKey({ ...data, fromFrame: true }); return; }
  if (data.type === 'divlet:paste') {
    if (typeof data.text === 'string' && data.text.length <= 512 * 1024) emit('frame-paste', { documentId: entry.doc.id, text: data.text, files: validFiles(data.files) });
    return;
  }
  if (data.type === 'divlet:drop') {
    const files = validFiles(data.files);
    if (files.length) emit('images', { documentId: entry.doc.id, files, nodeId: typeof data.nodeId === 'string' ? data.nodeId : null });
    return;
  }
  if (data.type === 'divlet:snapshot') { receiveShot(entry, data); return; }
  if (data.type === 'divlet:snapshot-failed') { finishCapture(entry); return; }
  if (data.type === 'divlet:escape') { handleKey({ key: 'Escape' }); return; }
  if (data.type === 'divlet:edit-step' && (data.dir === 1 || data.dir === -1)) { emit('edit-step', { documentId: entry.doc.id, dir: data.dir, create: !!data.create, nodeId: typeof data.nodeId === 'string' ? data.nodeId : null }); return; }
  if (data.type === 'divlet:edit-fallback' && typeof data.nodeId === 'string' && typeof data.tag === 'string') { emit('edit-fallback', { documentId: entry.doc.id, nodeId: data.nodeId, tag: data.tag.slice(0, 20) }); return; }
  if (data.type === 'divlet:editing') { entry.el.classList.toggle('editing', !!data.active); if (!data.active && document.activeElement === entry.iframe) viewport.focus({ preventScroll: true }); return; }
  if (data.documentId !== entry.doc.id || !Number.isInteger(data.version) || data.version < entry.expectedNavigationVersion) return;
  if (data.type === 'divlet:context') {
    const frame = entry.iframe.getBoundingClientRect();
    emit('context', { kind: 'node', id: entry.doc.id, x: frame.left + (Number(data.clientX) || 0) * camera.k, y: frame.top + (Number(data.clientY) || 0) * camera.k });
    return;
  }
  if (data.type === 'divlet:spacing-edit' && typeof data.nodeId === 'string' && (data.kind === 'padding' || data.kind === 'margin' || data.kind === 'gap' || data.kind === 'size') && Array.isArray(data.sides) && (data.kind === 'size' || Number.isFinite(data.value))) {
    // A side (or the gap) dragged on the canvas becomes a declarative style on the element (the style engine turns it into a class).
    const names = { t: 'top', r: 'right', b: 'bottom', l: 'left' };
    const value = Math.round(clamp(Number(data.value) || 0, data.kind === 'margin' ? -2000 : 0, 2000));
    // A drag commits while it runs so the model, inspector and built pages follow it; the drag's group keeps one undo step.
    // Trailing messages of a finished drag still belong to it, so a stray late edit never becomes its own undo step.
    const dragging = gesture?.type === 'space' && gesture.id === entry.doc.id;
    const drag = dragging ? gesture : null;
    if (drag) drag.live = true;
    const landed = result => { if (drag) drag.liveCommitted = true; return result; };
    // The bridge's own messages only ever come from a drag on this document, so its last drag group is the right one even
    // when the message arrives long after the release (a busy main thread must not split a gesture into two undo steps).
    const group = dragging ? gesture.group : entry.spaceGroup;
    if (data.kind === 'size') {
      const styles = {};
      for (const key of ['width', 'height']) if (Number.isFinite(data[key])) styles[key] = `${Math.round(clamp(data[key], 8, 16384))}px`;
      if (Object.keys(styles).length) commit(entry.doc.id, { nodes: { [data.nodeId]: { styles } } }, { label: `size ${Object.entries(styles).map(([key, value]) => `${key} ${value}`).join(', ')} on ${data.nodeId}`, group }).then(landed).catch(() => {});
      return;
    }
    if (data.kind === 'gap') {
      commit(entry.doc.id, { nodes: { [data.nodeId]: { styles: { gap: `${value}px` } } } }, { label: `gap ${value}px on ${data.nodeId}`, group }).then(landed).catch(() => {});
      return;
    }
    const sides = [...new Set(data.sides)].filter(side => names[side]);
    if (!sides.length) return;
    const styles = Object.fromEntries(sides.map(side => [`${data.kind}-${names[side]}`, `${value}px`]));
    const where = sides.length === 4 ? 'all sides' : sides.map(side => names[side]).join(' + ');
    commit(entry.doc.id, { nodes: { [data.nodeId]: { styles } } }, { label: `${data.kind} ${where} ${value}px on ${data.nodeId}`, group }).then(landed).catch(() => {});
    return;
  }
  if (data.type === 'divlet:handles') {
    // Measurements belong to the render that produced them: an older render's report can arrive after a newer one and would
    // leave the inspector quoting numbers the page no longer has (a pill's radius after its class was removed).
    if (Number.isInteger(data.version) && data.version < entry.renderedVersion) return;
    const source = data.box;
    const sides = key => Array.isArray(source?.[key]) && source[key].length === 4 && source[key].every(Number.isFinite);
    const box = typeof source?.nodeId === 'string' && sides('margin') && sides('padding') ? { nodeId: source.nodeId, margin: [...source.margin], padding: [...source.padding] } : null;
    if (box) {
      if (sides('border') && source.border.every(value => value >= 0)) box.border = [...source.border];
      if (['static', 'relative', 'absolute', 'fixed', 'sticky'].includes(source.position)) box.position = source.position;
      if (Array.isArray(source.inset) && source.inset.length === 4 && source.inset.every(value => typeof value === 'string' && value.length <= 64)) box.inset = [...source.inset];
      if (source.content && ['width', 'height'].every(key => source.content[key] === null || Number.isFinite(source.content[key]) && source.content[key] >= 0)) box.content = { width: source.content.width, height: source.content.height };
      if (source.colors && typeof source.colors === 'object') box.colors = Object.fromEntries(['background', 'color', 'radius', 'fontSize', 'borderColor'].filter(key => typeof source.colors[key] === 'string' && source.colors[key].length <= 64).map(key => [key, source.colors[key]]));
    }
    const changed = JSON.stringify(box) !== JSON.stringify(entry.box ?? null);
    entry.box = box;
    if (changed) emit('spacing-box', { documentId: entry.doc.id, nodeId: box?.nodeId ?? null });
  }
  if (data.type === 'divlet:handles') {
    if (Number.isInteger(data.version) && data.version < entry.renderedVersion) return;
    entry.handlesNode = typeof data.nodeId === 'string' ? data.nodeId : null; entry.handles = Array.isArray(data.rects) ? data.rects.filter(item => typeof item?.id === 'string' && [item.x, item.y, item.w, item.h].every(Number.isFinite)).slice(0, 12) : []; return; }
  if (data.type === 'divlet:reorder' && typeof data.nodeId === 'string' && typeof data.targetId === 'string') {
    // A live reorder belongs to the running grip drag, so it commits in the drag's own undo group. The release message can
    // arrive after the pointer is up, so the drag's group stays known to the frame for a moment (same rule as the pills).
    const dragging = gesture?.type === 'space' && gesture.id === entry.doc.id;
    // The bridge's own messages only ever come from a drag on this document, so its last drag group is the right one even
    // when the message arrives long after the release (a busy main thread must not split a gesture into two undo steps).
    const group = dragging ? gesture.group : entry.spaceGroup;
    const drag = dragging ? gesture : null;
    if (drag) drag.live = true;
    // The reorder commits through the actions layer; it reports back so a cancelled drag only undoes what really landed.
    const committed = () => { if (drag) drag.liveCommitted = true; };
    emit('reorder', { documentId: entry.doc.id, nodeId: data.nodeId, targetId: data.targetId, after: !!data.after, copy: !!data.copy, group, committed });
    return;
  }
  if (data.type === 'divlet:hover-node') { showBadge(entry, data.node && typeof data.node.nodeId === 'string' && data.node.rect ? data.node : null); return; }
  if (data.type === 'divlet:rendered') {
    if (data.version < entry.renderedVersion) return;
    entry.renderedVersion = data.version;
    entry.awaitingVersion = 0;
    entry.placeholder.hidden = true;
    if (data.version >= entry.doc.render) queueCapture(entry);
    if (entry.ghost) requestAnimationFrame(() => requestAnimationFrame(() => dropGhost(entry)));
    setFrameStatus(entry, data.version >= entry.doc.render ? 'live' : 'updating');
    entry.port?.postMessage({ type: 'divlet:inspect', enabled: inspectFlag() });
    syncNodeSelection(entry);
    syncWork(entry);
    if (entry.pendingFlash && entry.pendingFlash.version <= data.version) { postToFrame(entry.doc.id, { type: 'divlet:flash', nodeIds: entry.pendingFlash.nodeIds }); entry.pendingFlash = null; }
    if (entry.pendingScroll) { entry.port?.postMessage(entry.pendingScroll); entry.pendingScroll = null; }
    deliverEdit(entry);
    updateFrame(entry);
  } else if (data.type === 'divlet:observations') {
    if (data.version < entry.renderedVersion) return;
    // `version` here is the render revision the frame shows; the server checks it against the frame's render.
    const report = { documentId: data.documentId, version: data.version, render: data.version, nodes: validNodes(data.nodes) };
    for (const key of ['contentHeight', 'scrollHeight']) if (Number.isFinite(data[key]) && data[key] >= 0 && data[key] < 1e7) report[key] = Math.round(data[key]);
    store.observations.set(data.documentId, report);
    queueObservation(entry, report);
    emit('observations', report);
  } else if (data.type === 'divlet:node-selection') {
    if (data.version < entry.renderedVersion || !Array.isArray(data.nodeIds)) return;
    selectNodes(data.documentId, data.nodeIds.filter(id => typeof id === 'string').slice(0, 50));
  } else if (data.type === 'divlet:override-text' && typeof data.instance === 'string' && typeof data.address === 'string' && typeof data.content === 'string') {
    // Text typed into an instance becomes an override of that instance, never an edit of the component.
    emit('override-text', { documentId: data.documentId, instance: data.instance, address: data.address, content: data.content });
  } else if (data.type === 'divlet:text-edit' && typeof data.nodeId === 'string' && typeof data.content === 'string') {
    edit(data.documentId, { type: 'text', id: data.nodeId, content: data.content }, { label: `edit text of ${data.nodeId}`, expectedRender: Number.isInteger(data.renderVersion) ? data.renderVersion : data.version }).catch(() => {});
  } else if (data.type === 'divlet:render-error' || data.type === 'divlet:error') {
    entry.awaitingVersion = 0;
    setFrameStatus(entry, 'error');
    toast(data.message || 'The preview could not apply this revision.');
  }
}

/* ---- gestures ------------------------------------------------------------- */
function snapMove(ids, dx, dy, startRects) {
  const moving = ids.map(descriptor).filter(Boolean);
  // Snapping is measured from where the drag started, not from a rect a live commit has already moved.
  const origin = new Map(moving.map(doc => [doc.id, startRects?.get(doc.id) ?? doc.artboard]));
  const b = boundsOf(moving.map(doc => ({ ...doc, artboard: origin.get(doc.id) })));
  const others = documents().filter(doc => !ids.includes(doc.id));
  const threshold = 6 / camera.k;
  const lines = [];
  let sx = dx;
  let sy = dy;
  if (others.length && !snapDisabled) {
    for (const [pos, size, cross, crossSize] of [['x', 'width', 'y', 'height'], ['y', 'height', 'x', 'width']]) {
      const delta = pos === 'x' ? dx : dy;
      const edges = [b[pos] + delta, b[pos] + delta + b[size] / 2, b[pos] + delta + b[size]];
      let best = null;
      for (const other of others) {
        const r = other.artboard;
        for (const target of [r[pos], r[pos] + r[size] / 2, r[pos] + r[size]]) for (const edge of edges) {
          const diff = target - edge;
          if (Math.abs(diff) <= threshold && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, target, other };
        }
      }
      if (best) {
        if (pos === 'x') sx = dx + best.diff; else sy = dy + best.diff;
        lines.push({ axis: pos, at: best.target, other: best.other.artboard, cross, crossSize });
      }
    }
  }
  return { dx: Math.round(sx), dy: Math.round(sy), lines, bounds: b };
}
/** Snap resized edges to neighbouring artboards and the moving width to common device widths. */
function snapResize(current, rect) {
  if (snapDisabled) return { rect, lines: [] };
  const threshold = 6 / camera.k;
  const others = documents().filter(doc => doc.id !== current.id).map(doc => doc.artboard);
  const out = { ...rect };
  const lines = [];
  const nearest = (value, targets) => {
    let best = null;
    for (const target of targets) { const diff = target.at - value; if (Math.abs(diff) <= threshold && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { ...target, diff }; }
    return best;
  };
  const edges = axis => others.flatMap(o => (axis === 'x' ? [o.x, o.x + o.width] : [o.y, o.y + o.height]).map(at => ({ at, other: o })));
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (current.dir.includes('e')) {
    const hit = nearest(right, edges('x'));
    const preset = nearest(rect.width, WIDTH_PRESETS.map(at => ({ at })));
    if (preset) out.width = preset.at;
    else if (hit) { out.width = Math.round(hit.at - rect.x); lines.push({ axis: 'x', at: hit.at, other: hit.other }); }
  }
  if (current.dir.includes('w')) {
    const hit = nearest(rect.x, edges('x'));
    const preset = nearest(rect.width, WIDTH_PRESETS.map(at => ({ at })));
    if (preset) { out.width = preset.at; out.x = right - preset.at; }
    else if (hit) { out.x = Math.round(hit.at); out.width = right - out.x; lines.push({ axis: 'x', at: hit.at, other: hit.other }); }
  }
  if (current.dir.includes('s')) {
    const hit = nearest(bottom, edges('y'));
    if (hit) { out.height = Math.round(hit.at - rect.y); lines.push({ axis: 'y', at: hit.at, other: hit.other }); }
  }
  if (current.dir.includes('n')) {
    const hit = nearest(rect.y, edges('y'));
    if (hit) { out.y = Math.round(hit.at); out.height = bottom - out.y; lines.push({ axis: 'y', at: hit.at, other: hit.other }); }
  }
  if (out.width < MIN_SIZE || out.height < MIN_SIZE) return { rect, lines: [] };
  return { rect: out, lines };
}

function drawGuides(lines, rect) {
  guides.replaceChildren();
  for (const line of lines) {
    const node = el('div', `guide guide-${line.axis}`);
    const s = camera;
    if (line.axis === 'x') {
      const x = s.x + line.at * s.k;
      const y0 = s.y + Math.min(line.other.y, rect.y) * s.k;
      const y1 = s.y + Math.max(line.other.y + line.other.height, rect.y + rect.height) * s.k;
      Object.assign(node.style, { left: `${x}px`, top: `${y0}px`, height: `${y1 - y0}px` });
    } else {
      const y = s.y + line.at * s.k;
      const x0 = s.x + Math.min(line.other.x, rect.x) * s.k;
      const x1 = s.x + Math.max(line.other.x + line.other.width, rect.x + rect.width) * s.k;
      Object.assign(node.style, { top: `${y}px`, left: `${x0}px`, width: `${x1 - x0}px` });
    }
    guides.append(node);
  }
}

function applyOverrides(map) {
  overrides.clear();
  for (const [id, rect] of map) { overrides.set(id, rect); emit('live-rect', { id, rect }); }
  for (const entry of entries.values()) {
    place(entry);
    if (!entry.size.querySelector('input')) entry.size.textContent = `${round(rectOf(entry.doc).width)} × ${round(rectOf(entry.doc).height)}`;
  }
}

// Drag steps that reach the project while the gesture runs (the same idea as the bridge's pill drags): the artboard keeps
// its own preview rect, the model and everything built from it follow at most every DRAG_MS, and one group keeps one undo step.
const DRAG_MS = 90;
function liveArtboards(done, items) {
  const stamp = JSON.stringify(items.map(item => [item.id, item.patch]));
  if (done.liveStamp === stamp) return;
  const now = performance.now();
  if (now - (done.liveAt || 0) < DRAG_MS) return;
  done.liveAt = now;
  done.liveStamp = stamp;
  for (const { id, patch, label } of items) {
    const doc = descriptor(id);
    if (!doc) continue;
    // The preview rect stays authoritative for the whole gesture: while a landed commit is being reconciled the model can sit a
    // throttling step behind the pointer, and releasing the override there made the artboard step backwards mid-drag. The
    // release, a cancel and a failed commit all clear it, so it never outlives the gesture.
    pendingOverrides.set(id, { version: Number.POSITIVE_INFINITY });
    commit(id, { artboard: patch }, { label, group: done.group })
      .then(() => { done.liveCommitted = true; })
      .catch(() => { pendingOverrides.delete(id); overrides.delete(id); });
  }
}

function finishOverrides(results) {
  Promise.allSettled(results).then(() => {
    for (const [id, pending] of [...pendingOverrides]) {
      const doc = descriptor(id);
      if (!doc || pending.failed || doc.version >= pending.version) { pendingOverrides.delete(id); overrides.delete(id); }
    }
    reconcileArtboards();
  });
}

function startPan(event) {
  event.preventDefault();
  cancelAnimationFrame(animation);
  gesture = { type: 'pan', pointerId: event.pointerId, x: event.clientX, y: event.clientY, cx: camera.x, cy: camera.y };
  viewport.classList.add('panning');
}

function startPinch() {
  const [a, b] = [...pointers.values()];
  cancelAnimationFrame(animation);
  gesture = { type: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: camera.k, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cx: camera.x, cy: camera.y };
  marquee.hidden = true;
}

// The middle button pans the canvas wherever the board owns the pointer (everywhere but inside
// a page in Play mode, where the page may use it). No browser autoscroll or paste on top of it.
viewport.addEventListener('mousedown', event => { if (event.button === 1 && !store.expanded) event.preventDefault(); });
viewport.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });

viewport.addEventListener('pointerdown', event => {
  if (store.expanded || (event.button !== 0 && event.button !== 1)) return;
  if (event.target.closest('#empty button')) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) { startPinch(); return; }
  if (pointers.size > 2) return;
  // Pressing the canvas takes focus from a field (committing it), so keys act on the board again.
  const active = document.activeElement;
  if (active && active !== viewport && active !== document.body) active.blur?.();
  viewport.focus({ preventScroll: true });
  viewport.setPointerCapture(event.pointerId);
  snapDisabled = event.altKey;
  if (spaceDown || event.button === 1) return startPan(event);
  const handle = event.target.closest('.ab-handle');
  const wrapper = event.target.closest('.artboard');
  if (handle && wrapper) {
    const entry = entries.get(wrapper.dataset.artboardId);
    event.preventDefault();
    gesture = { type: 'resize', pointerId: event.pointerId, dir: handle.dataset.dir, id: entry.doc.id, start: { ...entry.doc.artboard }, x: event.clientX, y: event.clientY, group: newGroup() };
    entry.el.classList.add('resizing');
    return;
  }
  const grab = event.target.closest('.ab-label, .frame-cover');
  if (grab && wrapper && !event.target.closest('.ab-expand, .ab-more, .ab-rename')) {
    const id = wrapper.dataset.artboardId;
    event.preventDefault();
    const onName = !!event.target.closest('.ab-name');
    const onSize = !!event.target.closest('.ab-size');
    const onPage = grab.classList.contains('frame-cover');
    // A side pill of the selected element (margin or padding) is dragged instead of the artboard.
    const pill = onPage ? spaceHandleAt(entries.get(id), event) : null;
    if (pill) {
      // One group for the whole drag: the live commits and the release fold into a single undo step.
      gesture = { type: 'space', pointerId: event.pointerId, id, x: event.clientX, y: event.clientY, group: newGroup() };
      entries.get(id).port.postMessage({ type: 'divlet:space-drag', phase: 'start', id: pill });
      return;
    }
    if (!event.shiftKey && doubleTap(event, `${onName ? 'name' : onSize ? 'size' : onPage ? 'cover' : 'label'}:${id}`)) {
      const entry = entries.get(id);
      if (onName) renameArtboard(entry);
      else if (onSize) editSize(entry);
      else if (onPage) editAt(entry, event);
      else fit([id]);
      gesture = { type: 'idle', pointerId: event.pointerId };
      return;
    }
    // On the page: a click picks the element under the pointer, a drag moves the artboard.
    if (onPage) {
      gesture = { type: 'press', pointerId: event.pointerId, x: event.clientX, y: event.clientY, id, additive: event.shiftKey || event.metaKey || event.ctrlKey, group: newGroup() };
      return;
    }
    if (event.shiftKey) {
      if (store.selected.has(id)) selectArtboards([...store.selected].filter(item => item !== id));
      else selectArtboards([id], { additive: true });
      gesture = { type: 'idle', pointerId: event.pointerId };
      return;
    }
    const wasSelected = store.selected.has(id);
    if (!wasSelected) selectArtboards([id]);
    const ids = [...store.selected];
    // Where every moving artboard started: live commits re-publish the model, so deltas are measured from here, not from it.
    const startRects = new Map(ids.map(item => [item, { ...rectOf(descriptor(item) || { artboard: {} }) }]));
    gesture = { type: 'move', pointerId: event.pointerId, x: event.clientX, y: event.clientY, id, ids, wasSelected, moved: false, group: newGroup(), startRects };
    return;
  }
  if (store.mode === 'select' && !wrapper) {
    event.preventDefault();
    store.node = null;
    const b = viewport.getBoundingClientRect();
    gesture = { type: 'marquee', pointerId: event.pointerId, start: { x: event.clientX - b.left, y: event.clientY - b.top }, end: { x: event.clientX - b.left, y: event.clientY - b.top }, initial: event.shiftKey ? [...store.selected] : [] };
    return;
  }
  if (!wrapper) startPan(event);
});

viewport.addEventListener('pointermove', event => {
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (gesture?.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const bounds = viewport.getBoundingClientRect();
    const k = clamp(gesture.k * distance / gesture.distance, MIN_K, MAX_K);
    const ratio = k / gesture.k;
    const px = gesture.mid.x - bounds.left;
    const py = gesture.mid.y - bounds.top;
    setCamera({ k, x: px - (px - gesture.cx) * ratio + (mid.x - gesture.mid.x), y: py - (py - gesture.cy) * ratio + (mid.y - gesture.mid.y) });
    return;
  }
  if (!gesture) {
    const cover = event.target.closest?.('.frame-cover');
    const wrapper = cover?.closest('.artboard');
    const pillId = wrapper ? spaceHandleAt(entries.get(wrapper.dataset.artboardId), event) : null;
    viewport.title = pillId ? handleHint(pillId) : '';
    viewport.style.cursor = pillId ? (pillId === 'move' ? 'grab' : pillId === 'size' ? 'nwse-resize' : /-(?:[lr]|x)$/.test(pillId) ? 'ew-resize' : 'ns-resize') : '';
    if (wrapper && store.mode === 'select' && !wrapper.classList.contains('editing') && !pillId) hoverAt(entries.get(wrapper.dataset.artboardId), event);
    else if (hoverEntry) { clearHover(); hideBadge(); }
    return;
  }
  if (gesture.pointerId !== event.pointerId) return;
  if (gesture.type === 'press') {
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 4) return;
    clearHover();
    hideBadge();
    const { id } = gesture;
    const wasSelected = store.selected.has(id);
    if (!wasSelected) selectArtboards([id]);
    // Where every moving artboard started: a live commit re-publishes the model, so deltas must be measured from here.
    const startRects = new Map([...store.selected].map(item => [item, { ...rectOf(descriptor(item) || { artboard: {} }) }]));
    gesture = { type: 'move', pointerId: gesture.pointerId, x: gesture.x, y: gesture.y, id, ids: [...store.selected], wasSelected, moved: false, group: gesture.group, startRects };
  }
  if (gesture.type === 'space') {
    entries.get(gesture.id)?.port.postMessage({ type: 'divlet:space-drag', phase: 'move', dx: (event.clientX - gesture.x) / camera.k, dy: (event.clientY - gesture.y) / camera.k, ...pagePoint(gesture.id, event), shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey, alt: event.altKey });
    return;
  }
  if (gesture.type === 'pan') {
    setCamera({ x: gesture.cx + event.clientX - gesture.x, y: gesture.cy + event.clientY - gesture.y });
  } else if (gesture.type === 'move') {
    const dist = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
    if (!gesture.moved && dist < 4) return;
    gesture.moved = true;
    viewport.classList.add('moving');
    snapDisabled = event.altKey;
    const raw = { dx: (event.clientX - gesture.x) / camera.k, dy: (event.clientY - gesture.y) / camera.k };
    // Every rect is measured from where the drag started, never from the model a live commit has already moved.
    const origin = id => gesture.startRects?.get(id) ?? descriptor(id).artboard;
    const snapped = snapMove(gesture.ids, raw.dx, raw.dy, gesture.startRects);
    const map = new Map();
    for (const id of gesture.ids) { const a = origin(id); map.set(id, { ...a, x: a.x + snapped.dx, y: a.y + snapped.dy }); }
    gesture.delta = snapped;
    applyOverrides(map);
    liveArtboards(gesture, [...gesture.ids].map(id => { const a = origin(id); return { id, patch: { x: Math.round(a.x + snapped.dx), y: Math.round(a.y + snapped.dy) }, label: gesture.ids.length > 1 ? `move ${gesture.ids.length} artboards` : 'move artboard' }; }));
    drawGuides(snapped.lines, { x: snapped.bounds.x + snapped.dx, y: snapped.bounds.y + snapped.dy, width: snapped.bounds.width, height: snapped.bounds.height });
  } else if (gesture.type === 'resize') {
    const s = gesture.start;
    const dx = (event.clientX - gesture.x) / camera.k;
    const dy = (event.clientY - gesture.y) / camera.k;
    let { x, y, width, height } = s;
    if (gesture.dir.includes('e')) width = Math.max(MIN_SIZE, s.width + dx);
    if (gesture.dir.includes('s')) height = Math.max(MIN_SIZE, s.height + dy);
    if (gesture.dir.includes('w')) { width = Math.max(MIN_SIZE, s.width - dx); x = s.x + s.width - width; }
    if (gesture.dir.includes('n')) { height = Math.max(MIN_SIZE, s.height - dy); y = s.y + s.height - height; }
    snapDisabled = event.altKey;
    const snapped = snapResize(gesture, { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
    gesture.rect = snapped.rect;
    applyOverrides(new Map([[gesture.id, snapped.rect]]));
    const patch = {};
    for (const key of ['x', 'y', 'width', 'height']) if (snapped.rect[key] !== gesture.start[key]) patch[key] = snapped.rect[key];
    if (Object.keys(patch).length) liveArtboards(gesture, [{ id: gesture.id, patch, label: 'resize artboard' }]);
    drawGuides(snapped.lines, snapped.rect);
  } else if (gesture.type === 'marquee') {
    gesture.end = { x: event.clientX - viewport.getBoundingClientRect().left, y: event.clientY - viewport.getBoundingClientRect().top };
    const r = { x: Math.min(gesture.start.x, gesture.end.x), y: Math.min(gesture.start.y, gesture.end.y), width: Math.abs(gesture.end.x - gesture.start.x), height: Math.abs(gesture.end.y - gesture.start.y) };
    marquee.hidden = false;
    Object.assign(marquee.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
    const ids = documents().filter(doc => {
      const s = screenRect(rectOf(doc));
      return s.x <= r.x + r.width && s.x + s.width >= r.x && s.y - 24 <= r.y + r.height && s.y + s.height >= r.y;
    }).map(doc => doc.id);
    store.selected = new Set([...gesture.initial, ...ids]);
    for (const [id, entry] of entries) entry.el.classList.toggle('selected', store.selected.has(id));
  }
});

/** The editing handles on the selected element (spacing, gap, size, grip) are a preference; the pages are told when it changes. */
export function editHandles() {
  try { return localStorage.getItem('divlet:handles') !== 'off'; } catch { return true; }
}
export function setEditHandles(enabled) {
  try { if (enabled) localStorage.removeItem('divlet:handles'); else localStorage.setItem('divlet:handles', 'off'); } catch {}
  for (const entry of entries.values()) entry.port?.postMessage({ type: 'divlet:handles-enabled', enabled });
}

/** The page's measured CSS box (edges, offsets and untransformed content size), or null. */
export function measuredBox(documentId, nodeId) {
  const box = entries.get(documentId)?.box;
  return box && box.nodeId === nodeId ? box : null;
}

/** What a pill does, for the browser's tooltip while the pointer rests on it. */
function handleHint(id) {
  const names = { t: 'top', r: 'right', b: 'bottom', l: 'left' };
  if (id === 'move') return 'Drag to move this element before or after another · Alt copies';
  if (id === 'size') return 'Drag to resize · Shift width only · Ctrl height only · Alt 1px steps';
  const [kind, side] = id.split('-');
  if (kind === 'gap') return 'Drag to change the gap between children · Alt 1px steps';
  return `Drag to change the ${names[side]} ${kind} · Shift all sides · Ctrl opposite side · Alt 1px steps`;
}

/** The pointer in the page's own coordinates (the frame is scaled by the camera). */
function pagePoint(id, event) {
  const frame = entries.get(id)?.iframe.getBoundingClientRect();
  return frame ? { x: (event.clientX - frame.left) / camera.k, y: (event.clientY - frame.top) / camera.k } : {};
}

/** The id of the margin/padding pill (reported by the page's bridge) under the pointer, or null. */
function spaceHandleAt(entry, event) {
  if (!entry?.handles?.length || store.mode !== 'select') return null;
  const frame = entry.iframe.getBoundingClientRect();
  const x = (event.clientX - frame.left) / camera.k, y = (event.clientY - frame.top) / camera.k;
  // Zoomed out, a pill is a few screen pixels: its hit area grows so that it is at least 16 screen pixels across.
  const grow = item => Math.max(0, (16 / camera.k - Math.min(item.w, item.h)) / 2);
  return entry.handles.find(item => { const g = grow(item); return x >= item.x - g && x <= item.x + item.w + g && y >= item.y - g && y <= item.y + item.h + g; })?.id ?? null;
}

/**
 * After a pill drag: the dragged frame held its preview while the pointer was down, so let it catch up once the final
 * commit has landed (the drag's own last commit may still be in flight when the pointer comes up).
 */
function releaseDragFrame(id) {
  // The drag's last commit may still be queued; the frame catches up once the queue is empty.
  idle(id).then(() => {
    const entry = entries.get(id);
    if (entry && !gesture) updateFrame(entry);
  });
  for (const delay of [120, 600]) {
    setTimeout(() => {
      const entry = entries.get(id);
      if (entry && !gesture) updateFrame(entry);
    }, delay);
  }
}

function endGesture(event) {
  pointers.delete(event.pointerId);
  if (gesture?.type === 'pinch') { if (pointers.size < 2) gesture = null; return; }
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  const done = gesture;
  gesture = null;
  viewport.classList.remove('panning', 'moving');
  guides.replaceChildren();
  marquee.hidden = true;
  if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  if (done.type === 'space') {
    const entry = entries.get(done.id);
    entry?.port.postMessage({ type: 'divlet:space-drag', phase: 'end' });
    if (entry) entry.spaceGroup = done.group;
    releaseDragFrame(done.id);
  } else if (done.type === 'press') {
    const entry = entries.get(done.id);
    if (entry) pickAt(entry, event, done.additive);
  } else if (done.type === 'marquee') {
    const dist = Math.hypot(done.end.x - done.start.x, done.end.y - done.start.y);
    selectArtboards(dist < 3 ? done.initial : [...store.selected]);
  } else if (done.type === 'move') {
    if (!done.moved) {
      if (done.wasSelected && done.ids.length > 1) selectArtboards([done.id]);
      return;
    }
    const { dx, dy } = done.delta || { dx: 0, dy: 0 };
    const results = [];
    for (const id of done.ids) {
      const doc = descriptor(id), from = done.startRects?.get(id) ?? doc?.artboard;
      if (!doc || !from || (!dx && !dy)) continue;
      const next = { x: Math.round(from.x + dx), y: Math.round(from.y + dy) };
      // The live commits already put it there: a second identical patch would only add a "no change" history row.
      if (doc.artboard.x === next.x && doc.artboard.y === next.y) { pendingOverrides.delete(id); overrides.delete(id); continue; }
      pendingOverrides.set(id, { version: doc.version + 1 });
      results.push(commit(id, { artboard: next }, { label: done.ids.length > 1 ? `move ${done.ids.length} artboards` : 'move artboard', group: done.group }).then(result => { pendingOverrides.set(id, { version: result.version }); }, () => { pendingOverrides.get(id).failed = true; }));
    }
    if (!results.length) { overrides.clear(); reconcileArtboards(); return; }
    finishOverrides(results);
  } else if (done.type === 'resize') {
    const entry = entries.get(done.id);
    entry?.el.classList.remove('resizing');
    const rect = done.rect;
    if (!rect) return;
    const patch = {};
    for (const key of ['x', 'y', 'width', 'height']) if (rect[key] !== done.start[key]) patch[key] = rect[key];
    if (!Object.keys(patch).length) { overrides.clear(); reconcileArtboards(); return; }
    const doc = descriptor(done.id);
    pendingOverrides.set(done.id, { version: (doc?.version ?? 0) + 1 });
    finishOverrides([commit(done.id, { artboard: patch }, { label: 'resize artboard', group: done.group }).then(result => { pendingOverrides.set(done.id, { version: result.version }); }, () => { pendingOverrides.get(done.id).failed = true; })]);
  }
}
viewport.addEventListener('pointerup', endGesture);
viewport.addEventListener('pointerleave', () => { if (!gesture) { clearHover(); hideBadge(); } });
viewport.addEventListener('pointercancel', endGesture);

/** Escape during a drag puts everything back where it was. */
function cancelGesture() {
  if (!gesture || !['move', 'resize', 'marquee', 'space'].includes(gesture.type)) return false;
  const done = gesture;
  if (done.type === 'space') {
    const entry = entries.get(done.id);
    entry?.port.postMessage({ type: 'divlet:space-drag', phase: 'cancel' });
    if (entry) entry.spaceGroup = done.group;
    releaseDragFrame(done.id);
  }
  gesture = null;
  if (done.pointerId !== undefined && viewport.hasPointerCapture(done.pointerId)) viewport.releasePointerCapture(done.pointerId);
  pointers.clear();
  viewport.classList.remove('panning', 'moving');
  entries.get(done.id)?.el.classList.remove('resizing');
  guides.replaceChildren();
  marquee.hidden = true;
  if (done.type === 'marquee') { store.selected = new Set(done.initial); updateSelectionClasses(); }
  else {
    const ids = done.ids ?? (done.id ? [done.id] : []);
    for (const id of ids) {
      pendingOverrides.delete(id);
      // The group was just undone; a message trailing the cancelled drag must not open a new step in it.
      if (entries.get(id)) entries.get(id).spaceGroup = null;
    }
    // The preview goes at once: Escape must not leave the artboard floating at the dragged position while the undo travels, and
    // a gesture starting in that window would snapshot the preview instead of the model.
    const settle = () => { overrides.clear(); reconcileArtboards(); };
    settle();
    if (done.live || done.liveAt) {
      // The drag's commits may still be queued: undoing before they land would revert the previous, unrelated step and then
      // let this drag's commit arrive as a new one. Wait for the queue, and undo only if a live commit actually landed.
      Promise.all(ids.map(id => idle(id)))
        .then(() => (done.liveCommitted ? undo() : null))
        .then(settle, settle);
    }
  }
  return true;
}

viewport.addEventListener('contextmenu', event => {
  event.preventDefault();
  if (store.expanded || gesture?.type === 'move' || gesture?.type === 'resize') return;
  const wrapper = event.target.closest('.artboard');
  if (wrapper) {
    const id = wrapper.dataset.artboardId;
    const entry = entries.get(id);
    // The menu is about what is selected: with the artboard itself selected (or nothing yet) it is the
    // artboard's menu (Delete, Duplicate, Rename…); once an element of it is selected, right-clicking
    // the page opens that element's menu (the page selects what is under the pointer and answers).
    const inside = store.node?.documentId === id && store.node.nodeIds.length > 0;
    const at = inside && event.target.closest('.frame-cover') && store.mode === 'select' ? framePoint(entry, event) : null;
    if (!store.selected.has(id)) selectArtboards([id]);
    if (at) postToFrame(id, { type: 'divlet:context-at', ...at });
    else emit('context', { kind: 'artboard', id, x: event.clientX, y: event.clientY });
  } else emit('context', { kind: 'canvas', x: event.clientX, y: event.clientY, world: worldPoint(event.clientX, event.clientY) });
});

/* ---- dropping images from the desktop -------------------------------------- */
const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
let dropTarget = null;
function setDropTarget(entry) {
  if (dropTarget === entry) return;
  dropTarget?.el.classList.remove('drop-target');
  dropTarget = entry;
  dropTarget?.el.classList.add('drop-target');
}
viewport.addEventListener('dragover', event => {
  if (!hasFiles(event) || store.expanded) return;
  event.preventDefault();
  const wrapper = event.target.closest?.('.artboard');
  setDropTarget(wrapper ? entries.get(wrapper.dataset.artboardId) : null);
  event.dataTransfer.dropEffect = wrapper ? 'copy' : 'none';
});
viewport.addEventListener('dragleave', event => { if (!viewport.contains(event.relatedTarget)) setDropTarget(null); });
viewport.addEventListener('drop', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  const entry = dropTarget;
  setDropTarget(null);
  const files = [...event.dataTransfer.files].filter(file => file.type.startsWith('image/'));
  if (!files.length) { toast('Only images can be dropped onto an artboard'); return; }
  if (!entry) { toast('Drop images onto an artboard'); return; }
  emit('images', { documentId: entry.doc.id, files });
});
window.addEventListener('dragover', event => { if (hasFiles(event) && !viewport.contains(event.target)) { event.preventDefault(); event.dataTransfer.dropEffect = 'none'; } });
window.addEventListener('drop', event => { if (hasFiles(event) && !viewport.contains(event.target)) event.preventDefault(); });

viewport.addEventListener('wheel', event => {
  if (store.expanded) return;
  event.preventDefault();
  cancelAnimationFrame(animation);
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
  if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-clamp(event.deltaY * unit, -120, 120) * (event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 20 ? 0.01 : 0.0022)), event.clientX, event.clientY);
  else setCamera({ x: camera.x - (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit, y: camera.y - (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit });
}, { passive: false });
// Page zoom must never rescale the interface: Ctrl+wheel anywhere zooms the canvas only.
window.addEventListener('wheel', event => { if ((event.ctrlKey || event.metaKey) && !viewport.contains(event.target)) event.preventDefault(); }, { passive: false });

window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && cancelGesture()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
  if (event.code === 'Space' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target.isContentEditable || event.target.closest?.('button, summary, select, a[href]')) && !store.expanded) {
    spaceDown = true;
    viewport.classList.add('space-ready');
    event.preventDefault();
  }
});
window.addEventListener('keyup', event => { if (event.code === 'Space') { spaceDown = false; viewport.classList.remove('space-ready'); } });
// A window that loses focus mid-gesture gets no pointerup: cancel it properly (cancel the page's drag, drop the previews and
// undo what the gesture already committed), otherwise a stale preview rect would outlive the gesture and later be written back.
window.addEventListener('blur', () => {
  spaceDown = false;
  viewport.classList.remove('space-ready', 'panning', 'moving');
  if (cancelGesture()) return;
  // No gesture to cancel: leave previews that belong to something else (an arrow-key nudge) alone.
  if (!gesture) { pointers.clear(); return; }
  gesture = null;
  pointers.clear();
  marquee.hidden = true;
  guides.replaceChildren();
});

// Arrow-key nudges in quick succession form one undo step; positions accumulate locally so fast repeats never lose a step.
let nudging = { group: null, at: 0, targets: new Map() };
export function nudge(dx, dy, ids = [...store.selected]) {
  const now = performance.now();
  if (now - nudging.at > 800) nudging = { group: newGroup(), at: now, targets: new Map() };
  nudging.at = now;
  for (const id of ids) {
    const doc = descriptor(id);
    if (!doc) continue;
    const from = nudging.targets.get(id) || rectOf(doc);
    const next = { ...doc.artboard, x: from.x + dx, y: from.y + dy };
    nudging.targets.set(id, next);
    overrides.set(id, next);
    pendingOverrides.set(id, { version: Infinity });
    const entry = entries.get(id);
    if (entry) { place(entry); emit('live-rect', { id, rect: next }); }
    commit(id, { artboard: { x: next.x, y: next.y } }, { label: ids.length > 1 ? `nudge ${ids.length} artboards` : 'nudge artboard', group: nudging.group })
      .then(result => { if (nudging.targets.get(id) === next) pendingOverrides.set(id, { version: result.version }); })
      .catch(() => { pendingOverrides.delete(id); overrides.delete(id); nudging.targets.delete(id); })
      .finally(() => reconcileArtboards());
  }
}

export function disposeCanvas() {
  visibility.disconnect();
  for (const entry of entries.values()) unmount(entry);
}

on('state', () => {
  reconcileArtboards();
  for (const entry of entries.values()) {
    syncWork(entry);
    entry.port?.postMessage({ type: 'divlet:writable', enabled: store.state?.project?.capabilities?.properties === true });
  }
});
on('selection', detail => updateSelectionClasses(detail));
on('rename-artboard', id => { const entry = entries.get(id); if (entry) renameArtboard(entry); });
