/*
 * The HTML codec: a frame to HTML and back. `encodeHtml` writes the preview page the board renders, `renderFile` the generated
 * file people open, `exportHtml` clean markup for copying, `htmlToSpecs` turns pasted HTML into insert specs, and `decodeHtml`
 * reads HTML back into a validated document (hand edits, imports, the round-trip check after encoding).
 *
 * The parse5 tree is walked defensively and typed loosely on purpose: it is a foreign, version-specific shape, and everything
 * this module returns goes through `validateDocument` before anyone trusts it.
 */
import { parse, parseFragment } from 'parse5';
import postcss from 'postcss';
import { serializeDeclarations } from './declarations.ts';
import { validateDocument, DivletError, VOID_TAGS, LIMITS, documentLimits, supportsTag } from './model.ts';
import type { DocumentModel, ElementNode, Limits, Node, NodeId } from './model.ts';

/** A node of the parse5 tree, as this codec needs to read it. */
type P5Node = any;
/** Where a generated part came from (an instance and the component address inside it). */
export interface PartOrigin { instance: NodeId; address: string }
/** Options shared by the encoders: the compiled stylesheet, the expansion parts and the instance map. */
export interface EncodeOptions {
  compiledCss?: string;
  parts?: ReadonlyMap<NodeId, PartOrigin>;
  instances?: ReadonlyMap<NodeId, string>;
  limits?: Limits;
}
export interface ExportOptions { nodeId?: NodeId; compiledCss?: string; limits?: Limits }
export interface RenderFileOptions extends EncodeOptions {}
export interface DecodeOptions { fallbackId?: string; previous?: unknown; limits?: Limits }
/** One element of a pasted fragment, ready for `edit_divlet`'s insert op. */
export interface NodeSpec {
  tag: string;
  id?: string;
  className?: string;
  attrs?: Record<string, string>;
  style?: Record<string, string>;
  text?: string;
  children?: NodeSpec[];
}











const HTML_NS = 'http://www.w3.org/1999/xhtml';
const META_ID = 'divlet-metadata';
const ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;
const escapeText = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;');
const escapeAttribute = (value: string): string => escapeText(value).replaceAll('"', '&quot;');
const jsonText = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');

function error(message: string, details?: unknown, code = 'INVALID_HTML'): never {
  throw new DivletError(code, message, details);
}

/** A node the walk has already proved exists; documents are validated before any of this runs. */
function need(doc: DocumentModel, id: NodeId): Node {
  const node = doc.nodes[id];
  if (!node) error(`Unknown node: ${id}`, undefined, 'NOT_FOUND');
  return node;
}

export function encodeHtml(input: unknown, { compiledCss = '', parts, instances, limits = LIMITS }: EncodeOptions = {}): string {
  const doc = validateDocument(input, { limits });
  const nodeMetadata: Record<NodeId, Record<string, unknown>> = {};
  const textIds: Record<NodeId, NodeId> = {};
  for (const node of Object.values(doc.nodes)) {
    if (Object.keys(node.metadata).length) nodeMetadata[node.id] = node.metadata;
    if (node.type === 'element' && node.tag === 'textarea' && node.children.length) textIds[node.id] = node.children[0] as NodeId;
  }
  const manifest = { schemaVersion: 1, id: doc.id, name: doc.name, version: doc.version, artboard: doc.artboard, metadata: doc.metadata, nodeMetadata, textIds };
  function render(id: NodeId): string {
    const node = need(doc, id);
    if (node.type === 'text') return `<!--divlet:text:${id}-->${escapeText(node.content)}<!--/divlet:text:${id}-->`;
    if (node.type !== 'element') error(`${id} is an instance; encode the expanded frame`);
    const attrs = [`data-divlet-id="${escapeAttribute(id)}"`];
    const part = parts?.get(id);
    // Parts of an expanded instance are rendered but not selectable; instance roots name their component.
    if (part) attrs.push(`data-divlet-in="${escapeAttribute(part.instance)}"`, `data-divlet-at="${escapeAttribute(part.address)}"`);
    const ref = instances?.get(id);
    if (ref) attrs.push(`data-divlet-ref="${escapeAttribute(ref)}"`);
    for (const [key, value] of Object.entries(node.attrs)) attrs.push(`${key}="${escapeAttribute(value)}"`);
    if (node.className) attrs.push(`class="${escapeAttribute(node.className)}"`);
    const style = serializeDeclarations(Object.entries(node.style));
    if (style) attrs.push(`style="${escapeAttribute(style)}"`);
    const start = `<${node.tag} ${attrs.join(' ')}>`;
    if (VOID_TAGS.has(node.tag)) return start;
    if (node.tag === 'textarea') {
      const child = node.children[0];
      let text = child ? (need(doc, child) as { content: string }).content : '';
      if (text.startsWith('\n')) text = '\n' + text;
      return `${start}${escapeText(text)}</textarea>`;
    }
    return `${start}${node.children.map(render).join('')}</${node.tag}>`;
  }
  if (typeof compiledCss !== 'string' || /<\/style/i.test(compiledCss)) error('Invalid compiled stylesheet');
  const tokens = Object.entries(doc.tokens).map(([name, value]) => `${name}:${value};`).join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeText(doc.name)}</title><script id="${META_ID}" type="application/json">${jsonText(manifest)}</script><style data-divlet-tokens>:root{${tokens}}</style><style data-divlet-custom>${layered(doc.css)}</style>${compiledCss ? `<style data-divlet-compiled>${compiledCss}</style>` : ''}</head><body data-divlet-root="${escapeAttribute(doc.rootId)}">${render(doc.rootId)}</body></html>\n`;
}








const LAYERS = '@layer theme, base, components, utilities;\n@layer components {\n';
/**
 * Custom CSS sits in Tailwind's components layer: it beats the preflight reset, and the
 * utilities in className beat it — classes stay the last word, as on the board.
 */
export const layered = (css: string): string => (css ? `${LAYERS}${css}\n}` : '');
const unlayer = (text: string): string => (text.startsWith(LAYERS) && text.endsWith('\n}') ? text.slice(LAYERS.length, -2) : text);

const INLINE_TAGS = new Set('a abbr b bdi bdo br cite code data dfn em i img input kbd label mark q s samp small span strong sub sup time u var wbr'.split(' '));

/**
 * Clean, readable HTML for people: no divlet IDs, no text-boundary comments, indented blocks.
 * With `nodeId` it returns that element (or text) alone; otherwise a standalone page whose
 * head carries the tokens, the document CSS and the compiled Tailwind utilities.
 */
export function exportHtml(input: unknown, { nodeId, compiledCss = '', limits = LIMITS }: ExportOptions = {}): string {
  const doc = validateDocument(input, { limits });
  const start = nodeId ?? doc.rootId;
  if (!Object.hasOwn(doc.nodes, start)) error(`Unknown node: ${start}`, undefined, 'NOT_FOUND');
  const inlineOnly = (node: ElementNode): boolean => node.children.every((id: NodeId) => {
    const child = need(doc, id);
    return child.type === 'text' || (child.type === 'element' && INLINE_TAGS.has(child.tag));
  });
  const textOf = (node: ElementNode): string => {
    const child = node.children[0];
    return child ? (need(doc, child) as { content: string }).content : '';
  };
  function open(node: ElementNode): string {
    const attrs: string[] = [];
    for (const [key, value] of Object.entries(node.attrs)) attrs.push(`${key}="${escapeAttribute(value)}"`);
    if (node.className) attrs.push(`class="${escapeAttribute(node.className)}"`);
    const style = serializeDeclarations(Object.entries(node.style), true);
    if (style) attrs.push(`style="${escapeAttribute(style)}"`);
    return `<${node.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  }
  function inline(id: NodeId): string {
    const node = need(doc, id);
    if (node.type === 'text') return escapeText(node.content);
    if (node.type !== 'element') error(`${id} is an instance; expand the frame before exporting it`);
    if (VOID_TAGS.has(node.tag)) return open(node);
    if (node.tag === 'textarea') return `${open(node)}${escapeText(textOf(node))}</textarea>`;
    return `${open(node)}${node.children.map(inline).join('')}</${node.tag}>`;
  }
  function block(id: NodeId, depth: number): string {
    const node = need(doc, id);
    const pad = '  '.repeat(depth);
    if (node.type === 'text') return node.content.trim() ? pad + escapeText(node.content) : '';
    if (node.type !== 'element') error(`${id} is an instance; expand the frame before exporting it`);
    if (VOID_TAGS.has(node.tag) || node.tag === 'textarea' || !node.children.length || inlineOnly(node)) return pad + inline(id);
    const inner = node.children.map(child => block(child, depth + 1)).filter(Boolean).join('\n');
    return `${pad}${open(node)}\n${inner}\n${pad}</${node.tag}>`;
  }
  const body = block(start, nodeId ? 0 : 1);
  if (nodeId) return body + '\n';
  if (typeof compiledCss !== 'string' || /<\/style/i.test(compiledCss)) error('Invalid compiled stylesheet');
  const tokens = Object.entries(doc.tokens).map(([name, value]) => `  ${name}: ${value};`).join('\n');
  const styles = [tokens && `:root {\n${tokens}\n}`, layered(doc.css), compiledCss].filter(Boolean).join('\n');
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeText(doc.name)}</title>\n${styles ? `<style>\n${styles}\n</style>\n` : ''}</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

const DROPPED_TAGS = new Set('script style template iframe object embed link meta noscript base head title frame frameset applet portal'.split(' '));
const URL_ATTRIBUTES = /^(href|src|action|formaction|poster|xlink:href)$/i;
const INLINE_FALLBACK = new Set('font big center tt strike blink nobr acronym'.split(' '));

/**
 * Turn a pasted HTML fragment into insert specs (see ops.insertNode). Scripts, event handlers,
 * unsafe URLs and divlet bookkeeping are dropped; unknown elements become div/span so their
 * content survives. Document-level rules (nesting, lists, tables) are checked on insert.
 */
export function htmlToSpecs(html: unknown, { limit = 1000 }: { limit?: number } = {}): NodeSpec[] {
  if (typeof html !== 'string' || html.length > 512 * 1024) error('Pasted HTML must be a string of at most 512 KiB');
  const tree = /<body[\s>]/i.exec(html) ? parse(html) : parseFragment(html);
  const documentNode: P5Node = tree;
  const body: P5Node = /<body[\s>]/i.test(html)
    ? (documentNode.childNodes as P5Node[]).find((node: P5Node) => node.tagName === 'html')?.childNodes.find((node: P5Node) => node.tagName === 'body')
    : documentNode;
  let count = 0;
  function convert(node: P5Node, inSvg: boolean, inPre: boolean): NodeSpec | string | null {
    if (node.nodeName === '#text') return inPre || node.value.trim() ? node.value : null;
    if (!node.tagName || DROPPED_TAGS.has(node.tagName)) return null;
    if (++count > limit) error(`Pasted HTML has more than ${limit} elements`, undefined, 'TOO_LARGE');
    const svg = inSvg || node.tagName === 'svg';
    const supported = supportsTag(node.tagName, inSvg);
    const tag = supported ? node.tagName : INLINE_FALLBACK.has(node.tagName) ? 'span' : 'div';
    const spec: NodeSpec = { tag };
    const attrs: Record<string, string> = {};
    for (const item of node.attrs ?? []) {
      const name = item.prefix ? `${item.prefix}:${item.name}` : item.name;
      if (/^on/i.test(name) || /^data-divlet-/i.test(name) || /^(srcdoc|is)$/i.test(name) || !/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name)) continue;
      if (name === 'class') { if (item.value.trim()) spec.className = item.value.trim().replace(/\s+/g, ' '); continue; }
      if (name === 'style') { try { const style = parseInlineStyle(item.value); if (Object.keys(style).length) spec.style = style; } catch {} continue; }
      if (name === 'id') {
        if (ID.test(item.value)) spec.id = item.value;
        if (svg) attrs.id = item.value;
        continue;
      }
      if (URL_ATTRIBUTES.test(name)) {
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(item.value.replace(/[\u0000-\u0020\u007f]+/g, ''))?.[1]?.toLowerCase();
        if (scheme && !['http', 'https', 'mailto', 'tel'].includes(scheme)) continue;
      }
      attrs[name] = item.value;
    }
    if (Object.keys(attrs).length) spec.attrs = attrs;
    if (!VOID_TAGS.has(tag)) {
      const source = node.tagName === 'template' ? [] : node.childNodes ?? [];
      const children = source.map((child: P5Node) => convert(child, svg, inPre || tag === 'pre' || tag === 'textarea')).filter((child: NodeSpec | string | null): child is NodeSpec | string => child !== null);
      if (children.length === 1 && typeof children[0] === 'string') spec.text = children[0];
      else if (children.length) spec.children = children as NodeSpec[];
    }
    return spec;
  }
  const specs: NodeSpec[] = [];
  for (const node of body?.childNodes ?? []) {
    const spec = convert(node, false, false);
    if (spec === null) continue;
    specs.push(typeof spec === 'string' ? { tag: 'p', text: spec.trim() } : spec);
  }
  if (!specs.length) error('There is no supported content to paste', undefined, 'NOTHING_TO_PASTE');
  return specs;
}

/**
 * The generated HTML file of a frame: the exact DOM of the preview (so it renders identically)
 * without divlet bookkeeping, except `data-divlet-id` anchors on the frame's own elements and
 * `data-divlet-ref` on instances. Line breaks sit inside tags, where they never render.
 */
export function renderFile(input: unknown, { compiledCss = '', parts, instances, limits = LIMITS }: RenderFileOptions = {}): string {
  const doc = validateDocument(input, { limits });
  if (typeof compiledCss !== 'string' || /<\/style/i.test(compiledCss)) error('Invalid compiled stylesheet');
  const open = (node: ElementNode): string => {
    const attrs: string[] = [];
    if (!parts?.has(node.id)) attrs.push(`data-divlet-id="${escapeAttribute(node.id)}"`);
    const ref = instances?.get(node.id);
    if (ref) attrs.push(`data-divlet-ref="${escapeAttribute(ref)}"`);
    for (const [key, value] of Object.entries(node.attrs)) attrs.push(`${key}="${escapeAttribute(value)}"`);
    if (node.className) attrs.push(`class="${escapeAttribute(node.className)}"`);
    const style = serializeDeclarations(Object.entries(node.style));
    if (style) attrs.push(`style="${escapeAttribute(style)}"`);
    return `<${node.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}`;
  };
  const inline = (id: NodeId): string => {
    const node = need(doc, id);
    if (node.type === 'text') return escapeText(node.content);
    if (node.type !== 'element') error(`${id} is an instance; expand the frame before rendering it`);
    if (VOID_TAGS.has(node.tag)) return `${open(node)}>`;
    if (node.tag === 'textarea') {
      const child = node.children[0];
      let text = child ? (need(doc, child) as { content: string }).content : '';
      if (text.startsWith('\n')) text = '\n' + text;
      return `${open(node)}>${escapeText(text)}</textarea>`;
    }
    return `${open(node)}>${node.children.map(inline).join('')}</${node.tag}>`;
  };
  // Each block returns its markup without the final ">" — the next line break closes it.
  const block = (id: NodeId, depth: number): string => {
    const node = doc.nodes[id] as any;
    const hasElements = node.type === 'element' && !['pre', 'textarea', 'svg'].includes(node.tag) && node.children.some((child: NodeId) => (doc.nodes[child] as any).type === 'element');
    const mixed = hasElements && node.children.some((child: NodeId) => (doc.nodes[child] as any).type === 'text');
    if (!hasElements || mixed) return inline(id).slice(0, -1);
    const indent = (level: number): string => '\n' + '  '.repeat(level);
    return `${open(node)}${node.children.map((child: NodeId) => `${indent(depth + 1)}>${block(child, depth + 1)}`).join('')}${indent(depth)}></${node.tag}`;
  };
  const tokens = Object.entries(doc.tokens).map(([name, value]) => `${name}:${value};`).join('');
  const body = `<body\n>${block(doc.rootId, 0)}\n></body>`;
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeText(doc.name)}</title>\n${tokens ? `<style>:root{${tokens}}</style>\n` : ''}${doc.css ? `<style>${layered(doc.css)}</style>\n` : ''}${compiledCss ? `<style>${compiledCss}</style>\n` : ''}</head>\n${body}</html>\n`;
}

function attr(node: P5Node, name: string): string | undefined {
  return node.attrs?.find((item: P5Node) => item.name === name)?.value;
}

function parseInlineStyle(value: string): Record<string, string> {
  let root: postcss.Root;
  try { root = postcss.parse(`div{${value}}`); } catch (cause) { const reason = cause as { reason?: string; message: string }; error(`Invalid inline style: ${reason.reason || reason.message}`); }
  const rule = root.first as postcss.Rule | undefined;
  if (root.nodes.length !== 1 || rule?.type !== 'rule' || rule.selector !== 'div') error('Inline style escapes its declaration block');
  const style: Record<string, string> = {};
  for (const node of (rule as postcss.Rule).nodes as postcss.Declaration[]) {
    if (node.type !== 'decl') error('Inline style supports declarations only');
    if (Object.hasOwn(style, node.prop)) error(`Duplicate inline style property: ${node.prop}`);
    style[node.prop] = node.value + (node.important ? ' !important' : '');
  }
  return style;
}

export function decodeHtml(source: unknown, { fallbackId = 'imported', previous, limits = LIMITS }: DecodeOptions = {}): DocumentModel {
  documentLimits(limits);
  if (typeof source !== 'string' || Buffer.byteLength(source) > LIMITS.bytes * 2) error('HTML must be a string of at most 4 MiB');
  const html = source;
  const prior = previous ? validateDocument(previous, { limits }) : null;
  const parseErrors: any[] = [];
  const tree: P5Node = parse(html, { sourceCodeLocationInfo: true, onParseError: (value: any) => parseErrors.push(value) });
  const relevantErrors = parseErrors.filter(item => item.code !== 'missing-doctype');
  if (relevantErrors.length) {
    const first = relevantErrors[0];
    error(`Malformed HTML at line ${first.startLine}:${first.startCol}: ${first.code}`, { line: first.startLine, column: first.startCol, errors: relevantErrors.slice(0, 10) });
  }
  const elements: P5Node[] = [];
  const sourceRanges: Array<[number, number]> = [];
  function walk(node: P5Node, parent?: P5Node): void {
    if (node.tagName) elements.push(node);
    const location = node.sourceCodeLocation;
    if (location) {
      for (const part of [location.startTag, location.endTag]) if (part) sourceRanges.push([part.startOffset, part.endOffset]);
      if (node.nodeName === '#comment' || node.nodeName === '#documentType' || (node.nodeName === '#text' && ['style', 'script', 'textarea', 'title'].includes(parent?.tagName))) sourceRanges.push([location.startOffset, location.endOffset]);
      if (location.startTag && html.slice(location.startTag.startOffset, location.startTag.endOffset).startsWith('</')) error('Closing tag used as an opening tag');
    }
    for (const child of node.childNodes ?? []) walk(child, node);
    if (node.content) walk(node.content, node);
  }
  walk(tree);
  sourceRanges.sort((a, b) => a[0] - b[0]);
  let range = 0;
  for (const match of html.matchAll(/<\/?[A-Za-z]/g)) {
    while (range < sourceRanges.length && (sourceRanges[range] as [number, number])[1] <= (match.index as number)) range++;
    if (range === sourceRanges.length || (sourceRanges[range] as [number, number])[0] > (match.index as number)) {
      const before = html.slice(0, match.index).split('\n');
      error(`HTML contains ignored or misplaced markup at line ${before.length}:${(before.at(-1) as string).length + 1}`, { offset: match.index, line: before.length, column: (before.at(-1) as string).length + 1 });
    }
  }
  for (const node of elements) {
    const location = node.sourceCodeLocation;
    if (location && !VOID_TAGS.has(node.tagName) && !['meta', 'base', 'link', 'embed', 'param'].includes(node.tagName) && !location.endTag) {
      const selfClosedForeign = node.namespaceURI !== HTML_NS && /\/\s*>$/.test(html.slice(location.startOffset, location.endOffset));
      if (!selfClosedForeign) error(`Missing closing tag for <${node.tagName}> opened at line ${location.startLine}:${location.startCol}`, { line: location.startLine, column: location.startCol });
    }
    if (['html', 'head', 'body'].includes(node.tagName) && node.namespaceURI !== HTML_NS) error('Unsupported document namespace');
  }
  const htmlNode: P5Node = (tree.childNodes as P5Node[]).find((node: P5Node) => node.tagName === 'html');
  const head: P5Node = htmlNode?.childNodes.find((node: P5Node) => node.tagName === 'head');
  const body: P5Node = htmlNode?.childNodes.find((node: P5Node) => node.tagName === 'body');
  if (!body) error('HTML body is missing');
  for (const attribute of htmlNode.attrs ?? []) if (attribute.name !== 'lang' || attribute.value !== 'en') error(`Unsupported html wrapper attribute: ${attribute.name}. Put render attributes on the root element.`, undefined, 'UNSUPPORTED_HTML');
  if (head?.attrs?.length) error('Head attributes are not supported', undefined, 'UNSUPPORTED_HTML');
  for (const attribute of body.attrs ?? []) if (attribute.name !== 'data-divlet-root') error(`Unsupported body wrapper attribute: ${attribute.name}. Put render attributes on the root element.`, undefined, 'UNSUPPORTED_HTML');
  let manifest: any;
  let css = '';
  let title: string | undefined;
  const tokens: Record<string, string> = {};
  let tokenStyleSeen = false;
  for (const node of head?.childNodes ?? []) {
    if (node.nodeName === '#text' && !node.value.trim()) continue;
    if (node.tagName === 'script' && attr(node, 'id') === META_ID && attr(node, 'type') === 'application/json') {
      for (const attribute of node.attrs) if (!['id', 'type'].includes(attribute.name)) error(`Unsupported metadata script attribute: ${attribute.name}`);
      if (manifest) error('Duplicate divlet metadata');
      try { manifest = JSON.parse(node.childNodes.map((child: P5Node) => child.value ?? '').join('')); } catch { error('Invalid divlet metadata JSON'); }
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) error('Divlet metadata must be an object');
      const allowed = new Set('schemaVersion id name version artboard metadata nodeMetadata textIds'.split(' '));
      for (const key of Object.keys(manifest)) if (!allowed.has(key)) error(`Unsupported divlet metadata field: ${key}`);
      continue;
    }
    if (node.tagName === 'style') {
      for (const attribute of node.attrs) if (!['data-divlet-tokens', 'data-divlet-custom', 'data-divlet-compiled'].includes(attribute.name) && !(attribute.name === 'type' && attribute.value === 'text/css')) error(`Unsupported stylesheet attribute: ${attribute.name}`, undefined, 'UNSUPPORTED_HTML');
      const text = node.childNodes.map((child: P5Node) => child.value ?? '').join('');
      if (attr(node, 'data-divlet-compiled') !== undefined) continue;
      if (attr(node, 'data-divlet-tokens') !== undefined) {
        if (tokenStyleSeen) error('Duplicate token stylesheet');
        tokenStyleSeen = true;
        let parsed;
        try { parsed = postcss.parse(text); } catch { error('Invalid token stylesheet'); }
        for (const rule of parsed.nodes) {
          if (rule.type !== 'rule' || rule.selector !== ':root') error('Token stylesheet only supports :root declarations');
          for (const declaration of rule.nodes) {
            if (declaration.type !== 'decl' || !declaration.prop.startsWith('--')) error('Token stylesheet only supports custom properties');
            if (Object.hasOwn(tokens, declaration.prop)) error('Duplicate token');
            tokens[declaration.prop] = declaration.value + (declaration.important ? ' !important' : '');
          }
        }
      } else css += (css ? '\n' : '') + (attr(node, 'data-divlet-custom') !== undefined ? unlayer(text) : text);
      continue;
    }
    if (node.tagName === 'title') {
      if (node.attrs.length) error('Title attributes are not supported', undefined, 'UNSUPPORTED_HTML');
      if (title !== undefined) error('Duplicate title');
      title = node.childNodes.map((child: P5Node) => child.value ?? '').join('');
      continue;
    }
    if (node.tagName === 'meta' && attr(node, 'charset')?.toLowerCase() === 'utf-8' && node.attrs.length === 1) continue;
    if (node.tagName === 'meta' && attr(node, 'name') === 'viewport' && attr(node, 'content') === 'width=device-width, initial-scale=1' && node.attrs.length === 2) continue;
    error(`Unsupported head content: ${node.tagName || node.nodeName}`);
  }
  for (const node of elements) if (node.tagName === 'script' && !head?.childNodes.includes(node)) error('Executable scripts are not supported', undefined, 'UNSUPPORTED_HTML');
  const ids = new Set<string>();
  const reserved = new Set<string>();
  for (const node of elements) {
    const id = attr(node, 'data-divlet-id');
    if (id !== undefined) {
      if (!ID.test(id) || reserved.has(id)) error(`Duplicate or invalid node id: ${id}`);
      reserved.add(id);
    }
  }
  for (const node of elements) for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#comment' && child.data.startsWith('divlet:text:')) {
      const id = child.data.slice('divlet:text:'.length);
      if (!ID.test(id) || reserved.has(id)) error(`Duplicate or invalid text id: ${id}`);
      reserved.add(id);
    }
  }
  let serial = 0;
  function allocate(prefix: string): string {
    let id;
    do { id = `${prefix}-${++serial}`; } while (reserved.has(id) || ids.has(id));
    return id;
  }
  function claim(id: string): string {
    if (typeof id !== 'string' || !ID.test(id) || ids.has(id)) error(`Duplicate or invalid node id: ${id}`);
    ids.add(id);
    return id;
  }
  const nodes: Record<NodeId, any> = {};
  const storedMetadata: Record<string, any> = manifest?.nodeMetadata ?? Object.fromEntries(Object.values(prior?.nodes ?? {}).map(node => [(node as any).id, (node as any).metadata]));
  if (!storedMetadata || typeof storedMetadata !== 'object' || Array.isArray(storedMetadata)) error('nodeMetadata must be an object');
  const textareaTextIds: Record<string, string> = manifest?.textIds ?? Object.fromEntries(Object.values(prior?.nodes ?? {}).filter(node => (node as any).type === 'element' && (node as any).tag === 'textarea' && (node as any).children.length).map(node => [(node as any).id, (node as any).children[0]]));
  if (!textareaTextIds || typeof textareaTextIds !== 'object' || Array.isArray(textareaTextIds)) error('textIds must be an object');
  function textNode(content: string, id: string = allocate('text')): string {
    claim(id);
    nodes[id] = { id, type: 'text', content, metadata: Object.hasOwn(storedMetadata, id) ? storedMetadata[id] : {} };
    return id;
  }
  function readChildren(children: P5Node[]): NodeId[] {
    const result = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeName === '#comment') {
        if (!child.data.startsWith('divlet:text:')) error('Only divlet text-boundary comments are supported');
        const id = child.data.slice('divlet:text:'.length);
        let content = '';
        let closed = false;
        for (++i; i < children.length; i++) {
          const part = children[i];
          if (part.nodeName === '#comment' && part.data === `/divlet:text:${id}`) { closed = true; break; }
          if (part.nodeName !== '#text') error(`Invalid text boundary: ${id}`);
          content += part.value;
        }
        if (!closed) error(`Unclosed text boundary: ${id}`);
        result.push(textNode(content, id));
      } else if (child.nodeName === '#text') result.push(textNode(child.value));
      else if (child.tagName) result.push(readElement(child));
      else error(`Unsupported body content: ${child.nodeName}`);
    }
    return result;
  }
  function readElement(node: P5Node): NodeId {
    const declared = attr(node, 'data-divlet-id');
    const naturalId = attr(node, 'id');
    const id = claim(declared ?? (naturalId && ID.test(naturalId) && !reserved.has(naturalId) && !ids.has(naturalId) ? naturalId : allocate('node')));
    const attrs: Record<string, string> = {};
    let className = '';
    let style: Record<string, string> = {};
    for (const item of node.attrs ?? []) {
      const name = item.prefix ? `${item.prefix}:${item.name}` : item.name;
      if (name === 'data-divlet-id' || name === 'data-divlet-in' || name === 'data-divlet-at' || name === 'data-divlet-ref') continue;
      if (name === 'class') className = item.value;
      else if (name === 'style') style = parseInlineStyle(item.value);
      else attrs[name] = item.value;
    }
    nodes[id] = { id, type: 'element', tag: node.tagName, attrs, className, style, metadata: Object.hasOwn(storedMetadata, id) ? storedMetadata[id] : {}, children: [] };
    if (node.tagName === 'textarea') {
      const content = node.childNodes.map((child: P5Node) => child.value ?? '').join('');
      const hinted = Object.hasOwn(textareaTextIds, id) ? textareaTextIds[id] : undefined;
      if (hinted !== undefined || content) nodes[id].children.push(textNode(content, hinted));
    } else nodes[id].children = readChildren(node.childNodes ?? []);
    return id;
  }
  const significant = body.childNodes.filter((node: P5Node) => node.nodeName !== '#text' || node.value.trim());
  let rootId: NodeId;
  if (significant.length === 1 && significant[0].tagName) rootId = readElement(significant[0]);
  else {
    rootId = claim(allocate('root'));
    nodes[rootId] = { id: rootId, type: 'element', tag: 'div', attrs: {}, className: '', style: {}, metadata: {}, children: readChildren(body.childNodes) };
  }
  const fallback = String(fallbackId).replace(/[^A-Za-z0-9_.:-]/g, '-').replace(/^[^A-Za-z]+/, '').slice(0, 96) || 'imported';
  return validateDocument({ schemaVersion: manifest?.schemaVersion ?? 1, id: manifest?.id ?? prior?.id ?? fallback, name: title ?? manifest?.name ?? prior?.name ?? fallback, version: manifest?.version ?? prior?.version ?? 1, artboard: manifest?.artboard ?? prior?.artboard ?? { x: 80, y: 100, width: 960, height: 720 }, rootId, tokens, css, metadata: manifest?.metadata ?? prior?.metadata ?? {}, nodes }, { limits });
}
