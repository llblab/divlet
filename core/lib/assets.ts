// Owns native asset-tree admission and decoding, not project activation, URL rewriting or filesystem publication.
import { canonicalMediaType, MAX_MEDIA_TYPE } from './media-type.ts';
import { DivletError, SOURCE_LIMITS } from './model.ts';
import type { AssetFile, AssetTree } from './model.ts';
import { ASSET_REFERENCE_LIMITS, validateAssetName } from './asset-reference.ts';

/** Native payloads retain the existing 20 MiB resource ceiling and 32 MiB source envelope. */
export const ASSET_LIMITS = Object.freeze({ files: 400, fileBytes: 20 * 1024 * 1024, encodedBytes: SOURCE_LIMITS.bytes, nodes: SOURCE_LIMITS.nodes, depth: ASSET_REFERENCE_LIMITS.depth, path: ASSET_REFERENCE_LIMITS.path, mediaType: MAX_MEDIA_TYPE });
export interface ParsedAssets { readonly tree: AssetTree; readonly files: ReadonlyMap<string, AssetFile> }
export interface AssetText { readonly kind: 'css' | 'svg'; readonly text: string; readonly ascii: boolean }

/** Compare validated names/paths for portable collisions; never rewrite their authored spelling or identity. */
export function assetCollisionKey(value: string): string { return value.normalize('NFC').toLowerCase(); }

/** Interpret declared text by MIME, not its filename; unsupported encodings must not be silently transcoded. */
export function readAssetText(file: AssetFile): AssetText | null {
  const mime = canonicalMediaType(file.mediaType);
  if (!mime) fail('Asset text requires a canonical media type.');
  const kind = mime.essence === 'text/css' ? 'css' : mime.essence === 'image/svg+xml' ? 'svg' : null;
  if (['text/html', 'application/xhtml+xml'].includes(mime.essence)) fail('Declared HTML asset closure is not supported.');
  if (!kind) return null;
  const charset = mime.params.get('charset')?.toLowerCase();
  if (charset && !['utf-8', 'us-ascii'].includes(charset)) fail('Declared text assets require UTF-8 or US-ASCII.');
  if (charset === 'us-ascii' && file.bytes.some(byte => byte > 127)) fail('A US-ASCII asset contains non-ASCII bytes.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); } catch { fail('Declared text assets contain invalid UTF-8.'); }
  const encoding = kind === 'css' ? /^@charset\s+['"]([^'"]+)['"]\s*;/i.exec(text)?.[1] : /^\s*<\?xml\b[^?]*\bencoding\s*=\s*['"]([^'"]+)['"]/i.exec(text)?.[1];
  if (encoding && !['utf-8', 'us-ascii'].includes(encoding.toLowerCase())) fail('Declared text asset encoding conflicts with its UTF-8 interpretation.');
  if (encoding?.toLowerCase() === 'us-ascii' && file.bytes.some(byte => byte > 127)) fail('A US-ASCII asset contains non-ASCII bytes.');
  return { kind, text, ascii: charset === 'us-ascii' || encoding?.toLowerCase() === 'us-ascii' };
}
function fail(message: string): never { throw new DivletError('INVALID_ASSET', message); }

function directory(input: unknown, where: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(`${where} must be an asset directory object.`);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${where} must contain only enumerable JSON data properties.`);
  }
  return input as Record<string, unknown>;
}

function decode(value: string, where: string): AssetFile {
  const comma = value.indexOf(',');
  if (!value.startsWith('data:') || comma < 0 || value.slice(comma - 7, comma) !== ';base64') fail(`${where} must be a canonical base64 Data URL.`);
  const mediaType = value.slice(5, comma - 7);
  if (!canonicalMediaType(mediaType) || mediaType.includes('#')) fail(`${where} must use a canonical Data-URL media type without discarded parameters or a fragment delimiter.`);
  const payload = value.slice(comma + 1), padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const size = payload.length / 4 * 3 - padding;
  if (size > ASSET_LIMITS.fileBytes) fail(`${where} exceeds the ${ASSET_LIMITS.fileBytes} decoded-byte limit.`);
  if (payload.length % 4 || /[^A-Za-z0-9+/=]/.test(payload) || payload.slice(0, payload.length - padding).includes('=')) fail(`${where} has invalid base64 data.`);
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.toString('base64') !== payload) fail(`${where} has noncanonical base64 data.`);
  return { mediaType, bytes };
}

/** Validate a detached source tree and decode bounded leaves once; named aliases and literal input are never rewritten. */
export function readAssets(input: unknown): ParsedAssets { return readTree(input, false); }
/** Check nullable sparse patches before merge, including names on deleted paths. */
export function validateAssetPatch(input: unknown): void { readTree(input, true); }
function readTree(input: unknown, deletions: boolean): ParsedAssets {
  const files = new Map<string, AssetFile>(), paths = new Set<string>(), active = new Set<object>();
  let encodedBytes = 0, nodes = 0;
  const visit = (input: unknown, parent: string, depth: number): AssetTree => {
    if (depth > ASSET_LIMITS.depth) fail('Asset directories exceed the depth limit.');
    const source = directory(input, parent || 'assets');
    if (active.has(source)) fail('Asset directories must not contain cycles.');
    active.add(source);
    const tree: AssetTree = {};
    for (const [name, value] of Object.entries(source)) {
      if (++nodes > ASSET_LIMITS.nodes) fail('Asset directories exceed the entry limit.');
      validateAssetName(name);
      const relative = parent ? `${parent}/${name}` : name;
      if (relative.length > ASSET_LIMITS.path) fail('Asset paths exceed the path-length limit.');
      const portable = assetCollisionKey(relative);
      if (paths.has(portable)) fail(`Asset paths alias on a portable filesystem: ${relative}.`);
      paths.add(portable);
      encodedBytes += Buffer.byteLength(name) + (typeof value === 'string' ? value.length : 0);
      if (encodedBytes > ASSET_LIMITS.encodedBytes) fail('Assets exceed the encoded-byte limit.');
      if (value === null && deletions) continue;
      if (typeof value === 'string') {
        if (files.size >= ASSET_LIMITS.files) fail('Assets exceed the file-count limit.');
        files.set(relative, decode(value, relative));
        tree[name] = value;
      } else tree[name] = visit(value, relative, depth + 1);
    }
    active.delete(source);
    return tree;
  };
  return { tree: visit(input, '', 0), files };
}
