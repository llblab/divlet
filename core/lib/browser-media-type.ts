/* Owns: the browser build's explicit absence of canonical MIME parsing. Embedded asset bytes stay a Node-host capability until
 * a portable WHATWG MIME implementation shares the Node decoder's exact canonicalization; no approximation is substituted. */
export const MAX_MEDIA_TYPE = 1024;
const missing = (): never => { throw Object.assign(new Error('Embedded assets need the local divlet host: this browser build does not decode project asset bytes.'), { code: 'ASSETS_UNAVAILABLE' }); };
export function mediaTypeForExtension(_extension: string): string | undefined { return missing(); }
export function resourceMediaTypeForExtension(_extension: string): string { return missing(); }
export function canonicalMediaType(_value: unknown): never { return missing(); }
