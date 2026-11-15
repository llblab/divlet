// Domain: Browser project-asset port. Owns: existing byte-capability refusal over shared admission. Excludes: private primitive activation, resource projection and host fallbacks.
import { readAssets as readAssetData, validateAssetPatch as validateAssetDataPatch } from './asset-data.ts';
import { canonicalMediaType } from './browser-media-type.ts';
import { requireAssetBytes } from './browser-asset-access.ts';
import type { AssetFile } from './model.ts';
import type { AssetText, ParsedAssets } from './asset-data.ts';
export { ASSET_LIMITS, assetCollisionKey, allocateAssetLeaf } from './asset-data.ts';
export type { AssetText, ParsedAssets } from './asset-data.ts';

export function readAssets(input: unknown): ParsedAssets { return readAssetData(input, requireAssetBytes); }
export function validateAssetPatch(input: unknown): void { validateAssetDataPatch(input, requireAssetBytes); }
export function readAssetText(file: AssetFile): AssetText | null { return canonicalMediaType(file.mediaType); }
