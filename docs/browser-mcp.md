# Browser-hosted MCP

**Status: implemented for tools; deployed on GitHub Pages; `--connect` ships with `@divlet/mcp` 0.0.3.** A static website can be an executable MCP provider: its tools run in the visitor's (or the agent's) browser, and a local agent connects by URL. The divlet GitHub Pages build is the first such provider — the real board, opening the canonical landing project, with the same contract tools Pi and the local MCP adapter offer. No MCP server is deployed for it. From a checkout: `node scripts/source.mjs mcp/index.js --connect <url>`.

```bash
# Register in any MCP host (Claude Code, an editor, a script). Tools run in a managed browser page, not on this machine.
npx -y @divlet/mcp --connect https://llblab.github.io/divlet/
```

A completely unmodified MCP client cannot speak to a static site: something on the agent side must supply the browser runtime and this transport. Here that is `@divlet/mcp --connect` (for any stdio MCP host) or `@divlet/core/browser-mcp` (for a harness that integrates it directly). What disappears is the website author's server, not the agent-side adapter.

## Layers

```text
agent host (MCP client) ── stdio ──▶ divlet-mcp --connect        @divlet/mcp       mcp/lib/connect.js
                                       │  connectBrowserMcp(url)   @divlet/core      core/lib/browser-mcp.ts
                                       ▼  page.evaluate(JSON text)  (Playwright, isolated context, no bindings)
                   static website ──▶ globalThis[Symbol.for('browser-mcp/1')]
                                       │  createBrowserMcpProvider  @divlet/web/mcp   web/lib/mcp-provider.ts
                                       │  defineTools (one registry) ────────────────  web/lib/mcp-tools.ts
                                       │  registerWebMcpTools (optional) ─────────────  web/lib/webmcp.ts
                                       ▼
                   application core: the tool's own operations (divlet: BrowserRuntime + board ports)
```

- **Tool registry** (`defineTools`): one canonical list of `{ name, title, description, inputSchema, annotations, execute(args, { signal }) }`. Input is validated by a bounded JSON Schema 2020-12 subset (`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `anyOf`, `oneOf`, numeric/length/item bounds); any other keyword is refused when the tool is defined, so a schema never claims validation it does not get. Execution has a deadline, an abort signal and a byte budget for the JSON result. The MCP provider and the WebMCP adapter both call the same `run`.
- **Browser MCP provider** (`createBrowserMcpProvider`, `exposeBrowserMcp`): a JSON-RPC 2.0 handler for MCP **2026-07-28** and nothing older. Implemented: `server/discover`, `tools/list`, `tools/call`, `notifications/cancelled`. It needs no Node, backend, extension or experimental API, and calls nothing outside the page.
- **Browser MCP transport** (`connectBrowserMcp`, `browserMcpTransport`): opens the URL in a managed Chromium, finds the endpoint, and exchanges messages by evaluating JSON text in the page. `browserMcpTransport(connection)` adapts a connection to the official TypeScript SDK's `Transport` interface.
- **WebMCP adapter** (`registerWebMcpTools`): registers the same registry with `document.modelContext.registerTool(tool, { signal })` when the browser provides it (WebMCP Community Group draft, 12 November 2026). Absent API → nothing is installed or emulated, and the MCP provider keeps working. WebMCP defines tools only; MCP resources/prompts are not mapped.

## Protocol revision

Revision 2026-07-28 is stateless: there is no `initialize`. Every request carries `_meta["io.modelcontextprotocol/protocolVersion"]` and `_meta["io.modelcontextprotocol/clientCapabilities"]` (missing → `-32602`); another version → `-32022` with `{ supported, requested }`. Results carry `resultType: "complete"` and `_meta["io.modelcontextprotocol/serverInfo"]`; discovery and list results carry `ttlMs: 0` and `cacheScope: "private"` (the tool set belongs to one page instance). Unknown tools are `-32602`; argument and domain refusals are tool results with `isError: true` and `structuredContent.error = { code, message, details? }`. A legacy `initialize` is refused with the supported versions named. Too many concurrent calls → `-31001` (application-defined, outside the reserved range). Cancelled calls get no response. The official SDK client (`@modelcontextprotocol/client` 2.4, `versionNegotiation: { mode: { pin: '2026-07-28' } }`) interoperates through both an in-memory and the browser transport.

`divlet-mcp --connect` answers both eras on its stdio side (legacy `initialize` clients and 2026-07-28 clients) and always uses 2026-07-28 toward the page.

## Discovery and connection

The discovery contract is project-specific and versioned (`browser-mcp/1`), not an MCP standard:

- The page publishes `globalThis[Symbol.for('browser-mcp/1')] = { protocol: 'browser-mcp/1', instance, handle(text) }` — non-enumerable, non-writable, a fresh random `instance` per provider. `handle` takes one JSON-RPC message as text and resolves to the response text (or `null`).
- An optional `<meta name="browser-mcp" content="browser-mcp/1">` says a provider is coming. With it, the transport waits (bounded, observable polling) for asynchronous initialization; without it, a page that has no endpoint after `load` fails fast with `NO_PROVIDER`. The meta tag carries no tool definitions — the only tool list is the one the live provider returns.

`connectBrowserMcp(url)` navigates, requires the final URL to stay on the requested origin (plus explicit `allowedOrigins`), waits for the endpoint, calls `server/discover` (refusing a provider without 2026-07-28 or without tools) and `tools/list`, then admits well-formed tools (name syntax, object input schema, bounded text) through the caller's `allowTools` policy. Repository subpaths work: every URL the application uses is relative.

## Lifecycle

| State | Kept separately |
| --- | --- |
| Agent state | The MCP host's conversation; never in the page. |
| Transport state | One connection = one origin + one provider `instance`; pending requests with ids, deadlines and abort signals. |
| Browser context | An isolated Playwright context per connection by default (no ordinary profile, cookies, permissions or downloads); `userDataDir` opts into a persistent profile. |
| Application state | Whatever the page keeps (divlet: one in-memory accepted project state, its history and selection). |
| Persistent storage | The page's own (divlet: IndexedDB in that browser profile). |

Any main-frame navigation or reload, or a replaced provider instance, makes the connection **stale**: every pending call is rejected with `PROVIDER_RELOADED` (it may or may not have completed; it is never retried), new calls fail with `STALE`, and `reconnect()` waits for the new provider and lists its tools again. Navigation to an untrusted origin, page close, crash or context loss **closes** the connection (`CLOSED`); authority is never transferred. `--connect` reconnects a stale page on the next call and emits `notifications/tools/list_changed` when the tool set changed. Pending requests are bounded (`maxPending`), each has a timeout and cancellation sends `notifications/cancelled` to the page.

## Security boundaries

- **No host privilege from the page.** The transport exposes no binding, function or route to the page; it only evaluates a fixed exchange function and reads its JSON text. Website code cannot call anything on the agent's machine, and the hostile-page test checks that no host functions appear.
- **Website text is data.** Tool descriptions, discovery instructions, results and errors are untrusted. `--connect` prefixes each description with its origin and "supplied by that website", drops behaviour annotations (claims, not guarantees), returns only text and JSON content (no website-chosen images, links or embedded resources) and caps text size.
- **Explicit trust.** The URL the user configures is the trusted origin; redirects elsewhere fail with `ORIGIN_CHANGED`; `--allow-tools` narrows what is offered. Per-call consent is the agent host's own tool-approval prompt, which applies to these tools like any other MCP tools.
- **Bounded traffic.** Request and response text are size-limited in both directions, replies must match the request id and JSON-RPC shape (`PROTOCOL_VIOLATION` otherwise), and `resultType`s other than `complete` are refused.
- **Isolation.** A fresh browser context per connection by default; nothing from the user's ordinary browser profile is used.

The page's own power is the browser's: it can do in its origin what any website can, and its storage is that browser profile's. A `--connect` session therefore shares state with a human only when both use the same page (the window `--connect` shows by default) — not automatically with the user's everyday browser.

## divlet on GitHub Pages

`scripts/pages-build.mjs` builds the public set: the real board client (`web/`), a bundled browser host (`core/lib/browser-board.ts`: `BrowserRuntime`, the board's writer/preview/export ports, the MCP provider and WebMCP registration), `project.divlet` (the canonical landing), `styles.json` (CSS compiled at build time by the local engine), a static `preview-bridge.js`, the prepared landing page under `page/`, and `.nojekyll`. `index.html` carries a hash-based meta CSP (Pages cannot send headers) and the `browser-mcp` hint.

- **One writer, shared vectors.** `BrowserRuntime` runs the same `divlet_read`, `divlet_patch`, `divlet_edit`, `divlet_frame_manage`, `divlet_undo` and `divlet_mark` from `core/lib/tools.ts` over the shared validation, operations, component expansion, preparation, diff and acceptance modules. `core/tests/browser-runtime.test.js` drives the same calls through it and the Node runtime and requires identical models, pages, refusals, history and serialized projects. Its orchestration still mirrors `runtime.js` rather than sharing one writer class (backlog).
- **Human and agent edit one state.** Board edits go through the same writer; selection and measured geometry are shared, so an agent's `view:selection` and `view:preview` see what the visitor selected and sees. Agent calls show in the activity plaque and History as `agent` changes.
- **First visit.** A visitor with no saved view of the project reads the landing frame expanded at the window's width (a phone gets the phone layout); "Edit on the board" goes back to the canvas, whose view is then remembered. The expanded page keeps receiving live renders, so agent edits appear while it is read.
- **Storage.** The visitor's copy lives in IndexedDB (key: page path + project), tied to the fingerprint of the published source; a new publication starts a fresh copy. "Download project file" saves it as a `.divlet` for the local host. Undo history belongs to the page instance.
- **Absent here, by design.** Opening other files, save-as, build output, image/font upload and embedded asset bytes (`ASSETS_UNAVAILABLE`), Markdown sites, utility compilation (new utility classes are reported as unstyled; use frame CSS or inline style) and the board conversation (`agent.conversation: false`; the Agent tab offers the `--connect` command instead).

Deploy: push to `main`; `.github/workflows/landing.yml` checks the landing source/cache, runs the unit checks and `web/tests/pages.mjs` against the built set on a static server, then copies the set to the `gh-pages` root only when its fingerprint (`.pages-hash`) changed. Configure Pages to serve the `gh-pages` branch root. A different static host works the same way: serve the directory from `node scripts/pages-build.mjs --copy <dir>` under any path.

## Reuse

**Another SPA.** Keep your operations; describe them once:

```js
import { defineTools, createBrowserMcpProvider, exposeBrowserMcp, registerWebMcpTools } from '@divlet/web/mcp';
const tools = defineTools([{ name: 'todos.add', description: 'Add a todo.', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false }, execute: ({ text }) => app.addTodo(text) }]);
exposeBrowserMcp(createBrowserMcpProvider({ name: 'todos', version: '1.0.0', tools }));
await registerWebMcpTools(tools); // optional; a no-op without document.modelContext
```

Add `<meta name="browser-mcp" content="browser-mcp/1">` if the provider appears after asynchronous start-up. `web/tests/fixtures/browser-mcp-site/` is a complete example (IndexedDB todo list whose UI and tools share one domain module).

**Another agent harness.** Use the connection directly, or hand the SDK-shaped transport to an MCP client:

```js
import { connectBrowserMcp, browserMcpTransport } from '@divlet/core/browser-mcp';
const site = await connectBrowserMcp('https://example.github.io/app/', { headless: false, allowTools: ['todos.add'] });
await site.callTool('todos.add', { text: 'From an agent' });
// or: await new Client(info, { versionNegotiation: { mode: { pin: '2026-07-28' } } }).connect(browserMcpTransport(site));
```

`playwright-core` is an optional peer of `@divlet/core` (a dependency of `@divlet/mcp`); the system Chrome is used first, then Playwright's Chromium, then Edge.

## Not supported

Resources, prompts, subscriptions (`listChanged` from the page), multi-round-trip input, tasks, progress and logging; pagination (one page of tools); non-Chromium browsers for the transport; attaching to an already running user browser; real WebMCP interoperability beyond a draft-shaped stand-in (no shipping browser was available to test); offline reload of the static board (no Service Worker); multi-tab ownership of one browser copy; and HTTP-reachable MCP for clients that cannot run an adapter.

Tests: `web/tests/mcp-provider.test.js` (protocol, SDK interop, bounds, WebMCP), `web/tests/browser-mcp.mjs` (real Chromium against static fixtures: correlation, timeouts, cancellation, reload/close, origin, hostile pages), `core/tests/browser-runtime.test.js` (writer parity), `web/tests/pages.mjs` (the built site under a prefix, agent by URL, persistence) and `mcp/tests/connect.test.js` / `connect.e2e.mjs` (the stdio adapter, both eras, through the SDK's stdio client).
