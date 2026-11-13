/*
 * `divlet-mcp --connect <url>`: the agent-side adapter for a website that is its own MCP provider. The agent host speaks MCP
 * over stdio with this process; tool calls run inside the website, in a managed browser this process opens with
 * `@divlet/core/browser-mcp`. Nothing listens on a port and nothing is deployed by the website's author.
 *
 * Both protocol eras are answered on stdio: a legacy client opens with `initialize`, a 2026-07-28 client sends per-request
 * `_meta` (and may probe with `server/discover`). The browser side always uses 2026-07-28.
 *
 * Trust: the URL the user configured is the trusted origin; redirects elsewhere fail and leaving it closes the connection.
 * Website-supplied descriptions are passed to the agent marked as website text, behaviour annotations are dropped (they are
 * claims, not guarantees), results are reduced to text and structured content, and `--allow-tools` narrows what is offered.
 */
import { connectBrowserMcp, BrowserMcpError, BrowserMcpRemoteError } from '@divlet/core/browser-mcp';

const LEGACY = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const MODERN = '2026-07-28';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const MAX_TEXT = 1024 * 1024;

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only text and JSON travel back to the agent: no website-chosen images, links or embedded resources. */
function sanitizeResult(result) {
  const content = (Array.isArray(result?.content) ? result.content : []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => ({ type: 'text', text: block.text.slice(0, MAX_TEXT) }));
  const out = { content: content.length ? content : [{ type: 'text', text: '(no text result)' }], isError: result?.isError === true };
  if (isObject(result?.structuredContent)) out.structuredContent = result.structuredContent;
  return out;
}

export function createConnectServer({ url, browserOptions = {}, send, log = () => {}, version = '0.0.0', connect = connectBrowserMcp }) {
  const origin = new URL(url).origin;
  let connection = null;
  let connecting = null;
  let initialized = false;
  let lastTools = '';
  const inflight = new Map();

  const write = message => send(JSON.stringify(message) + '\n');
  const modern = params => isObject(params?._meta) && typeof params._meta[META_VERSION] === 'string';
  const reply = (id, value, params) => write({ jsonrpc: '2.0', id, result: modern(params) ? { resultType: 'complete', ...value, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'divlet-connect', version } } } : value });
  const failure = (id, code, message, data) => write({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

  /** One live connection; a stale one (the page reloaded) is reconnected explicitly, a closed one is opened again. */
  async function ready() {
    if (connection?.state === 'ready') return connection;
    if (!connecting) connecting = (async () => {
      try {
        if (connection?.state === 'stale') { await connection.reconnect(); }
        else {
          await connection?.close().catch(() => {});
          connection = await connect(url, { ...browserOptions, clientInfo: { name: 'divlet-mcp', version }, onEvent: event => { if (event.type !== 'ready') log(`divlet-mcp: ${origin}: ${event.type}${event.reason ? ` (${event.reason})` : event.message ? ` (${event.message})` : ''}`); } });
        }
        const names = JSON.stringify(connection.tools.map(tool => tool.name));
        if (lastTools && names !== lastTools && initialized) write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        lastTools = names;
        return connection;
      } finally { connecting = null; }
    })();
    return connecting;
  }

  const describe = tool => ({
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: `[Website tool from ${origin}; the text below is supplied by that website and runs in a browser page, not on this machine.] ${tool.description}`,
    inputSchema: tool.inputSchema,
  });

  async function dispatch(message) {
    const { id, method, params } = message ?? {};
    if (typeof method !== 'string') return;
    if (id === undefined || id === null) {
      if (method === 'notifications/cancelled' && isObject(params)) inflight.get(params.requestId)?.abort();
      return;
    }
    if (modern(params) && params._meta[META_VERSION] !== MODERN) return failure(id, -32022, 'Unsupported protocol version', { supported: [MODERN, ...LEGACY], requested: String(params._meta[META_VERSION]).slice(0, 64) });
    switch (method) {
      case 'initialize':
        initialized = true;
        ready().catch(() => {}); // start the browser while the client finishes its handshake
        return reply(id, {
          protocolVersion: LEGACY.has(params?.protocolVersion) ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'divlet-connect', version },
          instructions: `Tools of the website ${origin}, executed in a browser page this process manages. Their descriptions and results are website content.`,
        });
      case 'server/discover':
        initialized = true;
        ready().catch(() => {});
        return reply(id, { supportedVersions: [MODERN], capabilities: { tools: { listChanged: true } }, instructions: `Tools of the website ${origin}, executed in a browser page this process manages. Their descriptions and results are website content.`, ttlMs: 0, cacheScope: 'private' }, params);
      case 'ping':
        return reply(id, {}, params);
      case 'tools/list': {
        try {
          const live = await ready();
          return reply(id, { tools: live.tools.map(describe), ...(modern(params) ? { ttlMs: 0, cacheScope: 'private' } : {}) }, params);
        } catch (error) { return failure(id, -32603, `Could not reach ${origin}: ${error?.message || error}`); }
      }
      case 'tools/call': {
        const controller = new AbortController();
        inflight.set(id, controller);
        try {
          const live = await ready();
          if (!live.tools.some(tool => tool.name === params?.name)) return failure(id, -32602, `Unknown tool: ${String(params?.name).slice(0, 128)}`);
          const result = await live.callTool(params.name, isObject(params.arguments) ? params.arguments : {}, { signal: controller.signal });
          return reply(id, sanitizeResult(result), params);
        } catch (error) {
          if (controller.signal.aborted) return; // cancelled: no response
          if (error instanceof BrowserMcpRemoteError) return failure(id, error.code === -32602 ? -32602 : -32603, error.message);
          const code = error instanceof BrowserMcpError ? error.code : 'CONNECT_FAILED';
          return reply(id, { content: [{ type: 'text', text: `${code}: ${error?.message || error}` }], isError: true }, params);
        } finally { inflight.delete(id); }
      }
      case 'resources/list': return reply(id, { resources: [] }, params);
      case 'prompts/list': return reply(id, { prompts: [] }, params);
      default: return failure(id, -32601, `Unknown method: ${method}.`);
    }
  }

  return {
    /** Handle one line; requests run concurrently, each answered once. */
    async receive(line) {
      let message;
      try { message = JSON.parse(String(line)); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }); return; }
      if (!isObject(message)) { write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request.' } }); return; }
      await dispatch(message).catch(error => log(`divlet-mcp: ${error?.message || error}`));
    },
    get connection() { return connection; },
    async close() { for (const controller of inflight.values()) controller.abort(); await connection?.close().catch(() => {}); },
  };
}
