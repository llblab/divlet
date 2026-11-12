// Owns bounded, self-contained font CSS for browser snapshots; not rasterization, publication or general filesystem access.
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import postcss from 'postcss';
import type { ChildNode } from 'postcss';
import valueParser from 'postcss-value-parser';
import path from 'node:path';
import { mediaTypeForExtension } from './media-type.ts';
import { decodeCss, cssString } from './css-literals.ts';
import { inlineDeclaredAssets } from './static.js';
import { DivletError, SOURCE_LIMITS } from './model.ts';
import type { AssetTree } from './model.ts';

function fail(): never { throw new DivletError('CAPTURE_UNAVAILABLE', 'This frame’s font resources cannot be embedded faithfully. Keep its live preview.'); }
function styles(html: string): string[] {
  const result: string[] = [];
  const walk = (node: DefaultTreeAdapterMap['node']): void => {
    if ('tagName' in node && node.tagName === 'link' && node.attrs.some(attr => attr.name === 'rel' && attr.value.toLowerCase().split(/\s+/).includes('stylesheet'))) fail();
    if ('tagName' in node && node.tagName === 'style') result.push(node.childNodes.map(child => 'value' in child ? child.value : '').join(''));
    if ('childNodes' in node) node.childNodes.forEach(walk);
  };
  walk(parse(html));
  return result;
}

/** The accepted public graph, never the disk-publication/repair plan or a filesystem resolver. */
export interface CaptureFontResources {
  readonly files: ReadonlyMap<string, string | Uint8Array>;
  readonly mediaTypes?: ReadonlyMap<string, string>;
  readonly documentPath: string;
}

export async function captureFontCSS(html: string, assets: AssetTree, resources?: CaptureFontResources): Promise<string> {
  const faces: string[] = [];
  for (const css of styles(html)) {
    const root = postcss.parse(css);
    root.walkAtRules(rule => {
      if (decodeCss(rule.name).toLowerCase() === 'import') fail();
      if (decodeCss(rule.name).toLowerCase() !== 'font-face') return;
      let wrapped: ChildNode = rule.clone();
      for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
        if (parent.type !== 'atrule') fail();
        const wrapper = parent.clone({ nodes: [] }); wrapper.append(wrapped); wrapped = wrapper;
      }
      faces.push(wrapped.toString());
    });
  }
  if (!faces.length) return '';
  // The shared export path resolves only explicit declarations and preserves MIME, bytes and literal Data URLs.
  // Images/unreferenced project leaves never enter this font-only closure.
  const embedded = await inlineDeclaredAssets(`<html><head><style>${faces.join('\n')}</style></head><body></body></html>`, assets);
  const css = styles(embedded).join('\n');
  let expandedBytes = Buffer.byteLength(css);
  if (expandedBytes > SOURCE_LIMITS.bytes) fail();
  const root = postcss.parse(css);
  root.walkDecls(decl => {
    const parsed = valueParser(decl.value);
    parsed.walk(node => {
      if (node.type === 'function' && decodeCss(node.value).toLowerCase() === 'url') {
        const nodes = node.nodes.filter(child => child.type !== 'space' && child.type !== 'comment');
        const first = nodes[0];
        if (node.unclosed || nodes.length !== 1 || !first || first.type !== 'string' && first.type !== 'word' || 'unclosed' in first && first.unclosed) fail();
        const value = decodeCss(first.value);
        if (!value.toLowerCase().startsWith('data:')) {
          if (!resources || !value || /^[a-z][a-z0-9+.-]*:|^\//i.test(value) || /[\\\\\0]/.test(value)) fail();
          const url = new URL(value, 'https://capture.invalid/' + resources.documentPath);
          if (/[?#]/.test(value)) fail(); // Even empty authored delimiters carry suffix semantics; URL.search/hash erase them.
          let key: string;
          try { key = decodeURIComponent(url.pathname.slice(1)); } catch { fail(); }
          if (!/^(?:_assets|assets)\//.test(key) || /[\\\\\0]/.test(key)) fail();
          const contents = resources.files.get(key);
          if (contents === undefined) fail();
          const length = typeof contents === 'string' ? Buffer.byteLength(contents) : contents.byteLength;
          const mediaType = resources.mediaTypes?.get(key) ?? mediaTypeForExtension(path.posix.extname(key).toLowerCase()) ?? 'application/octet-stream';
          const prefix = cssString('data:' + mediaType + ';base64,');
          // Reserve conservative total serialized growth before byte/base64 allocation; never scan unrelated graph entries.
          expandedBytes += Buffer.byteLength(prefix) + 4 * Math.ceil(length / 3) + 16;
          if (expandedBytes > SOURCE_LIMITS.bytes) fail();
          const bytes = typeof contents === 'string' ? Buffer.from(contents) : Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength);
          node.nodes = [{ ...first, type: 'string', quote: '"', value: prefix + bytes.toString('base64') }];
        }
        return false;
      }
      if (node.type === 'function' && ['var', 'env', 'attr'].includes(decodeCss(node.value).toLowerCase())) fail();
    });
    decl.value = parsed.toString();
  });
  return root.toString();
}
