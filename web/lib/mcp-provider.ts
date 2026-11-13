/*
 * Owns: the browser-side MCP provider — a JSON-RPC 2.0 handler for MCP protocol revision 2026-07-28 over the canonical tool
 * registry — and the page's discovery endpoint a local agent transport looks for. Excludes: how messages reach the page
 * (that is the agent's transport), application semantics (the registered tools own them) and any host privilege: the
 * provider only answers messages handed to it and never calls out of the page.
 *
 * Revision 2026-07-28 is stateless: there is no `initialize` handshake. Every request carries its protocol version and the
 * client capabilities in `params._meta`, and each request is answered independently. Implemented methods: `server/discover`,
 * `tools/list`, `tools/call` and the `notifications/cancelled` notification. Resources, prompts, subscriptions, multi
 * round-trip input and tasks are not offered and are not advertised.
 */
import { defineTools, boundedJson } from './mcp-tools.ts';
import type { BrowserTool, ToolLimits, ToolRegistry } from './mcp-tools.ts';

export { defineTools, compileSchema, ToolError, DEFAULT_TOOL_LIMITS } from './mcp-tools.ts';
export type { BrowserTool, ToolAnnotations, ToolDescriptor, ToolExecution, ToolLimits, ToolOutcome, ToolRegistry, JsonSchema } from './mcp-tools.ts';
export { registerWebMcpTools } from './webmcp.ts';
export type { WebMcpModelContext } from './webmcp.ts';

export const PROTOCOL_VERSION = '2026-07-28';
export const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([PROTOCOL_VERSION]);

/** The discovery contract between a page and an agent transport. Project-specific, versioned, not an MCP standard. */
export const ENDPOINT_PROTOCOL = 'browser-mcp/1';
/** Where the endpoint lives on the page's global object: a registered symbol, so it collides with no page or browser name. */
export const ENDPOINT_KEY: unique symbol = Symbol.for(ENDPOINT_PROTOCOL);
/** Optional static hint (`<meta name="browser-mcp" content="browser-mcp/1">`): the page intends to expose a provider. */
export const ENDPOINT_META = 'browser-mcp';

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
/** Required caching hints for discovery and list results. The tool set belongs to one page instance and may change on reload. */
const CACHE = Object.freeze({ ttlMs: 0, cacheScope: 'private' });

/** JSON-RPC and MCP error codes this provider emits. `TOO_MANY_REQUESTS` is application-defined, outside the reserved range. */
export const ERRORS = Object.freeze({ PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, UNSUPPORTED_VERSION: -32022, TOO_MANY_REQUESTS: -31001 });

export interface ProviderLimits extends ToolLimits {
  /** Largest accepted request or emitted response, in UTF-8 bytes. */
  readonly messageBytes: number;
  /** Requests that may be executing at once; further requests are refused rather than queued without bound. */
  readonly concurrent: number;
}

export const DEFAULT_PROVIDER_LIMITS: ProviderLimits = Object.freeze({ messageBytes: 2 * 1024 * 1024, concurrent: 32, resultBytes: 1024 * 1024, timeoutMs: 60_000 });

export interface ProviderOptions {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly instructions?: string;
  readonly tools: readonly BrowserTool[] | ToolRegistry;
  readonly limits?: Partial<ProviderLimits>;
}

type Id = string | number;
type Response = { jsonrpc: '2.0'; id: Id | null; result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };

export interface BrowserMcpProvider {
  /** Handle one JSON-RPC message (parsed JSON). Resolves to the response, or `null` for notifications and cancelled requests. */
  handle(message: unknown): Promise<Response | null>;
  /** Handle one message as JSON text and answer with JSON text (or `null`), enforcing the byte budget in both directions. */
  handleText(text: string): Promise<string | null>;
  /** Abort every running call; later requests are refused. */
  close(): void;
  readonly registry: ToolRegistry;
}

/** The object a page publishes at `globalThis[ENDPOINT_KEY]`. `instance` changes with every provider, so a transport sees replacement. */
export interface BrowserMcpEndpoint {
  readonly protocol: typeof ENDPOINT_PROTOCOL;
  readonly instance: string;
  handle(text: string): Promise<string | null>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const validId = (id: unknown): id is Id => (typeof id === 'string' && id.length <= 256) || Number.isSafeInteger(id);
const encoder = new TextEncoder();

export function createBrowserMcpProvider(options: ProviderOptions): BrowserMcpProvider {
  if (!options || typeof options.name !== 'string' || !options.name || typeof options.version !== 'string' || !options.version) throw new TypeError('A browser MCP provider needs a name and a version.');
  const limits: ProviderLimits = { ...DEFAULT_PROVIDER_LIMITS, ...options.limits };
  const registry: ToolRegistry = 'descriptors' in options.tools && typeof (options.tools as ToolRegistry).run === 'function'
    ? options.tools as ToolRegistry
    : defineTools(options.tools as readonly BrowserTool[], limits);
  const serverInfo = Object.freeze({ name: options.name, version: options.version, ...(options.title ? { title: options.title } : {}) });
  const running = new Map<Id, AbortController>();
  let closed = false;

  const meta = () => ({ [META_SERVER]: serverInfo });
  const ok = (id: Id, result: Record<string, unknown>): Response => ({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result, _meta: meta() } });
  const fail = (id: Id | null, code: number, message: string, data?: unknown): Response => ({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });

  /** The per-request `_meta` this revision requires; `null` when the request may proceed. */
  function admit(id: Id, params: Record<string, unknown>): Response | null {
    const fields = params._meta;
    if (!isObject(fields)) return fail(id, ERRORS.INVALID_PARAMS, `Missing _meta: every request must carry ${META_VERSION} and ${META_CAPABILITIES}.`);
    const version = fields[META_VERSION];
    if (typeof version !== 'string' || !version) return fail(id, ERRORS.INVALID_PARAMS, `Missing _meta["${META_VERSION}"].`);
    if (!isObject(fields[META_CAPABILITIES])) return fail(id, ERRORS.INVALID_PARAMS, `Missing _meta["${META_CAPABILITIES}"].`);
    if (!SUPPORTED_VERSIONS.includes(version)) return fail(id, ERRORS.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS], requested: version.slice(0, 64) });
    return null;
  }

  async function call(id: Id, params: Record<string, unknown>): Promise<Response | null> {
    const name = params.name;
    if (typeof name !== 'string' || !registry.has(name)) return fail(id, ERRORS.INVALID_PARAMS, `Unknown tool: ${typeof name === 'string' ? name.slice(0, 128) : String(name)}`);
    if (params.arguments !== undefined && !isObject(params.arguments)) return fail(id, ERRORS.INVALID_PARAMS, 'tools/call arguments must be an object.');
    if (running.size >= limits.concurrent) return fail(id, ERRORS.TOO_MANY_REQUESTS, `Too many concurrent requests (limit ${limits.concurrent}).`);
    if (running.has(id)) return fail(id, ERRORS.INVALID_REQUEST, 'A request with this id is still in progress.');
    const controller = new AbortController();
    running.set(id, controller);
    try {
      const outcome = await registry.run(name, params.arguments ?? {}, { signal: controller.signal });
      // A cancelled request gets no response (notifications/cancelled); a closed provider answers nothing further.
      if (controller.signal.aborted) return null;
      if (outcome.ok) {
        const structured = isObject(outcome.value) ? { structuredContent: outcome.value } : {};
        return ok(id, { content: [{ type: 'text', text: outcome.json }], ...structured, isError: false });
      }
      const { code, message, details } = outcome.error;
      const text = `${code}: ${message}${details === undefined ? '' : `\n${JSON.stringify(details)}`}`;
      return ok(id, { content: [{ type: 'text', text }], structuredContent: { error: outcome.error }, isError: true });
    } finally {
      running.delete(id);
    }
  }

  async function handle(message: unknown): Promise<Response | null> {
    if (!isObject(message) || message.jsonrpc !== '2.0') return fail(isObject(message) && validId(message.id) ? message.id : null, ERRORS.INVALID_REQUEST, 'Invalid request: expected one JSON-RPC 2.0 object.');
    const { id, method } = message;
    const params = message.params === undefined ? {} : message.params;
    if (typeof method !== 'string') {
      // Responses to requests this provider never sends are ignored rather than answered.
      return 'result' in message || 'error' in message ? null : fail(validId(id) ? id : null, ERRORS.INVALID_REQUEST, 'Invalid request: method must be a string.');
    }
    if (id === undefined) {
      // Notifications: only cancellation has meaning here; anything else is ignored as the specification requires.
      if (method === 'notifications/cancelled' && isObject(params) && validId(params.requestId)) running.get(params.requestId)?.abort();
      return null;
    }
    if (!validId(id)) return fail(null, ERRORS.INVALID_REQUEST, 'Invalid request: id must be a string or an integer.');
    if (!isObject(params)) return fail(id, ERRORS.INVALID_PARAMS, 'params must be an object.');
    if (closed) return fail(id, ERRORS.INTERNAL, 'The provider has closed.');
    if (method === 'initialize') return fail(id, ERRORS.METHOD_NOT_FOUND, `This provider implements only the stateless MCP revision(s) ${SUPPORTED_VERSIONS.join(', ')}; there is no initialize handshake.`, { supported: [...SUPPORTED_VERSIONS] });
    const refused = admit(id, params);
    if (refused) return refused;
    switch (method) {
      case 'server/discover':
        return ok(id, { supportedVersions: [...SUPPORTED_VERSIONS], capabilities: { tools: {} }, ...(options.instructions ? { instructions: options.instructions } : {}), ...CACHE });
      case 'tools/list':
        if (params.cursor !== undefined) return fail(id, ERRORS.INVALID_PARAMS, 'Invalid cursor: the tool list has a single page.');
        return ok(id, { tools: registry.descriptors.map(descriptor => JSON.parse(JSON.stringify(descriptor))), ...CACHE });
      case 'tools/call':
        return call(id, params);
      default:
        return fail(id, ERRORS.METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 128)}`);
    }
  }

  async function handleText(text: string): Promise<string | null> {
    if (typeof text !== 'string') return JSON.stringify(fail(null, ERRORS.INVALID_REQUEST, 'Messages are JSON text.'));
    if (text.length > limits.messageBytes || encoder.encode(text).byteLength > limits.messageBytes) return JSON.stringify(fail(null, ERRORS.INVALID_REQUEST, `The message exceeds ${limits.messageBytes} bytes.`));
    let message: unknown;
    try { message = JSON.parse(text); } catch { return JSON.stringify(fail(null, ERRORS.PARSE, 'Parse error.')); }
    let response: Response | null;
    try { response = await handle(message); }
    catch (error) { response = fail(isObject(message) && validId(message.id) ? message.id : null, ERRORS.INTERNAL, String((error as Error)?.message || error).slice(0, 1000)); }
    if (!response) return null;
    try { return boundedJson(response, limits.messageBytes); }
    catch (error) { return JSON.stringify(fail(response.id, ERRORS.INTERNAL, String((error as Error)?.message || error))); }
  }

  return Object.freeze({
    handle, handleText, registry,
    close() { closed = true; for (const controller of running.values()) controller.abort(); running.clear(); },
  });
}

/**
 * Publish the provider for an agent transport on this page. The endpoint is non-writable and non-enumerable; publishing a second
 * provider on the same page is refused. Returns a function that withdraws it (and closes the provider).
 */
export function exposeBrowserMcp(provider: BrowserMcpProvider, target: object = globalThis): () => void {
  if (Object.getOwnPropertyDescriptor(target, ENDPOINT_KEY)?.value) throw new Error('A browser MCP endpoint is already published on this page.');
  const random = globalThis.crypto?.getRandomValues?.(new Uint8Array(12));
  const instance = random ? [...random].map(byte => byte.toString(16).padStart(2, '0')).join('') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const endpoint: BrowserMcpEndpoint = Object.freeze({ protocol: ENDPOINT_PROTOCOL, instance, handle: (text: string) => provider.handleText(text) });
  Object.defineProperty(target, ENDPOINT_KEY, { value: endpoint, configurable: true, enumerable: false, writable: false });
  return () => {
    if (Object.getOwnPropertyDescriptor(target, ENDPOINT_KEY)?.value === endpoint) delete (target as any)[ENDPOINT_KEY];
    provider.close();
  };
}
