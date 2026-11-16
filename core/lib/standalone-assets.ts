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
/** Embed explicit declarations only. A caller may lower closure work/output bounds; the no-files path stays an exact no-op. */
export async function inlineDeclaredAssets(html: string, assets: unknown, { fragment = false, maxWorkBytes }: { fragment?: boolean; maxWorkBytes?: number } = {}): Promise<string> {
  const parsed = readAssets(assets ?? {}), budget = maxWorkBytes === undefined ? MAX_TOTAL : maxWorkBytes;
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > MAX_TOTAL) throw new DivletError('INVALID_ASSET', `Resource projection work budget must be an integer from 0 to ${MAX_TOTAL} bytes.`);
  if (!parsed.files.size) return html;
  if (typeof html !== 'string') throw new TypeError('Standalone HTML must be text.');
  const completed = new Map<string, string>(), encoder = new TextEncoder();
  let work = encoder.encode(html).byteLength;
  const limit = (): never => { throw new DivletError('FILE_TOO_LARGE', 'Standalone HTML exceeds its resource byte budget; save a project copy instead.'); };
  // A requested bound covers the input charge too; keep the original default's normalization path unchanged.
  if (maxWorkBytes !== undefined && work > budget) limit();
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
    if ((work += result.length + 5 * (result.match(/[<&"\\]/g)?.length || 0)) > budget) limit();
    return result;
  }
  const result = await rewriteHtml(html, (value, context) => url(value, [], undefined, context), fragment);
  if (encoder.encode(result).byteLength > budget) limit();
  return result;
}
