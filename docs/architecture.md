# Architecture

divlet is a local browser board for agents. A **project** is one `<name>.divlet` file (the [Divlet format](format.md)); a runtime serves it over loopback HTTP and generates HTML pages from accepted model changes. Managed-page hand edits are currently diagnosed rather than imported.

This guide describes the current implementation. The accepted [web-native core contract](web-native.md) owns the target architecture; [BACKLOG.md](../BACKLOG.md) tracks the gaps. In particular, the existing provider registry and style-engine seam do not yet establish complete plugin independence.

## Layout

```text
core/        the Divlet core: index.js (public API — the package's `.`), lib/, tests/
web/         the web client (a peer of core: plugins may act on both): `board.js` entry, `index.html`, `board.css`, modules by domain in `web/lib/`
plugins/     importers/exporters/style engines, one package each (index.js, lib/, tests/)
adapters/    host adapters, one package each: `pi/` (the Pi extension and its skill), `mcp/` (the MCP stdio server) and `cli/` (the standalone CLI)
packages/    host packaging that is published on its own: `divlet-pi` is the Pi manifest plus a re-export of `divlet/pi`
examples/    example projects (studio, a Markdown site, a PEN file)
```

## Entry points

The root package says what it is: `.` is the library (`core/index.js` — `openRuntime`, `launch`, `makeHost`, `startServer`,
`resolveOpenFile`), the bins are `divlet` (CLI) and `divlet-mcp` (MCP server), and every other surface is a named subpath
(`./runtime`, `./contract`, `./model`, `./project`, `./codec`, `./boards`, `./plugins`, `./engine`, `./pi`). A host manifest field
points at that host's adapter entry — `pi.extensions` is `dist/adapters/pi/index.js`, not a root shim — and the host's own package
(`packages/divlet-pi`) carries the host keywords and re-exports `divlet/pi`, so the adapter is never copied and cannot drift.
There is no root `index.js`: an entry that meant "this package is a Pi extension" was the wrong shape for a product whose other
hosts are a CLI and an MCP server.

## Core and plugins

The **core** is three things, connected and inseparable: (1) the **format**, a flexible web-oriented JSON description of a Divlet project (`core/lib/model.ts`, `core/lib/project.js`; see [format](format.md)); (2) the **codec** between that format and HTML (`core/lib/codec.js`, `core/lib/render.js`); (3) the **web editor with its own server** (`core/lib/runtime.js`, `core/lib/server.js`, `core/lib/hub.js`, `web/`). The core knows exactly one project format and speaks plain HTML/CSS.

Everything else attaches to the core as a **plugin**. Tailwind is one: `plugins/tailwind/` is a style engine (the declaration ↔ class codec `lib/styles.js`, local compilation and class explanation/suggestion `lib/styling.js`) reached through the seam `core/lib/engine.js`, and it contributes the inspector's class editor and Layout / Spacing / Effects folds on the client (`plugins/tailwind/web/`, registered through `web/lib/panels.js`; the server lists the active plugins' client modules as `clientPlugins` in the project info and serves them at `plugins/<id>/<file>`). Importers and exporters are the other plugin kind:

Plugin contracts are **types, not prose**. `core/lib/plugins.ts` exports `Importer` and `Exporter` (what a format plugin must provide), `core/lib/engine.ts` exports `StyleEngine` (what a style engine must provide), and `core/lib/contract.ts` exports the capability schema (`Schema`, `Tool`, `ToolParameters`, `Session`) that an adapter renders. Each is a real exported type with a declaration in the published package, so a plugin author writes `import type { Importer } from 'divlet/plugins'` and the compiler — not a reviewer — says whether the descriptor fits: `npm run typecheck` includes every `.ts` under `core/`, `adapters/` and `plugins/`, and `npm run build` emits `dist/**/*.d.ts`. A JavaScript plugin still works: the registry (`registerImporter`, `registerStyleEngine`, `registerExporter`) is the one place that promises a descriptor satisfies its contract, which is why that promise is written down as a cast there and nowhere else.

Every other format is an **importer plugin** under `plugins/<id>/`: a codec from a foreign source into a Divlet project. The contract and the registry live in `core/lib/plugins.js` (`id`, `extensions`, `claims`, optional `detach` and `summarize`, `convert`); the core asks `importerFor(file)` and never names a foreign format. `core/lib/import.js` is the generic driver: it converts once, publishes `<name>.divlet` exclusively and records `metadata.import`. Every plugin is a small package of its own: `package.json` with its own dependencies (the repository is an npm workspace, `plugins/*`), `index.js` as the entry point only, `lib/` for its code and `tests/` for its tests. Plugin implementations import core contracts (`../../../core/lib/...`). The current registries in `core/lib/plugins.ts` and `core/lib/engine.ts` still import concrete built-ins directly; moving that selection to composition code is required by the target contract. Exporters would be the symmetric plugin kind and use the same layout.

`plugins/pen/` is the Pencil importer: `index.js` is only the entry point (the descriptor the registry loads); the plugin's own code is in `lib/` — `source.js` (the PEN reader), `validate.js` (PEN wire validation, built on the core's exported validation helpers), `projection.js` (a PEN frame projected to HTML, which is what renders correctly), `pen-*.js` (gradient, mesh, path and polygon renderers) and `convert.js` (projection → Divlet: per-node style bundles become Tailwind classes through the core style codec, color variables become tokens, instances that equal their component plus overrides stay instances, `data-pen-*` carriers are dropped).

`plugins/html/` is the HTML importer: a static page opened by path becomes a one-frame project beside it (scripts, event handlers, comments, stylesheet links and frames are dropped and counted in the import provenance). It declares `listed: false`, so `.html` files in a folder are never offered as projects.

Two deliberate limits (maintainer decisions, 2026-11-08): the **exporter** contract (`registerExporter`, `exportAs` in `core/lib/plugins.js`) ships without an exporter until a concrete consumer and format exist (per-frame HTML downloads are the board's own route, not an exporter); and a changed `.pen` is never merged into an edited project: the board notices it and **Import again** creates a new sibling project (`<name>-2.divlet`), leaving the current project and the source untouched.

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

`landing/` is a static page for GitHub Pages, and a repository artifact: it is not part of the npm package and the product never
reads it. It is self-contained by rule — no scripts, no remote fonts, images or stylesheets — because nothing else is published
with it. `.github/workflows/landing.yml` fingerprints the folder with `scripts/landing-hash.mjs`, compares that with the
`.landing-hash` file at the root of the `gh-pages` branch, and publishes only when they differ: the published branch holds exactly
the files the hash covered (the same module answers "what ships" and "did it change"), so a commit that never touched the page
cannot rewrite it. Publishing needs a GitHub remote and Pages configured to serve `gh-pages`. This checkout has an origin;
that does not prove the remote is synchronized or Pages is enabled. npm publication is separate (see [npm publication](publishing.md)).

## Project ownership

A board (one runtime with its HTTP server) is the single writer of its project file and holds the accepted state, revisions,
selection and diagnostics. When a board starts it registers itself in `~/.divlet/boards/<hash>.json` (`core/lib/boards.js`:
absolute file, board URL with its access token, owning pid); a client that opens the same project file finds that entry, checks
the owner is alive, and attaches instead of opening a second writer. Attached calls run on the owner through the token-scoped
`api/tool` route, which speaks the same contract. A client that attached may close at any time without touching the board; when
the owner's process disappears the entry is stale and the next client opens the project itself. The registry lives outside the
project, is owner-only on disk, and grants nothing beyond the board's own local API.

## Modules

| Module | Responsibility |
| --- | --- |
| `core/lib/model.ts` | Document/node validation and limits, patches (`applyDocumentPatch`, including `styles`). |
| `core/lib/project.js` | Project settings, project read/write, components (`expandFrame`, `listComponents`). |
| `core/lib/codec.js`, `core/lib/render.js` | Model ↔ HTML (`encodeHtml`, `decodeHtml`, `renderFile`), frame preparation, Tailwind compilation hooks. |
| `core/lib/engine.js` | The style-engine seam; the Tailwind plugin (`plugins/tailwind/`) provides compilation and the declaration ↔ utility codec. |
| `core/lib/ops.js` | Structural operations (insert, move, wrap, …) on frames. |
| `core/lib/runtime.js` | The project runtime: accepted state, queue, history, persistence, watching, assets. |
| `core/lib/output.js`, `core/lib/static.js` | Generated-file ownership, collision checks, portable builds. |
| `core/lib/server.js`, `core/lib/hub.js`, `core/lib/launch.js`, `core/lib/projects.js` | HTTP boundary, the launcher, opening paths, project discovery and creation. |
| `adapters/pi/lib/extension.js`, `adapters/cli/index.js` | The Pi extension (tools `open/read/patch/edit/frame/undo/mark_divlet`) and the CLI. |
| `web/` | The board: canvas, panels, inspector, palette. |

## Frames in the browser

Every artboard keeps one iframe for the lifetime of its frame. The browser decides when an off-screen page loads and paints (`loading="lazy"`); only selected or expanded frames are promoted to `eager`. Scrolling, zooming or deselecting never unmounts, reloads or rotates the bridge of a frame, and updates reach a loaded frame only when its render version advances. Leaving full screen resets the interacted page by double-buffering: the old iframe stays above as a `frame-ghost` until the fresh authenticated frame reports its first render.

At far zoom a picture stands in for the live page, taken in the browser: once a page has rendered, the board asks its bridge (`divlet:capture`) and the bridge serializes the page into an SVG `foreignObject` with images and CSS `url()` resources inlined through CORS-enabled image loads (no `fetch`, so the preview CSP stays closed), rasterizes it and sends a WebP blob over the private port. One picture is taken at a time while the browser is idle; blobs are kept per frame and render. Nothing is stored on disk or requested from the server, so there is no loading state when zooming out. `web/canvas.js` shows the picture instead of the live page when a frame is drawn narrower than 260 px (`.artboard.lod`; the iframe stays loaded but is not painted) and zooms to a frame when its thumbnail is clicked. Web fonts that are not installed on the machine are not embedded (the picture falls back to system fonts).

## Trust boundaries

- The server binds loopback only, routes are token-scoped, Host/Origin are checked and request sizes bounded.
- Preview pages are sandboxed iframes; model, selection and editing traffic uses an authenticated document-bound `MessagePort`. `previewBridge` is serialized with `Function#toString` and must stay free of imports.
- Source and resource reads use bounded regular-file descriptors; generated outputs are owned by one project and never overwrite unowned files.
- Commits validate a prepared candidate against the expected version before changing accepted state; invalid external edits leave the last good state in place.
