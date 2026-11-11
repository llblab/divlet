// Owns native asset-tree admission and decoding, not project activation, URL rewriting or filesystem publication.
import { MIMEType } from 'node:util';
import { DivletError, SOURCE_LIMITS } from './model.ts';
import type { AssetFile, AssetTree } from './model.ts';

/** Native payloads retain the existing 20 MiB resource ceiling and 32 MiB source envelope. */
export const ASSET_LIMITS = Object.freeze({ files: 400, fileBytes: 20 * 1024 * 1024, encodedBytes: SOURCE_LIMITS.bytes, nodes: SOURCE_LIMITS.nodes, depth: SOURCE_LIMITS.depth, path: 2048, mediaType: 1024 });
export interface ParsedAssets { readonly tree: AssetTree; readonly files: ReadonlyMap<string, AssetFile> }
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
function fail(message: string): never { throw new DivletError('INVALID_ASSET', message); }

function directory(input: unknown, where: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(`${where} must be an asset directory object.`);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${where} must contain only enumerable JSON data properties.`);
  }
  return input as Record<string, unknown>;
}

function segment(name: string): void {
  // One tree key is one portable filesystem component; URL escaping happens at the reference boundary.
  if (!name || !name.isWellFormed() || name.startsWith('.') || reserved.has(name) || /[\u0000-\u001f\u007f/\\<>:"|?*]/.test(name) || /[. ]$/.test(name) || Buffer.byteLength(name) > 255 || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) fail(`Invalid asset key: ${JSON.stringify(name)}.`);
}

function decode(value: string, where: string): AssetFile {
  const comma = value.indexOf(',');
  if (!value.startsWith('data:') || comma < 0 || value.slice(comma - 7, comma) !== ';base64') fail(`${where} must be a canonical base64 Data URL.`);
  const mediaType = value.slice(5, comma - 7);
  if (!mediaType || mediaType.length > ASSET_LIMITS.mediaType || /[^\x20-\x7e]/.test(mediaType)) fail(`${where} has an invalid media type.`);
  let parsed: MIMEType;
  try { parsed = new MIMEType(mediaType); } catch { fail(`${where} has an invalid media type.`); }
  // MIMEType is deliberately forgiving; require exact serialization so malformed parameters are not silently discarded.
  if (parsed.toString() !== mediaType) fail(`${where} must use a canonical media type without discarded parameters.`);
  const payload = value.slice(comma + 1), padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const size = payload.length / 4 * 3 - padding;
  if (size > ASSET_LIMITS.fileBytes) fail(`${where} exceeds the ${ASSET_LIMITS.fileBytes} decoded-byte limit.`);
  if (payload.length % 4 || /[^A-Za-z0-9+/=]/.test(payload) || payload.slice(0, payload.length - padding).includes('=')) fail(`${where} has invalid base64 data.`);
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.toString('base64') !== payload) fail(`${where} has noncanonical base64 data.`);
  return { mediaType, bytes };
}

/** Validate a detached source tree and decode bounded leaves once; named aliases and literal input are never rewritten. */
export function readAssets(input: unknown): ParsedAssets {
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
      segment(name);
      const relative = parent ? `${parent}/${name}` : name;
      if (relative.length > ASSET_LIMITS.path) fail('Asset paths exceed the path-length limit.');
      const portable = relative.normalize('NFC').toLowerCase();
      if (paths.has(portable)) fail(`Asset paths alias on a portable filesystem: ${relative}.`);
      paths.add(portable);
      encodedBytes += Buffer.byteLength(name) + (typeof value === 'string' ? value.length : 0);
      if (encodedBytes > ASSET_LIMITS.encodedBytes) fail('Assets exceed the encoded-byte limit.');
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
