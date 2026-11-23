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

export const ICONS = {
  select: '<path d="m5 3 11 7.5-5 1-2.5 5L5 3Z"/>',
  inspect: '<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4 M8.5 7.5h3.0a1.0 1.0 0 0 1 1.0 1.0v3.0a1.0 1.0 0 0 1 -1.0 1.0h-3.0a1.0 1.0 0 0 1 -1.0 -1.0v-3.0a1.0 1.0 0 0 1 1.0 -1.0Z"/>',
  play: '<path d="M5.609 3.1v13.8l11.291 -6.9 -11.291 -6.9Z"/>',
  plus: '<path d="M10 3.1v13.8M3.1 10h13.8"/>',
  minus: '<path d="M3.1 10h13.8"/>',
  fit: '<path d="M3 7V4a1 1 0 0 1 1-1h3M13 3h3a1 1 0 0 1 1 1v3M17 13v3a1 1 0 0 1-1 1h-3M7 17H4a1 1 0 0 1-1-1v-3"/>',
  undo: '<path d="M6.688 3.376 2.824 7.24 6.688 11.104M3.376 7.24h7.728a4.968 4.968 0 0 1 0 9.936H7.792"/>',
  redo: '<path d="m14.352 4.416 3.864 3.864L13.312 11.104M16.624 7.24H8.896a4.968 4.968 0 0 0 0 9.936h3.312"/>',
  layers: '<path d="M10 3.292 16.708 6.933 10 10.575 3.292 6.933 10 3.292ZM3.292 10.192 10 13.833l6.708 -3.642M3.292 13.45 10 17.092l6.708 -3.642"/>',
  artboard: '<path d="M3.1 7.346h13.8M5.223 3.1h9.554a2.123 2.123 0 0 1 2.123 2.123v9.554a2.123 2.123 0 0 1 -2.123 2.123h-9.554a2.123 2.123 0 0 1 -2.123 -2.123v-9.554a2.123 2.123 0 0 1 2.123 -2.123Z"/>',
  // Four arrows out of the centre, each with its bracket in the outer corner: the brackets alone draw the square a frame
  // occupies, so the collapsed state reads as a viewport rather than as two opposite corners.
  expand: '<path d="M3 8V3h5M3 3l6 6M17 8V3h-5M17 3l-6 6M3 12v5h5M3 17l6-6M17 12v5h-5M17 17l-6-6"/>',
  collapse: '<path d="M3 3l5 5M8 4v4H4M17 3l-5 5M12 4v4h4M17 17l-5-5M12 16v-4h4M3 17l5-5M8 16v-4H4"/>',
  close: '<path d="m5 5 10 10M15 5 5 15"/>',
  site: '<path d="M7.877 3.631H4.692a1.592 1.592 0 0 0 -1.592 1.592v9.554A1.592 1.592 0 0 0 4.692 16.369h9.554a1.592 1.592 0 0 0 1.592 -1.592V12.123M11.062 3.1h5.838V8.938M16.9 3.1 8.938 11.062"/>',
  back: '<path d="m10.35 5.75 -5.75 5.75 5.75 5.75M3.1 10h13.8"/>',
  copy: '<path d="M13.45 6.55V4.825A1.725 1.725 0 0 0 11.725 3.1h-6.9A1.725 1.725 0 0 0 3.1 4.825v6.9A1.725 1.725 0 0 0 4.825 13.45H6.55M8.275 6.55h6.9a1.725 1.725 0 0 1 1.725 1.725v6.9a1.725 1.725 0 0 1 -1.725 1.725h-6.9a1.725 1.725 0 0 1 -1.725 -1.725v-6.9a1.725 1.725 0 0 1 1.725 -1.725Z"/>',
  trash: '<path d="M3.1 5.4h13.8M7.7 5.4V3.1h4.6v2.3M5.4 5.4l.8 11h7.6l.8-11"/>',
  chevron: '<path d="m7 5 5 5-5 5"/>',
  search: '<path d="m13.9 13.9 3.1 3.1M3.5 8.5a5 5 0 1 0 10 0a5 5 0 1 0 -10 0Z"/>',
  agent: '<path d="M10 3v4M10 13v4M3 10h4M13 10h4M10 10h.01"/>',
  user: '<path d="M3 16.5c1-3.4 3.8-5 7-5s6 1.6 7 5M6.5 7.2a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0Z"/>',
  file: '<path d="M6 3h5.5L15 6.5V16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M11 3v4h4"/>',
  alertDot: '<path d="M10 6.815v3.715M10 13.185M3.1 10a6.9 6.9 0 1 0 13.8 0a6.9 6.9 0 1 0 -13.8 0Z"/>',
  divlet: '<path d="M8 4.5 2.5 10 8 15.5" fill="none"/><path d="M10.5 4.5H12L17.5 10 12 15.5h-1.5Z" fill="currentColor" stroke="none"/>',
  alignL: '<path d="M4 3v14 M7.3 5.0h7.4a0.8 0.8 0 0 1 0.8 0.8v1.9a0.8 0.8 0 0 1 -0.8 0.8h-7.4a0.8 0.8 0 0 1 -0.8 -0.8v-1.9a0.8 0.8 0 0 1 0.8 -0.8Z M7.3 11.5h3.9a0.8 0.8 0 0 1 0.8 0.8v1.9a0.8 0.8 0 0 1 -0.8 0.8h-3.9a0.8 0.8 0 0 1 -0.8 -0.8v-1.9a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  alignCH: '<path d="M10 3v14 M5.3 5.0h9.4a0.8 0.8 0 0 1 0.8 0.8v1.9a0.8 0.8 0 0 1 -0.8 0.8h-9.4a0.8 0.8 0 0 1 -0.8 -0.8v-1.9a0.8 0.8 0 0 1 0.8 -0.8Z M7.3 11.5h5.4a0.8 0.8 0 0 1 0.8 0.8v1.9a0.8 0.8 0 0 1 -0.8 0.8h-5.4a0.8 0.8 0 0 1 -0.8 -0.8v-1.9a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  alignR: '<path d="M16 3v14 M5.3 5.0h7.4a0.8 0.8 0 0 1 0.8 0.8v1.9a0.8 0.8 0 0 1 -0.8 0.8h-7.4a0.8 0.8 0 0 1 -0.8 -0.8v-1.9a0.8 0.8 0 0 1 0.8 -0.8Z M8.8 11.5h3.9a0.8 0.8 0 0 1 0.8 0.8v1.9a0.8 0.8 0 0 1 -0.8 0.8h-3.9a0.8 0.8 0 0 1 -0.8 -0.8v-1.9a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  alignT: '<path d="M3 4h14 M5.8 6.5h1.9a0.8 0.8 0 0 1 0.8 0.8v7.4a0.8 0.8 0 0 1 -0.8 0.8h-1.9a0.8 0.8 0 0 1 -0.8 -0.8v-7.4a0.8 0.8 0 0 1 0.8 -0.8Z M12.3 6.5h1.9a0.8 0.8 0 0 1 0.8 0.8v3.9a0.8 0.8 0 0 1 -0.8 0.8h-1.9a0.8 0.8 0 0 1 -0.8 -0.8v-3.9a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  alignCV: '<path d="M3 10h14 M5.8 4.5h1.9a0.8 0.8 0 0 1 0.8 0.8v9.4a0.8 0.8 0 0 1 -0.8 0.8h-1.9a0.8 0.8 0 0 1 -0.8 -0.8v-9.4a0.8 0.8 0 0 1 0.8 -0.8Z M12.3 6.5h1.9a0.8 0.8 0 0 1 0.8 0.8v5.4a0.8 0.8 0 0 1 -0.8 0.8h-1.9a0.8 0.8 0 0 1 -0.8 -0.8v-5.4a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  alignB: '<path d="M3 16h14 M5.8 4.5h1.9a0.8 0.8 0 0 1 0.8 0.8v7.4a0.8 0.8 0 0 1 -0.8 0.8h-1.9a0.8 0.8 0 0 1 -0.8 -0.8v-7.4a0.8 0.8 0 0 1 0.8 -0.8Z M12.3 8.0h1.9a0.8 0.8 0 0 1 0.8 0.8v3.9a0.8 0.8 0 0 1 -0.8 0.8h-1.9a0.8 0.8 0 0 1 -0.8 -0.8v-3.9a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  distH: '<path d="M4 3v14M16 3v14 M8.8 6.0h2.4a0.8 0.8 0 0 1 0.8 0.8v6.4a0.8 0.8 0 0 1 -0.8 0.8h-2.4a0.8 0.8 0 0 1 -0.8 -0.8v-6.4a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  distV: '<path d="M3 4h14M3 16h14 M6.8 8.0h6.4a0.8 0.8 0 0 1 0.8 0.8v2.4a0.8 0.8 0 0 1 -0.8 0.8h-6.4a0.8 0.8 0 0 1 -0.8 -0.8v-2.4a0.8 0.8 0 0 1 0.8 -0.8Z"/>',
  heading: '<path d="M4.25 3.1v13.8M15.75 3.1v13.8M4.25 10h11.5"/>',
  text: '<path d="M3.1 4.25h13.8M10 4.25v12.65"/>',
  box: '<rect x="3.5" y="3.5" width="13" height="13" rx="2" stroke-dasharray="2 2"/>',
  rectangle: '<path d="M3.1 5.223h13.8v9.554h-13.8Z"/>',
  button: '<path d="M6.5 6.5h7.0a3.5 3.5 0 0 1 3.5 3.5v0.0a3.5 3.5 0 0 1 -3.5 3.5h-7.0a3.5 3.5 0 0 1 -3.5 -3.5v-0.0a3.5 3.5 0 0 1 3.5 -3.5Z"/>',
  image: '<path d="m4.246 14.862 4.246 -3.715 3.185 2.654 2.654 -2.123 3.185 3.185M6.072 8.408a1.274 1.274 0 1 0 2.548 0a1.274 1.274 0 1 0 -2.548 0ZM4.692 4.162h10.615a1.592 1.592 0 0 1 1.592 1.592v8.492a1.592 1.592 0 0 1 -1.592 1.592h-10.615a1.592 1.592 0 0 1 -1.592 -1.592v-8.492a1.592 1.592 0 0 1 1.592 -1.592Z"/>',
  link: '<path d="M8.152 11.848a3.696 3.696 0 0 0 5.175 0l2.834 -2.834a3.696 3.696 0 0 0 -5.175 -5.175M11.848 8.152a3.696 3.696 0 0 0 -5.175 0L3.839 10.986A3.696 3.696 0 0 0 9.014 16.161"/>',
  list: '<path d="M7.86 5.186h9.093M7.86 10h9.093M7.86 14.814h9.093M3.153 5.186a0.963 0.963 0 1 0 1.926 0a0.963 0.963 0 1 0 -1.926 0ZM3.153 10a0.963 0.963 0 1 0 1.926 0a0.963 0.963 0 1 0 -1.926 0ZM3.153 14.814a0.963 0.963 0 1 0 1.926 0a0.963 0.963 0 1 0 -1.926 0Z"/>',
  row: '<path d="M4.296 6.32h3.588a1.196 1.196 0 0 1 1.196 1.196v4.968a1.196 1.196 0 0 1 -1.196 1.196h-3.588a1.196 1.196 0 0 1 -1.196 -1.196v-4.968a1.196 1.196 0 0 1 1.196 -1.196ZM12.116 6.32h3.588a1.196 1.196 0 0 1 1.196 1.196v4.968a1.196 1.196 0 0 1 -1.196 1.196h-3.588a1.196 1.196 0 0 1 -1.196 -1.196v-4.968a1.196 1.196 0 0 1 1.196 -1.196Z"/>',
  grid: '<path d="M4.2 3.0h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1 -1.2 1.2h-3.6a1.2 1.2 0 0 1 -1.2 -1.2v-3.6a1.2 1.2 0 0 1 1.2 -1.2Z M12.2 3.0h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1 -1.2 1.2h-3.6a1.2 1.2 0 0 1 -1.2 -1.2v-3.6a1.2 1.2 0 0 1 1.2 -1.2Z M4.2 11.0h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1 -1.2 1.2h-3.6a1.2 1.2 0 0 1 -1.2 -1.2v-3.6a1.2 1.2 0 0 1 1.2 -1.2Z M12.2 11.0h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1 -1.2 1.2h-3.6a1.2 1.2 0 0 1 -1.2 -1.2v-3.6a1.2 1.2 0 0 1 1.2 -1.2Z"/>',
  more: '<path d="M3.1 10a1.244 1.244 0 1 0 2.489 0a1.244 1.244 0 1 0 -2.489 0ZM8.756 10a1.244 1.244 0 1 0 2.489 0a1.244 1.244 0 1 0 -2.489 0ZM14.411 10a1.244 1.244 0 1 0 2.489 0a1.244 1.244 0 1 0 -2.489 0Z"/>',
  parent: '<path d="M15.645 16.9h-7.527a3.764 3.764 0 0 1 -3.764 -3.764V3.1m3.136 9.409 3.764 -3.764 3.764 3.764"/>',
  child: '<path d="M4.825 3.675v6.9a3.45 3.45 0 0 0 3.45 3.45h8.05M12.875 10.575l3.45 3.45 -3.45 3.45"/>',
  wrap: '<rect x="3" y="3" width="14" height="14" rx="2.5" stroke-dasharray="2.2 2"/><rect x="6.5" y="6.5" width="7" height="7" rx="1.2"/>',
  unwrap: '<path d="M3 6V4a1 1 0 0 1 1-1h2M14 3h2a1 1 0 0 1 1 1v2M17 14v2a1 1 0 0 1-1 1h-2M6 17H4a1 1 0 0 1-1-1v-2 M7.7 6.5h4.6a1.2 1.2 0 0 1 1.2 1.2v4.6a1.2 1.2 0 0 1 -1.2 1.2h-4.6a1.2 1.2 0 0 1 -1.2 -1.2v-4.6a1.2 1.2 0 0 1 1.2 -1.2Z"/>',
  help: '<path d="M8 8a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.3v.4M10 14v.01 M3.0 10.0a7.0 7.0 0 1 0 14.0 0a7.0 7.0 0 1 0 -14.0 0Z"/>',
  keyboard: '<path d="M5.86 8.16M8.62 8.16M11.38 8.16M14.14 8.16M6.78 11.84h6.44M4.94 5.4h10.12a1.84 1.84 0 0 1 1.84 1.84v5.52a1.84 1.84 0 0 1 -1.84 1.84h-10.12a1.84 1.84 0 0 1 -1.84 -1.84v-5.52a1.84 1.84 0 0 1 1.84 -1.84Z"/>',
  swap: '<path d="M5.754 3.1v13.8M3.1 5.754 5.754 3.1 8.408 5.754M14.246 16.9v-13.8M11.592 14.246l2.654 2.654 2.654 -2.654"/>',
  hug: '<path d="M3.631 3.1h12.738M3.631 16.9h12.738M10 6.285v7.431M7.346 8.938 10 6.285 12.654 8.938M7.346 11.062 10 13.715l2.654 -2.654"/>',
  sun: '<path d="M10 3.1v1.38M10 15.52v1.38M3.1 10H4.48M15.52 10h1.38M5.124 5.124l0.92 0.92M13.956 13.956l0.92 0.92M5.124 14.876l0.92 -0.92M13.956 6.044l0.92 -0.92M7.056 10a2.944 2.944 0 1 0 5.888 0a2.944 2.944 0 1 0 -5.888 0Z"/>',
  moon: '<path d="M15.948 12.704A7.03 7.03 0 0 1 7.296 4.052a7.03 7.03 0 1 0 8.652 8.652Z"/>',
  auto: '<circle cx="10" cy="10" r="6.5"/><path d="M10 3.1v13.8a6.9 6.9 0 0 0 0 -13.8Z" fill="currentColor" stroke="none"/>',
  tidy: '<path d="M4.02 5.4h1.84a0.92 0.92 0 0 1 0.92 0.92v7.36a0.92 0.92 0 0 1 -0.92 0.92h-1.84a0.92 0.92 0 0 1 -0.92 -0.92v-7.36a0.92 0.92 0 0 1 0.92 -0.92ZM9.08 5.4h1.84a0.92 0.92 0 0 1 0.92 0.92v4.6a0.92 0.92 0 0 1 -0.92 0.92h-1.84a0.92 0.92 0 0 1 -0.92 -0.92v-4.6a0.92 0.92 0 0 1 0.92 -0.92ZM14.14 5.4h1.84a0.92 0.92 0 0 1 0.92 0.92v5.98a0.92 0.92 0 0 1 -0.92 0.92h-1.84a0.92 0.92 0 0 1 -0.92 -0.92v-5.98a0.92 0.92 0 0 1 0.92 -0.92Z"/>',
  undoKind: '<path d="M6.688 3.376 2.824 7.24 6.688 11.104M3.376 7.24h7.728a4.968 4.968 0 0 1 0 9.936H7.792"/>',
  pencil: '<path d="M3.371 16.629v-2.873L13.757 3.371a1.768 1.768 0 0 1 2.541 0a1.768 1.768 0 0 1 0 2.541L6.243 16.629H3.371Z"/>',
  tag: '<path d="M3.1 3.1h6.369l7.431 7.431 -6.369 6.369 -7.431 -7.431v-6.369ZM5.754 6.815a1.062 1.062 0 1 0 2.123 0a1.062 1.062 0 1 0 -2.123 0Z"/>',
  hash: '<path d="M8 3 6.5 17M13.5 3 12 17M3.5 7.5h13M3 12.5h13"/>',
  rotate: '<path d="M16.033 9.452A6.033 6.033 0 1 1 14.169 5.173M14.936 1.773v3.839H11.097"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  arrowUp: '<path d="M10 16.9V3.1M4.25 8.85l5.75 -5.75 5.75 5.75"/>',
  arrowRight: '<path d="M3.1 10h13.8M11.15 4.25l5.75 5.75 -5.75 5.75"/>',
  wrapLines: '<path d="M3.1 5.223h13.8M3.1 10h11.146a2.654 2.654 0 0 1 0 5.308H11.062M12.654 13.715 11.062 15.308l1.592 1.592M3.1 14.777h4.246"/>',
  textL: '<path d="M3.1 4.692h13.8M3.1 8.408h8.492M3.1 12.123h13.8M3.1 15.838h8.492"/>',
  textC: '<path d="M3.1 4.692h13.8M5.754 8.408h8.492M3.1 12.123h13.8M5.754 15.838h8.492"/>',
  textR: '<path d="M3.1 4.692h13.8M8.408 8.408h8.492M3.1 12.123h13.8M8.408 15.838h8.492"/>',
  textJ: '<path d="M3.1 4.692h13.8M3.1 8.408h13.8M3.1 12.123h13.8M3.1 15.838h13.8"/>',
  between: '<path d="M3.1 3.1v13.8M16.9 3.1v13.8M6.391 7.346h1.38a0.637 0.637 0 0 1 0.637 0.637v4.034a0.637 0.637 0 0 1 -0.637 0.637h-1.38a0.637 0.637 0 0 1 -0.637 -0.637v-4.034a0.637 0.637 0 0 1 0.637 -0.637ZM12.229 7.346h1.38a0.637 0.637 0 0 1 0.637 0.637v4.034a0.637 0.637 0 0 1 -0.637 0.637h-1.38a0.637 0.637 0 0 1 -0.637 -0.637v-4.034a0.637 0.637 0 0 1 0.637 -0.637Z"/>',
  arrowDown: '<path d="M10 3.1v13.8M4.25 11.15l5.75 5.75 5.75 -5.75"/>',
  sparkle: '<path d="M9 2.8c.5 3.6 2 5.1 5.6 5.6-3.6.5-5.1 2-5.6 5.6-.5-3.6-2-5.1-5.6-5.6C7 7.9 8.5 6.4 9 2.8Z M15.2 12.6v4.2M13.1 14.7h4.2"/>',
  send: '<path d="M10 16.9v-13.8M4.355 8.745 10 3.1 15.645 8.745"/>',
  stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.8" fill="currentColor" stroke="none"/>',
  cut: '<path d="M7.282 12.927 14.182 3.205M12.718 12.927 5.818 3.205M3.518 14.705a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0 -4.6 0ZM11.882 14.705a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0 -4.6 0Z"/>',
  paste: '<path d="M8.056 4.169V3.003h3.887V4.169M7.57 9.028h4.859M7.57 11.944h4.859M6.21 4.169h7.58a1.555 1.555 0 0 1 1.555 1.555v9.524a1.555 1.555 0 0 1 -1.555 1.555h-7.58a1.555 1.555 0 0 1 -1.555 -1.555v-9.524a1.555 1.555 0 0 1 1.555 -1.555Z"/>',
  code: '<path d="m6.5 6-3.5 4 3.5 4M13.5 6l3.5 4-3.5 4M11.3 4l-2.6 12"/>',
  download: '<path d="M10 3.1v9.554M5.754 8.938l4.246 4.246 4.246 -4.246M3.631 16.9h12.738"/>',
  upload: '<path d="M10 13.185V3.631M5.754 7.346l4.246 -4.246 4.246 4.246M3.631 16.9h12.738"/>',
  chat: '<path d="M3.1 4.825A1.725 1.725 0 0 1 4.825 3.1h10.35A1.725 1.725 0 0 1 16.9 4.825v6.9a1.725 1.725 0 0 1 -1.725 1.725H9.08L5.4 16.67V13.45A1.725 1.725 0 0 1 3.1 11.725v-6.9Z"/>',
  command: '<path d="M6.55 6.55V4.825a1.725 1.725 0 1 0 -1.725 1.725H6.55Zm0 0h6.9m-6.9 0v6.9m6.9 -6.9V4.825A1.725 1.725 0 1 1 15.175 6.55H13.45Zm0 0v6.9m0 0v1.725a1.725 1.725 0 1 0 1.725 -1.725H13.45Zm0 0H6.55m0 0v1.725A1.725 1.725 0 1 1 4.825 13.45H6.55Z"/>',
  enter: '<path d="M16.9 3.1v6.273a2.509 2.509 0 0 1 -2.509 2.509h-11.291M6.864 8.118l-3.764 3.764 3.764 3.764"/>',
  component: '<path d="m9.583 2.683 3.067 3.067L10 9.233 6.933 6.167 10 3.1ZM10 10.767l3.067 3.067 -3.067 3.067 -3.067 -3.067 3.067 -3.067ZM6.167 6.933 9.233 10 6.167 13.067 3.1 10 6.167 6.933ZM13.833 6.933l3.067 3.067 -3.067 3.067 -3.067 -3.067L13.833 6.933Z"/>',
  instance: '<path d="M10 3.1 16.9 10 10 16.9 3.1 10 10 3.1Z"/>',
  lock: '<path d="M7 8.8V6.4a3 3 0 0 1 6 0v2.4M5.92 8.8h8.16a1.92 1.92 0 0 1 1.92 1.92v4.56a1.92 1.92 0 0 1 -1.92 1.92h-8.16a1.92 1.92 0 0 1 -1.92 -1.92v-4.56a1.92 1.92 0 0 1 1.92 -1.92Z"/>',
  unlock: '<path d="M6.979 8.792V6.375a3.021 3.021 0 0 1 5.8 -1.088M5.891 8.792h8.217a1.933 1.933 0 0 1 1.933 1.933v4.592a1.933 1.933 0 0 1 -1.933 1.933h-8.217a1.933 1.933 0 0 1 -1.933 -1.933v-4.592a1.933 1.933 0 0 1 1.933 -1.933Z"/>',
  folder: '<path d="M3 6.2A1.7 1.7 0 0 1 4.7 4.5h3.1l1.6 1.8h5.9A1.7 1.7 0 0 1 17 8v6.3a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 14.3V6.2Z"/>',
  folderUp: '<path d="M3 6.2A1.7 1.7 0 0 1 4.7 4.5h3.1l1.6 1.8h5.9A1.7 1.7 0 0 1 17 8v6.3a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 14.3V6.2ZM10 13V9M8 10.8 10 9l2 1.8"/>',
  clock: '<path d="M10 6.072V10l2.76 1.698M3.1 10a6.9 6.9 0 1 0 13.8 0a6.9 6.9 0 1 0 -13.8 0Z"/>',
  gear: '<g transform="scale(.69)" stroke-width="2.17"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></g>',
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
  svg.dataset.icon = name; // Which glyph this is, for audits that must not judge a caret by a square's rules.
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
