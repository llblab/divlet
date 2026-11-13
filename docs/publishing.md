# npm publication

This guide owns the guarded first-publication procedure for **0.0.1** and is not permission to run it. A prepared tree or versioned changelog is not a completed registry publication. Publishing packages, pushing release refs and deploying the landing page require explicit maintainer authorization. Packaging does not freeze or cut over the native schema.

npm refused the original unscoped `divlet` name as too similar to `figlet`. The maintainer approved `@divlet/core` and a separately owned `@divlet/web`; the old four-package archives are historical candidates, not scoped substitutes. Never edit archive manifests in place or retry the rejected publisher.

## Package identity and imports

| Package | Contents | User entry point after publication |
| --- | --- | --- |
| `@divlet/web` | Browser assets and portable host ports; no core/Node dependency | Public `clientRoot`, `./session`, `./host` |
| `@divlet/core` | Library, declarations, model/runtime/server, built-in plugins and shared workflow skill | JavaScript public exports and `@divlet/core/skill` |
| `@divlet/cli` | Standalone CLI implementation and `divlet` bin | `npx -y @divlet/cli ./my-project` |
| `@divlet/mcp` | MCP server implementation and `divlet-mcp` bin | `npx -y @divlet/mcp --cwd ./workspace` |
| `@divlet/pi` | Pi adapter implementation, manifest and host dependencies | `pi install npm:@divlet/pi` |

```text
@divlet/cli ─┐
@divlet/mcp ─┼─→ @divlet/core ─→ @divlet/web
@divlet/pi  ─┘
```

Core's HTTP composition imports web's public asset locator; generic model/format modules do not import web. Web's portable contracts own opaque host payloads, not project validation/writes, and have no type/JSDoc back-edge to core. Browser modules use host HTTP/SSE and preview ports, not imports of the Node runtime. Backend plugins consume core contracts; client plugins use the served web module graph. See [architecture](architecture.md).

The root owns `@divlet/core`, `web/` owns `@divlet/web`, and `cli/`, `mcp/` and `pi/` own the adapters, without wrappers. All five versions match. Adapters pin `@divlet/core@0.0.1`; core pins `@divlet/web@0.0.1`. Core has no bins, Pi manifest/peer requirements or `./pi` export. Its tarball excludes the web and adapter implementations. Web owns its only client copy and portable declarations. Built-in plugins remain bundled in core, not separately published.

Node.js 22.19 or later is required. Pi is not required for CLI/MCP. Shared configurations should pin adapter versions, including `npm:@divlet/pi@0.0.1`. For MCP:

```json
{
  "mcpServers": {
    "divlet": {
      "command": "npx",
      "args": ["-y", "@divlet/mcp@0.0.1", "--cwd", "/absolute/path/to/workspace"]
    }
  }
}
```

## Readiness gates

- Freeze one coherent candidate after intended changes settle. Preserve unrelated work; root `dist/`, `web/dist/` and adapter `dist/` are generated publication output, not source development prerequisites.
- Align manifests, lockfile, versions and exact dependency pins. The workspace is `.`, `web`, `cli`, `mcp`, `pi`, `plugins/*`.
- Run [testing](testing.md): `npm test`, the source browser battery, MCP/contract/Pi checks and required `npm run test:release:pi`. A skipped Pi test is not installed-host proof.
- Inspect five tarballs: root, `web`, and each adapter. Check public exports/declarations, native client closure, sole file ownership, bins, manifests, licenses, excluded tests/caches and packaged documentation links. Root documentation links to separately packaged READMEs use absolute GitHub URLs. Repeat builds must not nest outputs or alter bytes.
- Local release checks install both local web/core tarballs, then adapters, into an empty consumer. They must not fetch unpublished product packages, link checkout code or rescue missing client files from a sibling directory. These checks are not registry-install evidence.
- Recheck each exact name/version immediately before publication. `E404` is neither reservation nor entitlement; name-similarity policy may appear only during PUT. An unexpected existing version requires an ownership/integrity decision, not an overwrite or automatic retry.
- Confirm maintainer identity, `@divlet` organization rights, permission to publish all five packages publicly and current npm 2FA requirements. Never store credentials in the repository or request OTPs/tokens in chat. No automatic publication is authorized by this guide.
- GitHub origin/homepage configuration proves neither push permission nor an authorized Pages deployment.

## First-publication sequence

Only after explicit authorization, using the built, frozen and validated candidate:

1. Review notes and record the candidate commit plus every archive's integrity. Keep Unreleased/candidate status until actual publication is verified.
2. Authenticate privately and recheck account/scope rights and registry state. Preserve errors; changing login or Node version does not resolve a name-policy refusal.
3. Publish **`@divlet/web` first**, then verify exact version and integrity. It has no product dependencies. In its validated package directory the command is `npm publish --access public --registry=https://registry.npmjs.org/`; a frozen verified archive may instead be supplied explicitly.
4. Publish **`@divlet/core` second**, only after its exact web dependency is available. Verify version/integrity and that an isolated registry install gets the matching web package without a workspace.
5. Publish `@divlet/cli`, `@divlet/mcp` and `@divlet/pi`, only after their exact core dependency is available. Verify each immutable archive and version.
6. Verify clean registry installations outside the checkout: CLI/MCP help plus an actual board and MCP tool call, and a real isolated Pi profile with `/divlet`, seven tools and the shared skill. No duplicate local adapter, global extension changes or active-session reload is permitted as a shortcut.
7. Only after registry checks pass, reconcile [BACKLOG.md](../BACKLOG.md), [CHANGELOG.md](../CHANGELOG.md) and release usage with the actual outcome. Create `v0.0.1`/push only if separately authorized. Never describe an attempted or failed publication as successful.

npm publication is **not atomic across five names**. If a later package fails, report the partial state and resume only missing publications after refreshing registry evidence. Never republish/unpublish successful packages to simulate atomicity; defective immutable bytes require a new aligned version and dependency pins.

The static landing is a separate delivery surface. Its workflow verifies the prepared native example cache and publishes only when its public-file fingerprint changes. npm publication neither enables Pages nor authorizes deployment.
