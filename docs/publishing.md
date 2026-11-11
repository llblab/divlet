# npm publication

The first release, **0.0.1**, is prepared locally but has not been published. This guide describes the intended publication, not permission to run it. Publishing packages, pushing release refs and deploying the landing page require explicit maintainer authorization.

## Package identity

| Package | Contents | User entry point after publication |
| --- | --- | --- |
| `divlet` | Library, declarations, board assets, built-in plugins, CLI, MCP server and the workflow skill | `npx -y divlet ./my-project` |
| `pi-divlet` | Pi manifest and a re-export of `divlet/pi`; depends on the exact product version | `pi install npm:pi-divlet` |

**`divlet-mcp` is a binary in `divlet`, not a separate npm package.** Select the package explicitly when launching it through npx:

```bash
npx -y --package=divlet divlet-mcp --cwd /absolute/path/to/workspace
```

A shared MCP configuration should pin the **package** version:

```json
{
  "mcpServers": {
    "divlet": {
      "command": "npx",
      "args": ["-y", "--package=divlet@0.0.1", "divlet-mcp", "--cwd", "/absolute/path/to/workspace"]
    }
  }
}
```

Both packages require Node.js 22.19 or later. Pi is not required for the product's CLI or MCP server. The Pi package is optional; keep its gallery keywords and host identity out of the root package. Plugins in `plugins/` are bundled in `divlet`'s build; publishing workspace packages separately is not part of this release.

## Readiness gates

- Freeze a coherent candidate first. Do not release a working tree another agent is still changing; review and commit all intended changes, and leave no unrelated edits in the candidate.
- Keep `package.json`, the root lockfile, `packages/pi-divlet/package.json` and `dependencies.divlet` in that wrapper aligned with the intended versions. The initial pair is `divlet@0.0.1` and `pi-divlet@0.0.1`.
- Run the checks in [Testing](testing.md): `npm test`, `npm run test:browser:all`, `npm run test:mcp`, `npm run test:contract`, `npm run test:pi` and `npm run test:release`. A skipped Pi check is not proof that the Pi installation works.
- Inspect `npm pack --dry-run --json` at the root and `npm pack --dry-run --json ./packages/pi-divlet` for intended files and metadata. `prepack` builds `dist/`; never publish with `--ignore-scripts` unless the exact build has been prepared and independently verified. The release smoke check installs local tarballs, not a package fetched by its unpublished name.
- Check the npm registry again immediately before publication: `npm view divlet version --registry=https://registry.npmjs.org/` and the same for `pi-divlet`. An `E404` means no public package is visible, not that the name is reserved or guaranteed claimable. An unexpected existing package requires an ownership decision, never an automatic overwrite or rename.
- The maintainer must have an npm account entitled to both names and satisfy npm's current authentication/2FA policy. Do not add a token to the repository. Authentication and publication are maintainer-controlled external steps; no automatic npm publish workflow is configured here.
- The GitHub origin is `git@github.com:llblab/divlet.git`. Its presence proves local configuration, not push access or that Pages is enabled. Package repository and issue links identify this repository; a configured Pages homepage is not proof of a live deployment.

## First-publication sequence

Only after explicit authorization, from the frozen and validated checkout:

1. Review the release notes and move the delivered Unreleased content under the actual release version/date as part of the release commit. Record the candidate commit; do not describe an attempted or failed publish as successful.
2. Authenticate with npm using the maintainer's approved flow and recheck package ownership/availability.
3. Publish **the product first**, from the repository root:
   ```bash
   npm publish --access public --registry=https://registry.npmjs.org/
   npm view divlet@0.0.1 version --registry=https://registry.npmjs.org/
   ```
4. Verify the registry installation in a fresh directory, outside the checkout, so workspace dependencies and local bins cannot hide missing files:
   ```bash
   npx -y --package=divlet@0.0.1 divlet --help
   npx -y --package=divlet@0.0.1 divlet-mcp --help
   ```
   Also open a scratch project and check the board and MCP tools with the published package; `--help` alone does not prove those paths.
5. Publish the wrapper only after `divlet@0.0.1` is available, then verify its registry version:
   ```bash
   cd packages/pi-divlet
   npm publish --access public --registry=https://registry.npmjs.org/
   npm view pi-divlet@0.0.1 version --registry=https://registry.npmjs.org/
   ```
   In a clean Pi profile, install `npm:pi-divlet@0.0.1`, reload and check `/divlet`, the seven tools and the skill. Do not load a local adapter at the same time.
6. After both installations pass, create the release tag `v0.0.1` on the candidate commit and push the intended commit/tag only if that is authorized too. Remove the pre-publication notices in the README and landing page only once their npm instructions are actually usable; reconcile [BACKLOG.md](../BACKLOG.md) and [CHANGELOG.md](../CHANGELOG.md) with the real outcome.

npm package publication is not atomic across the two names. If the product succeeds but the wrapper fails, retain that truthful partial state and resume with the wrapper; do not republish or unpublish the product to make the steps look atomic. A defective published version needs a new version and corresponding wrapper dependency, not an attempt to overwrite immutable package bytes.

The static landing page is a separate delivery surface. Its workflow verifies the native example's prepared cache and publishes only when the public-file fingerprint changes, and GitHub Pages must serve the `gh-pages` branch root. npm publication does not itself enable Pages or authorize deployment.
