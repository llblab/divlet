# Architecture

divlet is a local browser board for agents. A **project** is one `<name>.divlet` file (the [Divlet format](format.md)); a runtime serves it over loopback HTTP and generates HTML pages from accepted model changes. Managed-page hand edits are currently diagnosed rather than imported.

This guide describes the current implementation. The accepted [web-native core contract](web-native.md) owns the target architecture; [BACKLOG.md](../BACKLOG.md) tracks the gaps. In particular, the existing provider registry and style-engine seam do not yet establish complete plugin independence.

## Layout

```text
core/        the Divlet core: index.js (public API — the package's `.`), lib/, tests/
web/         the web client (a peer of core: plugins may act on both): `board.js` entry, `index.html`, `board.css`, modules by domain in `web/lib/`
plugins/     importers/exporters/style engines, one package each (index.js, lib/, tests/)
adapters/    host adapters, one package each: `pi/` (the Pi extension and its skill), `mcp/` (the MCP stdio server) and `cli/` (the standalone CLI)
packages/    host packaging that is published on its own: `pi-divlet` is the Pi manifest plus a re-export of `divlet/pi`
examples/    example projects (studio, a Markdown site, a PEN file)
```

## Entry points

The root package says what it is: `.` is the library (`core/index.js` — `openRuntime`, `launch`, `makeHost`, `startServer`,
`resolveOpenFile`), the bins are `divlet` (CLI) and `divlet-mcp` (MCP server), and every other surface is a named subpath
(`./runtime`, `./contract`, `./model`, `./project`, `./codec`, `./boards`, `./plugins`, `./engine`, `./pi`). A host manifest field
points at that host's adapter entry — `pi.extensions` is `dist/adapters/pi/index.js`, not a root shim — and the host's own package
(`packages/pi-divlet`) carries the host keywords and re-exports `divlet/pi`, so the adapter is never copied and cannot drift.
There is no root `index.js`: an entry that meant "this package is a Pi extension" was the wrong shape for a product whose other
hosts are a CLI and an MCP server.

## Core and plugins

The **core** is three things, connected and inseparable: (1) the **format**, a flexible web-oriented JSON description of a Divlet project (`core/lib/model.ts`, `core/lib/project.js`; see [format](format.md)); (2) the **codec** between that format and HTML (`core/lib/codec.js`, `core/lib/render.js`); (3) the **web editor with its own server** (`core/lib/runtime.js`, `core/lib/server.js`, `core/lib/hub.js`, `web/`). The core knows exactly one project format and speaks plain HTML/CSS. `core/lib/html-import.ts` owns admission of external HTML, distinct from strict codec decoding and managed-cache reconciliation.

Everything else attaches to the core as a **plugin**. Tailwind is one: `plugins/tailwind/` is a style engine (the declaration ↔ class codec `lib/styles.js`, local compilation and class explanation/suggestion `lib/styling.js`) reached through the seam `core/lib/engine.js`, and it contributes the inspector's class editor and Layout / Spacing / Effects folds on the client (`plugins/tailwind/web/`, registered through `web/lib/panels.js`; the server lists the active plugins' client modules as `clientPlugins` in the project info and serves them at `plugins/<id>/<file>`). Importers and exporters are the other plugin kind:

Plugin contracts are **types, not prose**. `core/lib/plugins.ts` exports `Importer` and `Exporter` (what a format plugin must provide), `core/lib/engine.ts` exports `StyleEngine` (what a style engine must provide), and `core/lib/contract.ts` exports the capability schema (`Schema`, `Tool`, `ToolParameters`, `Session`) that an adapter renders. Each is a real exported type with a declaration in the published package, so a plugin author writes `import type { Importer } from 'divlet/plugins'` and the compiler — not a reviewer — says whether the descriptor fits: `npm run typecheck` includes every `.ts` under `core/`, `adapters/` and `plugins/`, and `npm run build` emits `dist/**/*.d.ts`. A JavaScript plugin still works: the registry (`registerImporter`, `registerStyleEngine`, `registerExporter`) is the one place that promises a descriptor satisfies its contract, which is why that promise is written down as a cast there and nowhere else.

The renderer seam also exports `StyleEngineRequirement` (`id` plus exact opaque `version`), `ResolvedStyleEngine` and `resolveStyleEngine(requirement)`. The resolver consumes validated requirement data, returns `null` for native CSS and otherwise requires one exact, compilation-capable provider; missing, mismatched, ambiguous and incapable providers have explicit `STYLE_ENGINE_*` errors. It neither invokes providers nor changes active selection. `compileClasses(tokens, candidates, base, requirement)` opts into this resolution; explicit `null` never compiles utilities, whereas omitting the fourth argument preserves draft first-provider/empty-CSS behavior. Provider `version` remains optional for legacy-only capabilities. The bundled plugin also exports an opt-in, compiler-only `createRenderer()` descriptor: it pins stylesheet resolution to the provider, not caller/project `node_modules`, while the default draft descriptor remains unchanged. Its portable opaque version combines an explicit configuration-policy revision, actually resolved compiler/ordinary dependency versions and the four shipped Tailwind stylesheet hashes. Requested ranges and installation paths are not identity; optional platform binaries share their parent package's published semantic version. This is a trusted installed-package contract, not bytecode attestation; restart after dependency changes. Project dependency admission, host composition and matching resource/inspector capabilities remain [transition work](format.md#approved-first-release-profile); the factory is not a new public package subpath.

Foreign formats are **importer plugins** under `plugins/<id>/`. Their contract and registry live in `core/lib/plugins.ts` (`id`, `extensions`, `claims`, optional `detach` and `summarize`, `convert`). `core/lib/import.ts` selects native HTML directly and delegates other sources to `importerFor(file)`; it is the shared publication driver: it converts once, publishes `<name>.divlet` exclusively and records `metadata.import`. Every plugin is a small package of its own: `package.json` with its own dependencies (the repository is an npm workspace, `plugins/*`), `index.js` as the entry point only, `lib/` for its code and `tests/` for its tests. Plugin implementations import core contracts (`../../../core/lib/...`). The current registries in `core/lib/plugins.ts` and `core/lib/engine.ts` still import concrete built-ins directly; moving that selection to composition code is required by the target contract. Exporters would be the symmetric plugin kind and use the same layout.

`plugins/pen/` is the Pencil importer: `index.js` is only the entry point (the descriptor the registry loads); the plugin's own code is in `lib/` — `source.js` (the PEN reader), `validate.js` (PEN wire validation, built on the core's exported validation helpers), `projection.js` (a PEN frame projected to HTML, which is what renders correctly), `pen-*.js` (gradient, mesh, path and polygon renderers) and `convert.js` (projection → Divlet: per-node style bundles become Tailwind classes through the core style codec, color variables become tokens, instances that equal their component plus overrides stay instances, `data-pen-*` carriers are dropped).

Native HTML admission lives in `core/lib/html-import.ts`. A static page opened by path becomes a one-frame project beside it; scripts, event handlers, comments, stylesheet links and frames are dropped and counted in its provenance. The source dispatcher in `core/lib/import.ts` handles explicit opening, re-import and dropped-page providers without registering HTML as a plugin. HTML remains explicit-path input, never a project offered by folder listings. `core/tests/html-import.test.js` covers that boundary, including plain-CSS admission without an engine and non-overwriting publication.

Two deliberate limits (maintainer decisions, 2026-11-08): the **exporter** contract (`registerExporter`, `exportAs` in `core/lib/plugins.js`) ships without an exporter until a concrete consumer and format exist (per-frame HTML downloads are the board's own route, not an exporter); and a changed `.pen` is never merged into an edited project: the board notices it and **Import again** creates a new sibling project (`<name>-2.divlet`), leaving the current project and the source untouched.

The browser's `web/lib/actions.js` is a command facade, not a dependency of clipboard internals. `web/lib/artboards.js` owns frame creation, duplication and deletion, including grouping, component-safe deletion order, selection/reveal and failure/Undo feedback. The facade re-exports the same functions; `clip.js` calls that lower owner directly. Deletion captures target names, versions and component users before optimistic hiding removes them from the visible-descriptor lookup. Pending targets become dependency-ordered attempts and then accepted results; success count/name derive from those accepted results, not requested-first assumptions. Refused frames are shown again and retain their version guards against concurrent edits. Already-hidden or absent targets are ignored rather than becoming unguarded overlapping requests, and each command hides only its captured targets. Immediate toast Undo uses existing global Undo for accepted deletions; it is not a command-pinned inverse when other edits intervene. Literal local imports (including lazy imports and plugin client modules) are checked for existence and cycles by `core/tests/web-modules.test.js`.

## One capability contract

`core/lib/contract.js` owns the product's operations: the tool list (names, titles, descriptions), their parameters in a small
host-neutral schema form, the shared result shaping (frames rather than documents, compact project views, large-frame outlines)
and `createSession`, which resolves a project to the board that owns it. Hosts translate the representation only — the Pi
adapter renders the parameters as TypeBox and wraps results in Pi's tool envelope, `adapters/mcp/` renders the same parameters as
JSON Schema and answers in MCP content blocks — and both call the same implementation, so validation, revision checks and
domain error codes are identical everywhere. Add a capability once, in the contract.

The board's Agent tab is a host concern, so each adapter answers it its own way: Pi turns `ask` into a user message in the
running session, and the MCP server turns it into `sampling/createMessage` for its client when that client advertises
`sampling` — the client, not the board, runs the model. Neither adapter starts a service at import time, and neither is
imported by the core.

The message itself is built once, in `runtime.askMessage`, so every host receives the same prompt block: a bracketed English
header with `|key:value` metadata (`[divlet|project:<id>|frames:<n>|nodes:<n>]`), its value on that same line, the details as
Markdown lists from the following line (`frames:`, `elements in <frame>:`, `next:`), and the request itself after a blank line.
Per-turn context added by a host follows the same grammar (`adapters/pi/lib/extension.js` adds the changes since the last turn
and the selection snapshot that way), so an agent parses one shape everywhere and the request is never buried in prose. The
divlet skill names the block, so an installed agent recognises a request that arrives from the board.

**Hosts differ where the protocol does.** A board's agent answers requests either way, but only a host that owns the session can change it: the Pi extension offers the session's model and thinking level (`agent.controls` in the board state, `POST api/agent/settings`), while an MCP client — which can only answer `sampling/createMessage` — advertises nothing and the board shows no control at all rather than a disabled one. The board never stores a session setting as project content, never guesses a model name (it asks only for values the host listed), and re-reads what the host applied instead of assuming the request took effect. That is the rule for further Pi-only features: a capability is advertised in the board state, the UI disappears when it is absent, and the host — not the board — is the authority on what took effect.

The **skill** (`skills/divlet/SKILL.md`) is the same product surface for a human-less reader: it tells an agent with nothing installed how to get the tools (`npx -y --package=divlet divlet-mcp` registered by the host, or the Pi extension), how to open a project, and how to work. It is host-agnostic, shipped in the package, and checked against this code by `core/tests/skill.test.js` — tool names, CLI flags, error codes, the documents it points at and its front matter, so it cannot describe a product that no longer exists.

## The landing page

`examples/landing.divlet` is the canonical onboarding page, with one English `index` frame. Its text, layout and inline SVG are ordinary editable nodes; optional typed frame `head` data preserves the description/favicon without interpreting inert metadata. The project and authored `examples/assets/landing/` resources ship as an example, but the product never imports a marketing tree from that folder. `npm run demo` opens it; new-workspace template initialization is separate remaining work.

The narrowly tracked `examples/.divlet/landing/` build is derived through normal validation/output ownership, with portable provenance and no tracked locks or recovery state. `scripts/landing-build.mjs` attaches to any existing owner; its check mode snapshots inputs and owned output into a relocated sandbox, regenerates there and compares the complete owned cache without editing the original. A stale build or unresolved hand edit fails rather than being silently published. Rendering remains self-contained: no scripts or remote font/image/stylesheet dependencies.

`scripts/landing-hash.mjs` alone owns the public set and its fingerprint: owned `index.html` and eligible portable `_assets/` files, plus an empty `.nojekyll` marker required by Pages. It validates public bytes against output provenance and excludes sidecars, manifests, locks, trash and unowned files. The copy command prints the fingerprint of the exact byte snapshot it copied. `.github/workflows/landing.yml` verifies freshness, compares that hash with `.landing-hash` on `gh-pages`, and copies prepared public output only when different. It neither authors nor patches a second HTML page; metadata-only changes with identical public bytes create no deployment commit.

See [editable examples](../examples/README.md) for commands and file sets. Publishing requires separately authorized remote access and Pages configured for the `gh-pages` root. A configured origin/homepage does not prove synchronization or a live deployment; npm publication is separate (see [npm publication](publishing.md)).

## Project ownership

A board (one runtime with its HTTP server) is the single writer of its project file and holds the accepted state, revisions,
selection and diagnostics. When a board starts it registers itself in `~/.divlet/boards/<hash>.json` (`core/lib/boards.js`:
absolute file, board URL with its access token, owning pid); a client that opens the same project file finds that entry, checks
the owner is alive, and attaches instead of opening a second writer. Attached calls run on the owner through the token-scoped
`api/tool` route, which speaks the same contract. A client that attached may close at any time without touching the board; when
the owner's process disappears the entry is stale and the next client opens the project itself. The registry lives outside the
project, is owner-only on disk, and grants nothing beyond the board's own local API.

## History replay

The readable action log and the runtime's inverse/forward undo stacks are separate, bounded session state. Moving a frame patches its authored artboard coordinates and is undoable like content or project settings; a grouped gesture can contain several frame patches. Browser reloads attach to the same runtime history, but restarting the runtime does not restore a persistent timeline.

The owning runtime supports `undo({ steps })` and `redo({ steps })`, defaulting to one and admitting integers from 1 to the retained undo bound (currently 200). With `documentId`, it selects that many matching groups without removing unrelated groups. It composes the entries in replay order and passes one candidate through the existing whole-project validation and persistence path; source versions advance monotonically, not back to historical revision numbers. Only after persistence succeeds do entries move between the stacks. A later conflict, insufficient history or pre-source persistence refusal cannot leave an accepted prefix or consume stack entries. This reuses the source owner's existing commit policy: failures in derived-output publication after the canonical source write are diagnosed and retried as a pending generation, not presented as a failed source transaction or rolled back by history.

Frame membership replay retains the original collection index rather than appending restored frames. An external transaction removes missing frames from the end, inserts new frames at their final slots and records a checked relative-order operation for surviving frames. Reverse replay undoes that sequence in reverse, so mixed deletion/insertion/reordering restores the full authored array order. The order operation only rewrites its own members' slots, retaining unrelated later frames; a later conflicting relative order refuses the entire candidate. Reorder-only edits and their Undo/Redo also appear in the audit log. These are session undo records, not new project-format fields.

The runtime now exposes `readHistory().timeline` (also `readTimeline()`) and `navigateHistory({ pointId, expectedPoint, actor? })`. The timeline contains bounded point descriptors, the current ID/index, an opening/untracked/nonlinear/retained boundary and flags for legacy stack edges outside the segment. `historyHead().pointId` identifies the published authored state independently of the audit `seq`. Points carry bounded labels and sequence bounds for correlation, not restorable log-sequence addresses. Frame versions and project revisions still advance on replay; returning to a point restores authored values, not old revision counters. Points do not snapshot referenced resource bytes or site source files.

`core/lib/history.ts` owns only opaque session IDs and endpoint metadata, weakly associated with existing stack entries; the runtime remains the only replay/persistence authority. A group extension replaces its partial endpoint with a fresh ID. Ordinary whole-group Undo/Redo preserves point IDs and forward return; a new edit discards the old future. Non-top selective replay or untracked accepted content starts a new advertised segment without clearing legacy stacks or the readable audit log. New edits can grow a linear segment from that baseline. Retention follows the existing 200-group bound, independently of audit filtering; no full-project snapshot stack is added. Browser reload retains the runtime's IDs, while runtime restart opens a new baseline with new IDs. No timeline fields are written into project files.

Navigation validates the expected current ID inside the writer queue (`HISTORY_CONFLICT` on stale state), rejects a target outside the current segment (`HISTORY_POINT_UNAVAILABLE`) and replays the complete path once. An already-current target is a no-op. Addressable lineage is not a promise that current filesystem/rendering conditions permit replay: the existing whole-candidate validation and source/output safety checks still apply, and refusal does not advance point or stack authority. Observation/chat/host-activity events do not create state points. Conversely, traversing a net-equal group can move the point ID without producing an authored audit diff; clients must observe the point ID, not just `seq`.

The owning board advertises protocol support as `history.navigation: true` in project/SSE state and history reads. `GET api/history` includes the complete retained timeline independently of audit filters; `POST api/history/navigate` accepts `pointId` and `expectedPoint`, projects those fields into the queued runtime operation and fixes the actor to `user`. Stale heads and unavailable points return HTTP 409 with their domain codes; malformed queries return 400. The ordinary token, Host, Origin, content-type and request-size boundaries apply. A point-only move is published through SSE even when audit `seq` does not advance. An older owner that omits the capability must stay read-only for point navigation; no second writer is started to obtain it.

The browser's History pane renders authoritative point descriptors as Project states, with Current/Ahead/Restore labels. Activating a non-current row posts its captured expected point, never an audit sequence or a browser Undo loop; there is no optimistic cursor/project mutation. Activity remains readable in a separate native disclosure, without replay actions. Owners lacking the capability keep the explicitly described legacy reveal-only rows. Enter/Space activate states and arrows/Home/End move focus; focused points survive a transient read through a focusable group placeholder rather than falling into the canvas's default focus repair. Errors stay after the controls.

Timeline reads are lazy while History is closed and serial/coalesced while visible. A client-only read generation invalidates snapshots at each observed project/point/capability transition: A → B → A can return to the same current ID with a different retained future, so point equality alone does not prove snapshot freshness. A queued successful stale read gets a fresh follow-up; failed reads do not retry-loop and reopening/reconnecting can retry. Stale rows are not selectable while refreshing. UI coverage includes forward return/branch removal, point-only refresh, both ABA response races, keyboard/focus, phone/200% and old-owner capability absence/return. Dedicated browser acceptance also checks real live drag → chosen-state restoration of authored and visible geometry, mixed grouped multi-frame content/settings/lifecycle/order, one-persist jumps, safety/stale-request refusal and recovery, selective/untracked boundaries, the real retention window and reload/restart identity. Existing board/agent Undo/Redo remains single-step.

## Modules

| Module | Responsibility |
| --- | --- |
| `core/lib/model.ts` | Document/node validation and limits, patches (`applyDocumentPatch`, including `styles`). |
| `core/lib/project.js` | Project settings, project read/write, components (`expandFrame`, `listComponents`). |
| `core/lib/codec.js`, `core/lib/render.js` | Model ↔ HTML (`encodeHtml`, `decodeHtml`, `renderFile`), frame preparation, Tailwind compilation hooks. |
| `core/lib/engine.js` | The style-engine seam; the Tailwind plugin (`plugins/tailwind/`) provides compilation and the declaration ↔ utility codec. |
| `core/lib/ops.js` | Structural operations (insert, move, wrap, …) on frames. |
| `core/lib/runtime.js` | The project runtime: accepted state, queue, history, persistence, watching, assets. |
| `core/lib/history.ts` | Session point identity and linear stack lineage; no replay or persistence. |
| `core/lib/output.js`, `core/lib/static.js` | Generated-file ownership, collision checks, portable builds. |
| `core/lib/server.js`, `core/lib/hub.js`, `core/lib/launch.js`, `core/lib/projects.js` | HTTP boundary, the launcher, opening paths, project discovery and creation. |
| `adapters/pi/lib/extension.js`, `adapters/cli/index.js` | The Pi extension (tools `open/read/patch/edit/frame/undo/mark_divlet`) and the CLI. |
| `web/` | The board: canvas, panels, inspector, palette. |

## Frames in the browser

Every artboard keeps one iframe for the lifetime of its frame. The browser decides when an off-screen page loads and paints (`loading="lazy"`); only selected or expanded frames are promoted to `eager`. Scrolling, zooming or deselecting never unmounts, reloads or rotates the bridge of a frame, and updates reach a loaded frame only when its render version advances. Leaving full screen resets the interacted page by double-buffering: the old iframe stays above as a `frame-ghost` until the fresh authenticated frame reports its first render.

Expanded viewing is a reader surface, not an extra editor-interaction flag. A frame descriptor supplies an ephemeral `viewUrl` for its exact owned output filename; the site's template instead opens its existing routed content URL automatically. The client retires the editor port and rotates its capability before that navigation. The token-scoped `build/` route serves only the accepted public-file map, captured before editor sidecars are added to the complete disk-publication/repair plan; it never serves arbitrary filesystem paths or those sidecars. HTML carries only a nonce-authorized Escape helper, with opaque sandboxing, no connections/base/forms and no referrer; it receives no model channel. Closing retains the existing ghost/fresh authenticated-preview reset. Site live updates still forward only a version to the opaque page. This does not change scaled-canvas Play or make a matching navigated WindowProxy an editing authority.

At far zoom a picture stands in for the live page, taken in the browser: once a page has rendered, the board asks its bridge (`divlet:capture`) and the bridge serializes the page into an SVG `foreignObject` with images and CSS `url()` resources inlined through CORS-enabled image loads (no `fetch`, so the preview CSP stays closed), rasterizes it and sends a WebP blob over the private port. One picture is taken at a time while the browser is idle; blobs are kept per frame and render. Nothing is stored on disk or requested from the server, so there is no loading state when zooming out. `web/canvas.js` shows the picture instead of the live page when a frame is drawn narrower than 260 px (`.artboard.lod`; the iframe stays loaded but is not painted) and zooms to a frame when its thumbnail is clicked. Web fonts that are not installed on the machine are not embedded (the picture falls back to system fonts).

## Trust boundaries

- The server binds loopback only, routes are token-scoped, Host/Origin are checked and request sizes bounded.
- Preview pages are sandboxed iframes; model, selection and editing traffic uses an authenticated document-bound `MessagePort`. `previewBridge` is serialized with `Function#toString` and must stay free of imports.
- Source and resource reads use bounded regular-file descriptors; generated outputs are owned by one project and never overwrite unowned files.
- Commits validate a prepared candidate against the expected version before changing accepted state; invalid external edits leave the last good state in place.
