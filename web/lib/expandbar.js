// A page opened full screen has one control: its name, at the top, which is the way back. It can be dragged
// anywhere (to feel the whole page); a click — not a drag — goes back. Everything else is hidden.
import { $, clamp, uiScale } from './util.js';
import { store, on } from './store.js';
import { closeExpanded } from './canvas.js';

const bar = $('#expanded-preview');
const back = $('#expanded-back');
let spot = null; // where it was left, in screen pixels (kept while the page is open)
let drag = null;
let dragged = false;

function place() {
  if (!spot) { bar.classList.remove('moved'); bar.style.left = bar.style.top = ''; return; }
  const scale = uiScale();
  const rect = bar.getBoundingClientRect();
  const x = clamp(spot.x, 0, Math.max(0, innerWidth - rect.width));
  const y = clamp(spot.y, 0, Math.max(0, innerHeight - rect.height));
  bar.classList.add('moved');
  bar.style.left = `${x / scale}px`;
  bar.style.top = `${y / scale}px`;
}

// While dragging the pointer may cross the page (an iframe, which would swallow the events): listen on the
// document and let the page ignore the pointer until the drag ends.
function move(event) {
  if (!drag || drag.id !== event.pointerId) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
  drag.moved = true;
  bar.classList.add('dragging');
  spot = { x: drag.left + event.clientX - drag.x, y: drag.top + event.clientY - drag.y };
  place();
}
function finish(event) {
  if (!drag || drag.id !== event.pointerId) return;
  if (drag.moved) { dragged = true; setTimeout(() => { dragged = false; }, 0); }
  drag = null;
  bar.classList.remove('dragging');
  document.body.classList.remove('bar-dragging');
  document.removeEventListener('pointermove', move, true);
  document.removeEventListener('pointerup', finish, true);
  document.removeEventListener('pointercancel', finish, true);
}
back.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const rect = bar.getBoundingClientRect();
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
  document.body.classList.add('bar-dragging');
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', finish, true);
  document.addEventListener('pointercancel', finish, true);
});
back.addEventListener('click', () => { if (!dragged) closeExpanded(); });
back.addEventListener('keydown', event => {
  // The arrows nudge it when it has focus (the keyboard way to look underneath).
  const step = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }[event.key];
  if (!step || !event.altKey) return;
  event.preventDefault();
  const rect = bar.getBoundingClientRect();
  spot = { x: rect.left + step[0], y: rect.top + step[1] };
  place();
});
on('expanded', open => { if (open) requestAnimationFrame(place); else spot = null; });
addEventListener('resize', () => { if (store.expanded) place(); });
