// Reading and writing Tailwind classes by what they control, for the inspector's layout tools.
// Only base classes are touched (no `md:`/`hover:` prefix); responsive ones stay as written.
// Pure functions: no DOM, so they are unit-tested in Node.

export const split = value => String(value || '').split(/\s+/).filter(Boolean);
const join = list => list.join(' ');

/** True when a class has a variant prefix (`md:`, `hover:`); colons inside brackets do not count. */
export function hasVariant(name) {
  let depth = 0;
  for (const ch of name) {
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ':' && !depth) return true;
  }
  return false;
}
const baseOf = name => {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ':' && !depth) cut = i;
  }
  return name.slice(cut + 1);
};

/** Project colours (`--color-brand` → `bg-brand`, `text-brand`) are colour classes too; the panel tells us which names exist. */
let colorNames = new Set();
export const setColorNames = names => { colorNames = new Set(names); };
const colorGroup = (prefix, pattern) => ({ test: name => pattern.test(name) || (name.startsWith(`${prefix}-`) && colorNames.has(name.slice(prefix.length + 1))) });

export const GROUPS = {
  display: /^(block|inline-block|inline|flex|inline-flex|grid|inline-grid|contents|flow-root|hidden|table|list-item)$/,
  position: /^(static|relative|absolute|fixed|sticky)$/,
  direction: /^flex-(row|col|row-reverse|col-reverse)$/,
  wrap: /^flex-(wrap|nowrap|wrap-reverse)$/,
  justify: /^justify-(start|end|center|between|around|evenly|stretch|normal)$/,
  items: /^items-(start|end|center|baseline|stretch)$/,
  justifyItems: /^justify-items-(start|end|center|stretch|normal)$/,
  self: /^self-(auto|start|end|center|stretch|baseline)$/,
  textAlign: /^text-(left|center|right|justify|start|end)$/,
  opacity: /^opacity-(\d+(\.\d+)?|\[.+\])$/,
  z: /^-?z-(\d+|auto|\[.+\])$/,
  blur: /^blur(-(none|xs|sm|md|lg|xl|2xl|3xl|\[.+\]))?$/,
  gap: /^gap-(?!x-|y-)(.+)$/,
  radius: /^rounded(?:-(?:none|xs|sm|md|lg|xl|2xl|3xl|4xl|full|\[[^\]]+\]))?$/,
  bgColor: colorGroup('bg', /^bg-(?:transparent|current|inherit|white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?|\[(?:#|rgb|hsl|oklch|var\(--color|color:)[^\]]*\])$/),
  fontSize: /^text-(?:xs|sm|base|lg|xl|[2-9]xl|\[length:[^\]]+\])$/,
  fontWeight: /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[\d+\])$/,
  // `[border-width:Npx]` is what a declarative `border-width` style becomes; it is the same property as `border-N`.
  borderWidth: /^(?:border(?:-(?:0|2|4|8|\[\d+(?:\.\d+)?px\]))?|\[border-width:\d+(?:\.\d+)?px\])$/,
  borderStyle: /^(?:border-(?:solid|dashed|dotted|double|hidden|none)|\[border-style:(?:solid|dashed|dotted|double|groove|ridge|inset|outset|none|hidden)\])$/,
  borderColor: colorGroup('border', /^border-(?:transparent|current|white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?|\[(?:#|rgb|hsl|oklch|var\(--color)[^\]]*\])$/),
  textColor: colorGroup('text', /^text-(?:transparent|current|inherit|white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?|\[(?:#|rgb|hsl|oklch|var\(--color|color:)[^\]]*\])$/),
  translateX: /^-?translate-x-(.+)$/,
  translateY: /^-?translate-y-(.+)$/,
};

/** The base class of a group (the last one wins in Tailwind's order for the same property), or null. */
export function get(className, group) {
  return split(className).filter(name => !hasVariant(name) && GROUPS[group].test(name)).at(-1) ?? null;
}

/** Responsive or state classes of the same group, e.g. `md:flex` next to `block`. */
export function variantsOf(className, group) {
  const test = typeof group === 'string' ? name => GROUPS[group].test(name) : group;
  return split(className).filter(name => hasVariant(name) && test(baseOf(name)));
}

/** Replace a group's base classes with `next` (a class, a list, or null to remove), in place. */
export function set(className, group, next) {
  return replace(className, name => GROUPS[group].test(name), next);
}

function replace(className, test, next) {
  const list = split(className);
  const add = (Array.isArray(next) ? next : [next]).filter(Boolean);
  const at = list.findIndex(name => !hasVariant(name) && test(name));
  const kept = list.filter(name => hasVariant(name) || !test(name));
  const index = at < 0 ? kept.length : list.slice(0, at).filter(name => hasVariant(name) || !test(name)).length;
  kept.splice(index, 0, ...add.filter(name => !kept.includes(name)));
  return join(kept);
}

/* ---- values: Tailwind tokens ↔ what a person types ---------------------------- */
const NAMED_PX = { px: 1, '0': 0 };

/** CSS px for a spacing token (`4` → 16, `px` → 1, `[13px]` → 13, `[1.5rem]` → 24); other tokens as written (`auto`, `1/2`, `[5%]`). */
export function toPx(token) {
  if (token == null) return null;
  const negative = token.startsWith('-');
  const raw = negative ? token.slice(1) : token;
  let value;
  if (Object.hasOwn(NAMED_PX, raw)) value = NAMED_PX[raw];
  else if (/^\d+(\.\d+)?$/.test(raw)) value = Number(raw) * 4;
  else if (/^\[-?\d+(\.\d+)?px\]$/.test(raw)) value = Number(raw.slice(1, -3));
  else if (/^\[-?\d+(\.\d+)?rem\]$/.test(raw)) value = Number(raw.slice(1, -4)) * 16;
  else return token;
  return negative ? -value : value;
}

/** A spacing token for what a person typed: 16 → `4`, 13 → `[13px]`, auto, 50% → `[50%]`, 1/2, full; '' → null. */
export function fromInput(raw) {
  const text = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return null;
  const px = /^(-?\d+(\.\d+)?)(px)?$/.exec(text);
  if (px) {
    const value = Number(px[1]);
    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);
    if (abs === 0) return '0';
    if (abs === 1) return `${sign}px`;
    return Number.isInteger(abs) && abs % 2 === 0 ? `${sign}${abs / 4}` : `${sign}[${abs}px]`;
  }
  if (/^-?\d+(\.\d+)?(rem|em|%|vw|vh|dvh|svh|ch)$/.test(text)) return text.startsWith('-') ? `-[${text.slice(1)}]` : `[${text}]`;
  if (/^-?(\d+\/\d+|auto|full|screen|min|max|fit)$/.test(text)) return text;
  if (/^-?\[[^\s\]]+\]$/.test(text)) return text;
  return undefined;
}

/** What a field shows for a token: px numbers plain, others as written. */
export const display = token => {
  if (token == null) return '';
  const px = toPx(token);
  return typeof px === 'number' ? String(Math.round(px * 100) / 100) : px.replace(/^\[(.+)\]$/, '$1');
};

/* ---- boxes: padding, margin, inset ------------------------------------------- */
const BOXES = {
  padding: { all: 'p', x: 'px', y: 'py', t: 'pt', r: 'pr', b: 'pb', l: 'pl', negative: false },
  margin: { all: 'm', x: 'mx', y: 'my', t: 'mt', r: 'mr', b: 'mb', l: 'ml', negative: true },
  inset: { all: 'inset', x: 'inset-x', y: 'inset-y', t: 'top', r: 'right', b: 'bottom', l: 'left', negative: true },
};
const SIDES = ['t', 'r', 'b', 'l'];
const COVERS = { all: SIDES, x: ['r', 'l'], y: ['t', 'b'], t: ['t'], r: ['r'], b: ['b'], l: ['l'] };
const RANK = { all: 0, x: 1, y: 1, t: 2, r: 2, b: 2, l: 2 };

function parseBox(name, kind) {
  const box = BOXES[kind];
  const negative = name.startsWith('-');
  const rest = negative ? name.slice(1) : name;
  if (negative && !box.negative) return null;
  // Longest prefix first: `px-4` before `p-px`, `inset-x-0` before `inset-0`.
  for (const key of ['x', 'y', 't', 'r', 'b', 'l', 'all']) {
    const prefix = `${box[key]}-`;
    if (!rest.startsWith(prefix)) continue;
    const value = rest.slice(prefix.length);
    if (!value || (kind === 'inset' && /^(shadow|ring)/.test(value))) return null;
    if (key === 'all' && kind === 'padding' && /^[xytrbl]-/.test(value)) return null;
    return { key, token: negative ? `-${value}` : value };
  }
  return null;
}

/** Effective sides of a box from base classes: { t, r, b, l } tokens or null (more specific classes win). */
export function sides(className, kind) {
  const out = { t: null, r: null, b: null, l: null };
  const found = split(className).filter(name => !hasVariant(name)).map(name => parseBox(name, kind)).filter(Boolean);
  found.sort((a, b) => RANK[a.key] - RANK[b.key]);
  for (const item of found) for (const side of COVERS[item.key]) out[side] = item.token;
  return out;
}

export const isBoxClass = (name, kind) => !!parseBox(name, kind);

/** Set one side (`t`, `r`, `b`, `l`) or `all` to a token (null clears) and write the shortest classes. */
export function setSide(className, kind, side, token) {
  const current = sides(className, kind);
  for (const key of COVERS[side]) current[key] = token;
  return replace(className, name => isBoxClass(name, kind), boxClasses(kind, current));
}

function boxClasses(kind, { t, r, b, l }) {
  const box = BOXES[kind];
  const cls = (key, token) => (token == null ? null : token.startsWith('-') ? `-${box[key]}-${token.slice(1)}` : `${box[key]}-${token}`);
  if (t != null && t === r && r === b && b === l) return [cls('all', t)];
  const out = [];
  if (l === r && l != null) out.push(cls('x', l)); else out.push(cls('l', l), cls('r', r));
  if (t === b && t != null) out.push(cls('y', t)); else out.push(cls('t', t), cls('b', b));
  return out.filter(Boolean);
}

/* ---- single values ------------------------------------------------------------ */
const BLUR = { none: 0, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 40, '3xl': 64 };

/** Field value of a group's class: opacity 0–100, z-index, blur px, gap px. */
export function valueOf(className, group) {
  const name = get(className, group);
  if (!name) return null;
  if (group === 'opacity') { const v = name.slice(8); return v.startsWith('[') ? Math.round(Number.parseFloat(v.slice(1)) * (v.includes('%') ? 1 : 100)) : Number(v); }
  if (group === 'z') { const negative = name.startsWith('-'); const v = name.slice(negative ? 3 : 2); if (v === 'auto') return 'auto'; const n = Number(v.replace(/[[\]]/g, '')); return negative ? -n : n; }
  if (group === 'blur') { const v = name === 'blur' ? 'sm' : name.slice(5); if (Object.hasOwn(BLUR, v)) return BLUR[v]; return Number.parseFloat(v.slice(1)); }
  if (group === 'gap') return display(name.slice(4));
  return name;
}

/** The class for a field value, or null to remove: opacity 40 → `opacity-40`, z -1 → `-z-1`, blur 8 → `blur-sm`, gap 12 → `gap-3`. */
export function classFor(group, raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (group === 'z') { if (text === 'auto') return 'z-auto'; const n = Number.parseInt(text, 10); return Number.isFinite(n) ? (n < 0 ? `-z-${-n}` : `z-${n}`) : undefined; }
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) return undefined;
  if (group === 'opacity') { const v = Math.round(Math.min(100, Math.max(0, n))); return v === 100 ? null : `opacity-${v}`; }
  if (group === 'blur') { if (n <= 0) return null; const named = Object.entries(BLUR).find(([, px]) => px === n)?.[0]; return named ? `blur-${named}` : `blur-[${n}px]`; }
  if (group === 'gap') { const token = fromInput(text); return token == null ? null : token && !token.startsWith('-') ? `gap-${token}` : undefined; }
  return undefined;
}

/* ---- alignment ---------------------------------------------------------------- */
const AXIS = ['start', 'center', 'end'];

/** Where a flex or grid container puts its children: { x, y } of start/center/end (or null), and `between`. */
export function alignment(className) {
  const flow = get(className, 'display');
  const isGrid = flow === 'grid' || flow === 'inline-grid';
  const column = /^flex-col/.test(get(className, 'direction') || '');
  const justify = get(className, isGrid ? 'justifyItems' : 'justify')?.split('-').at(-1) ?? null;
  const items = get(className, 'items')?.slice(6) ?? null;
  const main = AXIS.includes(justify) ? justify : null;
  const cross = AXIS.includes(items) ? items : null;
  return { x: column && !isGrid ? cross : main, y: column && !isGrid ? main : cross, between: !isGrid && justify === 'between' };
}

/** Align a container's children to a cell of the 3×3 grid (x, y each start/center/end). */
export function setAlignment(className, x, y) {
  const flow = get(className, 'display');
  const isGrid = flow === 'grid' || flow === 'inline-grid';
  const column = /^flex-col/.test(get(className, 'direction') || '');
  const [main, cross] = column && !isGrid ? [y, x] : [x, y];
  let next = isGrid ? set(className, 'justifyItems', `justify-items-${main}`) : set(className, 'justify', `justify-${main}`);
  next = set(next, 'items', `items-${cross}`);
  return next;
}

/** Where an absolutely positioned element is pinned: { x, y } of start/center/end from its inset classes. */
export function pin(className) {
  const box = sides(className, 'inset');
  const tx = get(className, 'translateX');
  const ty = get(className, 'translateY');
  const axis = (start, end, translate) => (start === '1/2' && translate === `-${translate?.slice(1)}` && /1\/2$/.test(translate || '') ? 'center' : start != null && end == null ? 'start' : end != null && start == null ? 'end' : null);
  return { x: axis(box.l, box.r, tx), y: axis(box.t, box.b, ty) };
}

/** Pin to a cell: edges at 0, or centered with 1/2 and a -1/2 translate. */
export function setPin(className, x, y) {
  let next = className;
  const place = (start, end, translate, value) => {
    next = setSide(next, 'inset', start, value === 'start' ? '0' : value === 'center' ? '1/2' : null);
    next = setSide(next, 'inset', end, value === 'end' ? '0' : null);
    next = set(next, translate, value === 'center' ? `-${translate === 'translateX' ? 'translate-x' : 'translate-y'}-1/2` : null);
  };
  place('l', 'r', 'translateX', x);
  place('t', 'b', 'translateY', y);
  return next;
}
