/* Owns: the browser build's explicit asset-capability refusal. Private portable data admission does not establish
 * resource projection/storage; the default browser asset facade still refuses byte leaves at this shared boundary. */
export { MAX_MEDIA_TYPE } from './canonical-media-type.ts';
import { requireAssetBytes } from './browser-asset-access.ts';
export function mediaTypeForExtension(_extension: string): string | undefined { return requireAssetBytes(); }
export function resourceMediaTypeForExtension(_extension: string): string { return requireAssetBytes(); }
export function canonicalMediaType(_value: unknown): never { return requireAssetBytes(); }
