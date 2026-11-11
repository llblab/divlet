# Browser runtime, offline demo and agent connectivity

**Status: incremental implementation, not a completed browser runtime or a frozen API.** Shared standalone-frame validation, ordinary patches and inspection now execute in native browser ESM as well as Node. The board, full-project/component/resource handling and persistence still require their Node host. This note separates the portable semantic kernel direction, static-hosted demo and browser-agent transports. Implementation proceeds through bounded validated slices, not a wholesale runtime rewrite or a new release prerequisite. [BACKLOG.md](../BACKLOG.md) owns remaining work. The [web-native contract](web-native.md) remains the semantic authority.

## Current evidence

- Generated project pages already work on ordinary static hosting. That does not mean the editor can run without its host.
- `web/board.js` bootstraps through `api/project` and an `EventSource` at `events`; `web/lib/store.js` sends edits and model reads through HTTP. Copying `web/` to Pages would leave those dependencies unresolved.
- `core/lib/validation.ts` owns shared domain errors, JSON/object/key/text checks and bounded UTF-8 budget admission without runtime imports or Node globals. Existing model-facing error/function identities remain shared.
- `model.ts` binds style lowering through `model-styles.ts`, which retains the existing eager Node engine. The package's standard browser file mapping swaps only that port for `browser-styles.ts`, an explicit `NO_STYLE_ENGINE` refusal. Browser validation/native `style` maps do not imply Tailwind compilation or declarative `styles` lowering. No new public subpath or serialized capability field is introduced.
- CSS admission uses the same PostCSS grammar parser with source-map interpretation disabled. Browser bundling respects PostCSS's own optional-feature browser mappings; it adds no Node-global polyfill or alternate validator. `scripts/browser-model.mjs` owns the source/installed verification build profile and guards against concrete engine/writer/Tailwind inputs and external imports. It returns bytes in memory, not a shipped standalone browser SDK artifact.
- Remaining host closures include `project.ts` (`node:path`), `codec.ts` (`Buffer`), concrete provider bootstrap and the new asset decoder (`node:util`/`Buffer`). Browser compatibility cannot be inferred from TypeScript compilation.
- The current style/provider, component and format-transition gaps remain relevant. An offline fork must not silently establish different cascade, override, resource or renderer rules.

## Recommended boundary: portable semantics, explicit hosts

```text
board UI / agent operation contract
  +-- browser host
  |     +-- shared portable semantic kernel
  |     +-- browser storage / file permission / download / projection
  +-- Node host
        +-- same portable semantic kernel
        +-- filesystem / watcher / loopback API / host bridge
```

The kernel should own representable project data, validation, patches, component expansion, resource/reference semantics and candidate/history transformations that do not require I/O. The browser continues to own layout and painting; no alternate canvas renderer is implied. Host-independent logic should have one implementation and shared test vectors, not a browser reimplementation that merely resembles the Node validator.

Hosts own persistence, publication, subscriptions, permissions and transport. In the connected local mode, Node remains the single accepted-state writer and validates requests through the same kernel; a thin host does not trust arbitrary browser claims. In offline mode, a browser session may become its own writer only for its locally opened copy, with an explicit persistence boundary and multi-tab ownership policy. Connecting later must not silently merge that copy or reuse another owner's History IDs.

A Web Worker can isolate expensive pure work from UI rendering. A Service Worker serves a different role: offline loading, cache updates and local resource responses. Neither worker choice supplies filesystem authority. Do not make an immortal Service Worker the sole owner of accepted project state, or put a permanent fake HTTP server between the UI and an in-browser kernel merely to preserve every existing route string.

Do not select a new package name or folder hierarchy before the dependency boundary earns it. Preserve current public standalone-entry/provider behavior while extracting a browser-safe entry; WEB-2 already records why root-only provider registration would break that behavior. Avoid blanket Node polyfills as a substitute for separating filesystem/compiler composition from semantic code.

## Useful modes

- **Static publication:** ordinary rendered HTML/CSS/resources. This already exists and needs no editor runtime or service worker.
- **Static-hosted read-only demo:** load a deliberately public example project and its prepared frames into the real board UI. Clearly identify the demo/offline limitations. No fake agent connection, Stop control, filesystem save or unsupported edit operation. This can precede a complete offline editor if the read-only host contract genuinely reuses the same UI and projections.
- **Offline editor:** enable only operations the browser kernel and installed providers support. File System Access APIs require user permission and browser support; download/upload remains a fallback. IndexedDB/OPFS stores browser-local data, not an automatic save to the original repository file, and storage eviction/quota must not masquerade as durable filesystem persistence.
- **Connected host:** the existing local Node/CLI/MCP/Pi path, reached only through an explicitly chosen, authenticated connection. Capabilities come from the actual host; unsupported functions are absent, not guessed or cosmetically enabled.

Repository path prefixes are not origin isolation. Project sites under the same Pages hostname share an origin, and browser storage/file permissions are not private merely because application paths differ. A public demo should not persist private user projects by default; private editing needs an explicit storage policy and an appropriate origin/deployment boundary.

A first static visit may need the network. Reliable offline reopening additionally needs an explicit versioned cache/update strategy; it is not a consequence of being static HTML. Service Worker updates must not mix incompatible kernel, model and projection generations or cache authenticated API traffic indiscriminately.

## The landing as a real demonstration

The useful nesting is a static application shell opening an ordinary curated landing `.divlet` project. The iframe contains that project's content, not another recursively embedded copy of the editor. Keep an immediately readable explanation and installation command before or alongside an opt-in demo; forcing every visitor through the full editor would increase startup weight and obscure onboarding.

Copy-command buttons belong to trusted application-shell behavior, not arbitrary scripts hidden in inert project metadata. Clipboard writes require the relevant browser support/user action. Static hosts may not provide the Node server's configurable response headers. In particular, CSP `sandbox` cannot be supplied through a meta tag; prove iframe sandbox/referrer/channel behavior under the actual static host rather than assuming current server headers survive the move. Browser-only tool `path` arguments also cannot grant access to arbitrary OS files or bypass file-picker/handle permission.

A public demo project must be intentionally publishable: do not expose real project metadata, absolute resource paths, local credentials or unpublished work merely because the runtime needs model data. Opening a user's private project in the static editor must not upload it, auto-fetch its remote dependencies or pair with a local agent.

The core must not import a marketing project. A demo is composition-owned and opens an independently owned example. Existing `examples/landing/landing.divlet` and the single prepared public-set/fingerprint owner remain authoritative until an explicit, verified replacement; do not create a second manually maintained landing or relax private-output exclusions for a demo.

## Service Worker is not a public MCP endpoint

A Service Worker intercepts requests for its controlled browser clients within its origin/scope. It does not accept arbitrary inbound TCP connections or cause a remote MCP client's requests to GitHub Pages to execute in the visitor's browser. It can emulate a local route for a controlled page; that is not a generally reachable MCP HTTP server. Background lifetime also cannot be assumed.

There are two useful, distinct agent routes:

- **Browser-mediated tools, including WebMCP:** the WebMCP draft exposes JavaScript functions with tool descriptions and input schemas to participating browser agents. This closely matches the proposed inversion: application logic stays client-side and the agent invokes it there. Share divlet's operation vocabulary, schema and validation instead of inventing another command set. Feature presence, agent integration, cancellation, errors, user control and browser permissions need real proof. The inspected specification is a Community Group draft; it does not establish universal browser availability or interoperability with existing stdio/Streamable HTTP clients.
- **An external agent bridge:** a small extension/local host/explicit relay can connect the browser session to a normal MCP client. The browser may initiate an outbound connection instead of listening as a server, but a reachable bridge and a defined transport still exist. A private MessagePort/custom channel can be an implementation detail, not an advertised standard network MCP endpoint. Do not introduce a cloud relay, remote dependency or public listener by default. HTTPS/mixed-content rules, CSP and local-network permissions must be tested for the chosen browser/bridge path; an outbound connection is not guaranteed merely because a loopback endpoint exists.

A bridge must pair an exact origin, document, project and session through explicit user intent, preserve revision/single-writer checks and rotate capabilities after navigation/reconnect. No wildcard CORS, silent localhost probing, persisted session tokens in project content or automatic exposure of local files to a hosted page. Preserve the current authenticated document-bound preview channel and no-referrer boundaries.

## Evidence required before changing product claims

- Extend the proven standalone-frame browser closure as project/session operations are admitted; retain shared validation, candidate/refusal and size/Unicode vectors and no host/bootstrap leakage. Source-profile native-browser execution and installed-profile bundling/Node smoke are distinct checks, not proof of installed browser execution or universal browser compatibility.
- A real static-server test loads the chosen demo path with no `api/*` or SSE backend, missing-asset rescue or hidden Node process. Test repository prefixes, clean first load, subsequent offline reload, cache updates, accurate capabilities and bounded startup cost.
- Offline mutation proof covers candidate acceptance/refusal, undo/redo, local persistence failure, download/reopen and two-tab ownership. Missing renderer requirements must diagnose/read-only rather than silently return empty styling.
- A browser-agent experiment distinguishes WebMCP tool registration/execution from a conventional external MCP transport. An actual client must call a tool, receive a refusal and cancel work; feature detection alone is insufficient.

## References

- [Current architecture](architecture.md), [web-native semantics](web-native.md), [agent contract](agents.md), [resource ownership](format.md#approved-embedded-resource-ownership).
- [MDN Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API): controlled-client scope, secure contexts and lifecycle/cache responsibilities.
- [WebMCP draft](https://webmachinelearning.github.io/webmcp/): browser-mediated JavaScript tools; draft status is not a support guarantee.
- [Same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy) and [CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox): path prefixes do not isolate origins, and meta CSP cannot reproduce the sandbox response directive.
- [MCP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports): the stdio/network transport boundary remains distinct from browser-local tool exposure.
