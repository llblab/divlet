# Architecture

divlet is a local browser board for agents. A **project** is one `<name>.divlet` file (the [Divlet format](format.md)); a runtime serves it over loopback HTTP and generates HTML pages from accepted model changes. Managed-page hand edits are currently diagnosed rather than imported.

This guide describes the current implementation. The accepted [web-native core contract](web-native.md) owns the target architecture; [BACKLOG.md](../BACKLOG.md) tracks the gaps. In particular, the existing provider registry and style-engine seam do not yet establish complete plugin independence.

A browser-hosted/offline editor is not implemented: current startup depends on the Node HTTP/SSE host. The [browser runtime direction](browser-runtime.md) separates incremental shared-kernel extraction, host persistence, static demonstration and browser-agent connectivity without changing that current ownership contract.

## Layout

```text
core/        the Divlet core: index.js (public API — the package's `.`), lib/, tests/
web/         the web client (a peer of core: plugins may act on both): `board.js` entry, `index.html`, `board.css`, modules by domain in `web/lib/`, frontend unit/browser suites in `web/tests/`
plugins/     importers/exporters/style engines, one package each (index.js, lib/, tests/)
packages/    real adapters: cli/ (@divlet/cli), mcp/ (@divlet/mcp), pi/ (@divlet/pi); each owns implementation and tests
skills/      the portable product workflow in skills/divlet/, independent of any host
examples/    independent landing/, studio/ and handbook/ scenarios (no authored PEN demo)
```

## Entry points

The root package says what it is: `.` is the library (source `core/index.js`, published as `dist/core/index.js` — `openRuntime`, `launch`, `makeHost`, `startServer`,
`resolveOpenFile`), with named subpaths (`./runtime`, `./contract`, `./model`, `./project`, `./codec`, `./boards`, `./plugins`, `./engine`) and the shared `./skill` resource. The root has no bins, Pi manifest, Pi peer requirements or `./pi` export.

The three adapter packages own their implementations and tests, consume public `divlet` and `divlet/contract` rather than core internals, and depend on the exact matching product version (`0.0.1` initially). Each publishes its own `dist/index.js` entry: `@divlet/cli` owns the `divlet` bin, `@divlet/mcp` owns `divlet-mcp`, and `@divlet/pi` owns `pi.extensions` and host dependencies. There is no wrapper layer. Pi resolves the portable workflow through `divlet/skill`.

Frontend unit and Chromium acceptance suites live in `web/tests/`; server/model unit suites and their shared fixture builders remain in `core/tests/`. Tests use the core runtime as a fixture host, not as their ownership location. Build asset copying excludes tests, and the browser module graph covers only served production modules.

The npm workspace includes `.`, `packages/*` and `plugins/*`. Development executes sources with the custom `divlet-source` export condition; `scripts/source.mjs` propagates it through `NODE_OPTIONS` to children. Root start, demo, test, Pi and MCP scripts use this runner. Focused source tests use `node scripts/source.mjs --test …`. `dist/` is publishing output only.

The emitted runtime class previously exposed `reuseImage()` even after its implementation retired. Its name/signature remain as a deprecated compatibility boundary, synchronously throwing `UNSUPPORTED_OPERATION` without inspecting input or touching state/files. It is not a recovery capability or a registered route/tool. `saveAsset()` publishes a new ordinary authored image, not a resumed reuse operation.

## Core and plugins

The core connects one native format, HTML admission/projection and a local browser editor. It does not delegate document meaning to interchangeable plugins. The [module map](#modules) locates the current source owners; external HTML admission is distinct from strict codec decoding and managed-cache reconciliation.

Optional capabilities attach as plugins. Tailwind supplies the declaration ↔ class codec, compilation and class explanation/suggestion, plus the inspector's class/layout/spacing/effects panels. Client panels register through `web/lib/panels.js`; the server advertises `clientPlugins` and serves modules at `plugins/<id>/<file>`. A provider may expose the generic `data-inspector-slot="typography"` slot in Appearance for core-native controls. The core owns font-family inspection/patching in `web/lib/typography.js` and composes it there; without a provider it supplies a minimal Appearance section. No concrete provider import is needed. An advertised `project.capabilities.fontUpload` adds the adjacent device button: the browser decodes bytes, then the runtime queues one expected-version asset/CSS registration. The CSS owner admits only understood unconditional disjoint companion coverage, conservatively refusing overlap/ambiguous identity or conditions; it recognizes the codec-owned projected layer without treating authored layers as generated. Uninspectable style dependencies remain refused; the common allocator reserves directory and file identities. Selection is a later ordinary family edit. Pending device work belongs to the inspector upload operation, so recreated selection controls keep the same busy/duplicate guard. Importers/exporters translate foreign formats, not the native model.

Plugin contracts are **types, not prose**. `core/lib/plugins.ts` exports `Importer` and `Exporter` (what a format plugin must provide), `core/lib/engine.ts` exports `StyleEngine` (what a style engine must provide), and `core/lib/contract.ts` exports the capability schema (`Schema`, `Tool`, `ToolParameters`, `Session`) that an adapter renders. Each is a real exported type with a declaration in the published package, so a plugin author writes `import type { Importer } from 'divlet/plugins'` and the compiler — not a reviewer — says whether the descriptor fits: `npm run typecheck` includes every `.ts` under `core/`, `packages/` and `plugins/`, and `npm run build` emits `dist/**/*.d.ts`. A JavaScript plugin still works: the registry (`registerImporter`, `registerStyleEngine`, `registerExporter`) is the one place that promises a descriptor satisfies its contract, which is why that promise is written down as a cast there and nowhere else.

The renderer seam also exports `StyleEngineRequirement` (`id` plus exact opaque `version`), `ResolvedStyleEngine` and `resolveStyleEngine(requirement)`. The resolver consumes validated requirement data, returns `null` for native CSS and otherwise requires one exact, compilation-capable provider; missing, mismatched, ambiguous and incapable providers have explicit `STYLE_ENGINE_*` errors. It neither invokes providers nor changes active selection. `compileClasses(tokens, candidates, base, requirement)` opts into this resolution; explicit `null` never compiles utilities, whereas omitting the fourth argument preserves draft first-provider/empty-CSS behavior. Provider `version` remains optional for legacy-only capabilities. The bundled plugin also exports an opt-in, compiler-only `createRenderer()` descriptor: it pins stylesheet resolution to the provider, not caller/project `node_modules`, while the default draft descriptor remains unchanged. Its portable opaque version combines an explicit configuration-policy revision, actually resolved compiler/ordinary dependency versions and the four shipped Tailwind stylesheet hashes. Requested ranges and installation paths are not identity; optional platform binaries share their parent package's published semantic version. This is a trusted installed-package contract, not bytecode attestation; restart after dependency changes. Project dependency admission, host composition and matching resource/inspector capabilities remain [transition work](format.md#approved-first-release-profile); the factory is not a new public package subpath.

Foreign formats are **importer plugins** under `plugins/<id>/`. Their contract and registry live in `core/lib/plugins.ts` (`id`, `extensions`, `claims`, optional `detach` and `summarize`, `convert`). `core/lib/import.ts` selects native HTML directly and delegates other sources to `importerFor(file)`; it is the shared publication driver: it converts once, publishes `<name>.divlet` exclusively and records `metadata.import`. Every plugin is a small package of its own: `package.json` with its own dependencies (the repository is an npm workspace, `plugins/*`), `index.js` as the entry point only, `lib/` for its code and `tests/` for its tests. Plugin implementations import core contracts (`../../../core/lib/...`). The current registries in `core/lib/plugins.ts` and `core/lib/engine.ts` still import concrete built-ins directly; moving that selection to composition code is required by the target contract. Standalone public `./model`, `./engine` and `./plugins` imports currently work without the library root: model style patches receive the bundled Tailwind codec, the engine registry starts with Tailwind and the importer registry starts with PEN. Moving registration only into `core/index.js` would change those entry semantics; replacement initialization, registry order/deduplication and existing exports must be accounted for explicitly. Exporters would be the symmetric plugin kind and use the same layout.

Source/type dependencies and executable ESM dependencies are different graphs. The Node model's `model-styles.ts` port binds `engine.ts` at runtime, while the reverse `Style`/`StyleOptions` import is type-only and erased by Node. A browser build replaces only that port through the package file map; it does not relocate Node provider initialization to the root entry. The source-contract cycle remains real architectural coupling, but those edges do not establish a runtime initialization cycle. The bounded core/plugin backend audit found no static local ESM cycle after type stripping; it did not audit npm, adapter or browser dependencies and does not establish full Domain DAG compliance. Provider composition and type ownership remain transition work, not a runtime-cycle repair.

`plugins/pen/` is the Pencil importer: `index.js` is only the entry point (the descriptor the registry loads); the plugin's own code is in `lib/` — `source.js` (the PEN reader), `validate.js` (PEN wire validation, built on the core's exported validation helpers), `projection.js` (a PEN frame projected to HTML, which is what renders correctly), `pen-*.js` (gradient, mesh, path and polygon renderers) and `convert.js` (projection → Divlet: per-node style bundles become Tailwind classes through the core style codec, color variables become tokens, instances that equal their component plus overrides stay instances, `data-pen-*` carriers are dropped).

Native HTML admission lives in `core/lib/html-import.ts`. A static page opened by path becomes a one-frame project beside it; scripts, event handlers, comments, stylesheet links and frames are dropped and counted in its provenance. The source dispatcher in `core/lib/import.ts` handles explicit opening, re-import and dropped-page providers without registering HTML as a plugin. HTML remains explicit-path input, never a project offered by folder listings. `core/tests/html-import.test.js` covers that boundary, including plain-CSS admission without an engine and non-overwriting publication.

Two deliberate limits (maintainer decisions, 2026-11-08): the **exporter** contract (`registerExporter`, `exportAs` in `core/lib/plugins.ts`) ships without an exporter until a concrete consumer and format exist (per-frame HTML downloads are the board's own route, not an exporter); and a changed `.pen` is never merged into an edited project: the board notices it and **Import again** creates a new sibling project (`<name>-2.divlet`), leaving the current project and the source untouched.

## One capability contract

`core/lib/contract.ts` owns the product's operations: the tool list (names, titles, descriptions), their parameters in a small
host-neutral schema form, the shared result shaping (frames rather than documents, compact project views, large-frame outlines)
and `createSession`, which resolves a project to the board that owns it. Hosts translate the representation only — the Pi
adapter renders the parameters as TypeBox and wraps results in Pi's tool envelope, `packages/mcp/` renders the same parameters as
JSON Schema and answers in MCP content blocks — and both call the same implementation, so validation, revision checks and
domain error codes are identical everywhere. Add a capability once, in the contract.

The board's Agent tab is a host concern, so each adapter answers it its own way: Pi turns `ask` into a user message in the
running session, and the MCP server turns it into `sampling/createMessage` for its client when that client advertises
`sampling` — the client, not the board, runs the model. Neither adapter starts a service at import time, and neither is
imported by the core.

The message itself is built once, in `runtime.askMessage`, so every host receives the same prompt block: a bracketed English
header with `|key:value` metadata (`[divlet|project:<id>|frames:<n>|nodes:<n>]`), its value on that same line, the details as
Markdown lists from the following line (`frames:`, `elements in <frame>:`, `next:`), and the request itself after a blank line.
Per-turn context added by a host follows the same grammar (`packages/pi/lib/extension.js` adds the changes since the last turn
and the selection snapshot that way), so an agent parses one shape everywhere and the request is never buried in prose. The
divlet skill names the block, so an installed agent recognises a request that arrives from the board.

**Hosts differ where the protocol does.** A board's agent answers requests either way, but only a host that owns the session can change it: the Pi extension offers the session's model and thinking level (`agent.controls` in the board state, `POST api/agent/settings`), while an MCP client — which can only answer `sampling/createMessage` — advertises nothing and the board shows no control at all rather than a disabled one. The board never stores a session setting as project content, never guesses a model name (it asks only for values the host listed), and re-reads what the host applied instead of assuming the request took effect. That is the rule for further Pi-only features: a capability is advertised in the board state, the UI disappears when it is absent, and the host — not the board — is the authority on what took effect.

The **skill** (`skills/divlet/SKILL.md`) is the same product surface for a human-less reader: it tells an agent with nothing installed how to get the tools (`npx -y @divlet/mcp` registered by the host, or the Pi extension), how to open a project, and how to work. It is host-agnostic, shipped in the package, and checked against this code by `core/tests/skill.test.js` — tool names, CLI flags, error codes, the documents it points at and its front matter, so it cannot describe a product that no longer exists.

## The landing page

`examples/landing/landing.divlet` is the canonical onboarding page, with one English `index` frame. Its text, layout and literal SVG are ordinary editable nodes; optional typed frame `head` data preserves the description and a `data:image/svg+xml;base64` favicon without interpreting inert metadata. This small resource is inside the project, with no external landing assets input. This native source ships as an example, but the product never imports a separate marketing tree. `npm run demo` opens it; new-workspace template initialization is separate remaining work. The examples retain unfrozen `schemaVersion: 1`. The native writer now supports declared binary-resource trees and cache-independent rebuilding; explicit legacy-file conversion and the remaining resource consumers are tracked under FORMAT-ASSETS.

The narrowly tracked `examples/landing/.divlet/landing/` build is derived through normal validation/output ownership, with portable provenance and no tracked locks or recovery state. `scripts/landing-build.mjs` attaches to any existing owner; its check mode snapshots inputs and owned output into a relocated sandbox, regenerates there and compares the complete owned cache without editing the original. A stale build or unresolved hand edit fails rather than being silently published. Rendering remains self-contained: no scripts or remote font/image/stylesheet dependencies.

`scripts/landing-hash.mjs` alone owns the public set and its fingerprint: owned `index.html` and eligible portable `_assets/` files, plus an empty `.nojekyll` marker required by Pages. It validates public bytes against output provenance and excludes sidecars, manifests, locks, trash and unowned files. The copy command prints the fingerprint of the exact byte snapshot it copied. `.github/workflows/landing.yml` uses Node.js 22 to verify the nested source/cache and run its checks, compares that hash with `.landing-hash` on `gh-pages`, and copies prepared public output only when different. It neither authors nor patches a second HTML page; metadata-only changes with identical public bytes create no deployment commit.

See [editable examples](../examples/README.md) for commands and file sets. Publishing requires separately authorized remote access and Pages configured for the `gh-pages` root. A configured origin/homepage does not prove synchronization or a live deployment; npm publication is separate (see [npm publication](publishing.md)).

## Project ownership

A board (one runtime with its HTTP server) is the single writer of its project file and holds the accepted state, revisions,
selection and diagnostics. When a board starts it registers itself in `~/.divlet/boards/<hash>.json` (`core/lib/boards.ts`:
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

Timeline reads are lazy while History is closed and serial/coalesced while visible. The cache is one private read record containing payload, owning project and observed generation, replaced together; row construction receives that payload explicitly. Request and observation clocks remain separate from the cached result and are not server state addresses. A client-only read generation invalidates snapshots at each observed project/point/capability transition: A → B → A can return to the same current ID with a different retained future, so point equality alone does not prove snapshot freshness. A queued successful stale read gets a fresh follow-up; failed reads do not retry-loop and reopening/reconnecting can retry. Stale rows are not selectable while refreshing. UI coverage includes forward return/branch removal, point-only refresh, both ABA response races, keyboard/focus, phone/200% and old-owner capability absence/return. Dedicated browser acceptance also checks real live drag → chosen-state restoration of authored and visible geometry, mixed grouped multi-frame content/settings/lifecycle/order, one-persist jumps, safety/stale-request refusal and recovery, selective/untracked boundaries, the real retention window and reload/restart identity. Existing board/agent Undo/Redo remains single-step.

## Modules

| Module | Responsibility |
| --- | --- |
| `core/lib/model.ts` | Native vocabulary, validation/resource URL contexts, limits and patches. |
| `core/lib/validation.ts` | Host-free JSON/text/UTF-8 checks and the shared domain error. |
| `core/lib/board-session.ts` | Opaque reads/snapshots and optional view-state publication; no project writes. |
| `core/lib/board-host.ts` | Optional History and native source-update service contracts. |
| `core/lib/public-snapshot.ts` | Build-side allowlisted inspection data from explicitly public prepared HTML. |
| `web/lib/host.js`, `http-session.js`, `http.js` | Native host binding, HTTP/SSE read adapter and JSON transport. |
| `web/lib/http-services.js` | Native History and source-update adapters; no model authority. |
| `web/lib/file-picker.js` | Reusable read-only path/list/keyboard UI and request lifetime. |
| `web/lib/project.js`, `help.js` | Open/copy and Settings policy, writes and modal lifetime. |
| `core/lib/model-styles.ts`, `browser-styles.ts` | Node lowering binding and explicit absent browser capability. |
| `core/lib/asset-reference.ts` | Portable declared paths and explicit URI/dependency codec; not project storage. |
| `core/lib/assets.ts` | Canonical stored/sparse-patch resource trees and MIME-based text decoding. |
| `core/lib/font.ts` | Bounded face metadata and CSS descriptors; not glyph validation, upload or font storage. |
| `core/lib/font-woff.ts` | Bounded WOFF 1 table unpacking into the shared SFNT metadata path; no source conversion. |
| `core/lib/font-woff2.ts` | Bounded null-transform WOFF2/Brotli metadata input; original resource bytes stay canonical. |
| `core/lib/font-css.ts` | Non-shadowing face registration against closed, source-owned public styles; no write authority. |
| `core/lib/capture.ts` | Bounded, self-contained frame font CSS for browser rasterization; no filesystem/publication authority. |
| `core/lib/css-literals.ts` | Shared CSS escape decoding and quoted-string contents for projection and registration. |
| `core/lib/media-type.ts` | Canonical bounded MIME syntax; no byte sniffing or serving authority. |
| `core/lib/svg-resource.ts` | Strict XML SVG resource projection, not HTML parsing or publication. |
| `core/lib/project.ts` | Project settings/read/write and component expansion/listing. |
| `core/lib/codec.ts` | Strict native model ↔ HTML codec and `renderFile`. |
| `core/lib/html-import.ts` | Loss-aware external HTML admission, separate from the strict codec. |
| `core/lib/render.ts` | Frame preparation and utility-compilation hooks. |
| `core/lib/engine.ts` | Optional style-engine contract, registry and capability dispatch. |
| `core/lib/plugins.ts` | Importer/exporter contracts and registry. |
| `core/lib/import.ts` | Bounded source dispatch and exclusive conversion publication. |
| `core/lib/ops.ts` | Structural frame operations: insert, move, wrap and related edits. |
| `core/lib/runtime.js` | Accepted state, writer queue, replay, persistence, watching and assets. |
| `core/lib/history.ts` | Session point identity/lineage, not replay or persistence. |
| `core/lib/contract.ts` | Host-neutral operations, schemas, result shaping and sessions. |
| `core/lib/output.ts` | Generated-file hashes/MIME provenance, collision checks and safe publication. |
| `core/lib/static.js` | Resource closure/previews and bounded declared-byte HTML export. |
| `core/lib/server.ts` | Token-scoped board HTTP and preview boundary. |
| `core/lib/boards.ts` | Live-owner registry and attached-client transport. |
| `core/lib/projects.ts` | Project discovery and creation. |
| `core/lib/launch.ts` | Opening/composition for projects and collections. |
| `core/lib/hub.ts` | Collection launcher and its local HTTP surface. |
| `packages/pi/lib/extension.js` | Pi tools, session bridge and board conversation. |
| `packages/mcp/lib/server.js` | MCP stdio representation and sampling bridge. |
| `packages/cli/index.js` | Standalone command entry. |
| `web/` | Native ES-module board, canvas, panels, inspector and palette. |

## Browser command ownership

The browser's `web/lib/actions.js` is a command facade, not a dependency of clipboard internals. `web/lib/artboards.js` owns frame creation, duplication and deletion, including grouping, component-safe deletion order, selection/reveal and failure/Undo feedback. The facade re-exports the same functions; `clip.js` calls that lower owner directly. Deletion captures target names, versions and component users before optimistic hiding removes them from the visible-descriptor lookup. Pending targets become dependency-ordered attempts and then accepted results; success count/name derive from those accepted results, not requested-first assumptions. Refused frames are shown again and retain their version guards against concurrent edits. Already-hidden or absent targets are ignored rather than becoming unguarded overlapping requests, and each command hides only its captured targets. Immediate toast Undo uses existing global Undo for accepted deletions; it is not a command-pinned inverse when other edits intervene. Literal local imports (including lazy imports and plugin client modules) are checked for existence and cycles by `web/tests/modules.test.js`.

## Frames in the browser

Every artboard keeps one iframe for the lifetime of its frame. The browser decides when an off-screen page loads and paints (`loading="lazy"`); only selected or expanded frames are promoted to `eager`. Scrolling, zooming or deselecting never unmounts, reloads or rotates the bridge of a frame, and updates reach a loaded frame only when its render version advances. Leaving full screen resets the interacted page by double-buffering: the old iframe stays above as a `frame-ghost` until the fresh authenticated frame reports its first render.

Expanded viewing is a reader surface, not an extra editor-interaction flag. A frame descriptor supplies an ephemeral `viewUrl` for its exact owned output filename; the site's template instead opens its existing routed content URL automatically. The client retires the editor port and rotates its capability before that navigation. The token-scoped `build/` route serves only the accepted public-file map, captured before editor sidecars are added to the complete disk-publication/repair plan; it never serves arbitrary filesystem paths or those sidecars. HTML carries only a nonce-authorized Escape helper, with opaque sandboxing, no connections/base/forms and no referrer; it receives no model channel. Closing retains the existing ghost/fresh authenticated-preview reset. Site live updates still forward only a version to the opaque page. This does not change scaled-canvas Play or make a matching navigated WindowProxy an editing authority.

At far zoom a picture stands in for the live page, rasterized in the browser. The optional `project.capabilities.captureFonts` advertises a bounded, explicit `api/capture-fonts/<frame>?render=<revision>` read: core extracts that accepted frame’s font-face rules, retains their conditions/descriptors and embeds only referenced declared font bytes through the shared export inliner. Unreferenced assets and ordinary state/model reads carry no new payloads; no arbitrary filesystem/network reads are authorized. The board sends the prepared CSS with a unique capture ID through the authenticated document port. The bridge waits for loaded fonts, removes the clone’s original font-face rules through browser CSSOM, retains other rules, adds the self-contained faces and rasterizes the clone as SVG `foreignObject` to a WebP blob. Image URLs still use the existing CORS-enabled image loads; the preview gains no `fetch`/CSP authority. One capture runs at a time while idle, guarded across resource-read, port/generation, render and response IDs; no PNG/WebP is generated or stored by the server. `web/lib/canvas.js` uses a picture only when it matches the current render and the frame is drawn narrower than 260 px (`.artboard.lod`); the same iframe stays loaded. If web-font proof is absent or resource preparation refuses, the live frame stays painted rather than showing a stale or fallback-font picture. Legacy/network/imported/dynamic font dependencies remain outside this initial closed embedded profile.

## Trust boundaries

- The server binds loopback only, routes are token-scoped, Host/Origin are checked and request sizes bounded.
- Preview pages are sandboxed iframes; model, selection and editing traffic uses an authenticated document-bound `MessagePort`. `previewBridge` is serialized with `Function#toString` and must stay free of imports.
- Source and resource reads use bounded regular-file descriptors; generated outputs are owned by one project and never overwrite unowned files.
- Commits validate a prepared candidate against the expected version before changing accepted state; invalid external edits leave the last good state in place.
