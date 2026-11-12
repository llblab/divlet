// Owns canonical, bounded MIME syntax for stored resources and generated-file provenance; not content sniffing or serving authority.
import { MIMEType } from 'node:util';

export const MAX_MEDIA_TYPE = 1024;
/** Parse only a canonical printable MIME value; never coerce objects or retain discarded/ambiguous parameters. */
export function canonicalMediaType(value: unknown): MIMEType | null {
  if (typeof value !== 'string' || !value || value.length > MAX_MEDIA_TYPE || /[^\x20-\x7e]/.test(value)) return null;
  try { const parsed = new MIMEType(value); return parsed.toString() === value ? parsed : null; }
  catch { return null; }
}
