import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse, parseFragment, serialize } from 'parse5';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { createClassResourceMapper } from './style-engines.ts';
import { readAssets, readAssetText } from './assets.ts';
import { assetReference, readAssetReference, resolveAssetDependency } from './asset-reference.ts';
import { DivletError } from './validation.ts';
import { rewriteSvgResource, SVG_RESOURCE_ATTRIBUTES } from './svg-resource.ts';
import { decodeCss, cssString } from './css-literals.ts';
import { resourceMediaTypeForExtension } from './media-type.ts';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message, details) => { throw Object.assign(new Error(`Static bundle: ${message}`), details ? { details } : {}); };
export const MAX_RESOURCE_FILES = 400;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;

/** Descriptor/byte safety only; callers must establish source-path authority before reading. */
export async function readResourceBytes(file, budget = { bytes: 0 }) {
  const before = await fs.lstat(file, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(MAX_FILE)) fail(`unsafe or oversized resource ${file}`);
  const unchanged = stat => stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs;
  const changed = () => fail(`resource changed during preparation ${file}`);
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_FILE)) fail(`unsafe or oversized resource ${file}`);
    if (!unchanged(stat)) changed();
    // Reserve concurrent read work before allocating; failed plans discard, never refund, this budget.
    const size = Number(stat.size);
    if ((budget.bytes += size) > MAX_TOTAL) fail('resource byte limit exceeded');
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > size) fail(`resource grew during preparation ${file}`);
    if (length !== size || !unchanged(await handle.stat({ bigint: true }))) changed();
    const current = await fs.lstat(file, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile()) fail(`unsafe resource ${file}`);
    if (!unchanged(current)) changed();
    return buffer.subarray(0, length);
  } catch (error) { if (error.code === 'ENOENT') changed(); throw error; }
  finally { await handle?.close(); }
}

function decodePath(value) {
  if (/[\\\0]/.test(value) || /%(?:2f|5c|00)/i.test(value)) fail(`unsafe path ${value}`);
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { fail(`malformed path ${value}`); }
  if (/[\\\0%]/.test(decoded)) fail(`unsafe path ${value}`);
  if (decoded !== value && decoded.split('/').some((part) => part === '..' || part === '.')) fail(`encoded traversal ${value}`);
  return decoded;
}

function safeParts(value) {
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..') continue;
    if (part.startsWith('.') || /(?:~$|\.(?:divlet|pen)$|\.meta\.json$|\.sw[op]$|\.bak$)/i.test(part) || /^(?:node_modules|__pycache__|cache|manifest(?:\..*)?)$/i.test(part)) fail(`private resource ${value}`);
  }
}

function routeOutput(route) {
  if (!route.startsWith('/') || !route.endsWith('/') || /[?#]/.test(route)) fail(`noncanonical route ${route}`);
  const decoded = decodePath(route);
  if (decoded.split('/').some((part) => part === '.' || part === '..') || decoded.includes('//')) fail(`unsafe route ${route}`);
  safeParts(decoded);
  return `${decoded.slice(1)}index.html`;
}

// Rewrites only URL tokens, never declaration selectors (including Tailwind selectors).
const literalCssFunctions = new Set('rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix calc min max clamp round mod rem abs sign sin cos tan asin acos atan atan2 pow sqrt hypot log exp linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient repeating-conic-gradient matrix matrix3d translate translateX translateY translateZ translate3d scale scaleX scaleY scaleZ scale3d rotate rotateX rotateY rotateZ rotate3d skew skewX skewY perspective blur brightness contrast drop-shadow grayscale hue-rotate invert opacity saturate sepia cubic-bezier steps format tech local'.toLowerCase().split(' '));
const unsupportedSourceCss = () => { throw Object.assign(new Error('Canonical copy requires literal, fully understood CSS resource carriers; indirect or unsupported CSS was not relocated.'), { code: 'COPY_UNSUPPORTED_RESOURCE' }); };
function validateSourceCssValue(value, publicVariables = false) {
  const parsed = valueParser(value);
  parsed.walk(node => {
    if (node.unclosed) unsupportedSourceCss();
    if (node.type !== 'function') return;
    const name = decodeCss(node.value).toLowerCase();
    if (name === 'url') {
      const parts = node.nodes.filter(child => child.type !== 'space');
      if (parts.length === 1 && parts[0].type === 'string') {
        if (parts[0].unclosed || /[\r\n\f]/.test(parts[0].value)) unsupportedSourceCss();
      } else {
        const raw = valueParser.stringify(node.nodes).trim();
        if (!raw || /[\s()'"]/.test(raw) || node.nodes.some(child => child.type === 'function' || child.type === 'comment' || child.unclosed)) unsupportedSourceCss();
      }
      return false;
    }
    if (name === 'var' && publicVariables) return;
    if (!literalCssFunctions.has(name)) unsupportedSourceCss();
  });
}

async function rewriteCss(css, rewrite, inline = false, closed = false, inspectSelectors) {
  let root;
  try { root = postcss.parse(inline ? `x{${css}}` : css, { map: false }); }
  catch (error) { if (closed) unsupportedSourceCss(); throw error; }
  inspectSelectors?.(root);
  // PostCSS can split an escaped at-keyword into name + params; never silently miss a browser-recognized import.
  root.walkAtRules(rule => { if (rule.raws.afterName === '' && rule.params.startsWith('\\')) unsupportedSourceCss(); });
  if (closed) {
    root.walkDecls(decl => validateSourceCssValue(decl.value));
    root.walkAtRules(rule => {
      if (decodeCss(rule.name).toLowerCase() !== 'import') return;
      const first = valueParser(rule.params).nodes.find(node => node.type !== 'space' && node.type !== 'comment');
      if (!first || first.type !== 'string' && !(first.type === 'function' && decodeCss(first.value).toLowerCase() === 'url')) unsupportedSourceCss();
      validateSourceCssValue(rule.params);
    });
  }
  const jobs = [];
  root.walkDecls((decl) => jobs.push((async () => { decl.value = await values(decl.value); })()));
  root.walkAtRules(rule => {
    if (decodeCss(rule.name).toLowerCase() !== 'import') return;
    jobs.push((async () => {
      const parsed = valueParser(rule.params);
      const first = parsed.nodes.find((node) => node.type !== 'space' && node.type !== 'comment');
      if (first?.type === 'string') {
        first.value = cssString(await rewrite(decodeCss(first.value)));
        first.quote = '"';
      } else await rewriteNodes(parsed.nodes);
      rule.params = parsed.toString();
    })());
  });
  async function rewriteNodes(nodes) {
    for (const node of nodes) {
      if (node.type !== 'function') continue;
      if (decodeCss(node.value).toLowerCase() === 'url') {
        const raw = valueParser.stringify(node.nodes).trim();
        const url = node.nodes.length === 1 && node.nodes[0].type === 'string' ? node.nodes[0].value : raw;
        const result = await rewrite(decodeCss(url));
        node.nodes = [{ type: 'string', quote: '"', value: cssString(result) }];
      } else await rewriteNodes(node.nodes);
    }
  }
  async function values(value) {
    const parsed = valueParser(value);
    await rewriteNodes(parsed.nodes);
    return parsed.toString();
  }
  await Promise.all(jobs);
  return inline ? root.first.nodes.map((node) => node.toString()).join(';') : root.toString();
}

async function rewriteSrcset(value, rewrite) {
  // URL tokens end at whitespace; trailing commas delimit candidates. Data URLs
  // retain their internal commas, per the HTML srcset tokenization algorithm.
  let result = '';
  let i = 0;
  while (i < value.length) {
    const leading = value.slice(i).match(/^[\s,]+/)?.[0] || '';
    result += leading;
    i += leading.length;
    if (i >= value.length) break;
    const token = value.slice(i).match(/^\S+/)[0];
    i += token.length;
    const url = token.replace(/,+$/, '');
    result += await rewrite(url);
    result += token.slice(url.length);
    if (url.length !== token.length) continue;
    const start = i;
    let depth = 0;
    while (i < value.length) {
      if (value[i] === '(') depth++;
      if (value[i] === ')') depth--;
      if (value[i++] === ',' && depth === 0) break;
    }
    result += value.slice(start, i);
  }
  return result;
}

async function rewriteHtml(html, rewrite, fragment = false, withBase, closed = false, inspectSelectors) {
  const tree = fragment ? parseFragment(html) : parse(html);
  if (withBase) {
    let effective;
    function find(node) {
      if (node.tagName === 'base') {
        const href = node.attrs?.find(attr => attr.name === 'href');
        if (href && effective === undefined) effective = href.value;
        node.attrs = node.attrs.filter(attr => attr.name !== 'href');
      }
      for (const child of node.childNodes || []) find(child);
    }
    find(tree);
    if (effective !== undefined) rewrite = withBase(effective);
  }
  async function visit(node) {
    for (const attr of node.attrs || []) {
      if (['src', 'href', 'poster'].includes(attr.name)) attr.value = await rewrite(attr.value, { tag: node.tagName, attribute: attr.name });
      else if (attr.name === 'srcset') attr.value = await rewriteSrcset(attr.value, rewrite);
      else if (attr.name === 'style') attr.value = await rewriteCss(attr.value, rewrite, true, closed, inspectSelectors);
      else if (SVG_RESOURCE_ATTRIBUTES.has(attr.name)) {
        const declaration = await rewriteCss(`x:${attr.value}`, rewrite, true, closed, inspectSelectors);
        attr.value = declaration.slice(declaration.indexOf(':') + 1);
      }
    }
    if (node.tagName === 'style') {
      for (const child of node.childNodes || []) if (child.nodeName === '#text') child.value = await rewriteCss(child.value, rewrite, false, closed, inspectSelectors);
    } else for (const child of node.childNodes || []) await visit(child);
    if (node.content) await visit(node.content);
  }
  await visit(tree);
  return serialize(tree);
}

const stylesheetFailure = () => { throw Object.assign(new Error('Public stylesheet extraction requires a contiguous unscoped head-style group without document-head observers.'), { code: 'UNSUPPORTED_STYLESHEET_BUNDLE' }); };

const publicDomFailure = () => { throw Object.assign(new Error('Clean public HTML requires CSS independent of editor attributes and resolved attribute consumers.'), { code: 'UNSUPPORTED_PUBLIC_HTML' }); };
function checkAttributeConsumers(value) {
  // The value parser does not tokenize CSS hex escapes across whitespace as identifiers.
  if (value.includes('\\') && /(?:^|[^\w-])attr\s*\(/i.test(decodeCss(value))) publicDomFailure();
  const pending = [...valueParser(value).nodes]; let observed = false;
  while (pending.length) {
    const node = pending.pop();
    if (node.type !== 'function') continue;
    if (decodeCss(node.value).toLowerCase() === 'attr') {
      observed = true;
      const first = node.nodes.find(child => child.type !== 'space' && child.type !== 'comment');
      if (first?.type !== 'word') publicDomFailure();
    }
    for (const child of node.nodes) pending.push(child);
  }
  return observed;
}
function checkEditorObservers(value) {
  // Conservative exclusion, not a claim of arbitrary selector/value equivalence.
  if (/data-divlet-/i.test(decodeCss(value))) publicDomFailure();
  checkAttributeConsumers(value);
}

/** Pure artifact transform after URL closure; no canonical/source fields or filesystem authority. */
function preparePublicFrame(html, publish) {
  const tree = parse(html), head = tree.childNodes.find(node => node.tagName === 'html')?.childNodes.find(node => node.tagName === 'head');
  const styles = head?.childNodes.filter(node => node.tagName === 'style') || [];
  if (!styles.length) return { html };
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (['script', 'iframe', 'object', 'embed'].includes(node.tagName)) publicDomFailure();
    if (node.tagName === 'style' && node.parentNode !== head || node.tagName === 'link' && node.attrs.some(attr => attr.name === 'rel' && /(?:^|\s)stylesheet(?:\s|$)/i.test(attr.value))) stylesheetFailure();
    for (const child of node.childNodes || []) pending.push(child);
    if (node.content) pending.push(node.content);
    for (const attr of node.attrs || []) {
      if (attr.name.toLowerCase() === 'data-pen-style' || /^on/i.test(attr.name)) publicDomFailure();
      if (attr.name === 'style') postcss.parse(`x{${attr.value}}`, { map: false }).walkDecls(decl => checkEditorObservers(decl.value));
      else if (node.namespaceURI === 'http://www.w3.org/2000/svg' && checkAttributeConsumers(attr.value) && /data-divlet-/i.test(decodeCss(attr.value))) publicDomFailure();
    }
    if (node.attrs) node.attrs = node.attrs.filter(attr => !/^data-divlet-/i.test(attr.name));
  }
  if (styles.some(node => node.attrs.length)) stylesheetFailure();
  const first = head.childNodes.indexOf(styles[0]), last = head.childNodes.indexOf(styles.at(-1));
  if (head.childNodes.slice(first, last + 1).some(node => node.tagName !== 'style' && (node.nodeName !== '#text' || node.value.trim()))) stylesheetFailure();
  const css = styles.map(node => node.childNodes.map(child => child.value || '').join('')).join('\n');
  const rules = postcss.parse(css, { map: false });
  const checkSelector = value => { checkEditorObservers(value); const selector = decodeCss(value); if (/:has\s*\(/i.test(selector) || /(?:^|[\s,>+~(])(?:head|style|link)(?=[\s.#[:>,+~)]|$)/i.test(selector)) stylesheetFailure(); };
  rules.walkAtRules(rule => { checkEditorObservers(rule.params); if (['charset', 'namespace', 'import'].includes(rule.name.toLowerCase())) stylesheetFailure(); if (rule.name.toLowerCase() === 'scope') checkSelector(rule.params); });
  rules.walkRules(rule => checkSelector(rule.selector));
  rules.walkDecls(decl => checkEditorObservers(decl.value));
  if (/<\/style/i.test(css)) stylesheetFailure();
  const file = publish(css), link = parseFragment(`<link rel="stylesheet" href="${file}">`).childNodes[0];
  link.parentNode = head;
  head.childNodes = head.childNodes.flatMap(node => node === styles[0] ? [link] : node.tagName === 'style' ? [] : [node]);
  return { html: serialize(tree), stylesheet: file };
}




/** Normalize legacy file hints and admitted binding keys; this is not an access permission list. */
export function normalizeExternalFiles(projectDir, externalFiles = []) {
  if (!Array.isArray(externalFiles) || externalFiles.length > MAX_RESOURCE_FILES || externalFiles.some(file => typeof file !== 'string' || !path.isAbsolute(file) || /[\u0000-\u001f]/.test(file) || path.sep !== '\\' && file.includes('\\'))) fail('externalFiles must be a bounded list of exact absolute file paths');
  const files = [...new Set(externalFiles.map(file => path.resolve(file)))].sort();
  for (const file of files) safeParts(path.relative(path.resolve(projectDir), file).split(path.sep).join('/'));
  return files;
}

async function resourceFileExists(root, source, authorized) {
  const rel = path.relative(root, source);
  safeParts(rel.split(path.sep).join('/'));
  if (authorized !== null && (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) && !authorized.has(source)) {
    if (/[\u0000-\u001f]/.test(source)) fail(`unsafe external resource path ${source}`);
    fail(`resource escapes required snapshot containment ${source}`);
  }
  const components = new Set();
  for (const target of [root, source]) {
    const chain = [];
    for (let component = target; ; component = path.dirname(component)) {
      chain.unshift(component);
      if (component === path.dirname(component)) break;
    }
    for (const component of chain) components.add(component);
  }
  let missing = false;
  for (const component of components) {
    try {
      const stat = await fs.lstat(component);
      if (stat.isSymbolicLink()) fail(`symlink resource ${component}`);
      if (component !== source && !stat.isDirectory()) fail(`not a directory ${component}`);
      if (component !== source && component !== root) {
        const managed = await fs.lstat(path.join(component, '.divlet-build.json')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        if (managed) fail(`generated output is not an authored resource ${component}`);
      }
      if (component === source && (!stat.isFile() || stat.size > MAX_FILE)) fail(`unsafe or oversized resource ${source}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing = true;
      break;
    }
  }
  return !missing;
}

/** Internal contained snapshot for publisher-owned inputs or explicit admitted plan members. No file-serving route. */
export async function readConfinedResource(projectDir, file, { authorized = new Set(), budget } = {}) {
  if (projectDir !== path.resolve(projectDir) || file !== path.resolve(file)) fail('resource snapshots require canonical exact paths');
  if (!await resourceFileExists(projectDir, file, authorized)) fail('admitted resource is missing');
  const bytes = await readResourceBytes(file, budget);
  if (!await resourceFileExists(projectDir, file, authorized)) fail('admitted resource changed before source commit');
  return bytes;
}


/** Build a read-only, server-independent static artifact set. */
/** Standalone clean HTML embeds declared bytes only; legacy URLs and literal Data URLs keep their authored meaning. */
export async function inlineDeclaredAssets(html, assets, { fragment = false } = {}) {
  const parsed = readAssets(assets ?? {});
  if (!parsed.files.size) return html;
  const completed = new Map();
  let work = Buffer.byteLength(html);
  const limit = () => { throw new DivletError('FILE_TOO_LARGE', 'Standalone HTML exceeds its resource byte budget; save a project copy instead.'); };
  async function fileUrl(key, stack) {
    if (stack.includes(key)) throw new DivletError('UNSUPPORTED_EXPORT', 'Cyclic declared resources require a project/bundle copy, not one HTML file.');
    if (completed.has(key)) return completed.get(key);
    const file = parsed.files.get(key);
    if (!file) throw new DivletError('INVALID_ASSET', 'Missing declared resource during export.');
    const text = readAssetText(file), next = [...stack, key];
    const rewrite = value => url(value, next, key);
    const bytes = text ? Buffer.from(text.kind === 'css' ? await rewriteCss(text.text, rewrite, false, true) : await rewriteSvgResource(text.text, { url: rewrite, css: (css, inline) => rewriteCss(css, rewrite, inline, true) })) : file.bytes;
    if (text?.ascii && Buffer.from(bytes).some(byte => byte > 127)) throw new DivletError('INVALID_ASSET', 'Inlining this asset would violate its US-ASCII encoding.');
    const result = `data:${file.mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
    completed.set(key, result);
    return result;
  }
  async function url(value, stack = [], base, context) {
    let reference = readAssetReference(value);
    if (!reference && base && value && !value.startsWith('#') && !/^(?:data:|https?:|\/\/)/i.test(value)) reference = readAssetReference(resolveAssetDependency(base, value));
    if (!reference) return value;
    if (reference.suffix.startsWith('?') || context?.tag === 'use') throw new DivletError('UNSUPPORTED_EXPORT', 'This resource URL requires a project/bundle copy to retain its query or SVG-use semantics.');
    const result = await fileUrl(reference.path, stack) + reference.suffix;
    if ((work += result.length + 5 * (result.match(/[<&"\\]/g)?.length || 0)) > MAX_TOTAL) limit();
    return result;
  }
  const result = await rewriteHtml(html, (value, context) => url(value, [], undefined, context), fragment);
  if (Buffer.byteLength(result) > MAX_TOTAL) limit();
  return result;
}

export async function buildStatic({ projectDir, frames, frameFiles, site = new Map(), assetBase, siteBase, externalFiles = [], previews = new Map(), mapResources, assets, resourceDirectory = assets === undefined ? '_assets' : 'assets', closedCss = false, stylesheetFrames = new Set(), previewBase, nativeAssets = false, sitePreviews = new Map() }) {
  if (mapResources !== undefined && typeof mapResources !== 'function') fail('mapResources must be a function');
  if (!['_assets', 'assets'].includes(resourceDirectory)) fail('unsupported resource directory');
  const declared = assets === undefined ? null : readAssets(assets);
  if (declared && resourceDirectory !== 'assets') fail('declared assets require the assets/ resource directory');
  const root = path.resolve(projectDir);
  // Local projects are trusted to name filesystem dependencies; no manual file grants are required.
  const authorized = null;
  if (!(stylesheetFrames instanceof Set) || [...stylesheetFrames].some(id => !frames.has(id))) fail('stylesheet frames must belong to the complete public frame set');
  stylesheetFrames = new Set(stylesheetFrames);
  const stylesheets = new Map(), generatedStyles = new Map();
  const rewrittenPreviews = new Map(), rewrittenSitePreviews = new Map();
  const files = new Map();
  const sources = new Map();
  const warnings = [];
  const routes = new Map();
  const frameOutputs = new Map(), outputsById = new Map();
  if (frameFiles !== undefined && (!(frameFiles instanceof Map) || frameFiles.size !== frames.size || [...frames.keys()].some(id => !frameFiles.has(id)))) fail('frame filenames must match the public frame identities');
  frameFiles = frameFiles === undefined ? undefined : new Map(frameFiles);
  const foldedNames = new Set();
  const occupied = new Set();
  const resources = new Map(), declaredResources = new Map(), assetSources = new Map(), mediaTypes = new Map();
  const pending = [];
  const classRenames = new Map(), sourceSelectors = new Set();
  const numericReferences = new Set(), variableDefinitions = new Set();
  let selectorWork = 0, classMapper, classTheme, classTokens, classNumericTokens, uninspectedExternal = false;
  const checkSelector = (selector, from, to) => {
    if ((selectorWork += Buffer.byteLength(selector) + from.length + to.length) > MAX_TOTAL) unsupportedSourceCss();
    const decoded = decodeCss(selector);
    if (selector.includes('[') || decoded.includes('[') || decoded.includes(`.${from}`) || decoded.includes(`.${to}`)) unsupportedSourceCss();
  };
  const inspectSelectors = mapResources ? tree => {
    const remember = value => { if (sourceSelectors.has(value)) return; for (const [from, to] of classRenames) checkSelector(value, from, to); sourceSelectors.add(value); };
    tree.walkRules(rule => remember(rule.selector));
    tree.walkAtRules(rule => {
      remember(rule.params);
      if (rule.name.toLowerCase() === 'property') {
        const names = valueParser(rule.params).nodes.filter(node => node.type !== 'space' && node.type !== 'comment');
        if (names.length === 1 && names[0].type === 'word') variableDefinitions.add(decodeCss(names[0].value));
      }
    });
    tree.walkDecls(decl => { if (decl.prop.startsWith('--') || decodeCss(decl.prop).startsWith('--')) variableDefinitions.add(decodeCss(decl.prop)); });
  } : undefined;
  const onClassRename = (from, to) => { for (const selector of sourceSelectors) checkSelector(selector, from, to); classRenames.set(from, to); };
  let allowNewResources = true;
  const budget = { bytes: 0 };
  for (const base of [assetBase, siteBase, previewBase]) {
    if (base === undefined) continue;
    let parsed;
    try { parsed = new URL(base); } catch { fail('invalid runtime prefix'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !base.endsWith('/') || parsed.search || parsed.hash) fail('invalid runtime prefix');
  }
  function reserve(output) {
    if (occupied.has(output) || [...occupied].some((name) => name.startsWith(`${output}/`) || output.startsWith(`${name}/`))) fail(`output collision ${output}`);
    occupied.add(output);
  }
  for (const [id] of frames) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(id)) fail(`unsafe frame ${id}`);
    const output = frameFiles ? frameFiles.get(id) : `${id}.html`;
    if (frameFiles) {
      if (typeof output !== 'string' || !/^[\p{L}\p{N}\p{M}_-][\p{L}\p{N}\p{M}_.-]*\.html$/u.test(output) || Buffer.byteLength(output) > 200) fail('unsafe frame filename');
      const folded = output.normalize('NFKC').toLowerCase();
      if (foldedNames.has(folded)) fail('portable frame filename collision');
      foldedNames.add(folded);
    }
    reserve(output);
    outputsById.set(id, output);
    frameOutputs.set(`${id}.html`, output);
  }
  for (const [route] of site) {
    const output = routeOutput(route);
    reserve(output);
    routes.set(route, output);
  }
  for (const id of previews.keys()) if (!outputsById.has(id)) fail(`preview has no matching frame ${id}`);
  const confined = source => resourceFileExists(root, source, authorized);
  async function resource(source) {
    if (resources.has(source)) return resources.get(source);
    if (!allowNewResources) fail('preview references a resource absent from the public artifact graph');
    if (resources.size + declaredResources.size >= MAX_RESOURCE_FILES) fail('resource count limit exceeded');
    const relative = path.relative(root, source).split(path.sep).join('/');
    const basename = path.basename(source).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const output = `${resourceDirectory}/${hash(relative).slice(0, 20)}-${basename}`;
    reserve(output);
    resources.set(source, output);
    if (!await confined(source)) {
      sources.set(source, null);
      warnings.push({ code: 'MISSING_ASSET', message: `Missing local resource: ${relative}`, path: source });
      return output;
    }
    const bytes = await readResourceBytes(source, budget);
    if (!await confined(source)) fail(`resource changed during preparation ${source}`);
    sources.set(source, hash(bytes));
    files.set(output, bytes);
    // Defer recursive transforms until this source has a stable output identity.
    if (/\.(?:css|svg|html?)$/i.test(source)) {
      // A suffix cannot authorize lossy text interpretation. Binary fonts/images may have misleading names.
      const text = bytes.includes(0) ? null : bytes.toString('utf8');
      if (text === null || !Buffer.from(text).equals(bytes)) {
        if (closedCss) unsupportedSourceCss(); // Canonical relocation still requires proven text dependency semantics.
        mediaTypes.set(output, resourceMediaTypeForExtension(path.extname(source).toLowerCase()));
      }
      else pending.push(async () => {
        const rewrite = (url, context) => rewriteUrl(url, source, output, undefined, context);
        files.set(output, /\.css$/i.test(source) ? await rewriteCss(text, rewrite, false, closedCss, inspectSelectors) : await rewriteHtml(text, rewrite, /\.svg$/i.test(source), /\.html?$/i.test(source) ? base => baseRewrite(base, source, output) : undefined, closedCss, inspectSelectors));
      });
    }
    return output;
  }
  async function declaredResource(key) {
    if (declaredResources.has(key)) return;
    if (!allowNewResources) fail('preview references a resource absent from the public artifact graph');
    const file = declared?.files.get(key);
    if (!file) throw new DivletError('INVALID_ASSET', `Missing declared asset: ${key}`);
    if (resources.size + declaredResources.size >= MAX_RESOURCE_FILES) fail('resource count limit exceeded');
    if ((budget.bytes += file.bytes.byteLength) > MAX_TOTAL) fail('resource byte limit exceeded');
    const output = `assets/${key}`, content = readAssetText(file);
    reserve(output);
    declaredResources.set(key, output);
    mediaTypes.set(output, file.mediaType);
    assetSources.set(assetReference(key), hash(JSON.stringify([file.mediaType, hash(file.bytes)])));
    files.set(output, Buffer.from(file.bytes));
    if (content) pending.push(async () => {
      const source = assetReference(key), rewrite = url => {
        if (nativeAssets && content.kind === 'svg' && url && !url.startsWith('#') && !/^data:/i.test(url)) throw new DivletError('INVALID_ASSET', 'Native SVG file assets currently require inline or same-document dependencies.');
        return rewriteUrl(url, source, output);
      };
      const rewritten = content.kind === 'css'
        ? await rewriteCss(content.text, rewrite, false, true, inspectSelectors)
        : await rewriteSvgResource(content.text, { url: rewrite, css: (text, inline) => rewriteCss(text, rewrite, inline, true, inspectSelectors) });
      if (content.ascii && /[^\x00-\x7f]/.test(rewritten)) throw new DivletError('INVALID_ASSET', 'Rewriting this asset would violate its US-ASCII encoding.');
      files.set(output, rewritten);
    });
  }
  async function declaredUrl(reference, output) {
    await declaredResource(reference.path);
    // Go via the artifact root: comparing raw paths with encoded names can alias literal percent components.
    const up = path.posix.relative(path.posix.dirname(output), '.');
    return `${up ? up + '/' : ''}assets/${assetReference(reference.path).slice(6)}${reference.suffix}`;
  }
  function relativeUrl(from, to) {
    const relative = path.posix.relative(path.posix.dirname(from), to) || path.posix.basename(to);
    return /^[^/]*:/.test(relative) ? `./${relative}` : relative;
  }
  function baseRewrite(base, source, output) {
    const absoluteReference = value => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(value.trim().replace(/[\t\n\r]/g, ''));
    const localBase = !absoluteReference(base);
    if (localBase) decodePath(base.split(/[?#]/)[0]);
    let effective;
    try { effective = new URL(base, pathToFileURL(source)); } catch { fail(`unsupported HTML base ${base}`); }
    return async (value, context) => {
      const localReference = localBase && !absoluteReference(value);
      if (localReference) decodePath(value.split(/[?#]/)[0]);
      let resolved;
      try { resolved = new URL(value, effective); } catch { fail(`unsupported base-relative URL ${value}`); }
      if (!localReference || resolved.protocol !== 'file:') return rewriteUrl(resolved.href, source, output, undefined, context);
      return rewriteUrl(fileURLToPath(resolved) + resolved.search + resolved.hash, source, output, undefined, context);
    };
  }
  async function rewriteUrl(original, source, output, pageRoute, context) {
    const reference = readAssetReference(original);
    if (reference && nativeAssets && context?.tag === 'use') throw new DivletError('INVALID_ASSET', 'Declared SVG use references cannot load in the sandboxed native preview. Use inline SVG with same-document references.');
    if (reference) return declaredUrl(reference, output);
    const value = original.trim();
    if (!value || value.startsWith('#')) return original;
    let kind;
    let local = value;
    let absolute;
    try { absolute = new URL(value, assetBase || siteBase); } catch { /* Relative filesystem path. */ }
    const isAbsolute = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(value.replace(/[\t\n\r]/g, ''));
    if (isAbsolute && absolute && !['http:', 'https:', 'data:', 'mailto:', 'tel:'].includes(absolute.protocol)) fail(`unsafe URL ${value}`);
    if (isAbsolute && absolute && ['http:', 'https:'].includes(absolute.protocol)) {
      for (const [base, type] of [[assetBase, 'asset'], [siteBase, 'site']]) {
        if (!base) continue;
        const prefix = new URL(base);
        if (absolute.origin === prefix.origin && absolute.pathname.startsWith(prefix.pathname)) {
          decodePath(value.split(/[?#]/)[0]);
          kind = type;
          local = absolute.pathname.slice(prefix.pathname.length) + absolute.search + absolute.hash;
          break;
        }
      }
      if (!kind) {
        if ([assetBase, siteBase].filter(Boolean).some(base => absolute.origin === new URL(base).origin)) fail(`unrecognized runtime URL ${value}`);
        uninspectedExternal = true;
        return original;
      }
    }
    else if (/^(?:https?:|data:|mailto:|tel:)/i.test(value) || value.startsWith('//')) { if (/^(?:https?:|data:|\/\/)/i.test(value)) uninspectedExternal = true; return original; }
    else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) fail(`unsafe URL ${value}`);
    const baseAsset = readAssetReference(source);
    if (baseAsset) return declaredUrl(readAssetReference(resolveAssetDependency(baseAsset.path, value)), output);
    const suffixAt = local.search(/[?#]/);
    const suffix = suffixAt < 0 ? '' : local.slice(suffixAt);
    const pathname = suffixAt < 0 ? local : local.slice(0, suffixAt);
    const decoded = decodePath(pathname);
    if (!decoded && !kind) return original;
    if (kind === 'site') {
      const route = `/${pathname}`;
      const target = routes.get(route);
      if (!target) fail(`unknown site route ${value}`);
      return relativeUrl(output, target) + suffix;
    }
    if (kind === 'asset' && frameOutputs.has(decoded)) return relativeUrl(output, frameOutputs.get(decoded)) + suffix;
    if (kind !== 'asset') {
      const route = pageRoute ? path.posix.join(pageRoute, pathname) : pathname;
      const target = routes.get(route) || (pathname.startsWith('/') ? routes.get(pathname) : undefined);
      if (target) return relativeUrl(output, target) + suffix;
      const framePath = pageRoute
        ? path.posix.normalize(path.posix.join(decodePath(pageRoute), decoded)).replace(/^\//, '')
        : path.posix.normalize(path.posix.join(path.relative(root, path.dirname(source)).split(path.sep).join('/'), decoded));
      const frame = frameOutputs.get(framePath);
      if (frame) return relativeUrl(output, frame) + suffix;
    }
    if (kind && (path.isAbsolute(decoded) || decoded.split('/').includes('..'))) fail(`root escape ${value}`);
    const baseDir = kind === 'asset' ? root : path.dirname(source);
    const target = path.resolve(baseDir, decoded);
    return relativeUrl(output, await resource(target)) + suffix;
  }
  for (const [id, html] of frames) {
    const output = outputsById.get(id);
    const rewritten = await rewriteHtml(html, (url, context) => rewriteUrl(url, path.join(root, output), output, undefined, context));
    if (!stylesheetFrames.has(id)) { files.set(output, rewritten); continue; }
    const bundled = preparePublicFrame(rewritten, css => {
      const name = `style-${hash(css).slice(0, 20)}.css`;
      if (generatedStyles.has(name)) { if (generatedStyles.get(name) !== css) fail('stylesheet digest collision'); }
      else { reserve(name); generatedStyles.set(name, css); files.set(name, css); }
      return name;
    });
    files.set(output, bundled.html);
    if (bundled.stylesheet) stylesheets.set(id, bundled.stylesheet);
  }
  for (const [route, html] of site) {
    const output = routes.get(route);
    files.set(output, await rewriteHtml(html, (url, context) => rewriteUrl(url, path.join(root, 'index.html'), output, route, context)));
  }
  // Explicit canonical carriers join the public graph before recursive closure and preview locking.
  const mapped = mapResources ? await mapResources(async (value, kind = 'url', tokens = {}, numericTokens = {}) => {
    const rewrite = async url => {
      const reference = readAssetReference(url);
      if (reference) { await declaredResource(reference.path); return url; } // canonical copies retain declared identity, not cache paths
      return rewriteUrl(url, path.join(root, '__divlet_source__.html'), '__divlet_source__.html');
    };
    if (kind === 'url') return rewrite(value);
    if (kind === 'className') {
      if (classMapper && tokens !== classTokens && JSON.stringify(tokens) !== classTheme) unsupportedSourceCss();
      if (classMapper && JSON.stringify(numericTokens) !== classNumericTokens) unsupportedSourceCss();
      if (!classMapper) {
        classTokens = tokens;
        classNumericTokens = JSON.stringify(numericTokens);
        classTheme = JSON.stringify(tokens);
        classMapper = await createClassResourceMapper({ tokens, numericTokens, onRename: onClassRename, onNumericReference: name => numericReferences.add(name), onVariableDefinition: name => variableDefinitions.add(decodeCss(name)), rewriteValue: async (css, closed) => {
          let changed = false;
          const declaration = await rewriteCss(`x:${css}`, async url => { const result = await rewrite(url); if (result !== url) changed = true; return result; }, true, closed);
          return changed ? declaration.slice(declaration.indexOf(':') + 1) : css;
        } });
      }
      return classMapper(value);
    }
    let changed = false;
    const tracked = async url => {
      const result = await rewrite(url);
      if (result !== url) changed = true;
      return result;
    };
    let result;
    if (kind === 'css') result = await rewriteCss(value, tracked, false, closedCss, inspectSelectors);
    else if (kind === 'srcset') result = await rewriteSrcset(value, tracked);
    else if (kind === 'css-value') {
      const declaration = await rewriteCss(`x:${value}`, tracked, true, closedCss, inspectSelectors);
      result = declaration.slice(declaration.indexOf(':') + 1);
    } else fail('unsupported resource field kind');
    return changed ? result : value;
  }) : undefined;
  for (let i = 0; i < pending.length; i++) await pending[i]();
  if (numericReferences.size && (uninspectedExternal || [...numericReferences].some(name => variableDefinitions.has(name)))) unsupportedSourceCss();
  allowNewResources = false;
  const previewVersion = hash(JSON.stringify([...sources, ...assetSources].sort(([a], [b]) => a.localeCompare(b)))).slice(0, 20);
  async function preview(html, output, route) {
    return rewriteHtml(html, async (url, context) => {
      if (route && context?.tag === 'a' && context.attribute === 'href') return url;
      const rewritten = await rewriteUrl(url, path.join(root, route ? 'index.html' : output), output, route, context);
      const suffixAt = rewritten.search(/[?#]/), pathname = suffixAt < 0 ? rewritten : rewritten.slice(0, suffixAt);
      const directory = path.posix.dirname(output).split('/').map(encodeURIComponent).join('/');
      const rootPath = path.posix.normalize(path.posix.join(directory, pathname));
      if (!rootPath.startsWith(`${resourceDirectory}/`)) return rewritten;
      const absolute = previewBase ? previewBase + rootPath + (suffixAt < 0 ? '' : rewritten.slice(suffixAt)) : rewritten;
      const fragmentAt = absolute.indexOf('#');
      const before = fragmentAt < 0 ? absolute : absolute.slice(0, fragmentAt);
      return before + (before.includes('?') ? '&' : '?') + `divlet-resource=${previewVersion}` + (fragmentAt < 0 ? '' : absolute.slice(fragmentAt));
    });
  }
  for (const [id, html] of previews) rewrittenPreviews.set(id, await preview(html, outputsById.get(id)));
  for (const [route, html] of sitePreviews) {
    if (!routes.has(route)) fail('site preview has no matching route');
    rewrittenSitePreviews.set(route, await preview(html, routes.get(route), route));
  }
  return { files, sources, warnings, stylesheets, mediaTypes, ...(declared ? { assetSources } : {}), previews: rewrittenPreviews, sitePreviews: rewrittenSitePreviews, ...(mapResources ? { mapped } : {}) };
}
