/*
 * Owns: the agent side of the browser MCP transport — open a static website in a managed, isolated browser context, find the
 * page's MCP provider (`@divlet/web/mcp`), and exchange MCP protocol revision 2026-07-28 messages with it. Excludes: any
 * listening socket, relay or separately deployed MCP server; the browser is the execution environment and the page answers
 * only messages this side hands to it.
 *
 * The channel is a direct evaluation in the page: each message is JSON text passed to the page's endpoint and its reply comes
 * back as the evaluation result. No binding is exposed to the page, so website code has no function it can call on this
 * process; everything it returns is untrusted data, checked for size, shape and request correlation before use.
 *
 * Lifecycle is explicit. A connection is bound to one provider instance on one origin. A reload, a replaced provider or a
 * same-origin navigation makes it `stale` (pending calls are rejected, never retried) until `reconnect()` discovers the new
 * provider and lists its tools again; leaving the trusted origin, closing the page or losing the browser closes it.
 *
 * Playwright is loaded only when this module launches a browser (`playwright-core` is an optional peer); a caller may also
 * pass its own browser or context. Generic: nothing here knows divlet's tools.
 */

export const PROTOCOL_VERSION = '2026-07-28';
const ENDPOINT_PROTOCOL = 'browser-mcp/1';
const ENDPOINT_META = 'browser-mcp';
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** The page surface this module drives (a Playwright `Page`, typed locally so core needs no Playwright types). */
interface PageLike {
  goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded'; timeout?: number }): Promise<unknown>;
  url(): string;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  waitForFunction<A>(fn: (arg: A) => unknown, arg: A, options?: { timeout?: number; polling?: 'raf' | number }): Promise<unknown>;
  waitForLoadState(state?: 'load' | 'domcontentloaded', options?: { timeout?: number }): Promise<void>;
  mainFrame(): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  close(): Promise<void>;
  isClosed(): boolean;
  bringToFront?(): Promise<void>;
}
interface ContextLike { newPage(): Promise<PageLike>; close(): Promise<void>; on(event: string, listener: (...args: any[]) => void): unknown }
interface BrowserLike { newContext(options?: Record<string, unknown>): Promise<ContextLike>; close(): Promise<void>; on(event: string, listener: (...args: any[]) => void): unknown }

export type ConnectionState = 'connecting' | 'ready' | 'stale' | 'closed';

export interface ToolInfo {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}

export interface BrowserMcpOptions {
  /** Origins besides the URL's own that the page may redirect to. Default: none — a redirect elsewhere fails. */
  readonly allowedOrigins?: readonly string[];
  /** Which website-supplied tools the agent may call. Default: all listed tools (the URL itself is the user's explicit choice). */
  readonly allowTools?: readonly string[] | ((tool: ToolInfo) => boolean);
  readonly timeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly maxPending?: number;
  readonly maxTools?: number;
  readonly headless?: boolean;
  /** Reuse a caller-owned browser (a new isolated context is still created) or a caller-owned context. */
  readonly browser?: BrowserLike;
  readonly context?: ContextLike;
  /** A Chromium executable or Playwright channel to launch; by default the system Chrome, then Playwright's Chromium. */
  readonly executablePath?: string;
  readonly channel?: string;
  /** Opt-in persistent profile directory (so the site's IndexedDB survives restarts). Default: an ephemeral context. */
  readonly userDataDir?: string;
  readonly clientInfo?: { name: string; version: string };
  readonly onEvent?: (event: BrowserMcpEvent) => void;
}

export type BrowserMcpEvent =
  | { type: 'ready'; origin: string; instance: string; tools: number }
  | { type: 'stale'; reason: string }
  | { type: 'closed'; reason: string }
  | { type: 'warning'; message: string };

/** A local failure of this side (never a JSON-RPC error from the page). */
export class BrowserMcpError extends Error {
  readonly code: string;
  readonly data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'BrowserMcpError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** A JSON-RPC error the page returned. */
export class BrowserMcpRemoteError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'BrowserMcpRemoteError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export interface CallOptions { readonly signal?: AbortSignal; readonly timeoutMs?: number }

export interface BrowserMcpConnection {
  readonly url: string;
  readonly origin: string;
  readonly state: ConnectionState;
  /** The provider's `server/discover` result for the current instance (untrusted, page-supplied). */
  readonly discovery: Record<string, unknown> | null;
  /** Tools of the current provider instance that the trust policy allows. Descriptions are untrusted, page-supplied text. */
  readonly tools: readonly ToolInfo[];
  /** Send one MCP request; per-request `_meta` is attached. Resolves with the result object. */
  request(method: string, params?: Record<string, unknown>, options?: CallOptions): Promise<Record<string, unknown>>;
  /** `tools/call` for an allowed tool. Resolves with the MCP `CallToolResult`. */
  callTool(name: string, args?: Record<string, unknown>, options?: CallOptions): Promise<Record<string, unknown>>;
  /** Re-discover after a reload (or navigate back to the URL when the page is gone from it); refreshes the tool list. */
  reconnect(): Promise<void>;
  close(): Promise<void>;
  /** The managed page, for an embedding harness that shows or screenshots it. */
  readonly page: PageLike;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const originOf = (href: string): string => { try { return new URL(href).origin; } catch { return 'null'; } };

async function launchBrowser(options: BrowserMcpOptions): Promise<{ browser?: BrowserLike; context: ContextLike; owned: () => Promise<void> }> {
  if (options.context) return { context: options.context, owned: async () => {} };
  // Isolation: a fresh context per connection — no ordinary profile, cookies, permissions or downloads.
  const contextOptions = { acceptDownloads: false, permissions: [], serviceWorkers: 'allow', viewport: { width: 1440, height: 900 } };
  if (options.browser) {
    const context = await options.browser.newContext(contextOptions);
    return { context, owned: () => context.close().catch(() => {}) };
  }
  let playwright: any;
  try { playwright = await import('playwright-core'); }
  catch { throw new BrowserMcpError('BROWSER_UNAVAILABLE', 'Connecting to a website needs playwright-core (npm install playwright-core) and a Chromium-based browser.'); }
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  const headless = options.headless ?? true;
  const attempts: Array<Record<string, unknown>> = options.executablePath ? [{ executablePath: options.executablePath }]
    : options.channel ? [{ channel: options.channel }]
    : [{ channel: 'chrome' }, {}, { channel: 'msedge' }];
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      if (options.userDataDir) {
        const context = await chromium.launchPersistentContext(options.userDataDir, { ...attempt, headless, ...contextOptions });
        return { context, owned: () => context.close().catch(() => {}) };
      }
      const browser: BrowserLike = await chromium.launch({ ...attempt, headless });
      const context = await browser.newContext(contextOptions);
      return { browser, context, owned: () => browser.close().catch(() => {}) };
    } catch (error) { failures.push(String((error as Error)?.message || error).split('\n')[0] ?? ''); }
  }
  throw new BrowserMcpError('BROWSER_UNAVAILABLE', `No Chromium-based browser could be launched: ${failures.join(' | ')}`);
}

/** The in-page half of one exchange. Serialized into the page: it must not reference anything outside itself. */
function pageExchange({ key, instance, text }: { key: string; instance: string | null; text: string | null }): Promise<{ instance: string | null; protocol: unknown; reply?: unknown }> | { instance: string | null; protocol: unknown } {
  const endpoint = (globalThis as any)[Symbol.for(key)];
  const current = endpoint && typeof endpoint.instance === 'string' ? endpoint.instance : null;
  const protocol = endpoint ? endpoint.protocol : null;
  if (!endpoint || text === null || current !== instance || typeof endpoint.handle !== 'function') return { instance: current, protocol };
  return Promise.resolve(endpoint.handle(text)).then(reply => ({ instance: current, protocol, reply }));
}

/** Open `url` and connect to its browser MCP provider. */
export async function connectBrowserMcp(url: string, options: BrowserMcpOptions = {}): Promise<BrowserMcpConnection> {
  let target: URL;
  try { target = new URL(url); } catch { throw new BrowserMcpError('INVALID_URL', `Not a URL: ${String(url).slice(0, 200)}`); }
  if (!['https:', 'http:'].includes(target.protocol)) throw new BrowserMcpError('INVALID_URL', 'Only http(s) websites can be connected.');
  if (target.username || target.password) throw new BrowserMcpError('INVALID_URL', 'Credentials in the URL are not sent to a website.');
  const origin = target.origin;
  const trusted = new Set([origin, ...(options.allowedOrigins ?? []).map(originOf)]);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const maxMessageBytes = options.maxMessageBytes ?? 4 * 1024 * 1024;
  const maxPending = options.maxPending ?? 64;
  const maxTools = options.maxTools ?? 256;
  const clientInfo = options.clientInfo ?? { name: 'browser-mcp-transport', version: '1' };
  const emit = (event: BrowserMcpEvent) => { try { options.onEvent?.(event); } catch { /* observers cannot break the connection */ } };

  const { context, owned } = await launchBrowser(options);
  let page: PageLike;
  try { page = await context.newPage(); }
  catch (error) { await owned(); throw error; }

  let state: ConnectionState = 'connecting';
  let instance: string | null = null;
  let discovery: Record<string, unknown> | null = null;
  let tools: ToolInfo[] = [];
  let sequence = 0;
  let generation = 0;
  const pending = new Map<string, { reject: (error: Error) => void; generation: number }>();

  const failPending = (error: BrowserMcpError, only?: number) => {
    for (const [id, entry] of pending) if (only === undefined || entry.generation === only) { pending.delete(id); entry.reject(error); }
  };
  const markStale = (reason: string) => {
    if (state !== 'ready') return;
    state = 'stale';
    instance = null;
    generation++;
    failPending(new BrowserMcpError('PROVIDER_RELOADED', `The website's provider is gone (${reason}); reconnect to continue. The call may or may not have completed.`));
    emit({ type: 'stale', reason });
  };
  let closing: Promise<void> | null = null;
  let closedBy: BrowserMcpError | null = null;
  const shutdown = (reason: string, cause?: BrowserMcpError) => {
    if (closing) return closing;
    closedBy = cause ?? null;
    state = 'closed';
    instance = null;
    generation++;
    failPending(new BrowserMcpError('CLOSED', `The connection closed (${reason}).`));
    emit({ type: 'closed', reason });
    closing = (async () => { if (!page.isClosed()) await page.close().catch(() => {}); await owned(); })();
    return closing;
  };

  // Every main-frame navigation retires the current provider; leaving the trusted origins ends the connection.
  page.on('framenavigated', (frame: unknown) => {
    if (frame !== page.mainFrame()) return;
    if (!trusted.has(originOf(page.url()))) {
      const text = `the page navigated to an untrusted origin: ${originOf(page.url())}`;
      void shutdown(text, new BrowserMcpError('ORIGIN_CHANGED', `The website moved to an untrusted origin (${originOf(page.url())}); its authority was not transferred.`));
      return;
    }
    markStale('the page navigated or reloaded');
  });
  page.on('close', () => { void shutdown('the page closed'); });
  page.on('crash', () => { void shutdown('the page crashed'); });
  context.on('close', () => { void shutdown('the browser context closed'); });

  async function exchange(message: Record<string, unknown>, expectReply: boolean, at: number): Promise<Record<string, unknown> | null> {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > maxMessageBytes) throw new BrowserMcpError('MESSAGE_TOO_LARGE', `The request exceeds ${maxMessageBytes} bytes.`);
    let answer: unknown;
    try { answer = await page.evaluate(pageExchange, { key: ENDPOINT_PROTOCOL, instance, text }); }
    catch (error) {
      if (at !== generation || state !== 'ready') throw new BrowserMcpError(state === 'closed' ? 'CLOSED' : 'PROVIDER_RELOADED', 'The website reloaded or closed while the call was running.');
      markStale(`the page evaluation failed: ${String((error as Error)?.message || error).split('\n')[0]}`);
      throw new BrowserMcpError('PROVIDER_RELOADED', 'The website reloaded while the call was running.');
    }
    if (at !== generation) throw new BrowserMcpError(state === 'closed' ? 'CLOSED' : 'PROVIDER_RELOADED', 'The provider changed while the call was running.');
    if (!isObject(answer) || answer.instance !== instance || !('reply' in answer)) { markStale('the provider instance was replaced'); throw new BrowserMcpError('PROVIDER_RELOADED', 'The website replaced its provider; reconnect to continue.'); }
    const reply = answer.reply;
    if (reply === null) {
      if (expectReply) throw new BrowserMcpError('NO_RESPONSE', 'The provider sent no response to a request.');
      return null;
    }
    if (typeof reply !== 'string' || Buffer.byteLength(reply) > maxMessageBytes) throw new BrowserMcpError('MESSAGE_TOO_LARGE', `The website's response is not text of at most ${maxMessageBytes} bytes.`);
    let parsed: unknown;
    try { parsed = JSON.parse(reply); } catch { throw new BrowserMcpError('PROTOCOL_VIOLATION', 'The website answered with invalid JSON.'); }
    if (!isObject(parsed) || parsed.jsonrpc !== '2.0' || parsed.id !== message.id || (!('result' in parsed) === !('error' in parsed))) throw new BrowserMcpError('PROTOCOL_VIOLATION', 'The website answered with a response that does not match the request.');
    return parsed;
  }

  async function rawRequest(method: string, params: Record<string, unknown> = {}, { signal, timeoutMs: limit = timeoutMs }: CallOptions = {}, allowConnecting = false): Promise<Record<string, unknown>> {
    if (state !== 'ready' && !(allowConnecting && state === 'connecting')) throw new BrowserMcpError(state === 'closed' ? 'CLOSED' : 'STALE', state === 'closed' ? 'The connection is closed.' : 'The website reloaded; reconnect before calling it again.');
    if (pending.size >= maxPending) throw new BrowserMcpError('TOO_MANY_PENDING', `At most ${maxPending} requests may be outstanding.`);
    if (signal?.aborted) throw new BrowserMcpError('CANCELLED', 'The call was cancelled before it was sent.');
    const id = `bm-${++sequence}`;
    const at = generation;
    const meta = { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION, 'io.modelcontextprotocol/clientInfo': clientInfo, 'io.modelcontextprotocol/clientCapabilities': {} };
    const userMeta = isObject(params._meta) ? params._meta : {};
    const message = { jsonrpc: '2.0', id, method, params: { ...params, _meta: { ...userMeta, ...meta } } };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); pending.delete(id); fn(); };
      const cancel = (code: string, text: string) => finish(() => {
        reject(new BrowserMcpError(code, text));
        // Best effort: tell the provider to stop. A notification has no reply; failures here change nothing.
        if (state === 'ready' && generation === at) exchange({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: text } }, false, at).catch(() => {});
      });
      const onAbort = () => cancel('CANCELLED', 'The call was cancelled.');
      const timer = setTimeout(() => cancel('TIMEOUT', `${method} did not answer within ${limit} ms.`), limit);
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, { generation: at, reject: error => finish(() => reject(error)) });
      exchange(message, true, at).then(reply => finish(() => {
        if (!reply) return reject(new BrowserMcpError('NO_RESPONSE', 'The provider sent no response.'));
        if ('error' in reply) {
          const error = isObject(reply.error) ? reply.error : {};
          return reject(new BrowserMcpRemoteError(Number.isInteger(error.code) ? error.code as number : -32603, String(error.message ?? 'The website reported an error.').slice(0, 4000), error.data));
        }
        if (!isObject(reply.result)) return reject(new BrowserMcpError('PROTOCOL_VIOLATION', 'The website answered without a result object.'));
        const resultType = reply.result.resultType ?? 'complete';
        if (resultType !== 'complete') return reject(new BrowserMcpError('UNSUPPORTED_RESULT', `The website answered with resultType ${JSON.stringify(resultType)}, which this transport does not support.`));
        resolve(reply.result);
      }), error => finish(() => reject(error)));
    });
  }

  const allowed = (tool: ToolInfo): boolean => {
    const policy = options.allowTools;
    if (!policy) return true;
    return typeof policy === 'function' ? !!policy(tool) : policy.includes(tool.name);
  };

  function admitTools(list: unknown): ToolInfo[] {
    if (!Array.isArray(list)) throw new BrowserMcpError('PROTOCOL_VIOLATION', 'tools/list did not return a tool array.');
    const seen = new Set<string>();
    const out: ToolInfo[] = [];
    for (const item of list.slice(0, maxTools)) {
      if (!isObject(item) || typeof item.name !== 'string' || !TOOL_NAME.test(item.name) || seen.has(item.name) || typeof item.description !== 'string' || !isObject(item.inputSchema) || item.inputSchema.type !== 'object') {
        emit({ type: 'warning', message: `Ignored an invalid tool definition${isObject(item) && typeof item.name === 'string' ? ` (${item.name.slice(0, 128)})` : ''}.` });
        continue;
      }
      seen.add(item.name);
      const tool: ToolInfo = {
        name: item.name,
        ...(typeof item.title === 'string' ? { title: item.title.slice(0, 256) } : {}),
        description: item.description.slice(0, 16_384),
        inputSchema: item.inputSchema,
        ...(isObject(item.annotations) ? { annotations: item.annotations } : {}),
      };
      if (allowed(tool)) out.push(tool);
    }
    if (list.length > maxTools) emit({ type: 'warning', message: `Only the first ${maxTools} tools were admitted.` });
    return out;
  }

  /** Wait for the page's provider, then discover it and list its tools. */
  async function attach(): Promise<void> {
    state = 'connecting';
    if (!trusted.has(originOf(page.url()))) throw new BrowserMcpError('ORIGIN_CHANGED', `The website moved to an untrusted origin (${originOf(page.url())}); it was not connected.`);
    const probe = () => page.evaluate(pageExchange, { key: ENDPOINT_PROTOCOL, instance: null, text: null });
    let found = await probe();
    if (!found.instance) {
      // An observable signal, not a fixed delay: pages that announce a provider get the ready timeout; others fail after load.
      const announced = await page.evaluate(name => !!(globalThis as any).document?.querySelector(`meta[name="${name}"]`), ENDPOINT_META);
      if (!announced) await page.waitForLoadState('load', { timeout: readyTimeoutMs }).catch(() => {});
      if (announced || !(await probe()).instance) {
        if (!announced) throw new BrowserMcpError('NO_PROVIDER', 'The website does not expose a browser MCP provider.');
        await page.waitForFunction(key => { const endpoint = (globalThis as any)[Symbol.for(key)]; return !!endpoint && typeof endpoint.instance === 'string'; }, ENDPOINT_PROTOCOL, { timeout: readyTimeoutMs })
          .catch(() => { throw new BrowserMcpError('NO_PROVIDER', `The website announced a provider but did not publish it within ${readyTimeoutMs} ms.`); });
      }
      found = await probe();
    }
    if (found.protocol !== ENDPOINT_PROTOCOL || !found.instance) throw new BrowserMcpError('NO_PROVIDER', 'The website exposes an incompatible provider endpoint.');
    instance = found.instance;
    generation++;
    discovery = await rawRequest('server/discover', {}, { timeoutMs: readyTimeoutMs }, true).catch(error => {
      if (error instanceof BrowserMcpRemoteError && error.code === -32022) throw new BrowserMcpError('UNSUPPORTED_PROTOCOL', `The website does not support MCP ${PROTOCOL_VERSION}.`, error.data);
      throw error;
    });
    if (!Array.isArray(discovery.supportedVersions) || !discovery.supportedVersions.includes(PROTOCOL_VERSION)) throw new BrowserMcpError('UNSUPPORTED_PROTOCOL', `The website does not support MCP ${PROTOCOL_VERSION}.`, { supported: discovery.supportedVersions });
    if (!isObject(discovery.capabilities) || !isObject(discovery.capabilities.tools)) throw new BrowserMcpError('NO_TOOLS', 'The website provider does not offer tools.');
    tools = admitTools((await rawRequest('tools/list', {}, { timeoutMs: readyTimeoutMs }, true)).tools);
    state = 'ready';
    emit({ type: 'ready', origin: originOf(page.url()), instance, tools: tools.length });
  }

  try {
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: readyTimeoutMs });
    if (!trusted.has(originOf(page.url()))) throw new BrowserMcpError('ORIGIN_CHANGED', `The website redirected to an untrusted origin (${originOf(page.url())}); it was not connected.`);
    await attach();
  } catch (error) {
    const cause = closedBy as BrowserMcpError | null;
    await shutdown(`connection failed: ${(error as Error)?.message || error}`);
    if (cause) throw cause;
    throw error instanceof BrowserMcpError || error instanceof BrowserMcpRemoteError ? error : new BrowserMcpError('CONNECT_FAILED', String((error as Error)?.message || error).split('\n')[0] ?? 'Connection failed.');
  }

  const connection: BrowserMcpConnection = {
    url: target.href,
    origin,
    page,
    get state() { return state; },
    get discovery() { return discovery; },
    get tools() { return tools; },
    request: (method, params, callOptions) => rawRequest(method, params, callOptions),
    async callTool(name, args = {}, callOptions) {
      if (!tools.some(tool => tool.name === name)) throw new BrowserMcpError('TOOL_NOT_ALLOWED', `The website tool ${String(name).slice(0, 128)} is not available on this connection.`);
      return rawRequest('tools/call', { name, arguments: args }, callOptions);
    },
    async reconnect() {
      if (state === 'closed') throw new BrowserMcpError('CLOSED', 'The connection is closed; connect again.');
      if (state === 'ready') markStale('reconnect requested');
      try {
        if (!trusted.has(originOf(page.url()))) await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: readyTimeoutMs });
        else await page.waitForLoadState('domcontentloaded', { timeout: readyTimeoutMs }).catch(() => {});
        await attach();
      } catch (error) {
        if ((state as ConnectionState) !== 'closed') { state = 'stale'; instance = null; }
        throw error;
      }
    },
    close: () => shutdown('closed by the client'),
  };
  return connection;
}

/**
 * An SDK-shaped `Transport` (start/send/close/onmessage/onclose/onerror) over one connection, for an MCP client library that
 * accepts custom transports. It carries messages as they are; the client attaches its own per-request `_meta`. When the
 * provider goes stale or closes, the transport closes, so the client rejects its pending requests and must connect again.
 */
export function browserMcpTransport(connection: BrowserMcpConnection) {
  let closed = false;
  // The client's request ids are its own; cancellation is routed to the matching in-flight call through its signal.
  const inflight = new Map<unknown, AbortController>();
  const transport = {
    onmessage: undefined as ((message: unknown) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    async start() { if (connection.state !== 'ready') throw new BrowserMcpError('STALE', 'The connection is not ready.'); },
    async send(message: unknown) {
      if (closed) throw new BrowserMcpError('CLOSED', 'The transport is closed.');
      if (!isObject(message)) throw new BrowserMcpError('INVALID_MESSAGE', 'A JSON-RPC message must be an object.');
      if (typeof message.method !== 'string') return; // this provider never sends requests, so there are no responses to deliver
      if (message.id === undefined) {
        const params = isObject(message.params) ? message.params : {};
        if (message.method === 'notifications/cancelled') inflight.get(params.requestId)?.abort();
        return;
      }
      const { _meta, ...rest } = isObject(message.params) ? message.params : {} as Record<string, unknown>;
      const id = message.id;
      const controller = new AbortController();
      inflight.set(id, controller);
      try {
        const result = await connection.request(message.method, { ...rest, ...(isObject(_meta) ? { _meta } : {}) }, { signal: controller.signal });
        if (!closed) transport.onmessage?.({ jsonrpc: '2.0', id, result });
      } catch (error) {
        if (closed || controller.signal.aborted) return; // a cancelled request gets no response
        if (error instanceof BrowserMcpRemoteError) transport.onmessage?.({ jsonrpc: '2.0', id, error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } });
        else { transport.onerror?.(error as Error); if (connection.state !== 'ready') await transport.close(); }
      } finally {
        inflight.delete(id);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
      transport.onclose?.();
    },
  };
  return transport;
}
