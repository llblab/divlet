// Owns the native MIMEType compatibility view and extension defaults; portable canonical admission has no host dependency.
import { MIMEType } from 'node:util';
import { canonicalMediaType as readCanonicalMediaType } from './canonical-media-type.ts';
export { MAX_MEDIA_TYPE } from './canonical-media-type.ts';
const EXTENSION_TYPES: Readonly<Record<string, string>> = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
/** Compatibility defaults only: a declared MIME value takes priority and this lookup grants no file authority. */
export function mediaTypeForExtension(extension: string): string | undefined { return EXTENSION_TYPES[extension]; }
/** Stored provenance uses canonical MIME spelling, even when an HTTP compatibility default includes whitespace. */
export function resourceMediaTypeForExtension(extension: string): string { return new MIMEType(mediaTypeForExtension(extension) ?? 'application/octet-stream').toString(); }
/** Keep the existing native class/parameter API (including host-version behavior) outside portable admission. */
export function canonicalMediaType(value: unknown): MIMEType | null {
  const parsed = readCanonicalMediaType(value);
  return parsed ? new MIMEType(parsed.toString()) : null;
}
