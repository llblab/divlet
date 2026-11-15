// Node-only compatibility oracle: verbatim Buffer-based exporter captured from aa1be27 core/lib/static.js.
import { Buffer } from 'node:buffer';
import { readAssets, readAssetText } from '../../lib/assets.ts';
import { readAssetReference, resolveAssetDependency } from '../../lib/asset-reference.ts';
import { DivletError } from '../../lib/validation.ts';
import { rewriteCss, rewriteHtml } from '../../lib/resource-carriers.ts';
import { rewriteSvgResource } from '../../lib/svg-resource.ts';
const MAX_TOTAL = 64 * 1024 * 1024;

export async function nativeInlineDeclaredAssets(html, assets, { fragment = false } = {}) {
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
