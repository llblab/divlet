// PEN source validation: lossless wire validation of a PEN document and its divlet-namespaced presentation fields.
// Generic validation helpers come from the core (lib/model.ts); everything PEN-specific lives here.
import { HTML_TAGS, ID, SVG_TAGS, LIMITS, SOURCE_LIMITS, fail, json, keys, merge, metadata, object, safeAttribute, string, validStyle } from '../../../core/lib/model.ts';

/** A replacement in descendants is a complete typed node; name is presentation, not identity. */
export const isSourceReplacement = value => !!value && typeof value === 'object' && Object.hasOwn(value, 'id') && Object.hasOwn(value, 'type') && typeof value.id === 'string' && !!value.id && typeof value.type === 'string' && !!value.type;

/** Lossless PEN wire validation; indexes refer to the cloned source, never an expanded rendering tree. */
export function validateProjectSource(input) {
  try {
    object(input, 'project source');
    // Source dictionaries are inert JSON and use Maps for identity; opaque keys are not merge targets.
    json(input, 'project source', 0, true, SOURCE_LIMITS.depth * 4 + 16);
    if (Buffer.byteLength(JSON.stringify(input)) > SOURCE_LIMITS.bytes) fail('Project source exceeds 32 MiB');
    if (typeof input.version !== 'string' || !input.version) fail('PEN version must be a nonempty format string');
    if (!Array.isArray(input.children) || input.children.length > SOURCE_LIMITS.roots) fail(`PEN children must be an array of at most ${SOURCE_LIMITS.roots} canvas nodes`);
    if (Object.hasOwn(input, 'fileToken') && typeof input.fileToken !== 'string') fail('fileToken must be a string');
    if (Object.hasOwn(input, 'variables')) {
      object(input.variables, 'variables');
      for (const [name, variable] of Object.entries(input.variables)) {
        object(variable, `variable ${name}`);
        if (typeof variable.type !== 'string' || !Object.hasOwn(variable, 'value')) fail(`Variable ${name} requires type and value`);
        const expected = variable.type === 'number' ? 'number' : ['color', 'string'].includes(variable.type) ? 'string' : null;
        if (expected && typeof variable.value !== expected) fail(`Variable ${name} must have a ${expected} value`);
      }
    }
    if (Object.hasOwn(input, 'divlet')) {
      object(input.divlet, 'divlet');
    }
    const source = structuredClone(input);
    const nodes = new Map();
    const replacements = new Map();
    const overrides = [];
    const scalar = (node, key, type) => {
      if (Object.hasOwn(node, key) && typeof node[key] !== type) fail(`${node.id || 'override'}.${key} must be ${type}`);
    };
    const properties = node => {
      for (const key of ['name', 'context', 'content', 'ref', 'library', 'icon']) scalar(node, key, 'string');
      for (const key of ['enabled', 'reusable', 'clip']) scalar(node, key, 'boolean');
      for (const key of ['width', 'height', 'x', 'y', 'opacity', 'gap', 'fontSize', 'lineHeight']) {
        if (Object.hasOwn(node, key) && !['string', 'number'].includes(typeof node[key])) fail(`${node.id || 'override'}.${key} must be a number or string`);
      }
      if (Object.hasOwn(node, 'slot') && (!Array.isArray(node.slot) || node.slot.some(id => typeof id !== 'string'))) fail('slot must be an array of component IDs');
      if (Object.hasOwn(node, 'divlet')) {
        object(node.divlet, `${node.id || 'override'}.divlet`);
      }
    };
    const visitOverrides = (map, owner, depth) => {
      object(map, `${owner.id}.descendants`);
      for (const [address, override] of Object.entries(map)) {
        const segments = address.split('/');
        if (!address || address.length > LIMITS.text || segments.length > SOURCE_LIMITS.depth || segments.some(part => !part)) fail('Override addresses must have bounded, nonempty ID segments');
        object(override, `${owner.id}.descendants.${address}`);
        if (isSourceReplacement(override)) {
          visit(override, depth + 1);
          const list = replacements.get(owner.id) || [];
          list.push(override);
          replacements.set(owner.id, list);
        } else {
          properties(override);
          if (Object.hasOwn(override, 'children')) {
            if (!Array.isArray(override.children)) fail('Override children must be a complete node array');
            for (const child of override.children) visit(child, depth + 1);
            const list = replacements.get(owner.id) || []; list.push(...override.children); replacements.set(owner.id, list);
          }
          if (Object.hasOwn(override, 'descendants')) visitOverrides(override.descendants, owner, depth + 1);
        }
      }
    };
    const visit = (node, depth) => {
      if (depth > SOURCE_LIMITS.depth) fail('PEN node tree exceeds maximum depth');
      object(node, 'PEN node');
      if (typeof node.id !== 'string' || !node.id || typeof node.type !== 'string' || !node.type) fail('PEN nodes require nonempty string id and type');
      if (nodes.has(node.id)) fail(`Duplicate serialized PEN node id: ${node.id}`);
      if (nodes.size >= SOURCE_LIMITS.nodes) fail(`PEN source exceeds ${SOURCE_LIMITS.nodes} serialized nodes`);
      nodes.set(node.id, node);
      properties(node);
      if (node.type === 'ref' && typeof node.ref !== 'string') fail(`${node.id}.ref must be a component ID`);
      if (Object.hasOwn(node, 'children')) {
        if (!Array.isArray(node.children)) fail(`${node.id}.children must be an array`);
        for (const child of node.children) visit(child, depth + 1);
      }
      if (Object.hasOwn(node, 'descendants')) {
        if (node.type !== 'ref') fail(`${node.id}.descendants requires a ref node`);
        overrides.push(node);
        visitOverrides(node.descendants, node, depth);
      }
    };
    for (const node of source.children) visit(node, 0);
    return { source, nodes, replacements, overrides };
  } catch (error) {
    if (error instanceof DivletError && error.code === 'INVALID_DOCUMENT') throw new DivletError('INVALID_PROJECT', error.message, error.details);
    throw error;
  }
}

/** Interpreted node-level Divlet v1 fields; the PEN reader preserves their original wire values. */
export function validateWebProperties(input) {
  object(input, 'node.divlet');
  json(input, 'node.divlet', 0, true, SOURCE_LIMITS.depth * 4 + 16);
  const value = structuredClone(input);
  if (Object.hasOwn(value, 'tag') && !HTML_TAGS.has(value.tag) && !SVG_TAGS.has(value.tag)) fail(`Unsupported Divlet HTML/SVG tag: ${value.tag}`);
  if (Object.hasOwn(value, 'className')) value.className = string(value.className, 'node.divlet.className', 32768);
  if (Object.hasOwn(value, 'style')) value.style = validStyle(value.style, 'node.divlet');
  if (Object.hasOwn(value, 'attrs')) {
    object(value.attrs, 'node.divlet.attrs');
    for (const [name, text] of Object.entries(value.attrs)) {
      if (name.toLowerCase() === 'data-pen-style') fail('data-pen-style is owned by the PEN renderer.');
      safeAttribute(name, text, 'node.divlet');
      value.attrs[name] = string(text, `node.divlet.attrs.${name}`);
    }
  }
  if (Object.hasOwn(value, 'metadata')) value.metadata = metadata(value.metadata, 'node.divlet.metadata');
  return value;
}

/** Known presentation fields only; occurrence inheritance and full render/commit admission have separate owners. */
export function validateDivletPresentation(input, { canvasRoot = false, variables = {} } = {}) {
  object(input, 'node.divlet');
  if (typeof canvasRoot !== 'boolean') fail('canvasRoot must be a boolean');
  object(variables, 'PEN variables');
  json(input, 'node.divlet', 0, true, SOURCE_LIMITS.depth * 4 + 16);
  if (Buffer.byteLength(JSON.stringify(input)) > SOURCE_LIMITS.bytes) fail('Divlet presentation input exceeds the source byte budget');
  const value = structuredClone(input);
  if (Object.hasOwn(value, 'html') && value.html !== false) {
    const html = object(value.html, 'node.divlet.html');
    if (!Object.hasOwn(html, 'tag') || !Object.hasOwn(html, 'className')) fail('node.divlet.html requires explicit tag and className');
    if (typeof html.tag !== 'string') fail('node.divlet.html.tag must be an HTML/SVG tag string');
    const known = Object.fromEntries(['tag', 'className', 'attrs', 'style'].filter(key => Object.hasOwn(html, key)).map(key => [key, html[key]]));
    value.html = { ...html, attrs: {}, style: {}, ...validateWebProperties(known) };
    if (Object.hasOwn(html, 'link')) {
      const link = object(html.link, 'node.divlet.html.link');
      if (html.tag !== 'a' || Object.keys(html.attrs || {}).some(key => key.toLowerCase() === 'href') || Object.keys(link).length !== 2 || !Object.hasOwn(link, 'frame') || !Object.hasOwn(link, 'suffix') || typeof link.frame !== 'string' || !link.frame || typeof link.suffix !== 'string' || link.suffix.length > 65536 || !/^(?:\?[^#]*)?(?:#.*)?$/.test(link.suffix) || /[\u0000-\u0020\u007f\\]/.test(link.suffix)) fail('HTML link requires one canonical frame and a query/fragment suffix on an anchor without literal href');
    }
  }
  if (Object.hasOwn(value, 'viewport')) {
    if (!canvasRoot) fail('Divlet viewport belongs to serialized canvas roots only');
    const viewport = object(value.viewport, 'node.divlet.viewport');
    for (const key of ['width', 'height']) {
      if (!Object.hasOwn(viewport, key)) fail('Divlet viewport requires width and height');
      const raw = viewport[key];
      if (key === 'height' && raw === 'content') continue;
      let dimension = raw;
      if (typeof raw === 'string' && raw.startsWith('$')) {
        const variable = Object.hasOwn(variables, raw.slice(1)) ? variables[raw.slice(1)] : null;
        if (!variable || !Object.hasOwn(variable, 'type') || variable.type !== 'number' || !Object.hasOwn(variable, 'value')) fail('Viewport reference must resolve to a numeric PEN variable');
        dimension = variable.value;
      }
      if (!Number.isFinite(dimension) || dimension < 1 || dimension > 16384) fail('Viewport dimensions must resolve to finite numbers between 1 and 16384');
    }
  }
  if (canvasRoot && value.html && !Object.hasOwn(value, 'viewport')) fail('An HTML-owned canvas root requires explicit viewport intent');
  return value;
}
