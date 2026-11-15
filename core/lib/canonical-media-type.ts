// Domain: Canonical MIME admission. Owns: bounded printable canonical syntax and a portable read view. Excludes: general MIME normalization, byte decoding, extension policy and host authority.
export const MAX_MEDIA_TYPE = 1024;
export interface MediaTypeParameters extends Iterable<readonly [string, string]> {
  get(name: string): string | null;
}
export interface CanonicalMediaType {
  readonly essence: string;
  readonly params: MediaTypeParameters;
  toString(): string;
}
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LOWER_TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const lowerASCII = (value: string): string => value.replace(/[A-Z]/g, letter => letter.toLowerCase());

/** Recognize already-canonical WHATWG MIME serialization, not a permissive parser that repairs foreign input. */
export function canonicalMediaType(input: unknown): CanonicalMediaType | null {
  if (typeof input !== 'string' || !input || input.length > MAX_MEDIA_TYPE || /[^\x20-\x7e]/.test(input)) return null;
  const end = input.indexOf(';'), essence = end < 0 ? input : input.slice(0, end), slash = essence.indexOf('/');
  if (slash < 0 || !LOWER_TOKEN.test(essence.slice(0, slash)) || !LOWER_TOKEN.test(essence.slice(slash + 1))) return null;
  const parameters = new Map<string, string>();
  let offset = end < 0 ? input.length : end;
  while (offset < input.length) {
    const equals = input.indexOf('=', offset + 1);
    if (equals < 0) return null;
    const name = input.slice(offset + 1, equals);
    if (!LOWER_TOKEN.test(name) || parameters.has(name)) return null;
    offset = equals + 1;
    let value = '';
    if (input[offset] === '"') {
      offset++;
      while (offset < input.length && input[offset] !== '"') {
        let char = input[offset++]!;
        if (char === '\\') {
          char = input[offset++]!;
          if (char !== '"' && char !== '\\') return null;
        }
        value += char;
      }
      if (input[offset++] !== '"' || TOKEN.test(value)) return null; // Token values must serialize without quotes; empty values keep quotes.
    } else {
      const next = input.indexOf(';', offset), finish = next < 0 ? input.length : next;
      value = input.slice(offset, finish); offset = finish;
      if (!TOKEN.test(value)) return null;
    }
    parameters.set(name, value);
    if (offset < input.length && input[offset] !== ';') return null;
  }
  const params: MediaTypeParameters = Object.freeze({
    get(name: string): string | null { return parameters.get(lowerASCII(name)) ?? null; },
    [Symbol.iterator](): IterableIterator<[string, string]> { return parameters.entries(); },
  });
  return Object.freeze({ essence, params, toString: () => input });
}
