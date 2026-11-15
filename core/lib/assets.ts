// Domain: Native asset compatibility. Owns: Buffer views over shared validated data. Excludes: alternate admission, rewriting and publication.
import { Buffer } from 'node:buffer';
import { readAssets as readAssetData, validateAssetPatch as validateAssetDataPatch } from './asset-data.ts';
import type { ParsedAssets } from './asset-data.ts';
export { ASSET_LIMITS, assetCollisionKey, allocateAssetLeaf, readAssetText } from './asset-data.ts';
export type { ParsedAssets, AssetText } from './asset-data.ts';

/** Retain the native Buffer API without copying private decoded arrays or changing authored names/strings. */
export function readAssets(input: unknown): ParsedAssets {
  const parsed = readAssetData(input);
  const files = new Map([...parsed.files].map(([name, file]) => [name, {
    mediaType: file.mediaType,
    bytes: Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength),
  }]));
  return { tree: parsed.tree, files };
}
export function validateAssetPatch(input: unknown): void { validateAssetDataPatch(input); }
