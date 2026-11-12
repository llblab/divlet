/*
 * Owns: portable declared-asset paths, explicit URI syntax and relative dependency URLs.
 * Excludes: project admission, byte decoding, dependency traversal and publication.
 */
import { DivletError, withinUtf8Budget } from './validation.ts';

export const ASSET_REFERENCE_LIMITS = Object.freeze({ path: 2048, depth: 64, segmentBytes: 255, suffix: 2048, encoded: 6 + 2048 * 12 + 2048 });
/** A decoded authored path and an opaque per-use query/fragment; the suffix never participates in asset lookup. */
export interface AssetReference { readonly path: string; readonly suffix: string }
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
function fail(message: string): never { throw new DivletError('INVALID_ASSET', message); }

/** One declared tree key, with the same portable rules at storage and reference boundaries. */
export function validateAssetName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !name || !name.isWellFormed() || name.startsWith('.') || reserved.has(name) || /[\u0000-\u001f\u007f/\\<>:"|?*]/.test(name) || /[. ]$/.test(name) || !withinUtf8Budget(name, ASSET_REFERENCE_LIMITS.segmentBytes) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) fail('Invalid asset path component.');
}

export function validateAssetPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length > ASSET_REFERENCE_LIMITS.path) fail('Asset path exceeds the supported text profile.');
  const names = path.split('/');
  if (names.length > ASSET_REFERENCE_LIMITS.depth + 1) fail('Asset path exceeds the directory-depth limit.');
  for (const name of names) validateAssetName(name);
}

const encodeName = (name: string): string => encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
function validateSuffix(suffix: unknown): asserts suffix is string {
  if (typeof suffix !== 'string' || suffix.length > ASSET_REFERENCE_LIMITS.suffix || !/^(?:\?[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*)?(?:#[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*)?$/.test(suffix) || /%(?![0-9a-f]{2})/i.test(suffix)) fail('Invalid asset reference query or fragment.');
}

/** Encode an exact declared path; no Unicode normalization, alias interning or filesystem interpretation. */
export function assetReference(path: unknown, suffix: unknown = ''): string {
  validateAssetPath(path);
  validateSuffix(suffix);
  return `asset:${path.split('/').map(encodeName).join('/')}${suffix}`;
}

/** Recognize only the explicit scheme. Ordinary file/network URLs and literal Data URLs remain outside this codec. */
export function readAssetReference(input: unknown): AssetReference | null {
  if (typeof input !== 'string') fail('An asset reference must be text.');
  if (!/^\s*asset:/i.test(input)) return null;
  if (!input.startsWith('asset:') || input.length > ASSET_REFERENCE_LIMITS.encoded) fail('An asset reference must use the bounded canonical asset: form.');
  const body = input.slice(6), at = body.search(/[?#]/);
  const encoded = at < 0 ? body : body.slice(0, at), suffix = at < 0 ? '' : body.slice(at);
  let path: string;
  try { path = decodeURIComponent(encoded); } catch { fail('Invalid asset reference path encoding.'); }
  // Re-encoding also refuses encoded separators: a decoded slash must have been a literal directory separator.
  if (assetReference(path, suffix) !== input) fail('Asset reference path encoding is not canonical.');
  return { path, suffix };
}

/** Resolve a relative URL inside a declared text asset, never against a filesystem or network base. */
export function resolveAssetDependency(basePath: unknown, input: unknown): string {
  validateAssetPath(basePath);
  if (typeof input !== 'string' || input.length > ASSET_REFERENCE_LIMITS.encoded || input !== input.trim() || /[\\\u0000-\u001f\u007f]/.test(input)) fail('Invalid relative asset dependency.');
  const explicit = readAssetReference(input);
  if (explicit) return input;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(input)) fail('Asset dependencies require a declared or relative URL.');
  const at = input.search(/[?#]/), pathname = at < 0 ? input : input.slice(0, at), suffix = at < 0 ? '' : input.slice(at);
  if (!pathname) return assetReference(basePath, suffix);
  const names = basePath.split('/');
  names.pop();
  for (const name of pathname.split('/')) {
    if (name === '.') continue;
    if (name === '..') { if (!names.length) fail('Asset dependency escapes its declared namespace.'); names.pop(); continue; }
    let decoded: string;
    try { decoded = decodeURIComponent(name); } catch { fail('Invalid asset dependency path encoding.'); }
    validateAssetName(decoded);
    names.push(decoded);
  }
  return assetReference(names.join('/'), suffix);
}
