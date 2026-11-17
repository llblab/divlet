# divlet

**Design in the browser. Change it in conversation.**

A layout board for coding agents. Your pages are real HTML in live artboards; you point at what should change, the agent edits through validated tools, and every accepted change is versioned, logged and one Undo away.

[Try it in your browser](https://llblab.github.io/divlet/) · [Quick start](#quick-start) · [Connect an agent](#connect-an-agent) · [Board guide](docs/board.md) · [Documentation](docs/README.md)

## Why divlet

- **Real pages, not pictures of pages.** Each artboard is an iframe with real HTML and CSS. Resize it to check responsive behavior.
- **Plain CSS first, Tailwind where it fits.** The inspector edits CSS properties — layout, spacing, border, color, type and effects — with no plugin. The optional Tailwind plugin reads classes back into the same controls and can move inline CSS to utilities.
- **Point, then ask.** Select an element and ask your agent to change it. Pi and MCP share the same validated tools.
- **Build once, reuse.** Components, instance overrides, shared tokens and project CSS keep related pages connected.
- **Local and yours.** Projects are files in your workspace with autosave, history and undo. The board binds to loopback.

## Quick start

Requires **Node.js 22.19 or later**.

```bash
npx -y @divlet/cli /absolute/path/to/workspace
```

Open the printed URL. An empty folder gets `project.divlet` with a starter artboard; an existing project opens directly.

**First moves:** `V` selects, `P` lets the page behave normally, `L` opens Layers, `H` opens History, `A` opens Agent. `Ctrl K` finds any command; `?` lists every shortcut.

No install at all: the [website board](https://llblab.github.io/divlet/) runs the same editor entirely in your browser on the landing project.

## Connect an agent

### Pi

```bash
pi install npm:@divlet/pi
```

Then, in your workspace, run `/divlet` and open the returned URL. Pi brings the tools, the divlet skill and the Agent conversation.

### MCP

**1. Install the skill**, which teaches the agent the read → edit → verify loop:

```bash
npx skills add llblab/divlet --skill divlet --global
```

Skip this step under Pi: its extension already registers the same skill.

**2. Register the server**, which gives the agent the tools:

```json
{
  "mcpServers": {
    "divlet": {
      "command": "npx",
      "args": ["-y", "@divlet/mcp", "--cwd", "/absolute/path/to/workspace"]
    }
  }
}
```

Call `divlet_open` and open the returned URL. Clients that support sampling can also answer requests typed in the board's Agent tab.

### A board on a website

The [website board](https://llblab.github.io/divlet/) is its own MCP provider. Connect an agent to it by URL and the tools run inside that browser page:

```bash
npx -y @divlet/mcp --connect https://llblab.github.io/divlet/
```

Edits stay in that browser profile; images, fonts and other projects need the local server. See [browser-hosted MCP](docs/browser-mcp.md).

More options — source checkouts, version pinning, the JavaScript API — are in the [agent integration guide](docs/agents.md).

## Agent tools

The agent reads a frame and its version, submits a labelled change, then checks the result. A stale version is refused instead of overwriting newer work.

- **Open and inspect:** `divlet_open`, `divlet_read`
- **Change the layout:** `divlet_patch`, `divlet_edit`, `divlet_frame_manage`
- **Explain and recover:** `divlet_mark`, `divlet_undo`

The [tool guide](docs/agents.md#agent-tools) covers views, components, overrides and refusal codes.

## Your project

```text
workspace/
├─ project.divlet      Frames, components, tokens, CSS and embedded resources
└─ .divlet/project/    Generated HTML, rebuildable
```

The `.divlet` JSON file is the source; edit it through the board, an agent or your editor. Valid external changes appear on the board, invalid ones leave the last working state visible. The generated HTML can be served as a static site. Opening a Pencil `.pen` or static `.html` file imports it into a sibling `.divlet` and leaves the original untouched.

> The project format is a pre-freeze draft in 0.1.0: keep backups, since a later version may need an explicit conversion.

[Project format](docs/format.md) · [Files, imports and output](docs/board.md#where-projects-live) · [Markdown sites](docs/site.md)

## Boundaries

- **Static layouts, not applications:** HTML, SVG and CSS; no scripts or event handlers.
- **Overrides, not subtree replacement:** detach a component instance to change its structure.
- **The project file is the source:** hand edits to generated HTML are preserved but not imported back.
- **One live board per project:** other clients attach to it rather than writing alongside it.

## Development

```bash
npm ci --legacy-peer-deps
npm start -- /absolute/path/to/workspace   # run from source
npm test                                   # type checking and unit tests
npx playwright install chromium
npm run test:browser:all                   # browser suites
```

See [testing](docs/testing.md), [architecture](docs/architecture.md) and [AGENTS.md](AGENTS.md) for contributor rules; open work is in [BACKLOG.md](BACKLOG.md) and delivered changes in [CHANGELOG.md](CHANGELOG.md).

[MIT license](LICENSE)
