// Owns bounded, self-contained font CSS for browser snapshots; not rasterization, publication or general filesystem access.
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import postcss from 'postcss';
import type { ChildNode } from 'postcss';
import valueParser from 'postcss-value-parser';
import { inlineDeclaredAssets } from './static.js';
import { decodeCss } from './css-literals.ts';
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

export async function captureFontCSS(html: string, assets: AssetTree): Promise<string> {
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
  if (Buffer.byteLength(css) > SOURCE_LIMITS.bytes) fail();
  postcss.parse(css).walkDecls(decl => {
    valueParser(decl.value).walk(node => {
      if (node.type === 'function' && decodeCss(node.value).toLowerCase() === 'url') {
        const nodes = node.nodes.filter(child => child.type !== 'space' && child.type !== 'comment');
        if (nodes.length !== 1 || !['string', 'word'].includes(nodes[0]!.type) || !decodeCss(nodes[0]!.value).toLowerCase().startsWith('data:')) fail();
        return false;
      }
      if (node.type === 'function' && decodeCss(node.value).toLowerCase() === 'var') fail();
    });
  });
  return css;
}
