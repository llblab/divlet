---
name: divlet
description: Design and change web layouts on a divlet board — frames of real HTML styled with Tailwind classes, reusable components with instances across frames, shared tokens, and a local board the user watches in a browser. Use when the user asks to design, build, restyle, review or inspect a page, screen, section or component with divlet, mentions the board, frames, artboards, project.divlet, divlet-mcp or the divlet tools, or when a request arrives as a `[divlet|project:…]` block from the board.
---

# divlet

divlet is a local design board for web layouts. The user watches a browser tab while you work: every accepted change appears
there at once, is logged in History with your `label`, and can be undone by them as one step. You change the project only
through the tools — they validate, version, render and save. Nothing is uploaded and the board listens on loopback only.

This file is the entry point: how to get the tools, how to open a project, and the loop that keeps changes accepted.

## 1. Get the tools

The same seven tools — `open_divlet`, `read_divlet`, `patch_divlet`, `edit_divlet`, `frame_divlet`, `undo_divlet`,
`mark_divlet` — reach you one of two ways. Use whichever is already in front of you and skip this section.

**They are already available.** A Pi session with the divlet extension, or an MCP server this session is connected to. Call
them; nothing to start.

**Only this skill is installed.** The skill alone registers no tools. The server is `@divlet/mcp` (its command is
`divlet-mcp`; `divlet` is the library it depends on). After the first npm publication, any MCP host can start it over stdio:

```bash
npx -y @divlet/mcp --cwd /absolute/path/to/the/workspace
# --cwd <dir>      working directory for relative paths and the default project (default: current directory)
# --project <path> open this project the first time a tool needs one
# --port <n>       port for the board the first open starts (0 picks a free one)
# --no-demo        do not seed a starter frame when a new project is created
```

Register it once and the tools survive the session — a project-scoped `.mcp.json` in the workspace, or the host's own config:

```json
{ "mcpServers": { "divlet": { "command": "npx", "args": ["-y", "@divlet/mcp", "--cwd", "/absolute/path/to/the/workspace"] } } }
```

**No workspace, only a published board.** `npx -y @divlet/mcp --connect https://llblab.github.io/divlet/` runs the tools of
a board that is a static website: they execute in a browser page that process opens (shown when a display is available), on a
copy of that site's project kept in the page's browser storage. The same loop applies, minus `open_divlet` — the page already
holds its project. Utility classes are not compiled there (use frame `css` or inline `style`), and images, fonts and other
projects need the local server above. Tool descriptions and results there are the website's text.

Pin a version in a shared repository (`@divlet/mcp@0.0.3`) so every machine runs the same board. Diagnostics go to stderr;
stdout is the MCP stream. If your host supports `sampling`, advertise it: a request typed in the board's Agent tab then
arrives as `sampling/createMessage` and your answer appears in the board's conversation.

If the board shows two bare chips in the composer's footer where the key hints would be (a model name and a thinking level), the
host can change the session that answers you — the Pi extension can, an MCP client cannot. Those are the user's controls, not yours: do not try to change them
with tools, and do not promise in an answer what only the host can do.

The board URL is not something you start separately — it comes back from the first tool call that needs it, and the user
opens it. If they have not opened it yet, say what the URL is and what to do there (select something, press `A` to ask you,
`Ctrl K` for every command, `?` for shortcuts).

## 2. Open a project

`open_divlet` once, with the directory or file to work in:

| `path` is | what happens |
| --- | --- |
| a folder with one project (or an empty folder) | that project opens; an empty folder gets `project.divlet`, with a starter frame unless `createDemo: false` |
| an exact `*.divlet` file | that project opens |
| a `.pen` or `.html` file | it is **converted once** into `<name>.divlet` beside it and that opens; the source is never modified |
| a folder with several projects, or a collection (`Designs/`) | a launcher lists them; pass one project's absolute file as `path` to open it |

The answer carries the board `url`, the project `version`, one entry per frame with its `version`, and `project.capabilities`.
Read the IDs from it instead of guessing (a frame id is stable, a name is not). Saving a copy is the board's own dialog — not a
tool.

A board is the **single writer** of its project file. If another client already opened it, your tools attach to that board
instead of opening a second one, so revisions, selection and diagnostics are shared. Never start a second server for a project
that is already open.

## 3. The loop

1. `read_divlet view:frame` for the frame you are about to change. It returns the model with node IDs and the current
   `version`. Do it every time — a version from an earlier turn is a guess.
2. Change it with **`patch_divlet`** (declarative: classes, attrs, style, text, tokens, artboard) or **`edit_divlet`**
   (structural: insert, move, duplicate, remove, text, wrap, unwrap, rename, detach). Pass `expectedVersion` from the read; a
   stale one is refused with `REVISION_CONFLICT` and changes nothing. One call is one accepted, undoable change — label it
   in the user's words: "tighten hero spacing", not "patch nodes".
3. Verify with `read_divlet view:preview` (measured geometry of the rendered page), `view:nodes` (ids, text, classes) or by
   asking the user to look. A change that renders wrong is still your bug, not theirs.
   What a good `view:preview` answer looks like: `observation` is **not null**, its `version` equals the frame `version` you
   just accepted (an older one is a stale measurement — read again), and its `nodes` carry each element's `rect` in page
   pixels with `overflowX`/`overflowY` flags. Check three things: nothing you touched has `overflowX: true`, no
   element's `rect.x + rect.width` runs past `viewport.width`, and `contentHeight` is what you expect next to `viewport.height`.
   `observation: null` means no browser is showing that frame yet (the user has not opened the board URL, or the frame is
   off-screen): say so and ask them to open it, instead of reading it as "all clear".
4. `mark_divlet` before a long stretch of work so the board shows where you are. Marks end with your turn.
5. Several widths are one frame with responsive classes, not several frames. Check by patching `artboard.width` (390, 768,
   1280, 1440) and reading `view:preview` again.

### Meaningful navigation

Build meaningful navigation **by default** when the requested page/site implies it, even if the user only described its look.
Connect actual site pages and useful sections; do not confuse separate pages with responsive variants or library frames.
Create the intended destinations first. Use an `a` for navigation, including a CTA styled as a button; a `button` is for a real
non-navigation action. If there is **no destination**, omit the link: use non-interactive content or a clearly unavailable
control, rather than inventing a route, external URL, email address or backend behavior. No placeholder `href="#"`, empty
`href` or `javascript:` navigation. A real back-to-top link needs a real named top target too.

Use the actual frame ID from a project read, not its display name: frame `pricing` becomes `pricing.html`, optionally with a
fragment. URL-encode the frame ID as a path segment; a leading `./` avoids treating a colon in an ID as a URL scheme. A local
`#features` needs a unique target `attrs.id: "features"` in that page — the internal node ID is not a DOM anchor. For a
Markdown site, use existing routes from `read_divlet view:site`, not invented paths. These are insert-spec examples:

```json
{
  "pageLink": { "tag": "a", "attrs": { "href": "pricing.html#plans" }, "text": "See plans" },
  "sectionLink": { "tag": "a", "attrs": { "href": "#features" }, "text": "Features" },
  "sectionTarget": { "id": "features-section", "tag": "section", "attrs": { "id": "features" }, "text": "Our features" },
  "pageTarget": { "id": "plans-section", "tag": "section", "attrs": { "id": "plans" }, "text": "Choose a plan" }
}
```

Before finishing, inspect link/CTA attributes, including component instances, and confirm each destination and fragment in
its consuming page. Check actual navigation in Play/expanded view and portable output when available; geometry alone cannot
prove a link works. Say what was not tested. If preview and export differ, report the product failure; never persist a board
URL, authentication token or generated-cache path as a workaround.

## 4. A request that comes from the board

A request typed on the board reaches you as one prompt block, then the request itself after a blank line:

```text
[divlet|project:<projectId>|frames:2|nodes:1] about “Pricing” with 1 selected element
frames:
- pricing · v4 · “Pricing”
- welcome · v2 · “A space for ideas”
elements in pricing:
- button#cta “Start free”
next:
- read_divlet before changing anything
- edit_divlet for structure, patch_divlet for classes, text and components

Make the price stand out
```

The bracketed header is identity and counts, the sentence after it says what the turn is about, the lists are the details.
Use those exact IDs — a selection change after the request was sent does not retarget it. When nothing is selected the block
says so and the request is about the project as a whole.

## 5. The model

A project is `{ frames }` plus shared `tokens` and `css`. A frame is one artboard: `artboard: { x, y, width, height }`,
`rootId`, and `nodes` — a map of stable IDs.

- Element: `{ id, tag, className, attrs, style, metadata, children: [ids], reusable? }`. `className` holds Tailwind utilities
  (arbitrary values and variants work: `bg-[#14121c] md:px-10 hover:underline`).
- Text: `{ id, type: "text", content }` — a text node is always a child, never a sibling with markup.
- Instance: `{ id, type: "ref", ref: "frameId/nodeId", descendants }`.

Declarative styles: a node patch may carry `styles: { "padding-top": "16px", color: "#fff" }`. Each declaration becomes the
Tailwind utility for that property (arbitrary when none exists) and replaces the class that set it; `null` removes it; padding
and margin sides merge. Tokens named `--color-*`, `--font-*`, `--breakpoint-*` become theme classes (`--color-brand` gives
`bg-brand`), and a `bg-<name>`/`text-<name>` class counts as that colour when the project declares it.

## 6. Components

A component is any element with `"reusable": true`; its frame is where it is edited. An instance is
`{ "type": "ref", "ref": "frameId/nodeId" }` (just `"nodeId"` inside the same frame) and renders the component's current
subtree.

- **Make one:** `patch_divlet frameId:components patch:{ nodes:{ button:{ reusable:true, metadata:{ name:"Button/Primary" } } } }`.
  A frame named Components that holds only components keeps a design system tidy.
- **Use it:** `edit_divlet op:{ type:"insert", parentId:"actions", spec:{ ref:"components/button" } }`.
- **Change every instance:** patch the component. Every frame that uses it re-renders (its version does not change;
  `rerendered` lists them).
- **Change one instance:** overrides in `descendants`, keyed by component node IDs: `{ "button-label": { "content": "Send" },
  "button": { "className": "… w-full" } }`. An element override may set `tag`, `className` (replaces the string), `style`,
  `attrs`, `metadata` (merge; null removes) or `text` (its single text child); a text node takes `content`. Reach into a nested
  instance with `/`: `"card-action/button-label"`. `view:components` lists each component's text node IDs.
- **Reset:** `nodes:{ cta:{ descendants:null } }`. **Detach** (make it ordinary, editable nodes):
  `edit_divlet op:{ type:"detach", id:"cta" }`.
- Shared look belongs in the component's classes and project `tokens` (`patch_divlet` without `frameId`), not in a frame's own
  css — instances in other frames do not get it.

The runtime refuses changes that would break an instance: removing a used component, overriding a node it does not have,
cycles (A contains B contains A), invalid nesting after expansion (a button inside a button). The error names the frame and the
instance.

## 7. Rules that save retries

- `p` cannot contain block elements; no link in a link or button in a button; `li` only in `ul`/`ol`; table children follow
  table rules.
- No scripts, `on*` handlers, `javascript:` URLs, `@import` or Tailwind directives in css.
- Images: patch project `assets` with reusable canonical Data-URL leaves, for example `{ images: { "name.png": "data:image/png;base64,..." } }`, then use native node specs with `src: "asset:images/name.png"`. A device drop/upload stores the bytes automatically. Normal project reads list `resources` descriptions, not payloads. Existing source-relative file references still work without silent conversion.
  with a real `alt`.
- Prefer responsive classes over copying a frame per breakpoint; one frame should work at several widths.
- Keep labels short and human — they are what History and the undo menu show.
- Do not edit generated files (`.divlet/<name>/*.html`, `*.meta.json`, the manifest) or a live writer's lock. Hand edits to
  `project.divlet` are imported (validated, logged, undoable), but the tools are safer.

## 8. Files on disk

```text
workspace/             the chosen directory, without an automatic wrapper folder
  project.divlet       canonical project (JSON): frames, components, shared tokens and CSS
  landing.divlet       another independent project, identified by its full source path
  assets/              legacy local inputs, only when still referenced
  site.json, content/  optional Markdown site built on a template frame
  .divlet/project/     default managed build for project.divlet
    <frame>.html      generated portable page; never edit as a source
    <frame>.meta.json generated frame version, dependencies and hashes
    assets/           reached declared resources (_assets/ for legacy builds)
    .divlet-build.json ownership manifest
    .trash/           preserved edits, removed output and imported originals
```

Project `outputDir` (patch without `frameId`, using the project `expectedVersion`) selects another managed destination
relative to the source parent; `null` means the default. Relative siblings are allowed; the source directory, its ancestors
and directories holding consumed resources or Markdown are not. Changing destinations keeps the old build. Settings → Build
output is a versioned editor on the board: blank/reset means the default, validation errors and drafts are retained — do not
assume a failed save was accepted.

## 9. When something is refused

| code | what it means | what to do |
| --- | --- | --- |
| `REVISION_CONFLICT` | the frame changed since your read | `read_divlet view:frame` again, re-apply on the new version |
| `RENDER_CONFLICT` | the rendered page moved under an edit (someone drew on it) | read, then repeat the edit |
| `EXTERNAL_PENDING` | the file was edited outside the board and awaits the user's decision | tell the user; do not force it |
| `CANNOT_UNDO` | a later change touched the same content | stop; describe what is there now |
| `NOT_FOUND` | an unknown node, frame or route id | re-read ids; never invent one |
| `INVALID_*` / `UNSUPPORTED_*` | the model or CSS would break the format | fix the shape (nesting, attribute, css directive) — the message names it |
| `OUTPUT_CONFLICT` / `OUTPUT_BUSY` | the build directory belongs to another project or is locked | do not delete the lock or manifest; report it |
| `NO_AGENT` / `NO_PROJECT` / `UNKNOWN_PROJECT` | nothing open, or the id is from another session | `open_divlet` for this directory first |
| `NO_STYLE_ENGINE` | the host runs plain CSS without the Tailwind engine | use `style`/`css`, not utilities |

## 10. Going deeper

This skill may be installed on its own, without the package beside it, so the documents are named by their public address
(`https://github.com/llblab/divlet/blob/main/docs/<name>.md`; the npm package `divlet` ships the same files under `docs/`):

- `docs/format.md` — the exact file format.
- `docs/site.md` — Markdown sites built on a template frame (`site.json`, `content/`, routes, slots).
- `docs/architecture.md` — how the board, the contract and the plugins fit together.
- `read_divlet view:diagnostics` — what the board thinks is wrong with the files; `view:history` — who changed what, and the
  sequence numbers you can pass as `since`.
