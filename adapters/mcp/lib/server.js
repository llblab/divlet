/*
 * The MCP side of the shared contract: JSON-RPC 2.0 over stdio (MCP's stdio transport), with `tools/list` rendered from
 * `core/lib/contract.ts` and `tools/call` running the same operations Pi runs. Nothing here knows about layouts: it translates
 * MCP's messages into contract calls and the results back into MCP content blocks.
 *
 * When the client supports `sampling`, a request typed on the board is sent to that client as `sampling/createMessage` and the
 * answer is written back to the board, so the Agent tab works with an MCP client as the agent.
 *
 * MCP traffic never touches the browser preview channel. When this process owns a board it also registers it (runtime.js), so a
 * Pi session, another MCP client or the CLI attaches to the same board instead of opening a second writer; when it does not own
 * the board, tool calls are forwarded to the owner over that board's token-scoped HTTP API.
 */
import { createSession, forAgent, inputSchema, openView, toolList, S, optional } from '../../../core/lib/contract.ts';
import { openRuntime } from '../../../core/lib/runtime.js';
import { makeHost } from '../../../core/lib/launch.ts';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const SERVER_NAME = 'divlet';

/** The result envelope every MCP tool call returns: the same agent vocabulary Pi uses, as text. */
const answer = value => ({ content: [{ type: 'text', text: JSON.stringify(forAgent(value), null, 2) }] });
/** A domain refusal is a tool error, not a protocol error: the code and the message travel in the text. */
const refusal = error => ({ content: [{ type: 'text', text: `${error.code || 'ERROR'}: ${error.message}${error.details ? `\n${JSON.stringify(error.details, null, 2)}` : ''}` }], isError: true });

/** Start (or reuse) a board in this process; it registers itself, so other clients attach to it. */
export function localBoardOpener({ hubs = new Map() } = {}) {
  const boards = new Map();
  const opening = new Map();
  const open = async ({ file, args = {} } = {}) => {
    const key = file;
    if (boards.has(key)) return boards.get(key);
    if (!opening.has(key)) {
      opening.set(key, openRuntime({ cwd: file ? undefined : process.cwd(), file, port: args.port ?? 0, createDemo: args.createDemo ?? true, externalFiles: args.externalFiles })
        .then(runtime => { runtime.host = makeHost({ openBoard: location => open(location), hubs }); boards.set(key, runtime); return runtime; })
        .finally(() => opening.delete(key)));
    }
    return opening.get(key);
  };
  return open;
}

/**
 * The MCP server: reads newline-delimited JSON-RPC messages, writes one response per request. `send` is injected so tests and
 * hosts can capture traffic; the entry point passes a stdout writer.
 */
export function createMcpServer({ session, argv = {}, send, log = () => {} }) {
  const tools = toolList();
  const toolByName = new Map(tools.map(tool => [tool.name, tool]));
  let initialized = false;
  let sampling = false;
  let nextRequestId = 1;
  const pending = new Map();

  const write = (message) => send(JSON.stringify(message) + '\n');

  /** A request *to* the client (MCP is bidirectional): resolves with its result, rejects with its error. */
  function request(method, params, { timeout = 120_000 } = {}) {
    const id = `divlet-${nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`${method} timed out.`), { code: 'TIMEOUT' })); }, timeout);
      timer.unref?.();
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      write({ jsonrpc: '2.0', id, method, params });
    });
  }

  const result = (id, value) => write({ jsonrpc: '2.0', id, result: value });
  const failure = (id, code, message, data) => write({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

  async function dispatch(message) {
    const { id, method, params } = message ?? {};
    const notification = id === undefined || id === null;
    if (typeof method !== 'string') { if (!notification) failure(id, -32600, 'Invalid request: method must be a string.'); return; }
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        initialized = true;
        sampling = !!params?.capabilities?.sampling;
        return result(id, {
          protocolVersion: SUPPORTED.has(requested) ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: argv.version || '0.0.0' },
          instructions: 'divlet edits a local layout project (one .divlet file of HTML elements with Tailwind classes). Call open_divlet first, then read_divlet before patch_divlet or edit_divlet.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return;
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return result(id, { tools: tools.map(tool => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: inputSchema(tool) })) });
      case 'tools/call': {
        const name = params?.name;
        const tool = toolByName.get(name);
        if (!tool) return failure(id, -32602, `Unknown tool: ${name}.`);
        try {
          // `open_divlet` inherits the server's own defaults (--project, --port, --no-demo) unless the call overrides them.
          const args = name === 'open_divlet'
            ? { path: argv.project, port: argv.port, createDemo: argv.createDemo, ...(params?.arguments ?? {}) }
            : (params?.arguments ?? {});
          const value = await session.call(name, args, { cwd: argv.cwd });
          return result(id, answer(name === 'open_divlet' ? openView(value) : value));
        } catch (error) {
          return result(id, refusal(error));
        }
      }
      case 'resources/list':
        return result(id, { resources: [] });
      case 'prompts/list':
        return result(id, { prompts: [] });
      default:
        return failure(id, -32601, `Unknown method: ${method}.`);
    }
  }

  let queue = Promise.resolve();
  return {
    /** Feed one line (a JSON-RPC message) and await its handling. */
    async receive(line) {
      const text = String(line).trim();
      if (!text) return;
      let message;
      try { message = JSON.parse(text); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }); return; }
      // A reply to one of our own requests (sampling) is not a method call: settle it here.
      if (message && typeof message.method !== 'string' && message.id !== undefined) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (!waiter) return;
        if (message.error) waiter.reject(Object.assign(new Error(message.error.message || 'The client refused the request.'), { code: message.error.code, data: message.error.data }));
        else waiter.resolve(message.result);
        return;
      }
      queue = queue.then(() => dispatch(message)).catch(error => { log(`divlet mcp: ${error?.message || error}`); });
      await queue;
    },
    /** Whether the connected client said it can run a prompt for us (`sampling`). */
    get sampling() { return sampling; },
    request,
    get initialized() { return initialized; },
    tools,
  };
}

/** The text of a `sampling/createMessage` result (a client may answer with one block or a list of them). */
export function samplingText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : result?.content ? [result.content] : [];
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
}

/**
 * Make this server the agent of a board it owns: the Agent tab on that board becomes a real conversation, answered by the MCP
 * client through `sampling/createMessage`. Without client sampling support the board keeps saying that no agent is connected.
 */
export function wireBoardAgent(runtime, server, { log = () => {} } = {}) {
  if (!runtime || typeof runtime.on !== 'function') return;
  runtime.setAgent({ connected: true, busy: false, activity: null });
  runtime.on('ask', async ({ message, seq }) => {
    if (!server.sampling) {
      runtime.say({ text: 'This MCP client does not support sampling, so it cannot answer board requests. Connect a client that does, or open the board from Pi.', seq });
      return;
    }
    runtime.setAgent({ busy: true, activity: 'thinking' });
    try {
      const result = await server.request('sampling/createMessage', {
        messages: [{ role: 'user', content: { type: 'text', text: message } }],
        maxTokens: 4096,
        systemPrompt: 'You are the agent of a divlet layout board. Answer in a few sentences. Use the divlet tools (read_divlet, patch_divlet, edit_divlet) when the request asks for a change; style with Tailwind classes.',
      });
      const text = samplingText(result);
      runtime.say({ text: text || 'The client returned no text answer.', seq });
    } catch (error) {
      log(`divlet mcp: sampling failed: ${error?.message || error}`);
      runtime.say({ text: `The MCP client could not answer: ${error?.message || error}`, seq });
    } finally {
      runtime.setAgent({ busy: false, activity: null });
    }
  });
}

export { createSession, S, optional };
