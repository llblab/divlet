/* Owns: the browser build's explicit asset-capability refusal. The portable canonical MIME read slice is separate;
 * bounded byte decoding and all resource consumers must be proven before this project-asset gate is lifted. */
export { MAX_MEDIA_TYPE } from './canonical-media-type.ts';
const missing = (): never => { throw Object.assign(new Error('Embedded assets need the local divlet host: this browser build does not decode project asset bytes.'), { code: 'ASSETS_UNAVAILABLE' }); };
export function mediaTypeForExtension(_extension: string): string | undefined { return missing(); }
export function resourceMediaTypeForExtension(_extension: string): string { return missing(); }
export function canonicalMediaType(_value: unknown): never { return missing(); }
