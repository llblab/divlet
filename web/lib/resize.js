// Side panels with a width the user sets: drag the inner edge (or focus it and use ← →), double-click
// to reset. The width is remembered per panel and never exceeds what the window can hold.
import { clamp, uiScale } from './util.js';

const phone = () => document.documentElement.classList.contains('w720');
const store = {
  get: key => { try { return Number(localStorage.getItem(`divlet:width:${key}`)) || null; } catch { return null; } },
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
  let width = store.get(key) ?? base();
  // Widths are layout pixels of the scaled interface; the pointer and rectangles are screen pixels.
  const limit = () => Math.max(min, Math.min(max, innerWidth / uiScale() - 20 - 120));
  const apply = value => { width = clamp(Math.round(value), min, limit()); document.documentElement.style.setProperty(cssVar, `${width}px`); place(); };

  function place() {
    const hidden = panel.hidden || phone();
    handle.hidden = hidden;
    if (hidden) return;
    const r = panel.getBoundingClientRect();
    handle.style.top = `${r.top}px`;
    handle.style.height = `${r.height}px`;
    handle.style.left = `${(side === 'right' ? r.left : r.right) - 4}px`;
    handle.setAttribute('aria-valuenow', String(Math.round(r.width)));
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(limit()));
  }

  handle.addEventListener('pointerdown', event => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const x0 = event.clientX;
    const scale = uiScale();
    const w0 = panel.getBoundingClientRect().width / scale;
    let moved = false;
    handle.classList.add('dragging');
    document.body.classList.add('resizing-panel');
    const move = e => { moved = true; apply(w0 + (side === 'right' ? x0 - e.clientX : e.clientX - x0) / scale); };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing-panel');
      // Only a real drag makes the width the user's own; a plain click leaves the default (and its tracking) alone.
      if (moved) store.set(key, width);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => { store.set(key, null); apply(base()); });
  handle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const grow = (event.key === 'ArrowLeft') === (side === 'right');
    apply(panel.getBoundingClientRect().width / uiScale() + (grow ? 1 : -1) * (event.shiftKey ? 48 : 16));
    store.set(key, width);
  });

  apply(width);
  new ResizeObserver(place).observe(panel);
  new MutationObserver(place).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  if (follow) new ResizeObserver(() => { if (!store.get(key)) apply(base()); }).observe(follow);
  addEventListener('resize', () => apply(store.get(key) ?? base()));
  addEventListener('resize', () => requestAnimationFrame(place));
  document.addEventListener('scroll', place, true);
  return { width: () => width, handle };
}
