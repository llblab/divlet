# npm publication

This guide owns the guarded first-publication procedure for **0.0.1** and is not permission to run it. A prepared release tree or versioned changelog is not evidence of a completed registry publication. Publishing packages, pushing release refs and deploying the landing page require explicit maintainer authorization. This packaging change does not freeze or cut over the native schema.

## Package identity

| Package | Contents | User entry point after publication |
| --- | --- | --- |
| `divlet` | Library, declarations, board assets, built-in plugins and shared workflow skill (`divlet/skill`) | JavaScript public exports |
| `@divlet/cli` | Standalone CLI implementation and `divlet` bin | `npx -y @divlet/cli ./my-project` |
| `@divlet/mcp` | MCP server implementation and `divlet-mcp` bin | `npx -y @divlet/mcp --cwd ./workspace` |
| `@divlet/pi` | Pi adapter implementation, manifest and host dependencies | `pi install npm:@divlet/pi` |

The adapter packages live in `packages/cli`, `packages/mcp` and `packages/pi`, each with its own implementation and tests, not a wrapper. They share the root release version and depend on exact `divlet@0.0.1` initially. The root has no bins, Pi manifest/peer requirements or `divlet/pi` export. All four packages require Node.js 22.19 or later; Pi is not required for CLI or MCP use. Built-in plugins remain bundled in the product, not separately published in this release.

Shared configurations should pin `@divlet/cli@0.0.1`, `@divlet/mcp@0.0.1` and `npm:@divlet/pi@0.0.1`. For MCP:

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

- Build with `npm run build`, then freeze a coherent candidate and run the checks below. Do not release a working tree another agent is still changing; review and commit intended changes and exclude unrelated edits. `dist/` is publishing output, not a development prerequisite.
- Align the root manifest, lockfile and all three adapter manifests with the shared release version and exact adapter `dependencies.divlet` values.
- Run the checks in [Testing](testing.md): `npm test`, `npm run test:browser:all`, `npm run test:mcp`, `npm run test:contract`, `npm run test:pi` and `npm run test:release`. A skipped Pi check is not proof that Pi installation works.
- Inspect four tarballs: the root product and `packages/cli`, `packages/mcp`, `packages/pi`. Use `npm pack --dry-run --json` at the root and for each package path. Check exports, bins, manifests, declarations and documentation closure. The product excludes adapter packages, so shipped documentation links to their READMEs must use absolute GitHub URLs. Never publish unverified or stale generated output; the release smoke check installs local tarballs, not unpublished registry names.
- Recheck the registry immediately before publication with `npm view <name> version --registry=https://registry.npmjs.org/` for all four names. An `E404` does not establish reservation or entitlement. Unexpected existing packages require an ownership decision.
- **Verify namespace entitlement immediately before publication.** The maintainer must control `divlet` and the `@divlet` scope, have permission to publish all three scoped packages publicly, and satisfy current npm authentication/2FA policy. Never add a token to the repository. No automatic npm publication is authorized by this guide.
- The configured GitHub origin and Pages homepage do not prove push access, Pages activation or a live deployment.

## First-publication sequence

Only after explicit authorization, from the built, frozen and validated candidate:

1. Review release notes, record the candidate commit and move delivered Unreleased content to the actual release version/date. Do not describe an attempted or failed publication as successful.
2. Authenticate using the approved maintainer flow and recheck ownership and scope entitlement.
3. Publish the product first from the root, then verify availability:
   ```bash
   npm publish --access public --registry=https://registry.npmjs.org/
   npm view divlet@0.0.1 version --registry=https://registry.npmjs.org/
   ```
4. Only once `divlet@0.0.1` is available, publish each of `packages/cli`, `packages/mcp` and `packages/pi` from its package directory with `npm publish --access public --registry=https://registry.npmjs.org/`. Verify all three registry versions.
5. Verify installations outside the checkout, where workspace dependencies cannot hide missing files:
   ```bash
   npx -y @divlet/cli@0.0.1 --help
   npx -y @divlet/mcp@0.0.1 --help
   pi install npm:@divlet/pi@0.0.1
   ```
   Open a scratch project and check board serving and MCP tools; help output alone does not prove them. In a clean Pi profile, check `/divlet`, all seven tools and the shared skill without also loading a local adapter.
6. After all installations pass, create `v0.0.1` on the candidate commit and push only if separately authorized. Prepare npm-facing usage in the validated release candidate, but announce completed publication only after the documented registry paths and installations are verified; reconcile [BACKLOG.md](../BACKLOG.md) and [CHANGELOG.md](../CHANGELOG.md) with the real outcome.

npm publication is not atomic across four names. If any adapter fails after the product succeeds, report that partial state and resume only the remaining publications; do not republish or unpublish successful packages to simulate atomicity. Defective immutable bytes require a new aligned release version and exact adapter dependencies.

The static landing is a separate delivery surface. Its workflow checks the native example's prepared cache and publishes only when the public-file fingerprint changes; GitHub Pages must serve the `gh-pages` branch root. npm publication neither enables Pages nor authorizes deployment.
