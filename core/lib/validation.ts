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
