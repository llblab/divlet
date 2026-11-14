/** The interface size chosen in Settings (1 = 100%); popups placed from on-screen rectangles measure with it. */
export const uiScale = () => Number.parseFloat(document.documentElement.style.getPropertyValue('--ui')) || 1;
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const round = (value, digits = 0) => { const f = 10 ** digits; return Math.round(value * f) / f; };

export function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

const ICONS = {
  select: '<path d="m5 3 11 7.5-5 1-2.5 5L5 3Z"/>',
  inspect: '<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4 M8.5 7.5h3.0a1.0 1.0 0 0 1 1.0 1.0v3.0a1.0 1.0 0 0 1 -1.0 1.0h-3.0a1.0 1.0 0 0 1 -1.0 -1.0v-3.0a1.0 1.0 0 0 1 1.0 -1.0Z"/>',
  play: '<path d="M6.5 4.5v11l9-5.5-9-5.5Z"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  minus: '<path d="M4 10h12"/>',
  fit: '<path d="M3 7V4a1 1 0 0 1 1-1h3M13 3h3a1 1 0 0 1 1 1v3M17 13v3a1 1 0 0 1-1 1h-3M7 17H4a1 1 0 0 1-1-1v-3"/>',
  undo: '<path d="M7 4 3.5 7.5 7 11 M4 7.5h7a4.5 4.5 0 0 1 0 9H8"/>',
  redo: '<path d="m13 4 3.5 3.5L13 11 M16 7.5H9a4.5 4.5 0 0 0 0 9h3"/>',
  layers: '<path d="m10 3 7 3.8-7 3.8-7-3.8L10 3Z m3 10.2 7 3.8 7-3.8M3 13.6 10 17.4l7-3.8"/>',
  artboard: '<path d="M3.5 7.5h13 M5.5 3.5h9.0a2.0 2.0 0 0 1 2.0 2.0v9.0a2.0 2.0 0 0 1 -2.0 2.0h-9.0a2.0 2.0 0 0 1 -2.0 -2.0v-9.0a2.0 2.0 0 0 1 2.0 -2.0Z"/>',
  expand: '<path d="M12 3h5v5M17 3l-6 6M8 17H3v-5M3 17l6-6"/>',
  collapse: '<path d="M3 3l5 5M8 4v4H4M17 3l-5 5M12 4v4h4M17 17l-5-5M12 16v-4h4M3 17l5-5M8 16v-4H4"/>',
  close: '<path d="m5 5 10 10M15 5 5 15"/>',
  site: '<path d="M8 4H5a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 5 16h9a1.5 1.5 0 0 0 1.5-1.5V12M11 3.5h5.5V9M16.5 3.5 9 11"/>',
  back: '<path d="m9 5-5 5 5 5M4 10h12"/>',
  copy: '<path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7 M8.5 7.0h6.0a1.5 1.5 0 0 1 1.5 1.5v6.0a1.5 1.5 0 0 1 -1.5 1.5h-6.0a1.5 1.5 0 0 1 -1.5 -1.5v-6.0a1.5 1.5 0 0 1 1.5 -1.5Z"/>',
  trash: '<path d="M4 6h12M8 6V4h4v2M6 6l.7 10h6.6L14 6"/>',
  chevron: '<path d="m7 5 5 5-5 5"/>',
  search: '<path d="m13 13 3.5 3.5 M4.0 9.0a5.0 5.0 0 1 0 10.0 0a5.0 5.0 0 1 0 -10.0 0Z"/>',
  agent: '<path d="M10 3v4M10 13v4M3 10h4M13 10h4M10 10h.01"/>',
  user: '<path d="M4 16.5c.8-3 3.3-4.5 6-4.5s5.2 1.5 6 4.5 M7.0 7.5a3.0 3.0 0 1 0 6.0 0a3.0 3.0 0 1 0 -6.0 0Z"/>',
  file: '<path d="M6 3h5.5L15 6.5V16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M11 3v4h4"/>',
  alertDot: '<path d="M10 7v3.5M10 13v.01 M3.5 10.0a6.5 6.5 0 1 0 13.0 0a6.5 6.5 0 1 0 -13.0 0Z"/>',
  divlet: '<path d="M8 4.5 2.5 10 8 15.5" fill="none"/><path d="M10.5 4.5H12L17.5 10 12 15.5h-1.5Z" fill="currentColor" stroke="none"/>',
  alignL: '<path d="M4 3v14 M7.3 5.0h7.4a0.8 0.8 0 0 1 0.8 0.8v1.9a0.8 0.8 0 0 1 -0.8 0.8h-7.4a0.8 0.8 0 0 1 -0.8 -0.8v-1.9a0.8 0.8 0 0 1 0.8 -0.8Z M7.3 11.5h3.9a0.8 0.8 0 0 1 0.8 0.8v1.9a0.8 0.8 0 0 1 -0.8 0.8h-3.9a0.8 0.8 0 0 1 -0.8 -0.8v-1.9a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  alignCH: '<path d="M10 3v14 M5.3 5.0h9.4a0.8 0.8 0 0 1 0.8 0.8v1.9a0.8 0.8 0 0 1 -0.8 0.8h-9.4a0.8 0.8 0 0 1 -0.8 -0.8v-1.9a0.8 0.8 0 0 1 0.8 -0.8Z M7.3 11.5h5.4a0.8 0.8 0 0 1 0.8 0.8v1.9a0.8 0.8 0 0 1 -0.8 0.8h-5.4a0.8 0.8 0 0 1 -0.8 -0.8v-1.9a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  alignR: '<path d="M16 3v14 M5.3 5.0h7.4a0.8 0.8 0 0 1 0.8 0.8v1.9a0.8 0.8 0 0 1 -0.8 0.8h-7.4a0.8 0.8 0 0 1 -0.8 -0.8v-1.9a0.8 0.8 0 0 1 0.8 -0.8Z M8.8 11.5h3.9a0.8 0.8 0 0 1 0.8 0.8v1.9a0.8 0.8 0 0 1 -0.8 0.8h-3.9a0.8 0.8 0 0 1 -0.8 -0.8v-1.9a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  alignT: '<path d="M3 4h14 M5.8 6.5h1.9a0.8 0.8 0 0 1 0.8 0.8v7.4a0.8 0.8 0 0 1 -0.8 0.8h-1.9a0.8 0.8 0 0 1 -0.8 -0.8v-7.4a0.8 0.8 0 0 1 0.8 -0.8Z M12.3 6.5h1.9a0.8 0.8 0 0 1 0.8 0.8v3.9a0.8 0.8 0 0 1 -0.8 0.8h-1.9a0.8 0.8 0 0 1 -0.8 -0.8v-3.9a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  alignCV: '<path d="M3 10h14 M5.8 4.5h1.9a0.8 0.8 0 0 1 0.8 0.8v9.4a0.8 0.8 0 0 1 -0.8 0.8h-1.9a0.8 0.8 0 0 1 -0.8 -0.8v-9.4a0.8 0.8 0 0 1 0.8 -0.8Z M12.3 6.5h1.9a0.8 0.8 0 0 1 0.8 0.8v5.4a0.8 0.8 0 0 1 -0.8 0.8h-1.9a0.8 0.8 0 0 1 -0.8 -0.8v-5.4a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  alignB: '<path d="M3 16h14 M5.8 4.5h1.9a0.8 0.8 0 0 1 0.8 0.8v7.4a0.8 0.8 0 0 1 -0.8 0.8h-1.9a0.8 0.8 0 0 1 -0.8 -0.8v-7.4a0.8 0.8 0 0 1 0.8 -0.8Z M12.3 8.0h1.9a0.8 0.8 0 0 1 0.8 0.8v3.9a0.8 0.8 0 0 1 -0.8 0.8h-1.9a0.8 0.8 0 0 1 -0.8 -0.8v-3.9a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  distH: '<path d="M4 3v14M16 3v14 M8.8 6.0h2.4a0.8 0.8 0 0 1 0.8 0.8v6.4a0.8 0.8 0 0 1 -0.8 0.8h-2.4a0.8 0.8 0 0 1 -0.8 -0.8v-6.4a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  distV: '<path d="M3 4h14M3 16h14 M6.8 8.0h6.4a0.8 0.8 0 0 1 0.8 0.8v2.4a0.8 0.8 0 0 1 -0.8 0.8h-6.4a0.8 0.8 0 0 1 -0.8 -0.8v-2.4a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  heading: '<path d="M5 4v12M15 4v12M5 10h10"/>',
  text: '<path d="M4 5h12M10 5v11"/>',
  box: '<rect x="3.5" y="3.5" width="13" height="13" rx="2" stroke-dasharray="2 2"/>',
  rectangle: '<path d="M3.5 5.5h13.0v9.0h-13.0Z"/>',
  button: '<path d="M6.5 6.5h7.0a3.5 3.5 0 0 1 3.5 3.5v0.0a3.5 3.5 0 0 1 -3.5 3.5h-7.0a3.5 3.5 0 0 1 -3.5 -3.5v-0.0a3.5 3.5 0 0 1 3.5 -3.5Z"/>',
  image: '<path d="m4 14 4-3.5 3 2.5 2.5-2 3 3 M6.3 8.5a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0 -2.4 0Z M5.0 4.5h10.0a1.5 1.5 0 0 1 1.5 1.5v8.0a1.5 1.5 0 0 1 -1.5 1.5h-10.0a1.5 1.5 0 0 1 -1.5 -1.5v-8.0a1.5 1.5 0 0 1 1.5 -1.5Z"/>',
  link: '<path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.8.8M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8A3 3 0 0 0 9.2 15l.8-.8"/>',
  list: '<path d="M8 5.5h8.5M8 10h8.5M8 14.5h8.5 M3.6 5.5a0.9 0.9 0 1 0 1.8 0a0.9 0.9 0 1 0 -1.8 0Z M3.6 10.0a0.9 0.9 0 1 0 1.8 0a0.9 0.9 0 1 0 -1.8 0Z M3.6 14.5a0.9 0.9 0 1 0 1.8 0a0.9 0.9 0 1 0 -1.8 0Z"/>',
  row: '<path d="M3.8 6.0h3.9a1.3 1.3 0 0 1 1.3 1.3v5.4a1.3 1.3 0 0 1 -1.3 1.3h-3.9a1.3 1.3 0 0 1 -1.3 -1.3v-5.4a1.3 1.3 0 0 1 1.3 -1.3Z M12.3 6.0h3.9a1.3 1.3 0 0 1 1.3 1.3v5.4a1.3 1.3 0 0 1 -1.3 1.3h-3.9a1.3 1.3 0 0 1 -1.3 -1.3v-5.4a1.3 1.3 0 0 1 1.3 -1.3Z"/>',
  grid: '<path d="M4.2 3.0h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1 -1.2 1.2h-3.6a1.2 1.2 0 0 1 -1.2 -1.2v-3.6a1.2 1.2 0 0 1 1.2 -1.2Z M12.2 3.0h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1 -1.2 1.2h-3.6a1.2 1.2 0 0 1 -1.2 -1.2v-3.6a1.2 1.2 0 0 1 1.2 -1.2Z M4.2 11.0h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1 -1.2 1.2h-3.6a1.2 1.2 0 0 1 -1.2 -1.2v-3.6a1.2 1.2 0 0 1 1.2 -1.2Z M12.2 11.0h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1 -1.2 1.2h-3.6a1.2 1.2 0 0 1 -1.2 -1.2v-3.6a1.2 1.2 0 0 1 1.2 -1.2Z"/>',
  more: '<path d="M3.9 10.0a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0Z M8.9 10.0a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0Z M13.9 10.0a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0Z"/>',
  parent: '<path d="M14.5 15.5h-6a3 3 0 0 1-3-3V4.5 m2.5 7.5 3-3 3 3"/>',
  child: '<path d="M5.5 4.5v6a3 3 0 0 0 3 3h7 m12.5 10.5 3 3-3 3"/>',
  wrap: '<rect x="3" y="3" width="14" height="14" rx="2.5" stroke-dasharray="2.2 2"/><rect x="6.5" y="6.5" width="7" height="7" rx="1.2"/>',
  unwrap: '<path d="M3 6V4a1 1 0 0 1 1-1h2M14 3h2a1 1 0 0 1 1 1v2M17 14v2a1 1 0 0 1-1 1h-2M6 17H4a1 1 0 0 1-1-1v-2 M7.7 6.5h4.6a1.2 1.2 0 0 1 1.2 1.2v4.6a1.2 1.2 0 0 1 -1.2 1.2h-4.6a1.2 1.2 0 0 1 -1.2 -1.2v-4.6a1.2 1.2 0 0 1 1.2 -1.2Z"/>',
  help: '<path d="M8 8a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.3v.4M10 14v.01 M3.0 10.0a7.0 7.0 0 1 0 14.0 0a7.0 7.0 0 1 0 -14.0 0Z"/>',
  keyboard: '<path d="M5.5 8h.01M8.5 8h.01M11.5 8h.01M14.5 8h.01M6.5 12h7 M4.5 5.0h11.0a2.0 2.0 0 0 1 2.0 2.0v6.0a2.0 2.0 0 0 1 -2.0 2.0h-11.0a2.0 2.0 0 0 1 -2.0 -2.0v-6.0a2.0 2.0 0 0 1 2.0 -2.0Z"/>',
  swap: '<path d="M6 3.5v13M3.5 6 6 3.5 8.5 6M14 16.5v-13M11.5 14l2.5 2.5 2.5-2.5"/>',
  hug: '<path d="M4 3.5h12M4 16.5h12M10 6.5v7M7.5 9 10 6.5 12.5 9M7.5 11 10 13.5l2.5-2.5"/>',
  sun: '<path d="M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1 1M14.3 14.3l1 1M4.7 15.3l1-1M14.3 5.7l1-1 M6.8 10.0a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0Z"/>',
  moon: '<path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z"/>',
  auto: '<circle cx="10" cy="10" r="6.5"/><path d="M10 3.5v13a6.5 6.5 0 0 0 0-13Z" fill="currentColor" stroke="none"/>',
  tidy: '<path d="M3.5 5.0h2.0a1.0 1.0 0 0 1 1.0 1.0v8.0a1.0 1.0 0 0 1 -1.0 1.0h-2.0a1.0 1.0 0 0 1 -1.0 -1.0v-8.0a1.0 1.0 0 0 1 1.0 -1.0Z M9.0 5.0h2.0a1.0 1.0 0 0 1 1.0 1.0v5.0a1.0 1.0 0 0 1 -1.0 1.0h-2.0a1.0 1.0 0 0 1 -1.0 -1.0v-5.0a1.0 1.0 0 0 1 1.0 -1.0Z M14.5 5.0h2.0a1.0 1.0 0 0 1 1.0 1.0v6.5a1.0 1.0 0 0 1 -1.0 1.0h-2.0a1.0 1.0 0 0 1 -1.0 -1.0v-6.5a1.0 1.0 0 0 1 1.0 -1.0Z"/>',
  undoKind: '<path d="M7 4 3.5 7.5 7 11 M4 7.5h7a4.5 4.5 0 0 1 0 9H8"/>',
  pencil: '<path d="M12.5 4.5 15.5 7.5 7 16H4v-3l8.5-8.5Z m11 6 3 3"/>',
  tag: '<path d="M3.5 3.5h6l7 7-6 6-7-7v-6Z M6.0 7.0a1.0 1.0 0 1 0 2.0 0a1.0 1.0 0 1 0 -2.0 0Z"/>',
  hash: '<path d="M8 3 6.5 17M13.5 3 12 17M3.5 7.5h13M3 12.5h13"/>',
  rotate: '<path d="M15.5 9.5A5.5 5.5 0 1 1 13.8 5.6 M14.5 2.5v3.5H11"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  arrowUp: '<path d="M10 16V4M5 9l5-5 5 5"/>',
  arrowRight: '<path d="M4 10h12M11 5l5 5-5 5"/>',
  wrapLines: '<path d="M3.5 5.5h13M3.5 10h10.5a2.5 2.5 0 0 1 0 5H11M12.5 13.5 11 15l1.5 1.5M3.5 14.5h4"/>',
  textL: '<path d="M3.5 5h13M3.5 8.5h8M3.5 12h13M3.5 15.5h8"/>',
  textC: '<path d="M3.5 5h13M6 8.5h8M3.5 12h13M6 15.5h8"/>',
  textR: '<path d="M3.5 5h13M8.5 8.5h8M3.5 12h13M8.5 15.5h8"/>',
  textJ: '<path d="M3.5 5h13M3.5 8.5h13M3.5 12h13M3.5 15.5h13"/>',
  between: '<path d="M3.5 3.5v13M16.5 3.5v13 M6.6 7.5h1.3a0.6 0.6 0 0 1 0.6 0.6v3.8a0.6 0.6 0 0 1 -0.6 0.6h-1.3a0.6 0.6 0 0 1 -0.6 -0.6v-3.8a0.6 0.6 0 0 1 0.6 -0.6Z M12.1 7.5h1.3a0.6 0.6 0 0 1 0.6 0.6v3.8a0.6 0.6 0 0 1 -0.6 0.6h-1.3a0.6 0.6 0 0 1 -0.6 -0.6v-3.8a0.6 0.6 0 0 1 0.6 -0.6Z"/>',
  arrowDown: '<path d="M10 4v12M5 11l5 5 5-5"/>',
  sparkle: '<path d="M9 2.8c.5 3.6 2 5.1 5.6 5.6-3.6.5-5.1 2-5.6 5.6-.5-3.6-2-5.1-5.6-5.6C7 7.9 8.5 6.4 9 2.8Z M15.2 12.6v4.2M13.1 14.7h4.2"/>',
  send: '<path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9"/>',
  stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.8" fill="currentColor" stroke="none"/>',
  cut: '<path d="M7.4 12.8 14 3.5M12.6 12.8 6 3.5 M3.8 14.5a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0 -4.4 0Z M11.8 14.5a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0 -4.4 0Z"/>',
  paste: '<path d="M8 4V2.8h4V4M7.5 9h5M7.5 12h5 M6.1 4.0h7.8a1.6 1.6 0 0 1 1.6 1.6v9.8a1.6 1.6 0 0 1 -1.6 1.6h-7.8a1.6 1.6 0 0 1 -1.6 -1.6v-9.8a1.6 1.6 0 0 1 1.6 -1.6Z"/>',
  code: '<path d="m6.5 6-3.5 4 3.5 4M13.5 6l3.5 4-3.5 4M11.3 4l-2.6 12"/>',
  download: '<path d="M10 3.5v9M6 9l4 4 4-4M4 16.5h12"/>',
  upload: '<path d="M10 13V4M6 7.5l4-4 4 4M4 16.5h12"/>',
  chat: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9.2L6 15.8V13h-.5A1.5 1.5 0 0 1 4 11.5v-6Z"/>',
  command: '<path d="M7 7V5.5a1.5 1.5 0 1 0-1.5 1.5H7Zm0 0h6m-6 0v6m6-6V5.5A1.5 1.5 0 1 1 14.5 7H13Zm0 0v6m0 0v1.5a1.5 1.5 0 1 0 1.5-1.5H13Zm0 0H7m0 0v1.5A1.5 1.5 0 1 1 5.5 13H7Z"/>',
  enter: '<path d="M15.5 4.5v5a2 2 0 0 1-2 2h-9M7.5 8.5l-3 3 3 3"/>',
  component: '<path d="m10 2.8 3.2 3.2L10 9.2 6.8 6 10 2.8ZM10 10.8l3.2 3.2-3.2 3.2-3.2-3.2 3.2-3.2ZM6 6.8 9.2 10 6 13.2 2.8 10 6 6.8ZM14 6.8l3.2 3.2-3.2 3.2-3.2-3.2L14 6.8Z"/>',
  instance: '<path d="M10 2.8 17.2 10 10 17.2 2.8 10 10 2.8Z"/>',
  lock: '<path d="M7.5 9V7a2.5 2.5 0 0 1 5 0v2 M6.6 9.0h6.8a1.6 1.6 0 0 1 1.6 1.6v3.8a1.6 1.6 0 0 1 -1.6 1.6h-6.8a1.6 1.6 0 0 1 -1.6 -1.6v-3.8a1.6 1.6 0 0 1 1.6 -1.6Z"/>',
  unlock: '<path d="M7.5 9V7a2.5 2.5 0 0 1 4.8-.9 M6.6 9.0h6.8a1.6 1.6 0 0 1 1.6 1.6v3.8a1.6 1.6 0 0 1 -1.6 1.6h-6.8a1.6 1.6 0 0 1 -1.6 -1.6v-3.8a1.6 1.6 0 0 1 1.6 -1.6Z"/>',
  folder: '<path d="M3 6.2A1.7 1.7 0 0 1 4.7 4.5h3.1l1.6 1.8h5.9A1.7 1.7 0 0 1 17 8v6.3a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 14.3V6.2Z"/>',
  folderUp: '<path d="M3 6.2A1.7 1.7 0 0 1 4.7 4.5h3.1l1.6 1.8h5.9A1.7 1.7 0 0 1 17 8v6.3a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 14.3V6.2ZM10 13V9M8 10.8 10 9l2 1.8"/>',
  clock: '<path d="M10 6.3V10l2.6 1.6 M3.5 10.0a6.5 6.5 0 1 0 13.0 0a6.5 6.5 0 1 0 -13.0 0Z"/>',
  gear: '<g transform="scale(.8333)" stroke-width="1.8"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></g>',
};

/**
 * The key a shortcut means on any keyboard layout: a Latin letter as typed, otherwise the
 * physical key (Ф on a Russian layout is A), so single-letter and Ctrl shortcuts always work.
 */
export function shortcutKey(event) {
  const key = String(event.key || '');
  const code = String(event.code || '');
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code) && !event.shiftKey) return code.slice(5);
  if (code === 'Slash' && event.shiftKey) return '?';
  if (code === 'Equal' || code === 'NumpadAdd') return event.shiftKey || code === 'NumpadAdd' ? '+' : '=';
  if (code === 'Minus' || code === 'NumpadSubtract') return '-';
  return key.toLowerCase();
}

export function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/** Human label for a key combination, e.g. "Mod+Shift+Z" → "Ctrl ⇧ Z" or "⌘ ⇧ Z". */
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export function keys(combo) {
  return combo.split('+').map(part => ({ Mod: isMac ? '⌘' : 'Ctrl', Shift: '⇧', Alt: isMac ? '⌥' : 'Alt', Enter: '↵', Up: '↑', Down: '↓', Left: '←', Right: '→', Delete: 'Del', Escape: 'Esc' })[part] || part).join(' ');
}

export function button(iconName, tip, handler, className = '') {
  const node = el('button', `tool ${className}`.trim());
  node.type = 'button';
  node.setAttribute('aria-label', tip.replace(/ · .*/, ''));
  node.dataset.tip = tip;
  if (iconName) node.append(icon(iconName));
  if (handler) node.addEventListener('click', handler);
  return node;
}

export function ago(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/**
 * Re-rendering a panel between pointerdown and pointerup swallows the click (the pressed
 * element is gone). Panels ask `pressing()` before replacing their content and get
 * `after()` called once the pointer is released and the click has been dispatched.
 */
export function pressGuard(panel, after) {
  let down = false;
  panel.addEventListener('pointerdown', () => { down = true; }, true);
  const release = () => { if (!down) return; down = false; setTimeout(after, 0); };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);
  return () => down;
}

export function debounce(fn, wait) {
  let timer;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}
