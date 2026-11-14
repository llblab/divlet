import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { marked } from 'marked';
import { parseDocument } from 'yaml';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { decodeHtml } from './codec.ts';
import { DivletError, validateDocument, VOID_TAGS } from './model.ts';
import type { DocumentModel, Metadata, Node, NodeId } from './model.ts';
import { expandFrame } from './project.ts';
import type { ProjectSettings } from './project.ts';
import type { PreparedFrame } from './render.ts';

/** `site.json`: a template frame, the slots it exposes and the Markdown tree that fills them. */
export interface SiteConfig {
  schemaVersion: 1;
  title: string;
  templateId: string;
  contentDir: string;
  slots: { content: string; title?: string; navigation?: string };
  viewport?: { width: number; height: number };
}
/** One published page: where it came from and where it lives. */
export interface SiteRoute { path: string; title: string; description: string; order: number; sourcePath: string; sourceRelative: string; documentId: string }
/** One entry of the generated navigation tree. */
export interface SiteNavEntry { name: string; title: string; path: string | null; sourceRelative: string | null; order: number; children: SiteNavEntry[] }
/** A built site: the pages, the routes and the fingerprint that says whether a rebuild is needed. */
export interface SiteBuild {
  version: number;
  fingerprint: string;
  config: SiteConfig;
  routes: SiteRoute[];
  pages: Map<string, PreparedFrame>;
  tree: SiteNavEntry[];
}
/** What building a site needs from the runtime: the frames, a renderer, a reader and the URL bases. */
export interface BuildSiteOptions {
  projectDir: string;
  documents: Map<string, { document: DocumentModel; sourcePath?: string; htmlPath: string }>;
  settings: ProjectSettings | null;
  prepare(document: DocumentModel): Promise<PreparedFrame>;
  readFile(file: string): Promise<string | null>;
  previous?: SiteBuild | null;
  siteBase: string;
  assetBase: string;
}
/** A Markdown source and its path, as the tree walk finds them. */
interface MarkdownFile { sourcePath: string; source: string }

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const posix = (value: string): string => value.split(path.sep).join('/');
const escape = (value: unknown): string => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const flowContainers = new Set(['div', 'main', 'section', 'article', 'aside', 'nav', 'header', 'footer']);
const configFields: ReadonlySet<string> = new Set(['schemaVersion', 'title', 'templateId', 'contentDir', 'slots', 'viewport']);
const frontmatterFields: ReadonlySet<string> = new Set(['title', 'description', 'order', 'draft']);

function fail(code: string, message: string, details?: unknown): never { throw new DivletError(code, message, details); }
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function text(value: unknown, name: string, maximum = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /\0/.test(value)) fail('INVALID_SITE_CONFIG', `${name} must be a non-empty string of at most ${maximum} characters.`);
  return value;
}
function knownFields(value: unknown, fields: ReadonlySet<string>, name: string): void {
  if (!record(value)) fail('INVALID_SITE_CONFIG', `${name} must be an object.`);
  for (const key of Object.keys(value)) if (!fields.has(key)) fail('INVALID_SITE_CONFIG', `Unsupported ${name} field: ${key}`);
}
function safeRelative(value: unknown, name: string): string {
  const relative = text(value, name, 2048);
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('UNSAFE_PATH', `${name} must be a relative path inside divlet without empty, dot or parent segments.`);
  return relative;
}

// Refuse links in every existing component, including directory links. Missing
// assets are permitted during editing; the confined HTTP asset route yields 404.
async function confined(root: string, target: string, { missing = false }: { missing?: boolean } = {}): Promise<void> {
  if (!inside(root, target)) fail('UNSAFE_PATH', 'A site source or asset resolves outside divlet.');
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) fail('UNSAFE_PATH', `Symbolic links are not allowed in site paths: ${current}`);
  }
  const real = await fs.realpath(target);
  if (!inside(root, real)) fail('UNSAFE_PATH', 'A site source or asset resolves outside divlet.');
}

function parseConfig(source: string): SiteConfig {
  let config: any;
  try { config = JSON.parse(source); } catch { fail('INVALID_SITE_CONFIG', 'divlet/site.json must contain valid JSON.'); }
  knownFields(config, configFields, 'site configuration');
  if (config.schemaVersion !== 1) fail('INVALID_SITE_CONFIG', 'Site schemaVersion must be 1.');
  text(config.title, 'Site title');
  text(config.templateId, 'templateId', 96);
  config.contentDir = safeRelative(config.contentDir ?? 'content', 'contentDir');
  knownFields(config.slots, new Set(['content', 'title', 'navigation']), 'slots');
  text(config.slots.content, 'slots.content', 96);
  for (const key of ['title', 'navigation']) if (config.slots[key] !== undefined) text(config.slots[key], `slots.${key}`, 96);
  if (config.viewport !== undefined) {
    knownFields(config.viewport, new Set(['width', 'height']), 'viewport');
    for (const key of ['width', 'height']) if (!Number.isFinite(config.viewport[key]) || config.viewport[key] < 1 || config.viewport[key] > 16384) fail('INVALID_SITE_CONFIG', `viewport.${key} must be between 1 and 16384.`);
  }
  return config;
}

function validateSlots(template: DocumentModel, slots: SiteConfig['slots']): void {
  const ids = Object.values(slots);
  if (new Set(ids).size !== ids.length) fail('INVALID_SITE_SLOT', 'Site slots must refer to distinct nodes.');
  for (const [role, id] of Object.entries(slots)) {
    const node = template.nodes[id];
    if (!node || node.type !== 'element' || VOID_TAGS.has(node.tag)) fail('INVALID_SITE_SLOT', `Slot ${role} must reference an existing non-void element: ${id}`);
    if (role !== 'title' && !flowContainers.has(node.tag)) fail('INVALID_SITE_SLOT', `Slot ${role} requires a flow container such as article, div or nav.`);
    function visit(childId: NodeId): void {
      if (ids.includes(childId)) fail('INVALID_SITE_SLOT', 'Site slots cannot contain one another.');
      const child = template.nodes[childId];
      for (const grandchild of child?.type === 'element' ? child.children : []) visit(grandchild);
    }
    for (const child of node.children) visit(child);
  }
}

async function markdownSources(root: string, directory: string, readFile: (file: string) => Promise<string | null>, files: MarkdownFile[] = [], depth = 0): Promise<MarkdownFile[]> {
  if (depth > 32) fail('SITE_LIMIT', 'The Markdown tree is too deeply nested.');
  await confined(root, directory);
  for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name.startsWith('.')) continue;
    const full = path.join(directory, item.name);
    if (item.isSymbolicLink()) fail('UNSAFE_PATH', `Symbolic links are not supported in the Markdown tree: ${full}`);
    if (item.isDirectory()) await markdownSources(root, full, readFile, files, depth + 1);
    else if (item.isFile() && /\.md$/i.test(item.name)) {
      const source = await readFile(full);
      if (source === null) fail('SITE_SOURCE_CHANGED', 'A Markdown source disappeared during preparation.');
      files.push({ sourcePath: full, source });
      if (files.length > 200) fail('SITE_LIMIT', 'A site supports at most 200 Markdown files.');
    }
  }
  return files;
}

function parseMarkdown(source: string, sourceRelative: string): { fragment: DocumentModel; title: string; description: string; order: number; draft: boolean } {
  source = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let frontmatter: any = {};
  if (source.startsWith('---\n')) {
    const boundary = source.indexOf('\n---', 4);
    if (boundary < 0 || !/^(?:\n|$)/.test(source.slice(boundary + 4))) fail('INVALID_MARKDOWN', `Unclosed YAML frontmatter in ${sourceRelative}`);
    const document = parseDocument(source.slice(4, boundary), { uniqueKeys: true });
    if (document.errors.length) fail('INVALID_MARKDOWN', `Invalid YAML frontmatter in ${sourceRelative}: ${document.errors[0]?.message}`);
    try { frontmatter = document.toJS({ maxAliasCount: 0 }) ?? {}; }
    catch { fail('INVALID_MARKDOWN', `YAML aliases are not supported in ${sourceRelative}`); }
    if (!record(frontmatter)) fail('INVALID_MARKDOWN', `Frontmatter must be a mapping in ${sourceRelative}`);
    for (const key of Object.keys(frontmatter)) if (!frontmatterFields.has(key)) fail('INVALID_MARKDOWN', `Unsupported frontmatter field ${key} in ${sourceRelative}`);
    source = source.slice(boundary + 4).replace(/^\n/, '');
  }
  for (const key of ['title', 'description']) if (frontmatter[key] !== undefined && (typeof frontmatter[key] !== 'string' || frontmatter[key].length > (key === 'title' ? 512 : 2048))) fail('INVALID_MARKDOWN', `Frontmatter ${key} must be a bounded string in ${sourceRelative}`);
  if (frontmatter.order !== undefined && !Number.isFinite(frontmatter.order)) fail('INVALID_MARKDOWN', `Frontmatter order must be a number in ${sourceRelative}`);
  if (frontmatter.draft !== undefined && typeof frontmatter.draft !== 'boolean') fail('INVALID_MARKDOWN', `Frontmatter draft must be boolean in ${sourceRelative}`);
  const tokens = marked.lexer(source, { gfm: true });
  marked.walkTokens(tokens, token => { if (token.type === 'html') fail('UNSUPPORTED_MARKDOWN_HTML', `Raw HTML is not supported in Markdown: ${sourceRelative}`); });
  const html = marked.parser(tokens, { gfm: true });
  const fragment = decodeHtml(`<div>${html}</div>`, { fallbackId: 'markdown-fragment' });
  const heading = Object.values(fragment.nodes).find(node => node.type === 'element' && /^h[1-6]$/.test(node.tag));
  const plain = (id: NodeId): string => {
    const node = fragment.nodes[id];
    if (!node) return '';
    return node.type === 'text' ? node.content : node.type === 'element' ? node.children.map(plain).join('') : '';
  };
  const used = new Set<string>();
  for (const node of Object.values(fragment.nodes)) if (node.type === 'element' && /^h[1-6]$/.test(node.tag)) {
    const base = plain(node.id).normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
    let slug = base;
    for (let suffix = 2; used.has(slug); suffix++) slug = `${base}-${suffix}`;
    used.add(slug);
    node.attrs.id = slug;
  }
  return { fragment, title: frontmatter.title?.trim() || (heading && plain(heading.id).trim()) || path.posix.basename(sourceRelative, path.posix.extname(sourceRelative)), description: frontmatter.description ?? '', order: frontmatter.order ?? 0, draft: frontmatter.draft ?? false };
}

function routeFor(relative: string): string {
  const segments = relative.replace(/\.md$/i, '').split('/');
  if ((segments.at(-1) ?? '').toLowerCase() === 'index') segments.pop();
  return '/' + segments.map(encodeURIComponent).join('/') + (segments.length ? '/' : '');
}

function makeTree(routes: SiteRoute[]): SiteNavEntry[] {
  const root: SiteNavEntry = { name: '', title: '', path: null, sourceRelative: null, order: 0, children: [] };
  for (const route of routes) {
    const segments = route.sourceRelative.replace(/\.md$/i, '').split('/');
    const isIndex = (segments.at(-1) ?? '').toLowerCase() === 'index';
    if (isIndex && segments.length > 1) segments.pop();
    let parent = root;
    for (const [index, name] of segments.entries()) {
      let entry = parent.children.find(child => child.name === name);
      if (!entry) { entry = { name, title: name.replace(/[-_]/g, ' '), path: null, sourceRelative: null, order: 0, children: [] }; parent.children.push(entry); }
      if (index === segments.length - 1) Object.assign(entry, { title: route.title, path: route.path, sourceRelative: route.sourceRelative, order: route.order });
      parent = entry;
    }
  }
  function sort(entries: SiteNavEntry[]): void { entries.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)); for (const entry of entries) sort(entry.children); }
  sort(root.children);
  return root.children;
}

function navHtml(tree: SiteNavEntry[], active: string, siteBase: string): string {
  return `<ul class="divlet-navigation">${tree.map(entry => `<li>${entry.path ? `<a href="${escape(siteBase + entry.path.slice(1))}"${entry.path === active ? ' aria-current="page" class="divlet-current"' : ''}>${escape(entry.title)}</a>` : `<span>${escape(entry.title)}</span>`}${entry.children.length ? navHtml(entry.children, active, siteBase) : ''}</li>`).join('')}</ul>`;
}

function splitUrl(value: string): { pathname: string; suffix: string } {
  const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(value) as RegExpExecArray;
  return { pathname: match[1] as string, suffix: (match[2] ?? '') + (match[3] ?? '') };
}
function decodePath(value: string): string {
  try { return decodeURIComponent(value); }
  catch { fail('INVALID_SITE_URL', `Invalid URL escape: ${value}`); }
}

async function rewriteModel(document: DocumentModel, { projectDir, sourcePath, contentRoot, routeMap, route, siteBase, assetBase, markdown = false }: { projectDir: string; sourcePath: string; contentRoot: string; routeMap: Map<string, SiteRoute>; route: string; siteBase: string; assetBase: string; markdown?: boolean }): Promise<void> {
  async function rewrite(value: string, kind: 'link' | 'asset'): Promise<string> {
    if (!value || value.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return value;
    if (/[\u0000-\u001f\\]/.test(value)) fail('INVALID_SITE_URL', `Invalid local URL in ${sourcePath}`);
    const { pathname, suffix } = splitUrl(value);
    const decoded = decodePath(pathname);
    if (decoded.includes('\\') || decoded.includes('\0')) fail('INVALID_SITE_URL', `Invalid local URL in ${sourcePath}`);
    if (kind === 'link' && /\.md$/i.test(decoded)) {
      const target = path.resolve(decoded.startsWith('/') ? contentRoot : markdown ? path.dirname(sourcePath) : contentRoot, decoded.replace(/^\//, ''));
      if (!inside(contentRoot, target)) fail('UNSAFE_PATH', 'A Markdown link resolves outside the configured content tree.');
      const targetRoute = routeMap.get(target);
      if (!targetRoute) fail('UNKNOWN_SITE_LINK', `Markdown link has no published route: ${value} in ${sourcePath}`);
      return siteBase + targetRoute.path.slice(1) + suffix;
    }
    if (kind === 'link' && (decoded.startsWith('/') || !path.posix.extname(decoded))) {
      const local = new URL(value, `https://divlet.invalid${markdown ? route : '/'}`);
      return siteBase + local.pathname.replace(/^\//, '') + local.search + local.hash;
    }
    const target = path.resolve(decoded.startsWith('/') ? projectDir : path.dirname(sourcePath), decoded.replace(/^\//, ''));
    await confined(projectDir, target, { missing: true });
    return assetBase + posix(path.relative(projectDir, target)).split('/').map(encodeURIComponent).join('/') + suffix;
  }
  async function rewriteCss(value: string): Promise<string> {
    const parsed = valueParser(value);
    const urls: any[] = [];
    parsed.walk((node: any) => { if (node.type === 'function' && node.value.toLowerCase() === 'url') urls.push(node); });
    for (const node of urls) {
      const meaningful = node.nodes.filter((part: any) => !['space', 'comment'].includes(part.type));
      if (meaningful.length !== 1 || !['word', 'string'].includes(meaningful[0].type) || meaningful[0].value.includes('\\')) fail('INVALID_SITE_URL', 'Site CSS URLs must use a plain or quoted URL without CSS escapes.');
      const rewritten = await rewrite(meaningful[0].value, 'asset');
      node.nodes = [{ type: 'string', quote: '"', value: rewritten, sourceIndex: 0, sourceEndIndex: rewritten.length }];
    }
    return parsed.toString();
  }
  for (const node of Object.values(document.nodes)) {
    if (node.type !== 'element') continue;
    for (const name of ['href', 'xlink:href', 'src', 'poster', 'action', 'formaction']) if (node.attrs[name] !== undefined) node.attrs[name] = await rewrite(node.attrs[name] as string, name === 'href' && ['a', 'area'].includes(node.tag) ? 'link' : 'asset');
    if (node.attrs.srcset) {
      const candidates = [];
      for (const candidate of (node.attrs.srcset as string).split(',')) {
        const parts = candidate.trim().split(/\s+/);
        if (parts.length > 2 || !parts[0] || (parts[1] && !/^\d+(?:\.\d+)?[wx]$/.test(parts[1])) || /^data:/i.test(parts[0])) fail('UNSUPPORTED_SITE_URL', 'Site srcset requires comma-separated plain URLs with optional width/density descriptors; data URLs and URL whitespace are unsupported.');
        candidates.push(await rewrite(parts[0] as string, 'asset') + (parts[1] ? ' ' + parts[1] : ''));
      }
      node.attrs.srcset = candidates.join(', ');
    }
    for (const [property, value] of Object.entries(node.style)) node.style[property] = await rewriteCss(value);
  }
  const css = postcss.parse(document.css, { map: false });
  const declarations: postcss.Declaration[] = [];
  css.walkDecls(declaration => { declarations.push(declaration); });
  for (const declaration of declarations) declaration.value = await rewriteCss(declaration.value);
  document.css = css.toString();
  for (const [key, value] of Object.entries(document.tokens)) document.tokens[key] = await rewriteCss(value);
}

function clearSlot(document: DocumentModel, slotId: NodeId): void {
  function remove(id: NodeId): void { for (const child of (document.nodes[id] as { children?: NodeId[] })?.children ?? []) remove(child); delete document.nodes[id]; }
  const slot = document.nodes[slotId] as { children: NodeId[] };
  for (const id of slot.children) remove(id);
  slot.children = [];
}

function replaceSlot(document: DocumentModel, slotId: NodeId, fragment: DocumentModel, provenance: Record<string, unknown>, namespace: string): void {
  clearSlot(document, slotId);
  const slot = document.nodes[slotId] as { children: NodeId[] };
  const ids = new Map(Object.keys(fragment.nodes).map(id => [id, `site-${hash(namespace + ':' + id).slice(0, 24)}`]));
  const children = (fragment.nodes[fragment.rootId] as { children: NodeId[] }).children;
  const used = new Set<string>();
  function append(id: NodeId): void {
    const node = fragment.nodes[id];
    if (!node) return;
    const nextId = ids.get(id) as string;
    if (document.nodes[nextId] || used.has(nextId)) fail('SITE_ID_COLLISION', 'A generated node ID conflicts with the template.');
    used.add(nextId);
    // Provenance travels in metadata; the generated node is otherwise the fragment's own node.
    const metadata = { ...node.metadata, divletSite: provenance as Metadata['divletSite'] };
    const copy: Node = node.type === 'element'
      ? { ...structuredClone(node), id: nextId, metadata, children: node.children.map(child => ids.get(child) as NodeId) }
      : { ...structuredClone(node), id: nextId, metadata };
    document.nodes[nextId] = copy;
    // Recurse over the fragment's own IDs: the copy already holds the remapped ones.
    if (node.type === 'element') for (const child of node.children) append(child);
  }
  for (const id of children) append(id);
  slot.children = children.map(id => ids.get(id) as string);
}

export async function buildSite({ projectDir, documents, settings, prepare, readFile, previous, siteBase, assetBase }: BuildSiteOptions): Promise<SiteBuild | null> {
  const configPath = path.join(projectDir, 'site.json');
  const source = await readFile(configPath);
  if (source === null) return null;
  await confined(projectDir, configPath);
  const config = parseConfig(source);
  const templateEntry = documents.get(config.templateId);
  if (!templateEntry) fail('SITE_TEMPLATE_NOT_FOUND', `Unknown site template: ${config.templateId}`);
  const template = validateDocument(templateEntry.document);
  validateSlots(template, config.slots);
  const contentRoot = path.resolve(projectDir, config.contentDir);
  const files = await markdownSources(projectDir, contentRoot, readFile);
  if (files.reduce((sum, file) => sum + Buffer.byteLength(file.source), 0) > 16 * 1024 * 1024) fail('SITE_LIMIT', 'The Markdown tree exceeds 16 MiB.');
  // Hash semantic render inputs, not the compiler's cumulative stylesheet or unrelated frame revisions.
  const expandedTemplate = expandFrame(template, id => documents.get(id)?.document, settings).document;
  const fingerprint = hash(JSON.stringify([config, template, expandedTemplate, files, siteBase, assetBase]));
  if (previous?.fingerprint === fingerprint) return previous;
  const version = (previous?.version ?? 0) + 1;
  const routePaths = new Set<string>();
  const sources: Array<ReturnType<typeof parseMarkdown> & { path: string; sourcePath: string; sourceRelative: string; documentId: string }> = [];
  for (const file of files) {
    const sourceRelative = posix(path.relative(contentRoot, file.sourcePath));
    const parsed = parseMarkdown(file.source, sourceRelative);
    if (parsed.draft) continue;
    const routePath = routeFor(sourceRelative);
    if (routePaths.has(routePath)) fail('DUPLICATE_SITE_ROUTE', `Multiple Markdown files claim route ${routePath}`);
    routePaths.add(routePath);
    sources.push({ ...parsed, path: routePath, sourcePath: file.sourcePath, sourceRelative, documentId: 'site-' + hash(sourceRelative).slice(0, 24) });
  }
  sources.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  const routeMap = new Map(sources.map(route => [route.sourcePath, route]));
  const routes = sources.map(({ path, title, description, order, sourcePath, sourceRelative, documentId }) => ({ path, title, description, order, sourcePath, sourceRelative, documentId }));
  const tree = makeTree(routes);
  const pages = new Map<string, PreparedFrame>();
  for (const route of sources) {
    const document = structuredClone(template);
    document.id = route.documentId;
    document.name = `${route.title} — ${config.title}`;
    if (document.name.length > 512) document.name = document.name.slice(0, 512);
    document.version = version;
    if (config.viewport) Object.assign(document.artboard, config.viewport);
    (document.metadata as any).divletSite = { route: route.path, sourcePath: route.sourcePath, sourceRelative: route.sourceRelative, templateId: template.id, derived: true, frontmatter: { title: route.title, description: route.description, order: route.order } };
    for (const slotId of Object.values(config.slots) as string[]) clearSlot(document, slotId);
    const common = { projectDir, sourcePath: templateEntry.sourcePath ?? templateEntry.htmlPath, contentRoot, routeMap, route: route.path, siteBase, assetBase };
    await rewriteModel(document, common);
    const fragment = structuredClone(route.fragment);
    await rewriteModel(fragment, { ...common, sourcePath: route.sourcePath, markdown: true });
    replaceSlot(document, config.slots.content as string, fragment, { kind: 'markdown', sourcePath: route.sourcePath, route: route.path }, route.sourceRelative + ':content');
    if (config.slots.title) replaceSlot(document, config.slots.title as string, decodeHtml(`<div>${escape(route.title)}</div>`), { kind: 'title', sourcePath: route.sourcePath, route: route.path }, route.sourceRelative + ':title');
    if (config.slots.navigation) replaceSlot(document, config.slots.navigation as string, decodeHtml(`<div>${navHtml(tree, route.path, siteBase)}</div>`), { kind: 'navigation', route: route.path }, route.sourceRelative + ':navigation');
    const prepared = await prepare(document);
    pages.set(route.path, prepared);
  }
  return { version, fingerprint, config, routes, pages, tree };
}
