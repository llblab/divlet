/*
 * Owns: host-independent JSON/text admission primitives and the shared domain error identity.
 * Excludes: document/CSS validation, style providers, persistence and transport. No runtime imports or Node globals.
 */

/** A domain error with a stable code: adapters show `message`, callers branch on `code`. */
export class DivletError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DivletError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** An object at the admission boundary, before its fields have been validated. */
type Unchecked = Record<string, any>;
/** Shared native identifier grammar; consumers decide the field's diagnostics. */
export const ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;
const BAD_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function fail(message: string, details?: unknown, code = 'INVALID_DOCUMENT'): never {
  throw new DivletError(code, message, details);
}

export function object(value: unknown, label: string): Unchecked {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`);
  return value as Unchecked;
}

export function string(value: unknown, label: string, max = 65536): string {
  if (typeof value !== 'string' || value.length > max) fail(`${label} must be a string of at most ${max} characters`);
  if (value.includes('\0') || !value.isWellFormed()) fail(`${label} contains an unrepresentable character`);
  return value.replace(/\r\n?/g, '\n');
}

/**
 * Deep equality of plain JSON data with util.isDeepStrictEqual's results for such values: primitives by Object.is (so 0 and
 * -0 differ), arrays by position, objects by own enumerable key set regardless of order. Not for class instances or cycles.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((item, index) => sameJson(item, (b as unknown[])[index]));
  const keysA = Object.keys(a), keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) if (!Object.hasOwn(b, key) || !sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  return true;
}

/** Test a caller-owned UTF-8 budget without allocating more than budget + 1 encoded bytes. */
export function withinUtf8Budget(value: string, maxBytes: number): boolean {
  if (value.length > maxBytes) return false;
  const output = new Uint8Array(Math.min(value.length * 3, maxBytes + 1));
  const { read, written } = new TextEncoder().encodeInto(value, output);
  return read === value.length && written <= maxBytes;
}

export function keys(value: Unchecked, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`Unsupported ${label} field: ${key}`);
}

export function json(value: unknown, label = 'value', depth = 0, preserveKeys = false, maxDepth = 80): void {
  if (depth > maxDepth) fail(`${label} is too deeply nested`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) json(entry, label, depth + 1, preserveKeys, maxDepth);
    return;
  }
  const record = object(value, label);
  for (const [key, entry] of Object.entries(record)) {
    if (!preserveKeys && BAD_KEYS.has(key)) fail(`Unsafe property name: ${key}`);
    json(entry, label, depth + 1, preserveKeys, maxDepth);
  }
}

/** Host-selected text capacities; JSON container nesting is not DOM/document depth. */
export interface JsonTextLimits { readonly bytes: number; readonly nesting: number }

/** Opt-in native value profile only: callers still validate the decoded schema, fields and metadata. */
export function parseNativeJson(input: unknown, limits: JsonTextLimits): unknown {
  function invalid(message: string, offset?: number): never {
    throw new DivletError('INVALID_JSON', message, offset === undefined ? undefined : { offset });
  }
  const bytes = limits?.bytes, nesting = limits?.nesting;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(nesting) || nesting < 0) invalid('Native JSON capacities must be nonnegative safe integers.');
  if (typeof input !== 'string') invalid('Native JSON source must be text.');
  if (!withinUtf8Budget(input, bytes)) invalid('Native JSON exceeds its UTF-8 byte budget.');
  try {
    // Track only names and containers; the platform parser remains the JSON grammar authority.
    const scopes: Array<{ members: Set<string> | null; key: boolean }> = [];
    for (let index = 0; index < input.length; index++) {
      const char = input[index];
      if (char === '"') {
        const start = index;
        while (++index < input.length) {
          if (input[index] === '\\') index++;
          else if (input[index] === '"') break;
        }
        if (index >= input.length) invalid('Native source is not valid JSON.', start);
        const scope = scopes.at(-1);
        if (scope?.members && scope.key) {
          const name = JSON.parse(input.slice(start, index + 1)) as string;
          if (scope.members.has(name)) invalid('Native JSON contains a duplicate object member.', start);
          scope.members.add(name);
          scope.key = false;
        }
      } else if (char === '{' || char === '[') {
        if (scopes.length >= nesting) invalid('Native JSON exceeds its container nesting budget.', index);
        scopes.push({ members: char === '{' ? new Set() : null, key: char === '{' });
      } else if (char === '}' || char === ']') scopes.pop();
      else if (char === ',') {
        const scope = scopes.at(-1);
        if (scope?.members) scope.key = true;
      }
    }
    const root = { value: JSON.parse(input) as unknown };
    // A recursive reviver would add a host-dependent call-stack limit to the declared nesting budget.
    const pending: Record<string, unknown>[] = [root];
    while (pending.length) {
      const value = pending.pop()!;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const member = value[key];
        if (typeof member === 'number') {
          if (!Number.isFinite(member)) invalid('Native JSON contains a non-finite binary64 number.');
          if (member === 0) value[key] = 0;
        } else if (member !== null && typeof member === 'object') pending.push(member as Record<string, unknown>);
      }
    }
    return root.value;
  } catch (error) {
    // SyntaxError messages may quote private input; never pass platform diagnostics through.
    if (error instanceof SyntaxError) invalid('Native source is not valid JSON.');
    throw error;
  }
}
