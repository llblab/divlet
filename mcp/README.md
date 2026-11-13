# @divlet/mcp

The MCP stdio adapter for divlet. This package owns its implementation and depends on the exact matching `@divlet/core` product version; the core does not contain another copy.

Install:

```bash
npx -y @divlet/mcp@0.0.2 --cwd ./workspace
```

Unreleased (0.0.3): connect to a website that is its own MCP provider (the tools run in a managed browser page; `playwright-core` drives the installed Chrome or Playwright's Chromium):

```bash
npx -y @divlet/mcp --connect https://llblab.github.io/divlet/ [--allow-tools a,b] [--headless] [--profile <dir>]
```

The installed binary is `divlet-mcp`. Importing the package exposes `runMcp` without starting a service; the executable starts it explicitly. Protocol output uses stdout; diagnostics use stderr. Checkout commands use `node scripts/source.mjs mcp/index.js` from the repository root.

Shared development, release notes and publication guidance live in the [divlet repository](https://github.com/llblab/divlet).
