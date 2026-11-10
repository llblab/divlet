# divlet

**Design in the browser. Change it in conversation.**

A local layout board for coding agents. Work with real HTML in live artboards, reuse components across pages, and make changes through Pi, MCP or the project file. The browser renders the layout; divlet handles structure, selection, validation and history.

[Quick start](#quick-start) · [Connect an agent](#connect-an-agent) · [Board guide](docs/board.md) · [Documentation](docs/README.md)

> **Pre-release · 0.0.1 is in preparation.** No npm release has been published yet. Start from a checkout below; npm instructions are marked separately.

## Real pages, not pictures of pages

- **See the actual layout.** Each artboard is an iframe with real HTML, locally compiled Tailwind and CSS. Resize it to check responsive behavior.
- **Point, then ask.** Select an element and ask your connected agent to change it. Pi and MCP use the same seven validated tools.
- **Build once, reuse.** Components, instance overrides, shared tokens and project CSS keep related pages connected.
- **Keep your work local.** The board binds to loopback. Projects are files in your workspace, with autosave, history and undo—not a hosted design service.

## Quick start

Requires **Node.js 22.19 or later**. Pi is optional.

From a source checkout:

```bash
cd /path/to/divlet
npm ci --legacy-peer-deps
npm run build
npm start -- /absolute/path/to/workspace
```

Open the URL printed in the terminal. An empty workspace gets `project.divlet` with a starter artboard; an existing project opens directly, and a folder with several projects opens the launcher.

To explore the bundled projects, use `npm run demo`, `npm run demo:pen` or `npm run demo:site`. The [PEN example](examples/pen/README.md) includes reusable components, variables and a local SVG.

**First moves:** `V` selects, `P` lets the page behave normally, `L` opens Layers and `H` opens History. `Ctrl K` finds commands; `?` shows shortcuts. See the [board guide](docs/board.md) for direct editing, the inspector and touch controls.

## Connect an agent

### Pi

After building the checkout, install it once:

```bash
pi install /absolute/path/to/divlet
```

Open Pi in your workspace, run `/reload` if it is already running, then:

```text
/divlet
```

Open the returned board URL, select something and press `A` to ask about it. Pi supplies the tools, the bundled divlet skill and the Agent conversation. Replies stay in Agent; accepted edits appear in History.

### MCP

Register the checkout's stdio server in your host:

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

Call `open_divlet` and open its returned URL. No Pi installation is needed. Clients that support **sampling** can also answer requests typed in the board's Agent tab.

[Agent integration guide](docs/agents.md) → Alternative Pi installation, MCP options, the workflow skill and JavaScript entry points.

<details>
<summary><strong>npm installation — after the first publication</strong></summary>

The package **`divlet`** ships both commands: `divlet` and `divlet-mcp`. There is no separate `divlet-mcp` package.

```bash
# Open a standalone board:
npx -y divlet ./my-project

# Launch the server from an MCP host:
npx -y --package=divlet divlet-mcp --cwd ./my-project

# Or install both commands globally:
npm install -g divlet
```

For Pi, install `pi install npm:divlet-pi` only after **both** `divlet` and `divlet-pi` have been published. The thin wrapper depends on the product; it does not copy the adapter.

See [npm publication](docs/publishing.md) for version pinning, package identity and release gates.

</details>

## A project you can keep

```text
workspace/
├─ project.divlet      Frames, components, tokens and CSS
├─ assets/             Authored images and resources
└─ .divlet/project/    Generated HTML, metadata and build assets
```

The `.divlet` JSON file is the source. Edit it through the board, agent tools or your editor: valid external changes appear on the board, and invalid ones leave the last working state visible. Generated output belongs to one project and does not overwrite unowned files.

Open a Pencil `.pen` or static `.html` file to import it into a sibling `.divlet` project. The source stays untouched and an existing destination is not overwritten. The generated output can also be served independently as a static site.

[Project format](docs/format.md) · [Files, imports and output](docs/board.md#where-projects-live) · [Markdown sites](docs/site.md)

## Agent tools

**Read → edit → verify.** The agent reads the current frame and version, submits a labelled change, then checks the result. A stale version is refused rather than silently overwriting newer work.

- **Open and inspect:** `open_divlet`, `read_divlet`.
- **Change the layout:** `patch_divlet`, `edit_divlet`, `frame_divlet`.
- **Explain and recover:** `mark_divlet`, `undo_divlet`.

The [workflow skill](skills/divlet/SKILL.md) teaches the loop; the [tool guide](docs/agents.md#agent-tools) covers views, components, overrides and refusal codes.

## Current boundaries

- **Static web layouts, not application code.** HTML, SVG, CSS and Tailwind classes; no scripts, event handlers or build directives.
- **Property overrides, not arbitrary subtree replacement.** Change a component reference or detach the instance for structural changes.
- **Generated HTML is not an editing round trip yet.** Hand edits are reported and preserved on regeneration, not imported into the project. Make persistent changes in the model.
- **One live owner per project.** Other clients attach to its board and share revisions; independent writers are not supported.

## Go deeper

- [Board guide](docs/board.md) — Canvas, selection, panels, components, files and static output.
- [Agent integration](docs/agents.md) — Pi, MCP, tools and the JavaScript API.
- [Format reference](docs/format.md) — The JSON model and generated files.
- [Architecture](docs/architecture.md) — Core, plugins, adapters and trust boundaries.
- [Web-native core contract](docs/web-native.md) — Accepted design direction; implementation gaps remain in the backlog.
- [Documentation index](docs/README.md) — All guides, examples and contributor references.

## Development

These checks run from the source checkout; tests are not shipped in the npm package.

```bash
npm test                      # Type checking and unit tests
npx playwright install chromium
npm run test:browser:all      # Browser suites
npm run test:release          # Install local tarballs; publish nothing
```

See [testing and validation](docs/testing.md) for focused suites and prerequisites. Contributor rules live in [AGENTS.md](AGENTS.md); remaining work in [BACKLOG.md](BACKLOG.md); completed changes in [CHANGELOG.md](CHANGELOG.md).

[MIT license](LICENSE). Local files. Real HTML. Your agent, your workflow.
