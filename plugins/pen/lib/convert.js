/*
 * PEN → Divlet conversion. A PEN source is read through its native projection (which already renders it correctly) and every
 * frame is re-expressed as ordinary HTML/SVG/CSS with live variable references. Generated CSS uses ordinary data-attribute
 * selectors at the projection's original specificity; no utility compiler or normalization is involved. Component instances
 * that equal their definition plus overrides stay instances.
 */
import postcss from 'postcss';
import { readProject } from './source.js';
import { sourceFrame } from './projection.js';
import { validateSettings, writeProject } from '../../../core/lib/project.ts';
import { validateDocument } from '../../../core/lib/model.ts';
import { decodeCss } from '../../../core/lib/css-literals.ts';

function unsupported(message) { throw Object.assign(new Error(message), { code: 'UNSUPPORTED_PEN_RENDER' }); }
function refuseProjectionReferences(css) {
  if (decodeCss(css).toLowerCase().includes('data-pen-style')) unsupported('Authored CSS contains a projection-only style carrier name; ambiguous references are not converted.');
}

const slug = text => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

/** Keep authored tokens and explicit colour variables separate; never infer a variable from a matching literal. */
function colorTokens(variables, inherited, theme = {}) {
  const tokens = { ...inherited };
  for (const [name, variable] of Object.entries(variables || {})) {
    if (variable?.type !== 'color' || typeof variable.value !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(variable.value)) continue;
    const token = `--color-${slug(name) || 'color'}`;
    const alias = theme[token];
    const sameVariable = alias === `$${name}` || alias?.variable === name && !alias.unit;
    if (Object.hasOwn(tokens, token) && !sameVariable) unsupported('Colour variables require distinct native token names; ambiguous aliases are not converted.');
    tokens[token] = variable.value;
  }
  return tokens;
}

function uniqueId(base, taken) {
  let id = /^[A-Za-z]/.test(base) ? base : `f-${base}`;
  id = id.slice(0, 80) || 'frame';
  for (let n = 2; taken.has(id); n++) id = `${id.slice(0, 76)}-${n}`;
  taken.add(id);
  return id;
}

/** Select a styling hook absent from authored attributes and CSS, including escaped references and inline attr(). */
function styleAttribute(projections, tokens, css) {
  const used = new Set();
  const scan = css => { for (const match of decodeCss(css).toLowerCase().matchAll(/data-import-style(?:-\d+)?/g)) used.add(match[0]); };
  scan(css);
  for (const value of Object.values(tokens)) scan(value);
  for (const { document } of projections) {
    scan(document.css);
    for (const value of Object.values(document.tokens)) scan(value);
    for (const node of Object.values(document.nodes)) if (node.type === 'element') {
      for (const name of Object.keys(node.attrs)) used.add(name.toLowerCase());
      for (const value of Object.values(node.style)) scan(value);
    }
  }
  let name = 'data-import-style';
  for (let suffix = 2; used.has(name); suffix++) name = `data-import-style-${suffix}`;
  return name;
}

/** Preserve declaration order/priority in ordinary CSS; remove projection-only metadata and attributes. */
function convertFrame(projection, id, attribute) {
  const { document } = projection;
  const sheet = postcss.parse(document.css);
  const bundles = new Map(), residual = [];
  for (const rule of sheet.nodes) {
    const match = rule.type === 'rule' && /^\[data-pen-style="([^"]+)"\]$/.exec(rule.selector);
    if (match && rule.nodes.every(item => item.type === 'decl')) {
      bundles.set(match[1], rule.nodes.length);
      residual.push(rule.clone({ selector: `[${attribute}="${match[1]}"]` }).toString());
    } else {
      refuseProjectionReferences(rule.toString());
      residual.push(rule.toString());
    }
  }
  const nodes = {}, origin = new Map();
  let declarations = 0;
  for (const [nodeId, node] of Object.entries(document.nodes)) {
    origin.set(nodeId, projection.provenance.get(nodeId) ?? null);
    if (node.type !== 'element') { nodes[nodeId] = structuredClone(node); if (node.type === 'text') delete nodes[nodeId].metadata?.pen; continue; }
    const attrs = { ...node.attrs };
    const key = attrs['data-pen-style'];
    delete attrs['data-pen-style'];
    if (key !== undefined) {
      if (!bundles.has(key)) unsupported('A projection style reference has no matching declaration block.');
      attrs[attribute] = key;
      declarations += bundles.get(key);
    }
    for (const value of Object.values(node.style)) refuseProjectionReferences(value);
    const metadata = { ...node.metadata };
    delete metadata.pen;
    nodes[nodeId] = { ...structuredClone(node), attrs, metadata };
  }
  return { id, name: document.name, rootId: document.rootId, artboard: document.artboard, nodes, origin, residual, declarations };
}

/* ---- components: a PEN instance becomes a Divlet instance when it differs from its definition only by overrides ---- */
const sameObject = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

/** The override that turns definition node `d` into instance node `e`, or `undefined` when they are not the same shape. */
function overrideFor(e, d) {
  if (e.type !== d.type) return undefined;
  if (e.type === 'text') return e.content === d.content ? {} : { content: e.content };
  const out = {};
  if (e.tag !== d.tag) out.tag = e.tag;
  if (e.className !== d.className) out.className = e.className;
  for (const key of ['style', 'attrs']) if (!sameObject(e[key], d[key])) {
    const change = {};
    for (const [name, value] of Object.entries(e[key] ?? {})) if (d[key]?.[name] !== value) change[name] = value;
    for (const name of Object.keys(d[key] ?? {})) if (!(name in (e[key] ?? {}))) change[name] = null;
    out[key] = change;
  }
  return out;
}

/** Whether `inner` is within the subtree of `outer` in a frame (an instance inside its own definition would be a cycle). */
function isInside(frame, outer, inner) {
  const stack = [outer];
  while (stack.length) { const id = stack.pop(); if (id === inner) return true; const node = frame.nodes[id]; if (node?.type === 'element') stack.push(...node.children); }
  return false;
}

/**
 * The overrides an outer instance needs for a nested instance it shares with its definition: `ed`/`dd` are the nested
 * instance's `descendants` in the instance and in the definition. Addresses are the nested component's own, behind the
 * nested instance's id. `null` when the instance cannot be expressed (it drops an override the definition has).
 */
const stable = value => JSON.stringify(value, (_, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item));

function nestedOverrides(nestedId, ed = {}, dd = {}) {
  const out = {};
  for (const address of new Set([...Object.keys(ed), ...Object.keys(dd)])) {
    if (stable(ed[address]) === stable(dd[address])) continue;
    if (!ed[address]) return null;
    for (const [key, value] of Object.entries(dd[address] ?? {})) {
      if (key === 'style' || key === 'attrs') { for (const name of Object.keys(value)) if (!(name in (ed[address][key] ?? {}))) return null; }
      else if (!(key in ed[address])) return null;
    }
    out[`${nestedId}/${address}`] = ed[address];
  }
  return out;
}

function linkComponents(frames, reusable) {
  // Definitions: where each reusable PEN node is drawn in its own place.
  const defs = new Map();
  for (const frame of frames) for (const [nodeId, o] of frame.origin) if (o && !o.part && !o.instancePath.length && reusable.has(o.sourceId) && frame.nodes[nodeId]?.type === 'element' && !defs.has(o.sourceId)) defs.set(o.sourceId, { frame, nodeId });

  // One pass links every instance (at any nesting depth) whose expansion differs from its definition only by overrides and
  // contains no unlinked nested instance; the next pass then sees the nested ones as instances and can link their parents.
  const pass = () => {
    const decisions = [];
    for (const frame of frames) for (const [nodeId, o] of frame.origin) {
      if (!o || o.part || o.instancePath.length < 1 || !o.instanceId || !defs.has(o.sourceId) || frame.nodes[nodeId]?.type !== 'element') continue;
      const def = defs.get(o.sourceId), overrides = {};
      let ok = true;
      const walk = (eId, dId) => {
        const e = frame.nodes[eId], d = def.frame.nodes[dId];
        const eo = frame.origin.get(eId), dOrigin = def.frame.origin.get(dId);
        if (!e || !d || e.type !== d.type || (eo && dOrigin && eo.sourceId !== dOrigin.sourceId)) { ok = false; return; }
        if (e.type === 'ref') {
          // A nested instance that is already linked, on both sides: only what the outer instance changes about it is an override.
          const change = e.ref === d.ref ? nestedOverrides(dId, e.descendants, d.descendants) : null;
          if (!change) { ok = false; return; }
          Object.assign(overrides, change);
          return;
        }
        // Expanded by this instance only: a node of a deeper, still unlinked instance means the nested one is not ready yet.
        if (eo && eo.instancePath.length !== o.instancePath.length) { ok = false; return; }
        if (e.type === 'element' && e.children.length !== d.children.length) { ok = false; return; }
        const change = overrideFor(e, d);
        if (change === undefined) { ok = false; return; }
        if (Object.keys(change).length) overrides[dId] = change;
        if (e.type === 'element') for (let i = 0; i < e.children.length && ok; i++) walk(e.children[i], d.children[i]);
      };
      walk(nodeId, def.nodeId);
      if (ok && !(def.frame === frame && isInside(frame, def.nodeId, nodeId))) decisions.push({ frame, nodeId, def, overrides });
    }
    let applied = 0;
    for (const { frame, nodeId, def, overrides } of decisions) {
      const instance = frame.nodes[nodeId];
      if (!instance || instance.type !== 'element') continue;
      const drop = [];
      const collect = id => { drop.push(id); const node = frame.nodes[id]; if (node?.type === 'element') node.children.forEach(collect); };
      instance.children.forEach(collect);
      for (const id of drop) delete frame.nodes[id];
      frame.nodes[nodeId] = { id: nodeId, type: 'ref', ref: `${def.frame.id}/${def.nodeId}`, descendants: overrides, metadata: instance.metadata ?? {} };
      applied++;
    }
    return applied;
  };
  let total = 0;
  for (let applied = pass(); applied > 0 && total < 100000; applied = pass()) total += applied;
  for (const { frame, nodeId } of defs.values()) if (frame.nodes[nodeId]) frame.nodes[nodeId].reusable = true;
  return total;
}

function reusableIds(children, out = new Set()) {
  for (const node of children || []) { if (node.reusable === true) out.add(node.id); reusableIds(node.children, out); }
  return out;
}

/**
 * Variable references for the projection: a `$name` used as a colour, length, number or font stays a `var(--token)`, and the
 * token is declared once with the variable's value (px lengths carry their unit; a font stack carries its fallbacks).
 */
function variableReferences(variables, tokens) {
  const named = new Map();
  return (name, type, unit) => {
    const variable = Object.hasOwn(variables || {}, name) ? variables[name] : null;
    if (!variable) return null;
    if (type === 'color') {
      const token = `--color-${slug(name) || 'color'}`;
      return Object.hasOwn(tokens, token) ? `var(${token})` : null;
    }
    const value = variable.value;
    if (typeof value === 'number' ? !Number.isFinite(value) : typeof value !== 'string' || value.startsWith('$')) return null;
    if (unit === 'px' && typeof value !== 'number') return null;
    const key = `${name}\0${unit}`;
    if (!named.has(key)) {
      const base = `--${slug(name) || 'value'}`;
      let token = base;
      for (let n = 2; Object.hasOwn(tokens, token) && !(named.get(`token:${token}`) === key); n++) token = `${base}-${n}`;
      named.set(key, token); named.set(`token:${token}`, key);
      tokens[token] = unit === 'px' ? `${value}px` : unit === 'family' ? `${JSON.stringify(String(value))},system-ui,sans-serif` : String(value);
    }
    return `var(${named.get(key)})`;
  };
}

/**
 * Convert a PEN source (already-parsed JSON) to the text of a Divlet project plus statistics.
 * `provenance` is stored under the project's `metadata.import`.
 */
export function convertPen(input, { name, provenance } = {}) {
  const project = readProject(input);
  const tokens = colorTokens(project.source.variables, project.settings.tokens, project.source.divlet?.theme);
  const taken = new Set(), shared = new Set(), converted = [];
  const reference = variableReferences(project.source.variables, tokens);
  const projections = project.source.children.map(root => sourceFrame(project, root.id, { reference, includeProjectCss: false }));
  const attribute = styleAttribute(projections, tokens, project.settings.css);
  refuseProjectionReferences(project.settings.css);
  const stats = { frames: 0, nodes: 0, utilities: 0, arbitrary: 0, declarations: 0, tokens: Object.keys(tokens).length, instances: 0 };
  for (const [index, root] of project.source.children.entries()) {
    const projection = projections[index];
    const frame = convertFrame(projection, uniqueId(slug(projection.document.name) || slug(root.id) || 'frame', taken), attribute);
    for (const rule of frame.residual) shared.add(rule);
    stats.declarations += frame.declarations;
    converted.push(frame);
  }
  stats.instances = linkComponents(converted, reusableIds(project.source.children));
  const frames = converted.map(frame => validateDocument({ schemaVersion: 1, id: frame.id, name: frame.name, version: 1, rootId: frame.rootId, artboard: frame.artboard, tokens: {}, css: '', metadata: {}, nodes: frame.nodes }));
  stats.frames = frames.length;
  stats.nodes = frames.reduce((total, frame) => total + Object.keys(frame.nodes).length, 0);
  const settings = validateSettings({ name, tokens, css: [...shared, project.settings.css].filter(Boolean).join('\n'), metadata: provenance ? { import: provenance } : {} });
  return { text: writeProject(settings, frames), stats };
}

/** A card for launcher listings, without converting: the name and root frames of a PEN source. */
export function summarizePen(input) {
  const project = readProject(input);
  const roots = project.source.children;
  return { name: typeof project.source.divlet?.name === 'string' ? project.source.divlet.name : undefined, frames: roots.length, frameNames: roots.slice(0, 4).map(root => String(root.name || root.id || '').slice(0, 512)) };
}
