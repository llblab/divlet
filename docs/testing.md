# Testing

| Check | Command | Covers |
| --- | --- | --- |
| Unit | `node --test` | Model, project, codec, styles, runtime, server, launcher, import, history, safety, output ownership, static/site builds, the Pi adapter (`adapters/pi/tests`), plugins (`plugins/*/tests`) and package contents. |
| Browser (all) | `npm run test:browser:all` | The 25 real Chromium suites in `core/tests/browser/`: `run`, `responsive`, `layout-wrap`, `site`, `fullscreen`, `settings`, `interact`, `selection-completion`, `size-editor`, `controls`, `features`, `spacing`, `toolbars`, `appearance`, `reimport`, `chrome`, `fluid`, `snapshots`, `launcher`, `launcher-errors`, `native-collections`, `projects`, `security`, `static`, `native-default`. Most have a `test:<name>` script (`test:spacing`, `test:chrome`, …); `appearance`, `reimport` and a few others run only through this command or through a combined script (`test:controls`, `test:launcher`, `test:source`). |
| PEN fidelity | `npm run test:pen-fidelity [file.pen ...]` | Renders every root frame of a `.pen` (default: `examples/pen/field-notes.pen`, two frames) from the native projection and from the converted Divlet frame in Chromium and requires identical pixels; a flat, single-colour screenshot counts as a failure too, because an identical blank canvas would prove nothing. `PI_DIVLET_FIDELITY_LIMIT=N` samples the first N frames. The 68-frame, 3 195-instance result quoted in the changelog came from a design that is not part of this repository and cannot be reproduced from it. |
| Release | `npm run test:release` | Packs the package, installs the tarball into an empty directory and proves that the CLI answers, a board starts and serves the client and a plugin's client module, and the installed MCP server answers `initialize`, lists the shared tools and opens a board **without Pi**; the package holds no tests or caches. Also packs and installs `divlet-pi` against that installed product and checks it re-exports the same adapter function; this is not a real Pi session. Needs the npm registry (or its cache); publishes nothing. |
| MCP | `npm run test:mcp` | Spawns the packaged MCP entry and speaks its stdio transport for real: `initialize`, `tools/list`, tool calls with a domain refusal, two clients sharing one board (attachment, not a second writer), concurrent writes refused by revision, shutdown on EOF and board de-registration. |
| Contract | `npm run test:contract` | One tool list; the JSON Schema and TypeBox renderings agreeing on required parameters; the agent vocabulary; a board running only the tools it publishes; the board registry (one live owner, stale entries removed). |
| Pi RPC | `npm run test:pi` | A real Pi in RPC mode with a scripted model: a board request reaches a divlet tool, changes the project and returns as a reply. Skipped when the `pi` CLI is absent. |

## Conventions

- Assert actual state (project file, model, accepted version), not only that a request returned.
- Layout contracts are tested with geometry at 390 px, 390 px at 200% interface size and 820 px (`core/tests/browser/fluid.mjs` holds the 200% case; `chrome.mjs` holds the wide and phone layouts without it); errors and statuses must not move controls (`launcher-errors.mjs`, `projects.mjs`).
- Importer plugins keep their tests beside them; a plugin's tests must pass without any other plugin installed.
- Screenshots go to the ignored `artifacts/` directory.
