# Connecting an agent

[Back to the project README](../README.md) · [Board guide](board.md) · [Workflow skill](../skills/divlet/SKILL.md)

Pi and MCP expose the same seven tools, validation rules and domain errors. Pi additionally owns the running session, so it can advertise model and thinking-level controls to the board. MCP can answer requests from the board when its client supports sampling.

The first npm release is still in preparation. The checkout instructions work now; npm examples below apply only after publication.

## Pi from a checkout

Install dependencies and build the checkout as described in [Quick start](../README.md#quick-start). With Pi installed, choose **one** way to load the adapter:

```bash
# Load the built checkout as a package:
pi install /absolute/path/to/divlet

# Or link the source adapter, not the repository root:
mkdir -p ~/.pi/agent/extensions
ln -s /absolute/path/to/divlet/adapters/pi ~/.pi/agent/extensions/pi-divlet
```

For a one-off session, use `pi -e /absolute/path/to/divlet/adapters/pi/index.js`. Do not combine installation methods: the extension must load only once.

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
        "/absolute/path/to/divlet/adapters/mcp/index.js",
        "--cwd",
        "/absolute/path/to/workspace"
      ]
    }
  }
}
```

The server starts a board when the first tool needs one. Open the URL returned by `open_divlet` in your browser.

- `--cwd <dir>` sets the directory for relative paths and the default project.
- `--project <file.divlet>` opens that project when the first tool needs it.
- `--port <n>` chooses the board port; `0` requests a free port.
- `--no-demo` prevents a new project from getting a starter frame.

Diagnostics go to stderr; stdin/stdout carry MCP only. If the client advertises **sampling**, a request typed in the board's Agent tab is sent as `sampling/createMessage` and the answer appears in the conversation. A client without sampling still gets the tools, but cannot answer prompts from the board.

A board is the **single writer** of its project. A second client attaches to the existing board over its token-scoped local API, sharing revisions instead of opening another writer. Closing an attached client leaves the owner's board running; closing the owner's process stops it, and the next client can open it again.

## After npm publication

The product package is `divlet`; it ships both the `divlet` CLI and the `divlet-mcp` server command. There is no separate `divlet-mcp` package.

```bash
npx -y --package=divlet divlet-mcp --cwd /absolute/path/to/workspace
```

In an MCP configuration, use `"command": "npx"` and `"args": ["-y", "--package=divlet", "divlet-mcp", "--cwd", "/absolute/path/to/workspace"]`. Pin the package version for shared configurations; see [npm publication](publishing.md).

After both `divlet` and its [thin host wrapper `pi-divlet`](../packages/pi-divlet/README.md) are published, Pi users can run `pi install npm:pi-divlet`. The wrapper re-exports `divlet/pi`; it does not contain a second adapter implementation.

For other hosts, copy or link `skills/divlet/` into the host's skills directory, globally or per project, and register the MCP server separately. Installing a skill alone does not register tools. The [workflow skill](../skills/divlet/SKILL.md) explains the model, component recipes and the read → edit → verify loop.

## Agent tools

The following tools use the project file's vocabulary in their results: `frames` and `frameId`.

- **`open_divlet`** — Opens a project and returns the board URL, project version and frames with their versions. Repeated calls reuse the runtime.
- **`read_divlet`** — `view`: `project`, `frame`, `nodes` (`ids`, `query`, `depth`, `limit`), `components` (addresses, names, overridable text nodes and usage), `selection`, `preview` (measured geometry, overflow, `contentHeight`), `history` (`since`), `diagnostics`, `site` (`route`).
- **`patch_divlet`** — Atomically patches a frame (`frameId` + `expectedVersion`) or, without `frameId`, project settings (name, `outputDir`, shared `tokens`, `css`, `metadata`). Objects merge, arrays replace and `null` removes.
- **`edit_divlet`** — Structural operations: `insert` (a preset, a nested spec with `children`, an instance `{ ref, descendants }`, an array or an `html` fragment), `move`, `duplicate`, `remove`, `text`, `wrap`, `unwrap`, `detach`, `rename`.
- **`frame_divlet`** — `create`, `duplicate` (for example, a 390px-wide copy) or `delete` a frame. A copy uses the original components rather than copying them.
- **`undo_divlet`** — Undoes or redoes (`redo: true`) the latest change, optionally scoped to one frame.
- **`mark_divlet`** — Announces where the agent is working: a whole frame or elements at any depth (`nodeIds`), with a short `note`. The board animates the area with a flowing outline and shows the note in the agent indicator. Marks clear when the turn ends. A new call replaces them; `add: true` adds areas, and `clear: true` removes marks. The project is unchanged.

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

## From JavaScript

```js
import { readProject, expandFrame } from "divlet/project";
import { encodeHtml, exportHtml } from "divlet/codec";
import { validateDocument } from "divlet/model";
```

`readProject` validates the whole project, including component references. `expandFrame` expands instances into ordinary nodes. `exportHtml` produces clean HTML for a page or node. The runtime compiles Tailwind automatically.
