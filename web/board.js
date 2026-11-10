import { $, el, icon, button, clamp, keys, shortcutKey, uiScale } from './lib/util.js';
import { store, on, emit, documents, descriptor, apiUrl, request, receiveState, setConnection, selectArtboards, selectNodes, undo, redo, toast } from './lib/store.js';
import * as canvas from './lib/canvas.js';
import './lib/inspector.js';
import { loadClientPlugins } from './lib/panels.js';
import * as layers from './lib/layers.js';
import * as activity from './lib/activity.js';
import * as sidebar from './lib/sidebar.js';
import * as actions from './lib/actions.js';
import * as help from './lib/help.js';
import * as shortcuts from './lib/shortcuts.js';
import * as ask from './lib/ask.js';
import * as palette from './lib/palette.js';
import * as clip from './lib/clip.js';
import * as project from './lib/project.js';
import './lib/crumbbar.js';
import './lib/expandbar.js';
import { resizable } from './lib/resize.js';
import { openMenu, menuOpen, closeMenu } from './lib/menu.js';

const { entries } = canvas;
const viewport = $('#viewport');
// Opening a sidebar over the selected artboard brings that artboard back into the clear part of the canvas.
on('sidebar', ({ open }) => { if (open) setTimeout(() => canvas.revealSelection(), 180); });

/* ---- dock ----------------------------------------------------------------- */
const dock = $('#dock');
// The dock wraps on narrow screens; the inspector sits on top of its real height, never under it.
new ResizeObserver(() => {
  // A hidden dock measures 0: fall back to the stylesheet's one-row height rather than letting the inspector sit on nothing.
  const height = Math.round(dock.getBoundingClientRect().height / uiScale());
  if (height > 0) document.documentElement.style.setProperty('--dock-h', `${height}px`);
  else document.documentElement.style.removeProperty('--dock-h');
}).observe(dock);
const modeButtons = [['select', 'select', 'Select artboards and elements · V'], ['interact', 'play', 'Interact with the page · P']].map(([mode, name, tip]) => {
  const node = button(name, tip, () => canvas.setMode(mode), 'mode');
  node.dataset.mode = mode;
  return node;
});
const zoomOut = button('minus', 'Zoom out · −', () => canvas.zoomAt(1 / 1.25, undefined, undefined, { animate: true }), 'zoom-step');
const zoomValue = el('button', 'zoom');
zoomValue.id = 'zoom-value';
zoomValue.type = 'button';
zoomValue.dataset.tip = 'Zoom options';
zoomValue.setAttribute('aria-label', 'Zoom options');
zoomValue.setAttribute('aria-haspopup', 'menu');
zoomValue.addEventListener('click', () => openMenu([
  ...[0.25, 0.5, 1, 2].map(k => ({ label: `${k * 100}%`, checked: Math.abs(canvas.camera.k - k) < 0.005, keys: k === 1 ? '0' : undefined, run: () => canvas.zoomTo(k) })),
  '-',
  { label: 'Zoom in', icon: 'plus', keys: '+', run: () => canvas.zoomAt(1.25, undefined, undefined, { animate: true }) },
  { label: 'Zoom out', icon: 'minus', keys: '−', run: () => canvas.zoomAt(1 / 1.25, undefined, undefined, { animate: true }) },
  { label: 'Fit everything', icon: 'fit', keys: keys('Shift+1'), disabled: !documents().length, run: () => canvas.fit(null) },
  { label: 'Zoom to selection', icon: 'fit', keys: keys('Shift+2'), disabled: !store.selected.size, run: () => fitSelection() },
], { anchor: zoomValue, label: 'Zoom' }));
const zoomIn = button('plus', 'Zoom in · +', () => canvas.zoomAt(1.25, undefined, undefined, { animate: true }), 'zoom-step');
const undoButton = button('undo', `Undo · ${keys('Mod+Z')}`, () => undo());
const redoButton = button('redo', `Redo · ${keys('Mod+Shift+Z')}`, () => redo());
const helpButton = button('gear', `Settings · ${keys('Mod')} ,`, () => help.toggle());
helpButton.id = 'dock-help';
const siteLink = el('a', 'tool');
siteLink.id = 'open-site';
siteLink.href = './site/';
siteLink.target = '_blank';
siteLink.rel = 'noopener';
siteLink.setAttribute('aria-label', 'Open site');
siteLink.hidden = true;
const sep = () => el('i', 'sep');
// Bottom right: pointer modes, zoom, undo/redo and settings. Fit and zoom-to-selection live in the zoom menu and shortcuts.
dock.append(...modeButtons, sep(), zoomOut, zoomValue, zoomIn, sep(), undoButton, redoButton, sep(), siteLink, helpButton);

const paletteButton = $('#palette-open');
paletteButton.prepend(icon('search'));
$('#palette-keys').textContent = keys('Mod+K');
paletteButton.dataset.tip = `Search commands, artboards and elements · ${keys('Mod+K')}`;
paletteButton.addEventListener('click', () => palette.toggle(true));
on('palette', open => palette.toggle(open));

on('mode', mode => {
  for (const node of modeButtons) { node.classList.toggle('on', node.dataset.mode === mode); node.setAttribute('aria-pressed', String(node.dataset.mode === mode)); }
  document.body.dataset.canvasMode = mode;
});
canvas.setMode('select');

function paintHistory() {
  const head = store.state?.history;
  undoButton.disabled = !head?.canUndo;
  redoButton.disabled = !head?.canRedo;
  undoButton.dataset.tip = head?.undoLabel ? `Undo ${head.undoLabel} · ${keys('Mod+Z')}` : 'Nothing to undo';
  redoButton.dataset.tip = head?.redoLabel ? `Redo ${head.redoLabel} · ${keys('Mod+Shift+Z')}` : 'Nothing to redo';
}

/* The corner: panels on the left of the search, the project indicator that turns into Back. */
$('#status-dot').append(icon('divlet'));
$('#open-layers').prepend(icon('layers'));
$('#open-history').prepend(icon('clock'));
$('#open-agent').prepend(icon('sparkle'));
$('#open-layers').addEventListener('click', () => sidebar.toggle('layers'));
$('#open-history').addEventListener('click', () => sidebar.toggle('activity'));
$('#open-agent').addEventListener('click', () => sidebar.toggle('agent'));
$('#expanded-back').prepend(icon('back'));
$('#status').setAttribute('aria-haspopup', 'menu');
$('#status').addEventListener('click', () => {
  openMenu([
    { heading: String(store.state?.project?.name || 'Project') },
    { label: 'Open project…', icon: 'folder', keys: keys('Mod+O'), run: () => project.show('open') },
    { label: 'Save a copy as…', icon: 'download', disabled: !project.canShowCopy(), keys: keys('Mod+Shift+S'), run: () => project.show('save') },
    '-',
    { label: 'Copy project folder path', icon: 'copy', run: () => actions.copyText(String(store.state?.projectDir || ''), 'Folder path copied') },
  ], { anchor: $('#status'), label: 'Project' });
});
$('#empty-new').addEventListener('click', () => actions.newArtboard());

/* ---- site link ------------------------------------------------------------ */
siteLink.append(icon('site'));
$('#expanded-open-site').append(icon('site'));

on('state', state => {
  $('#loading').hidden = true;
  $('#status').setAttribute('aria-label', 'Project status');
  $('#empty').hidden = state.documents.length !== 0;
  siteLink.hidden = !state.site;
  if (state.site) { siteLink.href = state.site.url; siteLink.dataset.tip = `Open “${state.site.title || 'site'}” · ${state.site.routes.length} page${state.site.routes.length === 1 ? '' : 's'}`; }
  if (store.expanded) {
    const doc = descriptor(store.expanded.entry.doc.id);
    if (!doc) canvas.closeExpanded({ reset: false });
    else {
      $('#expanded-title').textContent = doc.name || doc.id;
      $('#expanded-open-site').hidden = !state.site;
      if (state.site) store.expanded.entry.iframe?.contentWindow.postMessage({ type: 'divlet:site-state', site: { version: state.site.version } }, '*');
    }
  }
  const source = String(state.project?.file || '').replaceAll('\\', '/');
  const filename = source.split('/').at(-1);
  const folder = String(state.projectDir || state.cwd || '').replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || 'divlet';
  const label = filename && filename !== 'project.divlet' ? filename.replace(/\.(?:divlet|pen)$/i, '') : folder;
  // Named sources must remain distinguishable when several projects share a folder.
  document.title = `${label} · divlet`;
  $('#status').dataset.project = label;
  paintHistory();
});

/* ---- toast ---------------------------------------------------------------- */
const toastNode = $('#toast');
let toastTimer;
let toastId = null;
const hideToast = () => { clearTimeout(toastTimer); toastNode.hidden = true; toastId = null; };
let toastDuration = 0;
on('toast', ({ message, action, sticky, id }) => {
  const text = el('span', 'toast-msg', message);
  toastNode.replaceChildren(text);
  if (action) {
    const run = el('button', 'toast-action', action.label);
    run.type = 'button';
    run.addEventListener('click', () => { hideToast(); action.run(); });
    toastNode.append(run);
  }
  const close = el('button', 'toast-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.append(icon('close'));
  close.addEventListener('click', hideToast);
  toastNode.append(close);
  toastNode.hidden = false;
  toastNode.classList.remove('pop');
  void toastNode.offsetWidth;
  toastNode.classList.add('pop');
  toastId = id ?? null;
  $('#sr').textContent = message;
  clearTimeout(toastTimer);
  toastDuration = sticky ? 0 : action ? 7000 : 4000;
  if (toastDuration) toastTimer = setTimeout(hideToast, toastDuration);
});
on('toast-clear', id => { if (toastId === id) hideToast(); });
toastNode.addEventListener('pointerenter', () => clearTimeout(toastTimer));
toastNode.addEventListener('pointerleave', () => { if (toastDuration && !toastNode.hidden) toastTimer = setTimeout(hideToast, 2500); });

/* ---- context menus -------------------------------------------------------- */
on('context', ({ kind, id, x, y, anchor, world }) => {
  const position = anchor ? { anchor } : { x, y };
  if (kind === 'artboard') actions.artboardMenu(id, position);
  else if (kind === 'node') actions.nodeMenu(id, position);
  else actions.canvasMenu(position, world);
});

/* ---- selection commands --------------------------------------------------- */
const nodeSelection = () => (store.node?.nodeIds.length ? store.node : null);

function deleteSelection() {
  const node = nodeSelection();
  if (node) return actions.deleteNodes(node.documentId, node.nodeIds);
  if (store.selected.size) return actions.deleteArtboards([...store.selected]);
}

function duplicateSelection() {
  const node = nodeSelection();
  if (node) return actions.duplicateNodes(node.documentId, node.nodeIds);
  if (store.selected.size) return actions.duplicateArtboards([...store.selected]);
}

function fitSelection() {
  const node = nodeSelection();
  if (node) canvas.fitNode(node.documentId, node.nodeIds[0]);
  else if (store.selected.size) canvas.fit([...store.selected]);
  else canvas.fit(null);
}
on('fit-selection', fitSelection);

/* ---- keyboard ------------------------------------------------------------- */
/** Keys that also navigate focus (Enter, Tab, arrows) are only ours when the canvas — not a control — has focus. */
const onCanvas = event => !event.target || event.target === document.body || event.target === viewport || event.target.classList?.contains('artboard');

function handleKey(event) {
  const prevent = () => event.preventDefault?.();
  const key = shortcutKey(event);
  const mod = event.ctrlKey || event.metaKey;
  if (store.expanded) { if (key === 'escape') { prevent(); canvas.closeExpanded(); } return true; }
  // A preview frame may still have focus for a moment after the Ask Pi field opened.
  if (event.fromFrame && ask.isOpen() && !mod && !event.altKey && (String(event.key).length === 1 || event.key === 'Backspace')) return ask.typeAhead(event.key);
  if (event.fromFrame && ask.isOpen() && key === 'enter' && !event.shiftKey) { ask.submit(); return true; }
  if (project.isOpen()) return false;
  if (help.isOpen()) { if (key === 'escape') { prevent(); help.toggle(false); return true; } return false; }
  if (shortcuts.isOpen()) { if (key === 'escape' || key === '?') { prevent(); shortcuts.toggle(false); return true; } return false; }
  if (palette.isOpen()) { if (key === 'escape') { prevent(); palette.toggle(false); return true; } return false; }
  if (menuOpen()) { if (key === 'escape') { prevent(); closeMenu(); return true; } return false; }
  if (mod && event.altKey && (key === '=' || key === '+' || key === '-')) { prevent(); help.stepUiSize(key === '-' ? -1 : 1); return true; }
  if (mod && !event.altKey && !event.shiftKey && (key === ',' || event.code === 'Comma')) { prevent(); help.toggle(true); return true; }
  if (mod && !event.altKey && key === 'o') { prevent(); project.show('open'); return true; }
  if (mod && event.shiftKey && !event.altKey && key === 's') { prevent(); project.show('save'); return true; }
  if (mod && !event.altKey && key === 'k') { prevent(); palette.toggle(true); return true; }
  // Copy, cut and paste from the board run through the native clipboard events (see clip.js);
  // keys forwarded by a preview frame have no clipboard event, so they act on the board's own copy.
  if (mod && !event.altKey && (key === 'c' || key === 'x' || key === 'v')) {
    if (!event.fromFrame) return false;
    if (key === 'v') clip.paste();
    else clip.copySelection({ cut: key === 'x' });
    return true;
  }
  const node = nodeSelection();
  const single = store.selected.size === 1 ? [...store.selected][0] : null;
  if (mod) {
    if (key === 'z') { prevent(); event.shiftKey ? redo() : undo(); }
    else if (key === 'y') { prevent(); redo(); }
    else if (key === 'd') { prevent(); duplicateSelection(); }
    else if (key === 'a') { prevent(); selectArtboards(documents().map(doc => doc.id)); }
    else if (key === 'g') {
      prevent();
      if (!node) return true;
      if (event.shiftKey) actions.unwrapNode(node.documentId, node.nodeIds[0]);
      else actions.wrapNodes(node.documentId, node.nodeIds);
    } else if (key === '=' || key === '+') { prevent(); canvas.zoomAt(1.25, undefined, undefined, { animate: true }); }
    else if (key === '-' || key === '_') { prevent(); canvas.zoomAt(1 / 1.25, undefined, undefined, { animate: true }); }
    else if (key === '0') { prevent(); canvas.zoomTo(1); }
    else return false;
    return true;
  }
  // The menu key (or Shift+F10) opens the actions of what is selected, next to it.
  if (key === 'contextmenu' || (event.shiftKey && key === 'f10')) {
    prevent();
    if (node) actions.nodeMenu(node.documentId, canvas.anchorPoint(node.documentId, node.nodeIds[0]));
    else if (single) actions.artboardMenu(single, canvas.anchorPoint(single, null));
    else return false;
    return true;
  }
  if (event.altKey && (key === 'arrowup' || key === 'arrowdown') && node) { prevent(); actions.moveNode(node.documentId, node.nodeIds[0], key === 'arrowup' ? -1 : 1); return true; }
  if (event.altKey) return false;
  if (event.shiftKey && (event.code === 'Digit1' || key === '!')) { prevent(); canvas.fit(null); return true; }
  if (event.shiftKey && (event.code === 'Digit2' || key === '@')) { prevent(); fitSelection(); return true; }
  if (key === 'enter' && onCanvas(event)) {
    prevent();
    if (event.shiftKey) { if (!actions.selectParent() && store.selected.size) selectArtboards([]); }
    else actions.selectChild();
    return true;
  }
  if (key === 'tab' && onCanvas(event) && documents().length) { prevent(); actions.selectSibling(event.shiftKey ? -1 : 1); return true; }
  switch (key) {
    case 'v': case 'i': canvas.setMode('select'); break;
    case 'p': canvas.setMode('interact'); break;
    case 'e': if (single) canvas.openExpanded(single); break;
    case 'f': fitSelection(); break;
    case 'a': prevent(); ask.toggle(true, { fromFrame: !!event.fromFrame }); break;
    case 'r': if (single && !node) actions.renameArtboard(single); else return false; break;
    case '0': canvas.zoomTo(1); break;
    case '+': case '=': canvas.zoomAt(1.25, undefined, undefined, { animate: true }); break;
    case '-': case '_': canvas.zoomAt(1 / 1.25, undefined, undefined, { animate: true }); break;
    case 'n': actions.newArtboard(); break;
    case 'l': sidebar.toggle('layers'); break;
    case 'h': sidebar.toggle('activity'); break;
    case '?': shortcuts.toggle(true); break;
    case 'delete': case 'backspace': prevent(); deleteSelection(); break;
    case 'escape':
      if (ask.isOpen()) ask.toggle(false);
      else if (node) { if (!actions.selectParent()) selectNodes(node.documentId, []); }
      else if (store.selected.size) selectArtboards([]);
      else if (store.mode !== 'select') canvas.setMode('select');
      else if (sidebar.isOpen()) sidebar.close();
      else return false;
      break;
    case 'arrowleft': case 'arrowright': case 'arrowup': case 'arrowdown':
      // With an element selected the arrows walk the tree: ↑↓ siblings, ← parent, → first child.
      if (node && onCanvas(event)) {
        prevent();
        if (key === 'arrowup') actions.selectSibling(-1);
        else if (key === 'arrowdown') actions.selectSibling(1);
        else if (key === 'arrowleft') actions.selectParent();
        else actions.selectChild({ edit: false });
        break;
      }
      if (node || !store.selected.size || !onCanvas(event)) return false;
      prevent();
      { const step = event.shiftKey ? 10 : 1; canvas.nudge(key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0, key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0); }
      break;
    default: return false;
  }
  return true;
}
canvas.setKeyHandler(handleKey);
window.addEventListener('keydown', event => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable) return;
  if (event.code === 'Space' || (event.repeat && /^(Delete|Backspace|Enter)$/.test(event.key))) return;
  if ((event.key === 'Enter' || event.key === ' ') && target instanceof HTMLButtonElement) return;
  handleKey(event);
});

/* ---- images and paste from preview frames --------------------------------- */
on('images', async ({ documentId, files, nodeId }) => {
  if (nodeId && cachedModelHas(documentId, nodeId)) selectNodes(documentId, [nodeId]);
  else if (!(store.selected.size === 1 && store.selected.has(documentId) && (!store.node || store.node.documentId === documentId))) selectArtboards([documentId]);
  clip.addImages(files, documentId);
});
on('frame-paste', ({ text, files }) => clip.paste({ text, files }));
on('override-text', ({ documentId, instance, address, content }) => actions.overrideText(documentId, instance, address, content));
function cachedModelHas(documentId, nodeId) { return !!store.models.get(documentId)?.nodes[nodeId]; }

/* ---- live connection ------------------------------------------------------ */
let offlineTimer = 0;
let wasOffline = false;
on('connection', value => {
  if (value === 'offline') {
    if (!offlineTimer && !wasOffline) offlineTimer = setTimeout(() => { wasOffline = true; toast('Connection lost — reconnecting. The preview is kept as it was.', null, { sticky: true, id: 'offline' }); }, 2500);
  } else if (value === 'connected') {
    clearTimeout(offlineTimer);
    offlineTimer = 0;
    if (wasOffline) { wasOffline = false; toast.clear('offline'); toast('Reconnected'); }
  }
});

// Plugins' client modules register their inspector panels before the first project state is shown.
const bootstrap = request('api/project').then(async info => { await loadClientPlugins(info.clientPlugins, apiUrl); return info; });
const stream = new EventSource(apiUrl('events'));
stream.addEventListener('open', () => { setConnection('connected'); activity.loadRecent(); });
stream.addEventListener('state', event => {
  bootstrap.catch(() => {}).then(() => {
    try { receiveState(JSON.parse(event.data)); setConnection('connected'); }
    catch { toast('Received an invalid project update. The current preview is retained.'); }
  });
});
stream.addEventListener('change', event => {
  try {
    const change = JSON.parse(event.data);
    activity.pushChange(change);
    emit('change', change);
    const entry = entries.get(change.documentId);
    if (change.actor !== 'user' || change.kind === 'undo' || change.kind === 'redo') canvas.flashNodes(change.documentId, change.render ?? 0, change.touched);
    if (entry && change.actor !== 'user') { entry.el.classList.add('touched'); setTimeout(() => entry.el.classList.remove('touched'), 1800); }
  } catch { /* ignore malformed change */ }
});
stream.addEventListener('error', () => setConnection('offline'));
bootstrap.then(info => { receiveState(info); project.checkImport(); }).catch(error => {
  $('#loading').hidden = true;
  setConnection('offline');
  toast(error.message);
});

// Several boards can be open in tabs: the tab says which project this one is (the file name, or the folder for project.divlet).
on('state', () => {
  const parts = String(store.state?.project?.file || '').split(/[\\/]/).filter(Boolean);
  const stem = (parts.at(-1) || '').replace(/\.divlet$/i, '');
  const name = stem === 'project' && parts.length > 1 ? parts.at(-2) : stem;
  document.title = name ? `${name} · divlet` : 'divlet';
});
on('state', () => { if (!document.activeElement || document.activeElement === document.body) viewport.focus({ preventScroll: true }); });
window.addEventListener('pagehide', () => { stream.close(); canvas.disposeCanvas(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

/* ---- hints ---------------------------------------------------------------- */
const tip = el('div', 'tip');
tip.setAttribute('role', 'tooltip');
document.body.append(tip);
let tipTimer = 0;
function showTip(target) {
  const code = target.dataset.tipCode;
  tip.classList.toggle('code', !!code);
  if (code) tip.replaceChildren(el('b', 'tip-title', target.dataset.tip), el('pre', 'tip-code', code));
  else tip.textContent = target.dataset.tip;
  tip.classList.add('show');
  const r = target.getBoundingClientRect();
  const w = tip.offsetWidth * uiScale();
  const h = tip.offsetHeight * uiScale();
  const above = r.bottom + h + 14 > innerHeight || (r.top > innerHeight / 2 && r.top > h + 14);
  tip.style.left = `${clamp(r.left + r.width / 2 - w / 2, 6, innerWidth - w - 6)}px`;
  tip.style.top = `${above ? r.top - h - 8 : r.bottom + 8}px`;
}
const hideTip = () => { clearTimeout(tipTimer); tip.classList.remove('show'); };
document.addEventListener('pointerover', event => {
  const target = event.target.closest?.('[data-tip]');
  clearTimeout(tipTimer);
  if (target && event.pointerType !== 'touch' && target.dataset.tip && !target.closest('.menu')) tipTimer = setTimeout(() => showTip(target), tip.classList.contains('show') ? 0 : 280);
  else hideTip();
});
document.addEventListener('focusin', event => { const target = event.target.closest?.('[data-tip]'); if (target?.dataset.tip && target.matches(':focus-visible')) showTip(target); });
document.addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', hideTip, true);
document.addEventListener('keydown', hideTip, true);
window.addEventListener('scroll', hideTip, true);


/* Panel widths: the inspector and the sidebar can be dragged wider or narrower. */
// The inspector is as wide as the toolbar under it until the user drags its edge; a double-click on the edge returns to that.
resizable($('#inspector'), { side: 'right', key: 'inspector', cssVar: '--inspector-w', min: 280, max: 640, follow: dock, fallback: () => Math.round(dock.getBoundingClientRect().width / uiScale()) || 336 });
resizable($('#sidebar'), { side: 'left', key: 'sidebar', cssVar: '--sidebar-w', min: 240, max: 560, fallback: 300 });

on('edit-step', info => actions.stepEdit(info));
