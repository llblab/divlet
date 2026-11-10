// Side panels with a width the user sets: drag the inner edge (or focus it and use ← →), double-click
// to reset. The width is remembered per panel and never exceeds what the window can hold.
import { clamp, uiScale } from './util.js';

const phone = () => document.documentElement.classList.contains('w720');
const store = {
  get: key => { try { const value = Number(localStorage.getItem(`divlet:width:${key}`)); return Number.isFinite(value) && value > 0 ? value : null; } catch { return null; } },
  set: (key, value) => { try { if (value) localStorage.setItem(`divlet:width:${key}`, String(value)); else localStorage.removeItem(`divlet:width:${key}`); } catch {} },
};

/**
 * `panel` hugs `side` of the window; `cssVar` carries its width (the stylesheet reads it).
 * `fallback` is the default width (a number or a function returning one); while the user has not set a width the panel keeps
 * it, and when `follow` is given it tracks that element's width (the inspector is as wide as the toolbar under it).
 * Double-clicking the handle returns to the default. Returns { width() } for tests.
 */
export function resizable(panel, { side, key, cssVar, min = 260, max = 640, fallback, follow }) {
  const handle = document.createElement('div');
  handle.className = `resize-handle resize-${side}`;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', `Resize ${key} panel`);
  handle.tabIndex = 0;
  handle.dataset.tip = 'Drag to resize · double-click to reset';
  handle.dataset.panel = key;
  handle.hidden = true;
  document.body.append(handle);

  const base = () => (typeof fallback === 'function' ? fallback() : fallback);
  let preferred = store.get(key);
  let width = preferred ?? base();
  // Widths are layout pixels of the scaled interface; the pointer and rectangles are screen pixels.
  const limit = () => Math.max(min, Math.min(max, innerWidth / uiScale() - 20 - 120));
  const apply = value => { width = clamp(Math.round(value), min, limit()); document.documentElement.style.setProperty(cssVar, `${width}px`); place(); };
  // Constraints affect the rendered width, never the remembered user choice.
  const restore = () => apply(preferred ?? base());
  const remember = () => { preferred = width; store.set(key, preferred); };

  function place() {
    const hidden = panel.hidden || phone();
    handle.hidden = hidden;
    if (hidden) return;
    const r = panel.getBoundingClientRect();
    handle.style.top = `${r.top}px`;
    handle.style.height = `${r.height}px`;
    handle.style.left = `${(side === 'right' ? r.left : r.right) - 4}px`;
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(limit()));
  }

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || handle.classList.contains('dragging')) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const x0 = event.clientX;
    const scale = uiScale();
    const w0 = width;
    let moved = false;
    handle.classList.add('dragging');
    document.body.classList.add('resizing-panel');
    const move = e => { if (e.pointerId !== event.pointerId) return; moved = true; apply(w0 + (side === 'right' ? x0 - e.clientX : e.clientX - x0) / scale); };
    const finish = cancelled => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', cancel);
      handle.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('keydown', keydown, true);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing-panel');
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (cancelled) restore();
      // Only a completed drag makes the width the user's own; clicks/cancellation never replace the preference.
      else if (moved) remember();
    };
    const up = e => { if (e.pointerId === event.pointerId) finish(false); };
    const cancel = e => { if (e?.pointerId === undefined || e.pointerId === event.pointerId) finish(true); };
    const keydown = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', cancel);
    handle.addEventListener('lostpointercapture', cancel);
    window.addEventListener('blur', cancel);
    document.addEventListener('keydown', keydown, true);
  });
  handle.addEventListener('dblclick', () => { preferred = null; store.set(key, null); restore(); });
  handle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    if (handle.classList.contains('dragging')) return;
    const grow = (event.key === 'ArrowLeft') === (side === 'right');
    apply(width + (grow ? 1 : -1) * (event.shiftKey ? 48 : 16));
    remember();
  });

  restore();
  new ResizeObserver(place).observe(panel);
  // Intro transforms do not resize the layout box; place the grip again at the final painted edge.
  for (const type of ['animationend', 'animationcancel']) panel.addEventListener(type, event => { if (event.target === panel) place(); });
  new MutationObserver(place).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  if (follow) new ResizeObserver(() => { if (preferred === null) restore(); }).observe(follow);
  addEventListener('resize', restore);
  addEventListener('storage', event => {
    if (event.key !== null && event.key !== `divlet:width:${key}`) return;
    try { if (event.storageArea !== localStorage) return; } catch { return; }
    preferred = store.get(key);
    restore();
  });
  addEventListener('resize', () => requestAnimationFrame(place));
  document.addEventListener('scroll', place, true);
  return { width: () => width, handle };
}
