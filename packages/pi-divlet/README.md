# pi-divlet

The Pi extension for [divlet](https://www.npmjs.com/package/divlet): the board's tools, the `/divlet` command, the agent bridge
and the bundled `divlet` skill.

```bash
pi install npm:pi-divlet    # from npm, after both divlet and pi-divlet are published
pi install /path/to/divlet  # or from a copy of the product repository
```

This package is the Pi packaging only — a manifest and a re-export. The extension itself is `divlet/pi` in the product package,
and everything it does (tools, validation, rendering, history) is the product's, shared with the MCP server (`divlet-mcp`) and
the CLI (`divlet`).
