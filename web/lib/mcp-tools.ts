/*
 * Owns: one canonical registry of browser-executed tools, the bounded JSON Schema subset that validates their input, and the
 * single execution path every adapter (the browser MCP provider, WebMCP) calls. Excludes: transport, discovery and any
 * application semantics — a tool's `execute` is the application's own operation.
 *
 * A schema keyword this module does not implement is refused when the tool is defined, so a registered schema never claims a
 * validation this code would silently skip.
 */

export type JsonSchema = { readonly [key: string]: unknown };

/** Advisory hints, as MCP and WebMCP describe them. A consumer treats them as untrusted claims, never as proof of safety. */
export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ToolExecution { readonly signal: AbortSignal }

/** One operation the application exposes. `execute` receives validated arguments and must honour `signal` where it can. */
export interface BrowserTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations?: ToolAnnotations;
  execute(args: Record<string, unknown>, context: ToolExecution): unknown;
}

/** The published description of a tool (no executable member). */
export interface ToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
}

export interface ToolLimits {
  /** Largest serialized result accepted from `execute`, in UTF-8 bytes. */
  readonly resultBytes: number;
  /** Longest a single execution may run before it is aborted. */
  readonly timeoutMs: number;
}

export const DEFAULT_TOOL_LIMITS: ToolLimits = Object.freeze({ resultBytes: 1024 * 1024, timeoutMs: 60_000 });

/** A failure the caller can report: `code` is a stable machine-readable string. */
export class ToolError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** The outcome of one call, already JSON-safe: either the tool's value or a structured refusal. */
export type ToolOutcome =
  | { readonly ok: true; readonly value: unknown; readonly json: string }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } };

export interface ToolRegistry {
  readonly descriptors: readonly ToolDescriptor[];
  has(name: string): boolean;
  /** Validate `args` against the tool's schema, run it under a deadline and return a JSON-safe outcome. */
  run(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<ToolOutcome>;
}

/* ---- the JSON Schema subset ---------------------------------------------------------------------- */

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const ANNOTATION_KEYWORDS = new Set(['$schema', 'title', 'description', 'default', 'examples', '$comment', 'deprecated', 'readOnly', 'writeOnly']);
const ASSERTION_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'oneOf', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const MAX_SCHEMA_NODES = 2000;
const MAX_SCHEMA_DEPTH = 32;
const MAX_VALUE_DEPTH = 64;

type Validator = (value: unknown, path: string, depth: number) => string | null;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const typeOf = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value;
const matchesType = (value: unknown, type: string): boolean => {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
};
const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((item, i) => sameJson(item, (b as unknown[])[i]));
  const keysA = Object.keys(a as object), keysB = Object.keys(b as object);
  return keysA.length === keysB.length && keysA.every(key => Object.hasOwn(b as object, key) && sameJson((a as any)[key], (b as any)[key]));
}

/** Compile a schema once; throws a `ToolError('INVALID_SCHEMA')` for anything outside the supported subset. */
export function compileSchema(schema: unknown, label = 'schema'): (value: unknown) => string | null {
  let nodes = 0;
  const compile = (node: unknown, path: string, depth: number): Validator => {
    if (++nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) throw new ToolError('INVALID_SCHEMA', `${label} is too large or too deeply nested.`);
    if (node === true) return () => null;
    if (node === false) return (_value, at) => `${at || 'value'} is not allowed`;
    if (!isObject(node)) throw new ToolError('INVALID_SCHEMA', `${label} at ${path || '/'} must be an object or a boolean.`);
    for (const key of Object.keys(node)) {
      if (!ANNOTATION_KEYWORDS.has(key) && !ASSERTION_KEYWORDS.has(key)) throw new ToolError('INVALID_SCHEMA', `${label} uses the unsupported keyword "${key}" at ${path || '/'}.`);
    }
    if ('$schema' in node && node.$schema !== DIALECT) throw new ToolError('INVALID_SCHEMA', `${label} declares an unsupported dialect; only JSON Schema 2020-12 is implemented.`);
    const checks: Validator[] = [];
    if ('type' in node) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.length || types.some(type => typeof type !== 'string' || !TYPES.has(type))) throw new ToolError('INVALID_SCHEMA', `${label} has an invalid type at ${path || '/'}.`);
      checks.push((value, at) => types.some(type => matchesType(value, type as string)) ? null : `${at || 'value'} must be ${types.join(' or ')}`);
    }
    if ('enum' in node) {
      if (!Array.isArray(node.enum) || !node.enum.length) throw new ToolError('INVALID_SCHEMA', `${label} has an empty enum at ${path || '/'}.`);
      const values = node.enum;
      checks.push((value, at) => values.some(item => sameJson(item, value)) ? null : `${at || 'value'} must be one of ${values.map(item => JSON.stringify(item)).join(', ')}`);
    }
    if ('const' in node) { const expected = node.const; checks.push((value, at) => sameJson(expected, value) ? null : `${at || 'value'} must be ${JSON.stringify(expected)}`); }
    for (const [key, test] of [['minimum', (v: number, n: number) => v >= n], ['maximum', (v: number, n: number) => v <= n]] as const) {
      if (!(key in node)) continue;
      const limit = node[key];
      if (typeof limit !== 'number' || !Number.isFinite(limit)) throw new ToolError('INVALID_SCHEMA', `${label} has an invalid ${key} at ${path || '/'}.`);
      checks.push((value, at) => typeof value !== 'number' || test(value, limit) ? null : `${at || 'value'} must be ${key === 'minimum' ? '≥' : '≤'} ${limit}`);
    }
    for (const [key, measure, compare] of [
      ['minLength', 'string', (n: number, l: number) => n >= l], ['maxLength', 'string', (n: number, l: number) => n <= l],
      ['minItems', 'array', (n: number, l: number) => n >= l], ['maxItems', 'array', (n: number, l: number) => n <= l],
    ] as const) {
      if (!(key in node)) continue;
      const limit = node[key];
      if (!nonNegativeInteger(limit)) throw new ToolError('INVALID_SCHEMA', `${label} has an invalid ${key} at ${path || '/'}.`);
      checks.push((value, at) => {
        if (measure === 'string' && typeof value === 'string') { let length = 0; for (const _ of value) length++; return compare(length, limit) ? null : `${at || 'value'} must have ${key.startsWith('min') ? 'at least' : 'at most'} ${limit} characters`; }
        if (measure === 'array' && Array.isArray(value)) return compare(value.length, limit) ? null : `${at || 'value'} must have ${key.startsWith('min') ? 'at least' : 'at most'} ${limit} items`;
        return null;
      });
    }
    if ('properties' in node || 'required' in node || 'additionalProperties' in node) {
      if ('properties' in node && !isObject(node.properties)) throw new ToolError('INVALID_SCHEMA', `${label} has invalid properties at ${path || '/'}.`);
      const properties = new Map(Object.entries((node.properties ?? {}) as Record<string, unknown>).map(([key, child]) => [key, compile(child, `${path}/properties/${key}`, depth + 1)]));
      const required = node.required ?? [];
      if (!Array.isArray(required) || required.some(key => typeof key !== 'string')) throw new ToolError('INVALID_SCHEMA', `${label} has an invalid required list at ${path || '/'}.`);
      const extra = 'additionalProperties' in node ? compile(node.additionalProperties, `${path}/additionalProperties`, depth + 1) : null;
      checks.push((value, at, level) => {
        if (!isObject(value)) return null;
        for (const key of required as string[]) if (!Object.hasOwn(value, key)) return `${at ? `${at}.` : ''}${key} is required`;
        for (const [key, item] of Object.entries(value)) {
          const child = properties.get(key) ?? extra;
          const problem = child?.(item, at ? `${at}.${key}` : key, level + 1);
          if (problem) return problem;
        }
        return null;
      });
    }
    if ('items' in node) {
      const items = compile(node.items, `${path}/items`, depth + 1);
      checks.push((value, at, level) => {
        if (!Array.isArray(value)) return null;
        for (let i = 0; i < value.length; i++) { const problem = items(value[i], `${at || 'value'}[${i}]`, level + 1); if (problem) return problem; }
        return null;
      });
    }
    for (const key of ['anyOf', 'oneOf'] as const) {
      if (!(key in node)) continue;
      const list = node[key];
      if (!Array.isArray(list) || !list.length) throw new ToolError('INVALID_SCHEMA', `${label} has an empty ${key} at ${path || '/'}.`);
      const variants = list.map((child, i) => compile(child, `${path}/${key}/${i}`, depth + 1));
      checks.push((value, at, level) => {
        const passing = variants.filter(variant => variant(value, at, level) === null).length;
        if (key === 'anyOf' ? passing > 0 : passing === 1) return null;
        return `${at || 'value'} does not match ${key === 'anyOf' ? 'any allowed shape' : 'exactly one allowed shape'}`;
      });
    }
    return (value, at, level) => {
      if (level > MAX_VALUE_DEPTH) return `${at || 'value'} is nested too deeply`;
      for (const check of checks) { const problem = check(value, at, level); if (problem) return problem; }
      return null;
    };
  };
  const root = compile(schema, '', 0);
  return value => root(value, '', 0);
}

/* ---- the registry -------------------------------------------------------------------------------- */

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_DESCRIPTION = 16_384;
const encoder = new TextEncoder();

/** The JSON text of a value, or a refusal when it is not plain JSON data or exceeds the byte budget. */
export function boundedJson(value: unknown, maxBytes: number): string {
  let text: string | undefined;
  try { text = JSON.stringify(value === undefined ? null : value); }
  catch (error) { throw new ToolError('INVALID_RESULT', `The result is not JSON data: ${(error as Error)?.message || error}`); }
  if (typeof text !== 'string') throw new ToolError('INVALID_RESULT', 'The result is not JSON data.');
  if (text.length > maxBytes || encoder.encode(text).byteLength > maxBytes) throw new ToolError('RESULT_TOO_LARGE', `The result exceeds ${maxBytes} bytes.`);
  return text;
}

function refusal(error: unknown): { code: string; message: string; details?: unknown } {
  const code = typeof (error as any)?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test((error as any).code) ? (error as any).code : 'TOOL_FAILED';
  const message = String((error as any)?.message ?? error ?? 'The tool failed.').slice(0, 4000);
  let details: unknown;
  try { const raw = (error as any)?.details; if (raw !== undefined) details = JSON.parse(boundedJson(raw, 16_384)); } catch { /* details are optional; drop what cannot travel */ }
  return details === undefined ? { code, message } : { code, message, details };
}

function annotationsOf(input: unknown, name: string): ToolAnnotations | undefined {
  if (input === undefined) return undefined;
  if (!isObject(input)) throw new ToolError('INVALID_TOOL', `${name}: annotations must be an object.`);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'title' ? typeof value !== 'string' : !['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].includes(key) || typeof value !== 'boolean') throw new ToolError('INVALID_TOOL', `${name}: unsupported annotation ${key}.`);
    out[key] = value;
  }
  return out as ToolAnnotations;
}

/** Validate tool definitions once and return the registry every adapter shares. */
export function defineTools(tools: readonly BrowserTool[], limits: Partial<ToolLimits> = {}): ToolRegistry {
  const budget: ToolLimits = { ...DEFAULT_TOOL_LIMITS, ...limits };
  const entries = new Map<string, { tool: BrowserTool; validate: (value: unknown) => string | null; descriptor: ToolDescriptor }>();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) throw new ToolError('INVALID_TOOL', 'A tool name must be 1–128 characters of A–Z, a–z, 0–9, "_", "-" or ".".');
    if (entries.has(tool.name)) throw new ToolError('INVALID_TOOL', `Duplicate tool name: ${tool.name}.`);
    if (typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > MAX_DESCRIPTION) throw new ToolError('INVALID_TOOL', `${tool.name}: description must be a non-empty string of at most ${MAX_DESCRIPTION} characters.`);
    if (tool.title !== undefined && typeof tool.title !== 'string') throw new ToolError('INVALID_TOOL', `${tool.name}: title must be a string.`);
    if (typeof tool.execute !== 'function') throw new ToolError('INVALID_TOOL', `${tool.name}: execute must be a function.`);
    if (!isObject(tool.inputSchema) || tool.inputSchema.type !== 'object') throw new ToolError('INVALID_SCHEMA', `${tool.name}: inputSchema must be an object schema.`);
    const annotations = annotationsOf(tool.annotations, tool.name);
    // The descriptor is a detached JSON copy: later mutation of the caller's object cannot change what was validated.
    const descriptor: ToolDescriptor = JSON.parse(JSON.stringify({ name: tool.name, ...(tool.title ? { title: tool.title } : {}), description: tool.description, inputSchema: tool.inputSchema, ...(annotations ? { annotations } : {}) }));
    entries.set(tool.name, { tool, validate: compileSchema(descriptor.inputSchema, `${tool.name} inputSchema`), descriptor });
  }
  const descriptors = Object.freeze([...entries.values()].map(entry => Object.freeze(entry.descriptor)));

  async function run(name: string, args: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<ToolOutcome> {
    const entry = entries.get(name);
    if (!entry) return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}.` } };
    const input = args === undefined ? {} : args;
    const problem = entry.validate(input);
    if (problem) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: `Invalid arguments for ${name}: ${problem}.` } };
    if (signal?.aborted) return { ok: false, error: { code: 'CANCELLED', message: 'The call was cancelled.' } };
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { const error = new ToolError('TIMEOUT', `${name} did not finish within ${budget.timeoutMs} ms.`); controller.abort(error); reject(error); }, budget.timeoutMs);
    });
    const cancelled = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason instanceof ToolError ? controller.signal.reason : new ToolError('CANCELLED', 'The call was cancelled.')), { once: true }));
    try {
      // A detached copy: the tool never receives an object the transport can still mutate.
      const value = await Promise.race([Promise.resolve().then(() => entry.tool.execute(JSON.parse(JSON.stringify(input)), { signal: controller.signal })), deadline, cancelled]);
      const json = boundedJson(value, budget.resultBytes);
      return { ok: true, value: JSON.parse(json), json };
    } catch (error) {
      return { ok: false, error: refusal(error) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  return Object.freeze({ descriptors, has: (name: string) => entries.has(name), run });
}
