// Owns MIME syntax and extension defaults shared by HTTP and byte projections; not content sniffing or serving authority.
import { MIMEType } from 'node:util';

export const MAX_MEDIA_TYPE = 1024;
const EXTENSION_TYPES: Readonly<Record<string, string>> = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
/** Compatibility defaults only: a declared MIME value takes priority and this lookup grants no file authority. */
export function mediaTypeForExtension(extension: string): string | undefined { return EXTENSION_TYPES[extension]; }
/** Stored provenance uses canonical MIME spelling, even when an HTTP compatibility default includes whitespace. */
export function resourceMediaTypeForExtension(extension: string): string { return new MIMEType(mediaTypeForExtension(extension) ?? 'application/octet-stream').toString(); }
/** Parse only a canonical printable MIME value; never coerce objects or retain discarded/ambiguous parameters. */
export function canonicalMediaType(value: unknown): MIMEType | null {
  if (typeof value !== 'string' || !value || value.length > MAX_MEDIA_TYPE || /[^\x20-\x7e]/.test(value)) return null;
  try { const parsed = new MIMEType(value); return parsed.toString() === value ? parsed : null; }
  catch { return null; }
}
