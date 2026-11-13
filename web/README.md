# @divlet/web

The browser board and portable host ports for **divlet**. This package owns the native browser modules, HTML/CSS and transport-free read, selection/observation and optional host-service contracts. It has no dependency on `@divlet/core`, Node built-ins, a project writer or a style engine.

`clientRoot` from `@divlet/web` is a URL to the package's client files. The Node server in `@divlet/core` uses that public locator instead of reaching into a sibling directory. The board itself uses its host's HTTP/SSE and document-bound preview ports; it does not import the Node runtime.

The public `@divlet/web/session` and `@divlet/web/host` subpaths ship portable declarations. A read session does not confer history navigation, project writes, raw filesystem access or public-data curation. Importing the package starts no service or UI.

For an installed board, use `@divlet/cli`, `@divlet/mcp` or `@divlet/pi`; they depend on `@divlet/core`, which pins the matching `@divlet/web` version. Install no separate global web service. All five packages share version `0.0.1`.

Source development uses the `divlet-source` export condition. `npm run build` at the repository root generates this package's `dist/`; native browser JavaScript is copied without tests, while the small TypeScript host ports are compiled with declarations. This is not a claim that the entire browser client is type-checked.

[Product](https://github.com/llblab/divlet#readme) · [Architecture](https://github.com/llblab/divlet/blob/main/docs/architecture.md) · [Testing](https://github.com/llblab/divlet/blob/main/docs/testing.md)
