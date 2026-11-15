// Domain: Resource carrier projection. Owns: HTML/CSS/srcset URL token rewrites and closed-source CSS refusal. Excludes: resolution, dependency graphs, filesystem access and publication.
import { parse, parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { decodeCss, cssString } from './css-literals.ts';
import { SVG_RESOURCE_ATTRIBUTES } from './svg-resource-attributes.ts';

export interface ResourceContext { readonly tag?: string; readonly attribute?: string }
export type ResourceRewrite = (value: string, context?: ResourceContext) => string | Promise<string>;
export type BaseRewrite = (base: string) => ResourceRewrite;
export type CssInspector = (root: postcss.Root) => void;
type HtmlNode = DefaultTreeAdapterMap['node'];

const literalCssFunctions = new Set('rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix calc min max clamp round mod rem abs sign sin cos tan asin acos atan atan2 pow sqrt hypot log exp linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient repeating-conic-gradient matrix matrix3d translate translateX translateY translateZ translate3d scale scaleX scaleY scaleZ scale3d rotate rotateX rotateY rotateZ rotate3d skew skewX skewY perspective blur brightness contrast drop-shadow grayscale hue-rotate invert opacity saturate sepia cubic-bezier steps format tech local'.toLowerCase().split(' '));
export const unsupportedSourceCss = (): never => { throw Object.assign(new Error('Canonical copy requires literal, fully understood CSS resource carriers; indirect or unsupported CSS was not relocated.'), { code: 'COPY_UNSUPPORTED_RESOURCE' }); };
function validateSourceCssValue(value: string, publicVariables = false): void {
  const parsed = valueParser(value);
  parsed.walk(node => {
    if ('unclosed' in node && node.unclosed) unsupportedSourceCss();
    if (node.type !== 'function') return;
    const name = decodeCss(node.value).toLowerCase();
    if (name === 'url') {
      const parts = node.nodes.filter(child => child.type !== 'space');
      if (parts.length === 1 && parts[0]!.type === 'string') {
        if (parts[0]!.unclosed || /[\r\n\f]/.test(parts[0]!.value)) unsupportedSourceCss();
      } else {
        const raw = valueParser.stringify(node.nodes).trim();
        if (!raw || /[\s()'"]/.test(raw) || node.nodes.some(child => child.type === 'function' || child.type === 'comment' || ('unclosed' in child && child.unclosed))) unsupportedSourceCss();
      }
      return false;
    }
    if (name === 'var' && publicVariables) return;
    if (!literalCssFunctions.has(name)) unsupportedSourceCss();
  });
}

/** Rewrites only URL tokens, never declaration selectors (including utility-class selectors). */
export async function rewriteCss(css: string, rewrite: ResourceRewrite, inline = false, closed = false, inspectSelectors?: CssInspector): Promise<string> {
  let root: postcss.Root;
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
  const jobs: Promise<void>[] = [];
  root.walkDecls((decl) => { jobs.push((async () => { decl.value = await values(decl.value); })()); });
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
  async function rewriteNodes(nodes: valueParser.Node[]): Promise<void> {
    for (const node of nodes) {
      if (node.type !== 'function') continue;
      if (decodeCss(node.value).toLowerCase() === 'url') {
        const raw = valueParser.stringify(node.nodes).trim();
        const url = node.nodes.length === 1 && node.nodes[0]!.type === 'string' ? node.nodes[0]!.value : raw;
        const result = await rewrite(decodeCss(url));
        node.nodes = [{ type: 'string', quote: '"', value: cssString(result) } as valueParser.StringNode];
      } else await rewriteNodes(node.nodes);
    }
  }
  async function values(value: string): Promise<string> {
    const parsed = valueParser(value);
    await rewriteNodes(parsed.nodes);
    return parsed.toString();
  }
  await Promise.all(jobs);
  return inline ? (root.first as postcss.Rule).nodes.map((node) => node.toString()).join(';') : root.toString();
}

export async function rewriteSrcset(value: string, rewrite: ResourceRewrite): Promise<string> {
  // URL tokens end at whitespace; trailing commas delimit candidates. Data URLs
  // retain their internal commas, per the HTML srcset tokenization algorithm.
  let result = '';
  let i = 0;
  while (i < value.length) {
    const leading = value.slice(i).match(/^[\s,]+/)?.[0] || '';
    result += leading;
    i += leading.length;
    if (i >= value.length) break;
    const token = value.slice(i).match(/^\S+/)![0];
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

export async function rewriteHtml(html: string, rewrite: ResourceRewrite, fragment = false, withBase?: BaseRewrite, closed = false, inspectSelectors?: CssInspector): Promise<string> {
  const tree = fragment ? parseFragment(html) : parse(html);
  if (withBase) {
    let effective: string | undefined;
    function find(node: HtmlNode): void {
      if ('tagName' in node && node.tagName === 'base') {
        const href = node.attrs?.find(attr => attr.name === 'href');
        if (href && effective === undefined) effective = href.value;
        node.attrs = node.attrs.filter(attr => attr.name !== 'href');
      }
      for (const child of 'childNodes' in node ? node.childNodes : []) find(child);
    }
    find(tree);
    if (effective !== undefined) rewrite = withBase(effective);
  }
  async function visit(node: HtmlNode): Promise<void> {
    for (const attr of 'attrs' in node ? node.attrs : []) {
      if (['src', 'href', 'poster'].includes(attr.name)) attr.value = await rewrite(attr.value, { tag: 'tagName' in node ? node.tagName : undefined, attribute: attr.name });
      else if (attr.name === 'srcset') attr.value = await rewriteSrcset(attr.value, rewrite);
      else if (attr.name === 'style') attr.value = await rewriteCss(attr.value, rewrite, true, closed, inspectSelectors);
      else if (SVG_RESOURCE_ATTRIBUTES.has(attr.name)) {
        const declaration = await rewriteCss(`x:${attr.value}`, rewrite, true, closed, inspectSelectors);
        attr.value = declaration.slice(declaration.indexOf(':') + 1);
      }
    }
    if ('tagName' in node && node.tagName === 'style') {
      for (const child of node.childNodes) if (child.nodeName === '#text' && 'value' in child) child.value = await rewriteCss(child.value, rewrite, false, closed, inspectSelectors);
    } else for (const child of 'childNodes' in node ? node.childNodes : []) await visit(child);
    if ('content' in node) await visit(node.content);
  }
  await visit(tree);
  return serialize(tree);
}
