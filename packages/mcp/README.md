# @divlet/mcp

The MCP stdio adapter for divlet. This package owns its implementation and depends on the exact matching `divlet` product version; the core does not contain another copy.

Install:

```bash
npx -y @divlet/mcp@0.0.1 --cwd ./workspace
```

The installed binary is `divlet-mcp`. Importing the package exposes `runMcp` without starting a service; the executable starts it explicitly. Protocol output uses stdout; diagnostics use stderr. Checkout commands use `node scripts/source.mjs packages/mcp/index.js` from the repository root.

Shared development, release notes and publication guidance live in the [divlet repository](https://github.com/llblab/divlet).
