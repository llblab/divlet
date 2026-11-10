import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import iconNodes from 'lucide-static/icon-nodes.json' with { type: 'json' };
import { parseFragment } from 'parse5';
import postcss from 'postcss';
import { validateDocument, DivletError, PROJECTION_LIMITS } from '../../../core/lib/model.ts';
import { validateWebProperties } from './validate.js';
import { readProject, materializeProject } from './source.js';
import { nativeGradientImage } from './pen-paint.js';
import { nativePathViewBox } from './pen-path.js';
import { nativePolygonPath } from './pen-polygon.js';
import { nativeMeshImage } from './pen-mesh.js';

const ICON_ROOT = new URL('./', import.meta.resolve('lucide-static/package.json'));
const ICON_LICENSE = await readFile(new URL('LICENSE', ICON_ROOT), 'utf8');
const ICON_ALIASES = new Map();

function iconShapes(name) {
  if (Object.hasOwn(iconNodes, name)) return iconNodes[name];
  if (typeof name !== 'string' || name.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return null;
  if (!ICON_ALIASES.has(name)) {
    let svg;
    try { svg = readFileSync(new URL(`icons/${name}.svg`, ICON_ROOT), 'utf8'); }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
    const root = parseFragment(svg).childNodes.find(node => node.tagName === 'svg');
    const shapes = root?.childNodes.filter(node => node.tagName);
    ICON_ALIASES.set(name, shapes?.every(node => !node.childNodes?.some(child => child.tagName)) ? shapes.map(node => [node.tagName, Object.fromEntries(node.attrs.map(attr => [attr.name, attr.value]))]) : null);
  }
  return ICON_ALIASES.get(name);
}

const ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;

function error(message, details, code = 'INVALID_HTML') {
  throw new DivletError(code, message, details);
}


/** Build an ephemeral DOM document for the existing codecs; never write this projection as PEN source. */
export function sourceFrame(input, rootId, options = {}) {
  const project = readProject(typeof input?.version === 'string' ? input : input?.format === 'pen' ? input.source : input);
  if (project.format !== 'pen') error('sourceFrame requires a PEN source.', undefined, 'UNSUPPORTED_PEN_RENDER');
  return sourceFrameView(project, rootId, options);
}

/**
 * `options.reference(name, type, unit)` lets the caller keep variables live: for a `$name` property it returns the CSS to
 * use (typically `var(--token)`, declaring the token itself) or null to inline the literal. Without it every variable is
 * resolved to its literal value.
 */
function sourceFrameView(project, rootId, { reference } = {}) {
  const settings = project.settings;
  const view = materializeProject(project, { rootIds: [rootId] });
  const root = view.roots[0];
  const diagnostics = structuredClone(view.diagnostics);
  const warn = (code, message, id) => {
    const previous = diagnostics.find(item => item.code === code);
    if (previous) { previous.count++; if (previous.nodes.length < 8) previous.nodes.push(id); }
    else diagnostics.push({ code, message, count: 1, nodes: [id] });
  };
  const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
  const idOf = node => `p-${digest(node.key)}`;
  const scalar = (value, type) => {
    if (typeof value === 'string' && value.startsWith('$')) {
      const variable = Object.hasOwn(project.source.variables || {}, value.slice(1)) ? project.source.variables[value.slice(1)] : null;
      if (!variable || variable.type !== type || typeof variable.value === 'string' && variable.value.startsWith('$')) error('Unsupported variable interpretation in PEN rendering.', undefined, 'UNSUPPORTED_PEN_RENDER');
      value = variable.value;
    }
    const primitive = type === 'color' ? 'string' : type;
    if (typeof value !== primitive && !(type === 'string' && typeof value === 'number')) error(`Unsupported PEN ${type} property value.`, undefined, 'UNSUPPORTED_PEN_RENDER');
    return value;
  };
  const number = value => scalar(value, 'number');
  const literalColor = value => String(scalar(value, 'color'));
  // A variable reference stays a reference (validated first) when the caller keeps variables live.
  const live = (value, type, unit) => {
    if (!reference || typeof value !== 'string' || !value.startsWith('$')) return null;
    scalar(value, type);
    return reference(value.slice(1), type, unit) ?? null;
  };
  const px = value => live(value, 'number', 'px') ?? `${number(value)}px`;
  const color = value => live(value, 'color', '') ?? literalColor(value);
  const solidPaint = (value, paint = color) => {
    if (Array.isArray(value)) {
      if (!value.length) return null;
      if (value.length !== 1) error('Unsupported PEN solid paint layers.', undefined, 'UNSUPPORTED_PEN_RENDER');
      return solidPaint(value[0], paint);
    }
    if (value && typeof value === 'object') {
      if (value.enabled === false) return null;
      if (value.type !== 'color' || value.opacity !== undefined) error('Unsupported PEN solid paint.', undefined, 'UNSUPPORTED_PEN_RENDER');
      return paint(value.color);
    }
    return paint(value);
  };
  const box = (value, id) => {
    if (Array.isArray(value)) {
      if (![2, 4].includes(value.length)) error('Unsupported PEN box array.', undefined, 'UNSUPPORTED_PEN_RENDER');
      warn('BOX_ORDER_POLICY', 'Padding/radius arrays use CSS side/corner order; reference rendering remains required.', id);
      return value.map(px).join(' ');
    }
    return px(value);
  };
  const nodes = {};
  const provenance = new Map();
  const styles = new Map();
  const meshBudget = { pixels: 0, triangles: 0, samples: 0 };
  let icons = false, renderedNodes = 0;
  const add = (node, origin) => {
    if (++renderedNodes > PROJECTION_LIMITS.nodes) error('Native DOM projection exceeds its node budget.', undefined, 'TOO_LARGE');
    if (Object.hasOwn(nodes, node.id)) error('Duplicate generated PEN DOM ID.', undefined, 'INVALID_PROJECTION');
    nodes[node.id] = node;
    if (origin) provenance.set(node.id, origin);
    return node.id;
  };
  const styleKey = style => {
    const raw = JSON.stringify(style);
    if (!styles.has(raw)) {
      const safe = validateWebProperties({ style }).style;
      const declarations = Object.entries(safe).map(([name, value]) => `${name}:${value}`).join(';');
      styles.set(raw, { key: digest(declarations), declarations });
    }
    return styles.get(raw).key;
  };
  const dimension = (style, key, value, parentFlow, isRoot) => {
    if (value === undefined) return;
    if (typeof value === 'number' || typeof value === 'string' && value.startsWith('$')) { style[key] = px(value); return; }
    const mode = /^(fill_container|fit_content)(?:\([^)]*\))?$/.exec(value)?.[1];
    if (mode === 'fit_content') { style[key] = 'auto'; return; }
    if (mode !== 'fill_container') error(`Unsupported PEN sizing mode: ${value}`, undefined, 'UNSUPPORTED_PEN_RENDER');
    const main = key === 'width' && parentFlow === 'row' || key === 'height' && parentFlow === 'column';
    if (main && !isRoot) { style.flex = '1 1 0px'; style[key] = '0px'; }
    else { style[key] = '100%'; style['align-self'] = 'stretch'; }
  };
  const render = (item, parentFlow = null, isRoot = false) => {
    const id = idOf(item);
    const p = item.properties;
    const bundle = p.divlet?.html && typeof p.divlet.html === 'object' ? p.divlet.html : null;
    const origin = { ...item.provenance, key: item.key, nodeType: item.type, presentation: bundle ? 'html' : 'native', htmlScope: view.sharedNodes.has(item.provenance.instancePath[0] ?? item.provenance.sourceId) ? 'shared' : 'local' };
    const web = p.divlet ? validateWebProperties(p.divlet) : {};
    if (bundle) {
      if (!['frame', 'text', 'rectangle'].includes(item.type) || item.type !== 'frame' && item.children.length) error('HTML ownership on this PEN primitive is outside the admitted presentation region.', undefined, 'UNSUPPORTED_PEN_RENDER');
      const html = validateWebProperties(Object.fromEntries(['tag', 'className', 'attrs', 'style'].filter(key => Object.hasOwn(bundle, key)).map(key => [key, bundle[key]])));
      if (bundle.link) {
        html.attrs = { ...html.attrs, href: `pen-${digest(bundle.link.frame)}.html${bundle.link.suffix}` };
        origin.link = structuredClone(bundle.link);
      }
      const children = [];
      if (item.type === 'text' && p.content !== undefined) children.push(add({ id: `${id}-text`, type: 'text', content: p.content, metadata: {} }, { ...origin, part: 'text' }));
      children.push(...item.children.map(child => render(child, 'html')));
      return add({ id, type: 'element', tag: html.tag, className: html.className, attrs: html.attrs || {}, style: html.style || {}, children, metadata: { ...web.metadata, ...(typeof p.name === 'string' ? { name: p.name } : {}), pen: origin } }, origin);
    }
    if (parentFlow === 'html') error('A native child under an HTML-owned parent requires an admitted contextual promotion closure.', undefined, 'UNSUPPORTED_PEN_RENDER');
    const style = { 'min-width': '0px', 'min-height': '0px', 'flex-shrink': '0' };
    let tag = 'div';
    let attrs = {};
    let children = [];
    let flow = null;
    if (item.type === 'frame') {
      if (p.layout === undefined || p.layout === 'horizontal') {
        flow = 'row';
        warn('DEFAULT_ROW_POLICY', 'Frames without layout use horizontal flow; this profile assumption needs reference rendering.', item.provenance.sourceId);
      } else if (p.layout === 'vertical') flow = 'column';
      else if (p.layout !== 'none') error(`Unsupported PEN layout: ${p.layout}`, undefined, 'UNSUPPORTED_PEN_RENDER');
      style.position = 'relative';
      if (flow) { style.display = 'flex'; style['flex-direction'] = flow; }
      if (p.gap !== undefined) style.gap = px(p.gap);
      if (p.padding !== undefined) style.padding = box(p.padding, item.provenance.sourceId);
      const align = { center: 'center', end: 'flex-end', start: 'flex-start', space_between: 'space-between' };
      if (p.alignItems !== undefined) { if (!Object.hasOwn(align, p.alignItems)) error('Unsupported PEN alignItems.', undefined, 'UNSUPPORTED_PEN_RENDER'); style['align-items'] = align[p.alignItems]; }
      if (p.justifyContent !== undefined) { if (!Object.hasOwn(align, p.justifyContent)) error('Unsupported PEN justifyContent.', undefined, 'UNSUPPORTED_PEN_RENDER'); style['justify-content'] = align[p.justifyContent]; }
      if (p.clip) style.overflow = 'hidden';
    } else if (item.type === 'text') {
      style['white-space'] = 'pre-wrap';
      if (p.content !== undefined) add({ id: `${id}-text`, type: 'text', content: p.content, metadata: {} }, { ...origin, part: 'text' });
      if (p.content !== undefined) children.push(`${id}-text`);
    } else if (['icon', 'path', 'polygon'].includes(item.type)) {
      tag = 'svg'; attrs.xmlns = 'http://www.w3.org/2000/svg';
      if (item.type === 'icon') {
        const shapes = p.library === 'lucide' ? iconShapes(p.icon) : null;
        if (!shapes) error('Unsupported or unavailable PEN icon.', undefined, 'UNSUPPORTED_PEN_RENDER');
        icons = true;
        Object.assign(attrs, { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', role: 'img', 'aria-label': p.name || p.icon });
        children = shapes.map(([shape, shapeAttrs], index) => add({ id: `${id}-glyph${index}`, type: 'element', tag: shape, attrs: shapeAttrs, children: [], metadata: {} }, { ...origin, part: 'glyph', readOnly: true }));
      } else if (item.type === 'polygon') {
        if (p.rotation !== undefined && number(p.rotation) !== 0 || ['flipX', 'flipY'].some(key => p[key] !== undefined && scalar(p[key], 'boolean')) || p.effect && p.effect.enabled !== false && p.effect.type !== 'blur') error('Polygon transforms/effects require a separately admitted geometry policy.', undefined, 'UNSUPPORTED_PEN_RENDER');
        if (p.effect && p.effect.enabled !== undefined && typeof p.effect.enabled !== 'boolean' || p.opacity !== undefined && (number(p.opacity) < 0 || number(p.opacity) > 1)) error('Unsupported polygon visibility/opacity context.', undefined, 'UNSUPPORTED_PEN_RENDER');
        const paints = Array.isArray(p.fill) ? p.fill : [p.fill];
        if (paints.some(fill => Array.isArray(fill) || fill && typeof fill === 'object' && fill.enabled !== false && (fill.blendMode !== undefined && fill.blendMode !== 'normal' || fill.enabled !== undefined && typeof fill.enabled !== 'boolean'))) error('Unsupported polygon paint enable/compositing context.', undefined, 'UNSUPPORTED_PEN_RENDER');
        const width = number(p.width), height = number(p.height);
        const geometry = nativePolygonPath(width, height, p.polygonCount === undefined ? 3 : number(p.polygonCount), p.cornerRadius === undefined ? 0 : number(p.cornerRadius));
        Object.assign(attrs, { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' });
        style.color = 'transparent';
        children.push(add({ id: `${id}-path`, type: 'element', tag: 'path', attrs: { d: geometry, fill: 'currentColor' }, children: [], metadata: {} }, { ...origin, part: 'geometry', readOnly: true }));
        warn('POLYGON_GEOMETRY_POLICY', 'Divlet uses top-first clockwise bbox vertices and locally clamped circular fillets; exact Pencil parity is unverified.', item.provenance.sourceId);
      } else {
        attrs.viewBox = nativePathViewBox(p.geometry, p.viewBox).join(' ');
        attrs.preserveAspectRatio = 'none';
        if (p.fillRule !== undefined && !['nonzero', 'evenodd'].includes(p.fillRule)) error('Unsupported PEN path fill rule.', undefined, 'UNSUPPORTED_PEN_RENDER');
        children.push(add({ id: `${id}-path`, type: 'element', tag: 'path', attrs: { d: p.geometry, fill: 'currentColor', ...(p.fillRule === undefined ? {} : { 'fill-rule': p.fillRule }) }, children: [], metadata: {} }, { ...origin, part: 'geometry', readOnly: true }));
      }
    } else if (item.type === 'ellipse') {
      if (p.innerRadius !== undefined && number(p.innerRadius) !== 0 || p.sweepAngle !== undefined && Math.abs(number(p.sweepAngle)) !== 360) error('Partial/ring PEN ellipses require separate geometry support.', undefined, 'UNSUPPORTED_PEN_RENDER');
      style['border-radius'] = '50%';
    } else if (item.type !== 'rectangle') error(`Unsupported PEN node type: ${item.type}`, undefined, 'UNSUPPORTED_PEN_RENDER');
    if (p.layoutPosition !== undefined && p.layoutPosition !== 'absolute') error('Unsupported PEN layout position.', undefined, 'UNSUPPORTED_PEN_RENDER');
    if (p.textGrowth !== undefined && p.textGrowth !== 'fixed-width') error('Unsupported PEN text growth.', undefined, 'UNSUPPORTED_PEN_RENDER');
    dimension(style, 'width', p.width, parentFlow, isRoot);
    dimension(style, 'height', p.height, parentFlow, isRoot);
    if (!isRoot && (parentFlow === 'none' || p.layoutPosition === 'absolute')) {
      style.position = 'absolute';
      if (p.x !== undefined) style.left = px(p.x);
      if (p.y !== undefined) style.top = px(p.y);
    }
    if (p.cornerRadius !== undefined && !['ellipse', 'polygon'].includes(item.type)) style['border-radius'] = box(p.cornerRadius, item.provenance.sourceId);
    if (p.enabled === false) { style.display = 'none'; warn('DISABLED_LAYOUT_POLICY', 'Disabled nodes are omitted from layout; source values are retained.', item.provenance.sourceId); }
    if (p.opacity !== undefined) { const value = number(p.opacity); if (value >= 0 && value <= 1) style.opacity = String(value); }
    if (p.fontSize !== undefined) style['font-size'] = px(p.fontSize);
    if (p.fontWeight !== undefined) style['font-weight'] = live(p.fontWeight, 'string', '') ?? String(scalar(p.fontWeight, 'string'));
    if (p.lineHeight !== undefined) style['line-height'] = live(p.lineHeight, 'number', '') ?? String(number(p.lineHeight));
    if (p.fontFamily !== undefined) {
      style['font-family'] = live(p.fontFamily, 'string', 'family') ?? `${JSON.stringify(String(scalar(p.fontFamily, 'string')))},system-ui,sans-serif`;
      warn('FONT_DEPENDENCY', 'Font names are retained with system fallback; no font files are loaded by the source codec.', item.provenance.sourceId);
    }
    if (p.textAlign !== undefined) {
      if (!['left', 'center', 'right', 'start', 'end'].includes(p.textAlign)) error('Unsupported PEN text alignment.', undefined, 'UNSUPPORTED_PEN_RENDER');
      style['text-align'] = p.textAlign;
    }
    if (p.fill !== undefined) {
      if (['text', 'icon', 'path', 'polygon'].includes(item.type)) {
        style.color = solidPaint(p.fill) ?? 'transparent';
      } else {
        const fills = (Array.isArray(p.fill) ? p.fill : [p.fill]).filter(fill => !(fill && typeof fill === 'object' && fill.enabled === false)).map(fill => {
          if (!fill || typeof fill !== 'object' || fill.type !== 'color') return fill;
          return solidPaint(fill);
        });
        const layers = [], sizes = [], origins = [];
        for (const fill of fills) {
          if (fill && typeof fill === 'object') {
            if (fill.type === 'gradient') {
              const image = nativeGradientImage(fill, { number, color: literalColor, boolean: value => scalar(value, 'boolean') });
              if (image) { layers.push(image); sizes.push('100% 100%'); origins.push('border-box'); }
              continue;
            }
            if (fill.type === 'mesh_gradient') {
              const image = nativeMeshImage(fill, { number, color: literalColor, boolean: value => scalar(value, 'boolean'), budget: meshBudget });
              if (image) { layers.push(image); sizes.push('100% 100%'); origins.push('border-box'); warn('MESH_RENDER_POLICY', 'Divlet uses neighbor-derived handles, tessellated Coons patches and a 128px premultiplied-sRGB PNG; exact Pencil parity is unverified.', item.provenance.sourceId); }
              continue;
            }
            if (fill.type !== 'image' || typeof fill.url !== 'string' || /[\u0000-\u001f\\]/.test(fill.url) || fill.mode && fill.mode !== 'cover') error('Unsupported PEN image fill.', undefined, 'UNSUPPORTED_PEN_RENDER');
            if (fill.enabled !== false) layers.push(`url(${JSON.stringify(fill.url)})`);
          } else { const value = color(fill); layers.push(`linear-gradient(${value},${value})`); }
          sizes.push('cover'); origins.push('padding-box');
        }
        if (fills.length === 1 && typeof fills[0] === 'string') style['background-color'] = color(fills[0]);
        else if (layers.length) {
          style['background-image'] = layers.reverse().join(','); style['background-size'] = sizes.reverse().join(','); style['background-origin'] = origins.reverse().join(','); style['background-position'] = 'center'; style['background-repeat'] = 'no-repeat';
          if (fills.length > 1) warn('FILL_ORDER_POLICY', 'Fill arrays paint first-to-last, with later layers on top; reference rendering remains required.', item.provenance.sourceId);
        }
      }
    }
    const stroke = p.stroke === undefined ? null : solidPaint(p.stroke);
    if (stroke !== null) {
      if (item.type === 'polygon') error('Polygon strokes require a separately admitted alignment/geometry policy.', undefined, 'UNSUPPORTED_PEN_RENDER');
      if (item.type === 'ellipse' && p.strokeAlignment !== undefined && !['inner', 'outer'].includes(p.strokeAlignment)) error('Unsupported PEN ellipse stroke alignment.', undefined, 'UNSUPPORTED_PEN_RENDER');
      if (item.type === 'ellipse' && p.strokeWidth && typeof p.strokeWidth === 'object') error('Ellipse strokes require one scalar width.', undefined, 'UNSUPPORTED_PEN_RENDER');
      if (tag === 'svg') { attrs.stroke = solidPaint(p.stroke, literalColor); if (p.strokeWidth !== undefined) attrs['stroke-width'] = String(number(p.strokeWidth)); }
      else if (item.type === 'ellipse') {
        const width = number(p.strokeWidth ?? 1);
        if (!Number.isFinite(width) || width < 0 || width > 16384) error('Unsupported PEN ellipse stroke width.', undefined, 'UNSUPPORTED_PEN_RENDER');
        // Border/outline widths snap to device pixels; shadow rings retain fractional strokes.
        style['box-shadow'] = `${p.strokeAlignment === 'outer' ? '' : 'inset '}0 0 0 ${width}px ${stroke}`;
      }
      else {
        const widths = p.strokeWidth ?? 1;
        if (typeof widths === 'object' && widths !== null) for (const [side, value] of Object.entries(widths)) {
          if (!['top', 'right', 'bottom', 'left'].includes(side)) error('Unsupported PEN stroke side.', undefined, 'UNSUPPORTED_PEN_RENDER');
          style[`border-${side}`] = `${px(value)} solid ${stroke}`;
        } else style.border = `${px(widths)} solid ${stroke}`;
      }
    }
    if (p.effect && p.effect.enabled !== false) {
      if (p.effect.type === 'shadow' && p.effect.shadowType === 'outer') {
        const shadow = `${px(p.effect.offset?.x ?? 0)} ${px(p.effect.offset?.y ?? 0)} ${px(p.effect.blur ?? 0)} ${color(p.effect.color)}`;
        style['box-shadow'] = style['box-shadow'] ? `${style['box-shadow']},${shadow}` : shadow;
      }
      else if (p.effect.type === 'blur') {
        const radius = number(p.effect.radius);
        if (!Number.isFinite(radius) || radius < 0 || radius > 16384) error('Unsupported PEN blur radius.', undefined, 'UNSUPPORTED_PEN_RENDER');
        style.filter = `blur(${radius}px)`;
      } else warn('UNSUPPORTED_EFFECT', 'This effect is retained in source but not rendered.', item.provenance.sourceId);
    }
    if (web.tag !== undefined) {
      if (tag === 'svg' && web.tag !== 'svg') error('SVG primitives cannot change their root tag.', undefined, 'UNSUPPORTED_PEN_RENDER');
      tag = web.tag;
    }
    attrs = { ...attrs, ...web.attrs, 'data-pen-style': styleKey(style) };
    if (item.children.length && item.type !== 'frame') error('Children on this PEN primitive are outside the observed profile.', undefined, 'UNSUPPORTED_PEN_RENDER');
    if (item.children.length) children.push(...item.children.map(child => render(child, flow || 'none')));
    const metadata = { ...web.metadata, ...(typeof p.name === 'string' ? { name: p.name } : {}), pen: origin };
    return add({ id, type: 'element', tag, attrs, className: web.className || '', style: web.style || {}, children, metadata }, origin);
  };
  const rootIdView = render(root, null, true);
  const rawRoot = project.source.children.find(node => node.id === rootId);
  const htmlRoot = root.properties.divlet?.html && typeof root.properties.divlet.html === 'object';
  const viewport = (key, fallback) => {
    const raw = htmlRoot ? rawRoot.divlet.viewport[key] : root.properties[key];
    const value = typeof raw === 'string' && raw.startsWith('$') ? number(raw) : raw;
    if (typeof value === 'number' && value >= 1 && value <= 16384) return value;
    warn('AUTO_VIEWPORT', 'A temporary viewport is used for intrinsic root dimensions; measure content before claiming final artboard height.', rootId);
    return fallback;
  };
  if (icons) warn('ICON_LIBRARY_POLICY', 'Lucide 1.67.0 with stroke width 2 is used; the PEN document does not pin an icon-library version.', rootId);
  const name = String(root.properties.name || rootId).slice(0, 512);
  const css = `${icons ? `/*! Lucide 1.67.0 (ISC/MIT)\n${ICON_LICENSE.replaceAll('*/', '* /')}*/\n` : ''}html,body{margin:0;padding:0;font-family:system-ui,sans-serif}*{box-sizing:border-box}\n${[...styles.values()].map(({ key, declarations }) => `[data-pen-style="${key}"]{${declarations}}`).join('\n')}\n${settings.css}`;
  const document = validateDocument({ schemaVersion: 1, id: `pen-${digest(rootId)}`, name, version: 1, rootId: rootIdView, artboard: { x: rawRoot.x === undefined ? 0 : number(rawRoot.x), y: rawRoot.y === undefined ? 0 : number(rawRoot.y), width: viewport('width', 1280), height: viewport('height', 800) }, nodes, tokens: settings.tokens, css, metadata: { ...root.properties.divlet?.metadata, pen: { rootId, projection: true, presentation: htmlRoot ? 'html' : 'native', ...(htmlRoot ? { viewport: { width: rawRoot.divlet.viewport.width, height: rawRoot.divlet.viewport.height }, viewportEditable: ['frame', 'text', 'rectangle'].includes(rawRoot.type) && !!rawRoot.divlet?.html } : {}), intrinsicHeight: htmlRoot ? rawRoot.divlet.viewport.height === 'content' : root.type === 'frame' && (root.properties.height === undefined || typeof root.properties.height === 'string' && /^fit_content(?:\([^)]*\))?$/.test(root.properties.height)) } } }, { limits: PROJECTION_LIMITS });
  return { format: 'pen-projection', document, provenance, diagnostics };
}












function attr(node, name) {
  return node.attrs?.find(item => item.name === name)?.value;
}


