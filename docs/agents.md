# Connecting an agent

[Back to the project README](../README.md) · [Board guide](board.md) · [Workflow skill](../skills/divlet/SKILL.md)

Pi and MCP expose the same seven tools, validation rules and domain errors. Pi additionally owns the running session, so it can advertise model and thinking-level controls to the board. MCP can answer requests from the board when its client supports sampling.

Use the npm adapters for an installed setup, or the checkout paths below for development. All three adapters depend on the exact matching product version.

## Pi from a checkout

Install dependencies as described in [Quick start](../README.md#quick-start). With Pi installed, choose **one** way to load the adapter:

```bash
# One-off source execution, without a build:
NODE_OPTIONS=--conditions=divlet-source pi -e /absolute/path/to/divlet/pi/index.js

# Or build, then install the adapter package persistently:
npm run build
pi install /absolute/path/to/divlet/pi
```

After building, a folder-scanning installation can instead symlink `/absolute/path/to/divlet/pi` into `~/.pi/agent/extensions/`. Its manifest loads `dist/index.js`, not the raw source. Do not install the repository root or combine installation methods: the extension must load only once.

Open Pi in your workspace, run `/reload` if the session is already running, then `/divlet`. It returns the board URL. `/divlet /absolute/path/to/landing.divlet` opens an exact project; a directory with several projects opens the launcher.

Select an artboard or element and press `A` to ask about it. Pi receives the selection with your request; replies appear in Agent, while accepted edits appear in History. The extension registers the bundled skill, available explicitly through `/skill:divlet`.

## MCP from a checkout

Register this stdio server in your host's configuration; no Pi installation is required:

```json
{
  "mcpServers": {
    "divlet": {
      "command": "node",
      "args": [
        "--conditions=divlet-source",
        "/absolute/path/to/divlet/mcp/index.js",
        "--cwd",
        "/absolute/path/to/workspace"
      ]
    }
  }
}
```

From the checkout root, the equivalent source command is `node scripts/source.mjs mcp/index.js --cwd /absolute/path/to/workspace`. The runner passes the `divlet-source` export condition to child processes through `NODE_OPTIONS`.

The server starts a board when the first tool needs one. Open the URL returned by `divlet_open` in your browser.

- `--cwd <dir>` sets the directory for relative paths and the default project.
- `--project <file.divlet>` opens that project when the first tool needs it.
- `--port <n>` chooses the board port; `0` requests a free port.
- `--no-demo` prevents a new project from getting a starter frame.

Diagnostics go to stderr; stdin/stdout carry MCP only. If the client advertises **sampling**, a request typed in the board's Agent tab is sent as `sampling/createMessage` and the answer appears in the conversation. A client without sampling still gets the tools, but cannot answer prompts from the board.

A board is the **single writer** of its project. A second client attaches to the existing board over its token-scoped local API, sharing revisions instead of opening another writer. Closing an attached client leaves the owner's board running; closing the owner's process stops it, and the next client can open it again.

## A board on a website

Available from `@divlet/mcp` 0.0.3; from a checkout use `node scripts/source.mjs mcp/index.js --connect <url>`. `divlet-mcp --connect <url>` connects any MCP host to a website that is its own MCP provider, such as the published board at `https://llblab.github.io/divlet/`. It opens the site in a managed Chromium (the installed Chrome first), finds the page's provider and offers its tools over stdio; each call runs in the page. No local board, project file or website server is involved.

- `--allow-tools <a,b>` offers only these website tools; `--allow-origin <origin>` admits one more redirect target (default: none).
- `--headless` / `--headed` hide or show the window (default: shown when a display is available).
- `--browser <path>` chooses the Chromium-based executable; `--profile <dir>` keeps the site's browser storage between runs.

The published board serves `divlet_read`, `divlet_patch`, `divlet_edit`, `divlet_frame_manage`, `divlet_undo` and `divlet_mark` on a copy of its project stored in that browser profile. Descriptions are marked as website text, annotations are dropped and results are reduced to text and JSON. A reloaded page is reconnected on the next call; calls that were running are reported as interrupted, never retried. See [browser-hosted MCP](browser-mcp.md).

## npm installation

The product library is `@divlet/core`; the dependency-free browser assets and portable host ports belong to `@divlet/web`. The [CLI adapter](https://github.com/llblab/divlet/blob/main/cli/README.md), [MCP adapter](https://github.com/llblab/divlet/blob/main/mcp/README.md) and [Pi adapter](https://github.com/llblab/divlet/blob/main/pi/README.md) are published as `@divlet/cli`, `@divlet/mcp` and `@divlet/pi`. They own their implementations, not wrappers, and depend on the exact matching `@divlet/core` version, which pins `@divlet/web`.

```bash
npx -y @divlet/cli ./my-project
npx -y @divlet/mcp --cwd /absolute/path/to/workspace
pi install npm:@divlet/pi
```

In an MCP configuration, use `"command": "npx"` and `"args": ["-y", "@divlet/mcp@0.0.4", "--cwd", "/absolute/path/to/workspace"]`. Shared configurations should also pin `@divlet/cli@0.0.4` and `npm:@divlet/pi@0.0.4`; see [npm publication](publishing.md). The `divlet` and `divlet-mcp` binary names belong to the CLI and MCP packages respectively. The root library has no bins, Pi manifest or `divlet/pi` export.

For other hosts, install the skill with `npx skills add llblab/divlet --skill divlet --global` (omit `--global` for one project; pick the target agents when asked), or copy/link `skills/divlet/` into the host's skills directory, and register the MCP server separately. Installing a skill alone does not register tools, and a Pi session that loads the extension must not install the skill again. The skill folder is self-contained: it links to documents by their public address, not through the package's `node_modules`. The [workflow skill](../skills/divlet/SKILL.md) explains the model, component recipes and the read → edit → verify loop.

## Agent tools

The following tools use the project file's vocabulary in their results: `frames` and `frameId`.

- **`divlet_open`** — Opens a project and returns the board URL, project version and frames with their versions. Repeated calls reuse the runtime.
- **`divlet_read`** — `view`: `project`, `frame`, `nodes` (`ids`, `query`, `depth`, `limit`), `components` (addresses, names, overridable text nodes and usage), `selection`, `preview` (measured geometry, overflow, `contentHeight`), `history` (`since`), `diagnostics`, `site` (`route`).
- **`divlet_patch`** — Atomically patches a frame (`frameId` + `expectedVersion`) or, without `frameId`, project settings (name, `outputDir`, shared `tokens`, `css`, `metadata`, `assets`). Resource patches use hierarchical Data-URL leaves and null deletions; project reads expose payload-free `resources` descriptions instead of binary strings. Objects merge, arrays replace and `null` removes.
- **`divlet_edit`** — Structural operations: `insert` (a preset, a nested spec with `children`, an instance `{ ref, descendants }`, an array or an `html` fragment), `move`, `duplicate`, `remove`, `text`, `wrap`, `unwrap`, `detach`, `rename`.
- **`divlet_frame_manage`** — `create`, `duplicate` (for example, a 390px-wide copy) or `delete` a frame. A copy uses the original components rather than copying them.
- **`divlet_undo`** — Undoes or redoes (`redo: true`) the latest change, optionally scoped to one frame.
- **`divlet_mark`** — Announces where the agent is working: a whole frame or elements at any depth (`nodeIds`), with a short `note`. The board animates the area with a flowing outline and shows the note in the agent indicator. Marks clear when the turn ends. A new call replaces them; `add: true` adds areas, and `clear: true` removes marks. The project is unchanged.

```json
{
  "frameId": "landing",
  "expectedVersion": 4,
  "label": "add pricing",
  "op": {
    "type": "insert",
    "after": "hero",
    "spec": {
      "tag": "section",
      "className": "grid gap-6 md:grid-cols-3",
      "children": [
        {
          "ref": "components/plan",
          "descendants": {
            "plan-name-text": { "content": "Pro" }
          }
        },
        { "tag": "p", "text": "Cancel anytime." }
      ]
    }
  }
}
```

An unknown MCP tool returns JSON-RPC `-32602`; domain errors retain codes such as `REVISION_CONFLICT`, `CANNOT_UNDO` and `RENDER_CONFLICT` in result text.

If the version has changed, the tool returns `REVISION_CONFLICT`: read the frame again and rebuild the patch. An invalid patch is never applied, even partially. Before each agent turn, the extension adds a hidden summary of user and file changes since the previous turn, together with a selection snapshot.

### Tool-name compatibility

Canonical names follow domain → resource → operation, using a reduced domain → operation form when the resource would be redundant. These names describe the current source/unreleased contract; earlier installed packages may advertise only the legacy spellings.

| Legacy name | Canonical name |
| --- | --- |
| `open_divlet` | `divlet_open` |
| `read_divlet` | `divlet_read` |
| `patch_divlet` | `divlet_patch` |
| `edit_divlet` | `divlet_edit` |
| `frame_divlet` | `divlet_frame_manage` |
| `undo_divlet` | `divlet_undo` |
| `mark_divlet` | `divlet_mark` |

Both spellings resolve to the same operation, parameters, revision checks and errors; aliases do not create another writer or change persisted project data. Sessions forward the original wire spelling to an attached board so a newer client can still use an older live owner, without retrying a mutation under a second name.

Local MCP lists the seven canonical names and accepts legacy calls. Pi registers legacy aliases inactive by default, keeping the seven canonical tools in new model requests; a host can activate legacy definitions for an existing workflow. Browser MCP and WebMCP explicitly expose six canonical names plus their six compatibility aliases because browser transport allowlisting and WebMCP registration require callable spellings to be listed. Alias descriptions identify the canonical replacement. MCP clients may add their own server namespace; that transport prefix is not part of the raw tool name. No alias removal is scheduled.

## From JavaScript

```js
import { readProject, expandFrame } from "@divlet/core/project";
import { encodeHtml, exportHtml } from "@divlet/core/codec";
import { validateDocument } from "@divlet/core/model";
```

`readProject` validates the whole project, including component references. `expandFrame` expands instances into ordinary nodes. `exportHtml` produces clean HTML for a page or node. The runtime compiles Tailwind automatically.
