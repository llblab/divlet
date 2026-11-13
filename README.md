# divlet

**Design in the browser. Change it in conversation.**

A local layout board for coding agents. Work with real HTML in live artboards, reuse components across pages, and make changes through Pi, MCP or the project file. The browser renders the layout; divlet handles structure, selection, validation and history.

[Quick start](#quick-start) · [Connect an agent](#connect-an-agent) · [Board guide](docs/board.md) · [Documentation](docs/README.md)

> **0.0.2 · release candidate.** CI publication is being verified; 0.0.1 remains the last confirmed npm release until that completes. The native project format remains a pre-freeze draft; keep backups because future versions may require explicit conversion.

## Real pages, not pictures of pages

- **See the actual layout.** Each artboard is an iframe with real HTML, locally compiled Tailwind and CSS. Resize it to check responsive behavior.
- **Point, then ask.** Select an element and ask your connected agent to change it. Pi and MCP use the same seven validated tools.
- **Build once, reuse.** Components, instance overrides, shared tokens and project CSS keep related pages connected.
- **Keep your work local.** The board binds to loopback. Projects are files in your workspace, with autosave, history and undo—not a hosted design service.

## Quick start

Requires **Node.js 22.19 or later**. Pi is optional.

Open a standalone board:

```bash
npx -y @divlet/cli@0.0.2 /absolute/path/to/workspace
```

Or run from a source checkout:

```bash
cd /path/to/divlet
npm ci --legacy-peer-deps
npm start -- /absolute/path/to/workspace
```

Open the URL printed in the terminal. An empty workspace gets `project.divlet` with a starter artboard; an existing project opens directly, and a folder with several projects opens the launcher.

`npm run demo` opens the real onboarding page, [examples/landing/landing.divlet](examples/landing/landing.divlet). Its tracked, derived cache supplies GitHub Pages; see [editing and rebuilding the landing](examples/README.md). `npm run demo:site` opens the Markdown handbook in `examples/handbook/`; `examples/studio/` holds a separate layout scenario. Pencil import remains supported, but no authored PEN demo is bundled.

**First moves:** `V` selects, `P` lets the page behave normally, `L` opens Layers and `H` opens History. `Ctrl K` finds commands; `?` shows shortcuts. See the [board guide](docs/board.md) for direct editing, the inspector and touch controls.

## Connect an agent

### Pi

Install the Pi adapter:

```bash
pi install npm:@divlet/pi@0.0.2
```

For checkout development, load the source adapter for a one-off session instead (no build needed):

```bash
NODE_OPTIONS=--conditions=divlet-source pi -e /absolute/path/to/divlet/pi/index.js
```

For a persistent local package installation, first run `npm run build`, then `pi install /absolute/path/to/divlet/pi`. Choose one method; never load both.

Open Pi in your workspace, run `/reload` if it is already running, then:

```text
/divlet
```

Open the returned board URL, select something and press `A` to ask about it. Pi supplies the tools, the bundled divlet skill and the Agent conversation. Replies stay in Agent; accepted edits appear in History.

### MCP

Two separate steps: the workflow skill teaches the agent the loop, the MCP server gives it the tools. Installing the skill registers no tools.

**1. Install the skill** (user-level, so every project sees it; the installer asks which agents to target):

```bash
npx skills add llblab/divlet --skill divlet --global
```

Drop `--global` to install into the current project only. Skip this step under Pi: the extension below already registers the same bundled skill, and installing it twice makes two copies compete.

**2. Register the server.** Use the npm adapter:

```json
{
  "mcpServers": {
    "divlet": {
      "command": "npx",
      "args": ["-y", "@divlet/mcp@0.0.2", "--cwd", "/absolute/path/to/workspace"]
    }
  }
}
```

Call `open_divlet` and open its returned URL. No Pi installation is needed. Clients that support **sampling** can also answer requests typed in the board's Agent tab.

[Agent integration guide](docs/agents.md) → Alternative Pi installation, MCP options, the workflow skill and JavaScript entry points.

<details>
<summary><strong>Package roles and alternative installation</strong></summary>

**`@divlet/core`** owns the library, model/runtime, server, built-in plugins and shared workflow skill. **`@divlet/web`** owns browser assets and portable host ports, without a dependency back on core. Core's HTTP composition uses its public asset locator. Three real adapter packages own their implementation and commands: **`@divlet/cli`**, **`@divlet/mcp`** and **`@divlet/pi`**. Each adapter pins the exact matching core version; core pins web. All five packages share one product release. See the [web package](https://github.com/llblab/divlet/blob/main/web/README.md).

```bash
# Open a standalone board:
npx -y @divlet/cli ./my-project

# Launch the server from an MCP host:
npx -y @divlet/mcp --cwd ./workspace

# Or install both commands globally:
npm install -g @divlet/cli @divlet/mcp
```

For Pi, run `pi install npm:@divlet/pi@0.0.2`. Shared setups should pin `@divlet/cli@0.0.2`, `@divlet/mcp@0.0.2` and `npm:@divlet/pi@0.0.2`. The root package has no commands or Pi manifest; there is no wrapper layer.

See [npm publication](docs/publishing.md) for version pinning, package identity and release gates.

</details>

## A project you can keep

```text
workspace/
├─ project.divlet      Frames, components, tokens, CSS and embedded resources
├─ assets/             Legacy local inputs, when still referenced
└─ .divlet/project/    Generated HTML, metadata and build assets
```

The `.divlet` JSON file is the source. Edit it through the board, agent tools or your editor: valid external changes appear on the board, and invalid ones leave the last working state visible. New image uploads are embedded in that file; explicitly named resources are materialized only as rebuildable output. Existing local-file references still work without silent conversion. Generated output belongs to one project and does not overwrite unowned files.

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

These checks run from the source checkout. Frontend unit and browser suites live in `web/tests/`; server/model unit suites live in `core/tests/`. Tests are neither served as client assets nor shipped in the npm package.

```bash
npm test                      # Type checking and unit tests
npx playwright install chromium
npm run test:browser:all      # Browser suites
npm run test:release          # Install local tarballs; publish nothing
```

See [testing and validation](docs/testing.md) for focused suites and prerequisites. Contributor rules live in [AGENTS.md](AGENTS.md); remaining work in [BACKLOG.md](BACKLOG.md); completed changes in [CHANGELOG.md](CHANGELOG.md).

[MIT license](LICENSE). Local files. Real HTML. Your agent, your workflow.
