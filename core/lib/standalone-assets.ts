/*
 * Owns: single-file HTML projection of declared bytes, recursive inline closure and export refusals.
 * Excludes: project admission, legacy filesystem resources, storage/publication and browser capability activation.
 */
import { readAssets, readAssetText } from './asset-data.ts';
import { encodeAssetBase64 } from './asset-base64.ts';
import { readAssetReference, resolveAssetDependency } from './asset-reference.ts';
import { DivletError } from './validation.ts';
import { rewriteCss, rewriteHtml } from './resource-carriers.ts';
import type { ResourceContext } from './resource-carriers.ts';
import { rewriteSvgResource } from './svg-resource.ts';

const MAX_TOTAL = 64 * 1024 * 1024;
/** Legacy URLs and literal Data URLs retain authored meaning; only explicit declarations are embedded. */
export async function inlineDeclaredAssets(html: string, assets: unknown, { fragment = false }: { fragment?: boolean } = {}): Promise<string> {
  const parsed = readAssets(assets ?? {});
  if (!parsed.files.size) return html;
  if (typeof html !== 'string') throw new TypeError('Standalone HTML must be text.');
  const completed = new Map<string, string>(), encoder = new TextEncoder();
  let work = encoder.encode(html).byteLength;
  const limit = (): never => { throw new DivletError('FILE_TOO_LARGE', 'Standalone HTML exceeds its resource byte budget; save a project copy instead.'); };
  async function fileUrl(key: string, stack: readonly string[]): Promise<string> {
    if (stack.includes(key)) throw new DivletError('UNSUPPORTED_EXPORT', 'Cyclic declared resources require a project/bundle copy, not one HTML file.');
    if (completed.has(key)) return completed.get(key)!;
    const file = parsed.files.get(key);
    if (!file) throw new DivletError('INVALID_ASSET', 'Missing declared resource during export.');
    const text = readAssetText(file), next = [...stack, key];
    const rewrite = (value: string) => url(value, next, key);
    const bytes = text ? encoder.encode(text.kind === 'css' ? await rewriteCss(text.text, rewrite, false, true) : await rewriteSvgResource(text.text, { url: rewrite, css: (css, inline) => rewriteCss(css, rewrite, inline, true) })) : file.bytes;
    if (text?.ascii && bytes.some(byte => byte > 127)) throw new DivletError('INVALID_ASSET', 'Inlining this asset would violate its US-ASCII encoding.');
    const result = `data:${file.mediaType};base64,${encodeAssetBase64(bytes)}`;
    completed.set(key, result);
    return result;
  }
  async function url(value: string, stack: readonly string[] = [], base?: string, context?: ResourceContext): Promise<string> {
    let reference = readAssetReference(value);
    if (!reference && base && value && !value.startsWith('#') && !/^(?:data:|https?:|\/\/)/i.test(value)) reference = readAssetReference(resolveAssetDependency(base, value));
    if (!reference) return value;
    if (reference.suffix.startsWith('?') || context?.tag === 'use') throw new DivletError('UNSUPPORTED_EXPORT', 'This resource URL requires a project/bundle copy to retain its query or SVG-use semantics.');
    const result = await fileUrl(reference.path, stack) + reference.suffix;
    if ((work += result.length + 5 * (result.match(/[<&"\\]/g)?.length || 0)) > MAX_TOTAL) limit();
    return result;
  }
  const result = await rewriteHtml(html, (value, context) => url(value, [], undefined, context), fragment);
  if (encoder.encode(result).byteLength > MAX_TOTAL) limit();
  return result;
}
