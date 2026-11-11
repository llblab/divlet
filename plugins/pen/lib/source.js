import path from 'node:path';
import { PROJECT_SCHEMA } from '../../../core/lib/project.ts';


import { DivletError, SOURCE_LIMITS, LIMITS, PROJECTION_LIMITS, validateTokens, validateCss, validateMetadata, merge } from '../../../core/lib/model.ts';
import { validateProjectSource, isSourceReplacement, validateDivletPresentation, validateWebProperties } from './validate.js';

/*
 * Source ownership stays in one JSON file, <name>.divlet or an existing .pen.
 * PEN uses { version: "2.21", children, variables, divlet? }; read/write retain that graph.
 * The runtime still consumes { schemaVersion: 1, name, version, tokens, css, metadata, frames }
 * during its transition. Native source must never be persisted through that legacy writer.
 *
 * A legacy frame is the ID-addressed node tree of one artboard. Any element marked
 * `reusable: true` is a component; a node `{ type: "ref", ref: "frameId/nodeId" }` is an
 * instance of it, with `descendants` overrides addressed by component node IDs (joined by
 * "/" to reach into nested instances), following the Pencil .pen conventions.
 */

export { PROJECT_SCHEMA };
const MAX_FRAMES = SOURCE_LIMITS.roots;
const THEME_UNITS = new Set(['', 'px', 'rem', 'em', '%', 'ms', 's', 'deg']);

const fail = (code, message, details) => { throw new DivletError(code, message, details); };
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** A frame as stored in the project file. */
export function storedFrame(document) {
  const { schemaVersion, ...frame } = document;
  return frame;
}

/** Project-level fields (everything but frames), validated. */
export function validateSettings(input = {}) {
  if (!isObject(input)) fail('INVALID_PROJECT', 'Project settings must be an object');
  const name = input.name ?? 'Untitled project';
  if (typeof name !== 'string' || name.length > 512) fail('INVALID_PROJECT', 'Project name must be a string of at most 512 characters');
  const version = input.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) fail('INVALID_PROJECT', 'Project version must be a positive integer');
  const outputDir = input.outputDir ?? null;
  if (outputDir !== null && (typeof outputDir !== 'string' || !outputDir.trim() || outputDir.length > 2048 || /[\\\u0000-\u001f]/.test(outputDir) || path.posix.isAbsolute(outputDir) || path.win32.isAbsolute(outputDir) || /^[a-z]:/i.test(outputDir))) fail('INVALID_OUTPUT_DIR', 'outputDir must be a relative directory path, or null for the default.');
  return { name, version, tokens: validateTokens(input.tokens ?? {}), css: validateCss(input.css ?? ''), metadata: validateMetadata(input.metadata ?? {}, 'project metadata'), outputDir };
}


/** Read PEN source without expansion; legacy frame projects remain available during the runtime transition. */
export function readProject(input) {
  if (!isObject(input)) fail('INVALID_PROJECT', 'A PEN file must be a JSON object');
  if (typeof input.version !== 'string') fail('INVALID_PROJECT', 'This is not a PEN source: it has no string "version".');
  return readSourceProject(input);
}


/** Serialize the PEN source graph, or the legacy settings/frames pair during the runtime transition. */
export function writeProject(settings, frames) {
  if (settings?.format === 'pen-projection' && typeof settings.version !== 'string') fail('INVALID_PROJECT', 'A rendering projection cannot be serialized as project source.');
  if (frames === undefined) {
    const input = typeof settings?.version === 'string' ? settings : settings?.format === 'pen' ? settings.source : null;
    if (!input) fail('INVALID_PROJECT', 'Supply a PEN source/read result, or legacy settings and frames.');
    return JSON.stringify(readSourceProject(input).source, null, 2) + '\n';
  }
  if (typeof settings?.version === 'string' || settings?.format === 'pen') fail('INVALID_PROJECT', 'A PEN source cannot be serialized as legacy frames.');
  if (frames.length > MAX_FRAMES) fail('INVALID_PROJECT', `A project can hold at most ${MAX_FRAMES} frames`);
  return JSON.stringify({ schemaVersion: PROJECT_SCHEMA, name: settings.name, version: settings.version, tokens: settings.tokens, css: settings.css, metadata: settings.metadata, ...(settings.outputDir !== null && settings.outputDir !== undefined ? { outputDir: settings.outputDir } : {}), frames: frames.map(storedFrame) }, null, 2) + '\n';
}

function settingsFromSource(source) {
  const extension = source.divlet;
  const theme = extension?.theme ?? {};
  if (!isObject(theme)) fail('INVALID_DIVLET_THEME', 'divlet.theme must map CSS custom properties to PEN variable references.');
  let themeBytes = 0;
  const tokens = Object.fromEntries(Object.entries(theme).map(([name, alias]) => {
    let variableName, unit = '';
    if (typeof alias === 'string' && alias.startsWith('$')) variableName = alias.slice(1);
    else if (isObject(alias) && typeof alias.variable === 'string') {
      variableName = alias.variable;
      unit = alias.unit ?? '';
      if (!THEME_UNITS.has(unit)) fail('INVALID_DIVLET_THEME', `Unsupported theme unit for ${name}`);
    } else fail('INVALID_DIVLET_THEME', `${name} must reference a PEN variable, not duplicate its value.`);
    const variable = Object.hasOwn(source.variables || {}, variableName) ? source.variables[variableName] : null;
    if (!variable) fail('INVALID_DIVLET_THEME', `${name} refers to missing PEN variable ${variableName}`);
    if (!['color', 'number', 'string'].includes(variable.type) || typeof variable.value === 'string' && variable.value.startsWith('$')) fail('UNSUPPORTED_DIVLET_THEME', `${name} requires a supported literal PEN variable.`);
    if (unit && variable.type !== 'number') fail('INVALID_DIVLET_THEME', `${name}: units apply only to numeric variables.`);
    themeBytes += Buffer.byteLength(name) + Buffer.byteLength(String(variable.value)) + unit.length + 2;
    if (themeBytes > LIMITS.bytes) fail('TOO_LARGE', 'Divlet theme aliases exceed 2 MiB of generated CSS.');
    return [name, `${variable.value}${unit}`];
  }));
  return validateSettings({ name: extension?.name, css: extension?.css, metadata: extension?.metadata, outputDir: extension?.outputDir, tokens });
}


function readSourceProject(input) {
  const { source, nodes, replacements, overrides } = validateProjectSource(input);
  const definitions = new Map([...nodes].filter(([, node]) => node.reusable === true));
  const diagnostics = [];
  const warn = (code, message, id) => {
    const previous = diagnostics.find(item => item.code === code && item.message === message);
    if (previous) { previous.count++; if (id && previous.nodes.length < 8) previous.nodes.push(id); }
    else diagnostics.push({ code, message, count: 1, nodes: id ? [id] : [] });
  };
  if (source.version !== '2.21') warn('UNVERIFIED_PEN_VERSION', `Only the observed PEN 2.21 profile is verified; preserving version ${source.version}.`);
  for (const [name, variable] of Object.entries(source.variables || {})) {
    if (!['color', 'number', 'string'].includes(variable.type)) warn('UNKNOWN_VARIABLE_TYPE', `Variable ${name} has an unsupported type; its value is preserved.`);
    else if (typeof variable.value === 'string' && variable.value.startsWith('$')) warn('UNVERIFIED_VARIABLE_ALIAS', `Variable ${name} starts with $; token aliases are not established by the profile.`);
  }
  const token = (value, expected, id) => {
    if (typeof value !== 'string' || !value.startsWith('$')) return value;
    const name = value.slice(1);
    const variable = Object.hasOwn(source.variables || {}, name) ? source.variables[name] : null;
    if (!variable) fail('INVALID_VARIABLE', `${id} refers to missing variable ${name}`);
    if (!['number', 'color', 'string'].includes(variable.type)) return variable.value;
    if (variable.type !== expected) fail('INVALID_VARIABLE', `${id} expects a ${expected} variable, not ${variable.type}: ${name}`);
    return variable.value;
  };
  const values = (value, expected, id) => {
    if (Array.isArray(value)) value.forEach(part => values(part, expected, id));
    else token(value, expected, id);
  };
  const properties = (node, id) => {
    for (const key of ['gap', 'opacity', 'fontSize', 'lineHeight', 'x', 'y']) token(node[key], 'number', id);
    for (const key of ['fontFamily', 'fontWeight']) token(node[key], 'string', id);
    for (const key of ['padding', 'cornerRadius']) values(node[key], 'number', id);
    if (isObject(node.strokeWidth)) Object.values(node.strokeWidth).forEach(value => token(value, 'number', id));
    else token(node.strokeWidth, 'number', id);
    values(node.stroke, 'color', id);
    values(node.fill, 'color', id); // Image objects and their URL strings are not token references.
    for (const key of ['width', 'height']) {
      const value = node[key];
      if (typeof value !== 'string') continue;
      if (value.startsWith('$')) { token(value, 'number', id); warn('UNVERIFIED_SIZING_REFERENCE', 'Variable-based dimensions are not established by the observed profile.', id); }
      else if (/^(fill_container|fit_content)\([^)]*\)$/.test(value)) warn('PARAMETERIZED_SIZING', 'Sizing parameters are preserved; their layout semantics require reference rendering.', id);
      else if (!['fill_container', 'fit_content'].includes(value)) warn('UNKNOWN_SIZING_MODE', 'An unrecognized sizing string is preserved.', id);
    }
    if (node.opacity !== undefined) {
      const opacity = token(node.opacity, 'number', id);
      if (typeof opacity === 'number' && (opacity < 0 || opacity > 1)) warn('AMBIGUOUS_OPACITY', 'Opacity outside 0..1 is preserved, not automatically rescaled.', id);
    }
    const effect = node.effect;
    if (isObject(effect)) {
      token(effect.color, 'color', id);
      for (const key of ['blur', 'radius']) token(effect[key], 'number', id);
      for (const key of ['x', 'y']) token(effect.offset?.[key], 'number', id);
      if (effect.type === 'blur') warn('AMBIGUOUS_BLUR', 'The profile does not establish node blur versus backdrop blur.', id);
      else if (effect.type !== 'shadow') warn('UNKNOWN_EFFECT', 'An unsupported effect is preserved.', id);
    }
    for (const slot of node.slot || []) if (!definitions.has(slot)) fail('INVALID_SLOT', `${id} names missing slot component ${slot}`);
  };
  for (const node of nodes.values()) {
    if (!['frame', 'ref', 'text', 'icon', 'rectangle', 'path'].includes(node.type)) warn('UNKNOWN_NODE_TYPE', `Unsupported node type ${node.type} is preserved.`, node.id);
    if (node.type === 'ref' && !definitions.has(node.ref)) fail('INVALID_REF', `${node.id} refers to missing or non-reusable component ${node.ref}`);
    properties(node, node.id);
  }
  // Iterative DFS keeps long, acyclic component chains independent of the JS call-stack limit.
  const visited = new Set();
  const active = new Set();
  for (const start of nodes.values()) {
    const pending = [{ node: start, exit: false }];
    while (pending.length) {
      const { node, exit } = pending.pop();
      if (exit) { active.delete(node.id); visited.add(node.id); continue; }
      if (active.has(node.id)) fail('COMPONENT_CYCLE', `Cyclic PEN component dependency at ${node.id}`);
      if (visited.has(node.id)) continue;
      active.add(node.id);
      pending.push({ node, exit: true });
      const dependencies = [...(node.children || []), ...(replacements.get(node.id) || [])];
      if (node.type === 'ref') dependencies.push(definitions.get(node.ref));
      for (let index = dependencies.length - 1; index >= 0; index--) pending.push({ node: dependencies[index], exit: false });
    }
  }
  const scopes = new Map();
  const resolve = (reference, address, id) => sourceAddressTarget(definitions, reference, address, id, scopes);
  const checkOverrides = (reference, map, id, depth = 0) => {
    if (depth > SOURCE_LIMITS.depth) fail('INVALID_OVERRIDE', 'Override scope nesting exceeds maximum depth');
    const replaced = new Set(Object.keys(map).filter(address => isSourceReplacement(map[address])));
    for (const [address, override] of Object.entries(map)) {
      const segments = address.split('/');
      for (let index = 1; index < segments.length; index++) if (replaced.has(segments.slice(0, index).join('/'))) {
        warn('OVERLAPPING_OVERRIDES', 'A replacement and an override below it coexist; their application order requires an explicit rendering policy.', id);
        break;
      }
      const target = resolve(reference, address, id);
      if (isSourceReplacement(override)) continue; // Its own references/overrides are independently indexed.
      properties(override, `${id}/${address}`);
      if (Object.hasOwn(override, 'children') && target.type !== 'frame') fail('INVALID_OVERRIDE', `${id}/${address}.children requires a frame target`);
      if (Object.hasOwn(override, 'ref')) warn('UNVERIFIED_REF_OVERRIDE', 'Partial ref-target changes are preserved; only complete replacements have verified structural semantics.', id);
      if (Object.hasOwn(override, 'descendants')) {
        if (target.type !== 'ref') fail('INVALID_OVERRIDE', `${id}/${address}.descendants requires an instance target`);
        checkOverrides(target.ref, override.descendants, `${id}/${address}`, depth + 1);
      }
    }
  };
  for (const node of overrides) checkOverrides(node.ref, node.descendants, node.id);
  let settings;
  try { settings = settingsFromSource(source); }
  catch (error) { fail(error.code || 'INVALID_DIVLET', 'Invalid Divlet project settings.', { path: ['divlet'], causeCode: error.code }); }
  const project = { format: 'pen', source, nodes, definitions, settings, diagnostics };
  validateDivletSourceFields(project);
  return project;
}


function sourceAddressTarget(definitions, reference, address, id, scopes = new Map()) {
  let definition = definitions.get(reference);
  const segments = address.split('/');
  for (const [index, segment] of segments.entries()) {
    if (!definition) fail('INVALID_OVERRIDE', `${id}: missing component ${reference}`);
    if (!scopes.has(definition.id)) {
      const scope = new Map();
      const collect = node => { scope.set(node.id, node); if (node.type !== 'ref') for (const child of node.children || []) collect(child); };
      for (const child of definition.children || []) collect(child);
      scopes.set(definition.id, scope);
    }
    const target = scopes.get(definition.id).get(segment);
    if (!target) fail('INVALID_OVERRIDE', `${id}: ${address} does not resolve in component ${definition.id}`);
    if (index === segments.length - 1) return target;
    if (target.type !== 'ref') fail('INVALID_OVERRIDE', `${id}: ${address} crosses a node that is not an instance`);
    definition = definitions.get(target.ref);
  }
}

export { PROJECTION_LIMITS } from '../../../core/lib/model.ts';
const SOURCE_STRUCTURE = new Set(['id', 'type', 'ref', 'descendants', 'children', 'reusable']);


function validateDivletSourceFields(project, { maxNodes = PROJECTION_LIMITS.nodes, maxBytes = PROJECTION_LIMITS.bytes } = {}) {
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > PROJECTION_LIMITS.nodes || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PROJECTION_LIMITS.bytes) fail('INVALID_LIMIT', 'Field validation limits must be positive integers within the existing work budgets.');
  let nodes = 0, bytes = 0, refs = 0;
  const charge = value => { bytes += Buffer.byteLength(JSON.stringify(value)); if (bytes > maxBytes) fail('TOO_LARGE', 'Divlet field validation exceeds its byte budget.'); };
  const invalid = (nodeId, location, causeCode) => fail('INVALID_DIVLET', 'Invalid Divlet fields or serialized scope.', { ...(nodeId === null ? {} : { nodeId }), path: location, ...(causeCode ? { causeCode } : {}) });
  charge(project.source.divlet || {});
  let shared;
  const rootIds = new Set(project.source.children.map(node => node.id));
  const visit = (owner, location, nodeId, canvasRoot, depth, ordinary = true) => {
    if (++nodes > maxNodes || depth > PROJECTION_LIMITS.depth) fail('TOO_LARGE', 'Divlet field validation exceeds its serialized-owner budget.');
    charge(location);
    if (Object.hasOwn(owner, 'divlet')) {
      charge(owner.divlet);
      try {
        validateWebProperties(owner.divlet);
        validateDivletPresentation(owner.divlet, { canvasRoot, variables: project.source.variables || {} });
        if (isObject(owner.divlet.html) && Object.hasOwn(owner.divlet.html, 'link')) {
          shared ??= sharedSourceNodes(project);
          if (!ordinary || !['frame', 'text', 'rectangle'].includes(owner.type) || shared.has(nodeId) || !rootIds.has(owner.divlet.html.link.frame)) invalid(nodeId, [...location, 'divlet', 'html', 'link']);
        }
      } catch (error) { invalid(nodeId, [...location, 'divlet'], error.code); }
    }
    for (const [index, child] of (owner.children || []).entries()) visit(child, [...location, 'children', index], child.id, false, depth + 1, ordinary && owner.type !== 'ref');
    for (const [address, patch] of Object.entries(owner.descendants || {})) visit(patch, [...location, 'descendants', address], isSourceReplacement(patch) ? patch.id : nodeId, false, depth + 1, false);
  };
  for (const [index, root] of project.source.children.entries()) visit(root, ['children', index], root.id, true, 0);
  const ownership = new Map();
  const htmlOwned = (node, depth = 0) => {
    if (depth > PROJECTION_LIMITS.instanceDepth) fail('TOO_LARGE', 'Root ownership validation exceeds its reference-depth budget.');
    if (ownership.has(node.id)) return ownership.get(node.id);
    refs++;
    // PEN property objects replace whole. A local bag without html does not deep-merge the definition bag.
    const owned = Object.hasOwn(node, 'divlet') ? isObject(node.divlet.html) : node.type === 'ref' ? htmlOwned(project.definitions.get(node.ref), depth + 1) : false;
    ownership.set(node.id, owned); return owned;
  };
  const roots = project.source.children.map((root, index) => {
    const owner = htmlOwned(root) ? 'html' : 'native';
    if (owner === 'html' && (!Object.hasOwn(root, 'divlet') || !Object.hasOwn(root.divlet, 'viewport'))) invalid(root.id, ['children', index, 'divlet', 'viewport']);
    const descriptor = { nodeId: root.id, owner }; charge(descriptor); return descriptor;
  });
  return { kind: 'divlet-source-fields', roots, work: { nodes, bytes, refs } };
}












/** Ephemeral PEN component projection with source provenance; never a replacement project source. */
export function materializeProject(input, { rootIds, maxNodes = PROJECTION_LIMITS.nodes, maxBytes = PROJECTION_LIMITS.bytes } = {}) {
  const project = readProject(typeof input?.version === 'string' ? input : input?.format === 'pen' ? input.source : input);
  if (project.format !== 'pen') fail('INVALID_PROJECT', 'PEN materialization requires a PEN source or read result.');
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > PROJECTION_LIMITS.nodes) fail('INVALID_LIMIT', 'maxNodes must be a positive integer within the projection node budget.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PROJECTION_LIMITS.bytes) fail('INVALID_LIMIT', 'maxBytes must be a positive integer within the projection byte budget.');
  const rootsById = new Map(project.source.children.map(node => [node.id, node]));
  const selected = rootIds === undefined ? [...rootsById.keys()] : rootIds;
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(id => !rootsById.has(id))) fail('INVALID_PROJECT', 'rootIds must contain unique canvas-root IDs.');
  const diagnostics = structuredClone(project.diagnostics);
  let work = 0;
  let bytes = 0;
  let instances = 0;
  const reserve = value => {
    bytes += Buffer.byteLength(JSON.stringify(value));
    if (bytes > maxBytes) fail('TOO_LARGE', `PEN projection work exceeds ${maxBytes} bytes.`);
  };
  const propertiesOf = node => Object.fromEntries(Object.entries(node).filter(([key]) => !SOURCE_STRUCTURE.has(key)));
  const noteAtomic = (before, patch, id) => {
    if (Object.keys(patch).some(key => Object.hasOwn(before, key) && patch[key] !== null && typeof patch[key] === 'object')) {
      const note = diagnostics.find(item => item.code === 'ATOMIC_PROPERTY_OVERRIDE');
      if (note) { note.count++; if (note.nodes.length < 8) note.nodes.push(id); }
      else diagnostics.push({ code: 'ATOMIC_PROPERTY_OVERRIDE', message: 'Projection replaces supplied array/object property values whole; it does not infer deep-merge or null-deletion rules.', count: 1, nodes: [id] });
    }
  };
  const applyProperties = (slot, patch, id) => {
    for (const key of SOURCE_STRUCTURE) if (Object.hasOwn(patch, key)) fail('UNSUPPORTED_PEN_OVERRIDE', `Structural partial override ${key} on ${id} has no verified projection semantics.`);
    noteAtomic(slot.properties, patch, id);
    reserve(patch);
    slot.properties = { ...slot.properties, ...structuredClone(patch) };
  };
  const resolve = (scope, address, id) => {
    const segments = address.split('/');
    for (const [index, segment] of segments.entries()) {
      const target = scope.get(segment);
      if (!target || target.retired) fail('UNSUPPORTED_OVERRIDE_CONFLICT', `${id}: ${address} is no longer available after nested replacements.`, { address, instance: id });
      if (index === segments.length - 1) return target;
      if (!target.scope) fail('UNSUPPORTED_OVERRIDE_CONFLICT', `${id}: ${address} no longer crosses an instance scope.`, { address, instance: id });
      scope = target.scope;
    }
  };
  const applyOverrides = (scope, map, path) => {
    const entries = new Map();
    const collect = (overrides, prefix = '') => {
      for (const [address, value] of Object.entries(overrides)) {
        const full = prefix + address;
        const { descendants, ...patch } = value;
        if (isSourceReplacement(value)) {
          if (entries.has(full)) fail('UNSUPPORTED_OVERRIDE_CONFLICT', `Multiple structural overrides address ${full}.`);
          entries.set(full, value);
          continue;
        }
        if (Object.keys(patch).length) {
          const before = entries.get(full);
          if (before && (isSourceReplacement(before) || Object.keys(patch).some(key => Object.hasOwn(before, key)))) fail('UNSUPPORTED_OVERRIDE_CONFLICT', `Multiple overrides assign the same property at ${full}.`);
          entries.set(full, { ...before, ...patch });
        }
        if (descendants) collect(descendants, `${full}/`);
      }
    };
    collect(map);
    const replaced = new Set([...entries].filter(([, value]) => isSourceReplacement(value) || Object.hasOwn(value, 'children')).map(([address]) => address));
    // Flattening local descendant maps exposes overlaps without using JSON key order as precedence.
    for (const address of entries.keys()) {
      const parts = address.split('/');
      for (let index = 1; index < parts.length; index++) if (replaced.has(parts.slice(0, index).join('/'))) fail('UNSUPPORTED_OVERRIDE_CONFLICT', `Replacement and descendant override overlap at ${address}.`, { address });
    }
    const targets = [...entries].map(([address, override]) => ({ address, override, target: resolve(scope, address, path.at(-1)) }));
    const structural = new Set(targets.filter(item => isSourceReplacement(item.override) || Object.hasOwn(item.override, 'children')).map(item => item.target));
    for (const { address, target } of targets) for (let parent = target.parent; parent; parent = parent.parent) {
      if (structural.has(parent)) fail('UNSUPPORTED_OVERRIDE_CONFLICT', `Replacement and descendant override overlap at ${address}.`, { address });
    }
    for (const { address, override, target } of targets) {
      if (isSourceReplacement(override)) {
        const parentPath = target.scope ? target.provenance.instancePath.slice(0, -1) : target.provenance.instancePath;
        const replacement = build(override, parentPath, target.depth, parentPath.length);
        const retired = [...target.children];
        while (retired.length) { const child = retired.pop(); child.retired = true; retired.push(...child.children); }
        delete target.scope; // A frame/text replacement must not inherit the retired ref's address scope.
        Object.assign(target, replacement);
        for (const child of target.children) child.parent = target;
      } else if (Object.hasOwn(override, 'children')) {
        if (target.type !== 'frame' || target.scope) fail('UNSUPPORTED_PEN_OVERRIDE', 'Child-list overrides require a direct frame target, not an instance root.');
        const { children, ...properties } = override;
        applyProperties(target, properties, address);
        const retired = [...target.children];
        while (retired.length) { const child = retired.pop(); child.retired = true; retired.push(...child.children); }
        target.children = children.map(child => build(child, target.provenance.instancePath, target.depth + 1, target.provenance.instancePath.length));
        for (const child of target.children) child.parent = target;
      } else applyProperties(target, override, address);
    }
  };
  const build = (raw, path, depth, nesting, scope = null) => {
    if (depth > PROJECTION_LIMITS.depth || nesting > PROJECTION_LIMITS.instanceDepth) fail('TOO_LARGE', 'PEN projection exceeds its tree or instance-depth budget.');
    if (++work > maxNodes) fail('TOO_LARGE', `PEN projection work exceeds ${maxNodes} nodes.`);
    let slot;
    if (raw.type === 'ref') {
      if (Object.hasOwn(raw, 'children')) fail('UNSUPPORTED_PEN_OVERRIDE', 'Ref nodes with their own children are outside the observed PEN profile.');
      const definition = project.definitions.get(raw.ref);
      if (definition.type === 'ref') fail('UNSUPPORTED_PEN_OVERRIDE', 'Ref-valued component definitions have no verified projection semantics.');
      const instancePath = [...path, raw.id];
      const ownScope = new Map();
      slot = build(definition, instancePath, depth, nesting + 1, ownScope);
      ownScope.delete(definition.id); // Addresses search children, not the definition root.
      slot.scope = ownScope;
      slot.provenance.instanceId = raw.id;
      const local = propertiesOf(raw);
      applyProperties(slot, local, raw.id);
      instances++;
      if (raw.descendants) applyOverrides(ownScope, raw.descendants, instancePath);
    } else {
      const properties = propertiesOf(raw);
      const provenance = { sourceId: raw.id, instancePath: [...path] };
      reserve([properties, provenance]);
      slot = { type: raw.type, properties: structuredClone(properties), provenance, depth, children: [] };
      slot.children = (raw.children || []).map(child => build(child, path, depth + 1, nesting, scope));
      for (const child of slot.children) child.parent = slot;
    }
    if (scope) scope.set(raw.id, slot);
    return slot;
  };
  const slots = selected.map(id => build(rootsById.get(id), [], 0, 0));
  const nodes = new Map();
  const emit = slot => {
    const key = JSON.stringify([slot.provenance.instancePath, slot.provenance.sourceId]);
    if (nodes.has(key)) fail('INVALID_PROJECTION', 'Duplicate instance-path/source-ID identity in PEN projection.');
    const node = { key, type: slot.type, properties: slot.properties, provenance: slot.provenance, children: [] };
    nodes.set(key, node);
    node.children = slot.children.map(emit);
    return node;
  };
  const roots = slots.map(emit);
  return { format: 'pen-projection', roots, nodes, diagnostics, sharedNodes: sharedSourceNodes(project), work: { nodes: work, bytes, instances } };
}







function sharedSourceNodes(project) {
  const shared = new Set();
  const visit = (node, inherited = false) => { const active = inherited || node.reusable === true; if (active) shared.add(node.id); for (const child of node.children || []) visit(child, active); };
  for (const root of project.source.children) visit(root);
  return shared;
}






















/* ---- components and instances -------------------------------------------- */







