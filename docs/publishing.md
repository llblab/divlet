# npm publication

All five packages publish together through GitHub Actions/OIDC, with frozen-archive integrity, provenance metadata and clean registry CLI/MCP/Pi installations checked. Do not treat a version as published until all five registry checks and the installed-host CI job pass. This guide owns publication safeguards and the first-publication procedure below; it is not permission to publish again. A prepared tree or versioned changelog is not a completed registry publication. Publishing packages, pushing release refs and deploying the landing page require explicit maintainer authorization. Packaging does not freeze or cut over the native schema.

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

The root owns `@divlet/core`, `web/` owns `@divlet/web`, and `cli/`, `mcp/` and `pi/` own the adapters, without wrappers. All five versions match. The 0.3.1 adapters pin `@divlet/core@0.3.1`; core pins `@divlet/web@0.3.1`. Core has no bins, Pi manifest/peer requirements or `./pi` export. Its tarball excludes the web and adapter implementations. Web owns its only client copy and portable declarations. Built-in plugins remain bundled in core, not separately published.

Node.js 22.19 or later is required. Pi is not required for CLI/MCP. Shared configurations should pin adapter versions, including `npm:@divlet/pi@0.3.1` after verifying that version is published. For MCP:

```json
{
  "mcpServers": {
    "divlet": {
      "command": "npx",
      "args": ["-y", "@divlet/mcp@0.3.1", "--cwd", "/absolute/path/to/workspace"]
    }
  }
}
```

## Subsequent releases

Keep all five versions aligned and update every exact internal dependency pin plus the lockfile. Validate and freeze a new candidate, then publish the new version in web → core → adapters order under the same integrity/install/auth safeguards. Published `0.0.1` bytes are immutable; fixes require a new version, never an overwrite or unpublish/retry. Git release refs and Pages remain separately authorized delivery surfaces. The first-publication sequence below is retained for its guards and recovery rules, not as a command to rerun the initial release.

## GitHub Actions publishing

The [Release workflow](https://github.com/llblab/divlet/blob/main/.github/workflows/release.yml) uses **npm Trusted Publishing (OIDC)**, not a stored `NPM_TOKEN`. It is one flow started by pushing a stable `vX.Y.Z` tag on a commit of `main`: it validates and freezes the candidate, publishes the **GitHub Release**, then publishes **npm**, then verifies the registry install. Ordinary pushes, branch pushes and a hand-created GitHub Release do not publish npm packages. Prereleases are not supported by this workflow.

### One-time maintainer setup

1. Push the reviewed workflow and its scripts to `main` only when Git/Pages delivery is authorized. The workflow file at the tagged commit is the one that runs. No setup command in this guide creates tags, pushes or publishes automatically.
2. In GitHub Settings → Environments, create **`npm`** and under Deployment branches and tags allow the **tag** rule `v*.*.*` (a run started by a tag has a tag ref, so a branch-only rule refuses the publish job; the `main` branch rule may stay). Add required reviewers if an approval gate is wanted; a solo maintainer must not enable a self-review prohibition that prevents any approval. Also protect the `v*` tags with a tag ruleset (no deletion or update, creation by maintainers only): the environment rule checks only the ref's name, and the workflow itself additionally refuses a tag whose commit is not on `main`.
3. For **each** of `@divlet/web`, `@divlet/core`, `@divlet/cli`, `@divlet/mcp` and `@divlet/pi`, open npm package Settings → Trusted Publisher and add GitHub Actions with these exact, case-sensitive values:
   | Field | Value |
   | --- | --- |
   | Organization or user | `llblab` |
   | Repository | `divlet` |
   | Workflow filename | `release.yml` (filename only) |
   | Environment name | `npm` |
   | Allowed action | Direct **`npm publish`** |
   Stage-only permission is not sufficient for this workflow; dist-tag management permission is not needed. Do not add an npm write token to Actions secrets. According to the [npm trusted-publisher guide](https://docs.npmjs.com/trusted-publishers/), a new connection must complete its first successful publish within **two days** or expire: create these bindings near the next intended release, not by republishing `0.0.1` to test them. npm does not validate the connection when it is saved.
4. After the first successful OIDC release, optionally restrict npm Publishing access to require 2FA and disallow traditional tokens. Make that account change deliberately; this repository does not change account settings or revoke tokens for you.

### Run a release

Align the five manifests, exact pins, lockfile and the changelog first. The changelog's `## X.Y.Z — <title>` heading must already name the release (not `Unreleased`): the GitHub Release is written from that section, so the flow refuses a missing, empty or still-unreleased one before anything is published. Then, under separate Git authorization, create the stable tag on the intended `main` commit and push it:

```bash
git tag -a v0.3.1 -m "divlet 0.3.1" && git push origin v0.3.1
```

The tag push is the whole release action; there is nothing to dispatch. The tag must resolve to a commit that is on `main` (a tag on a side branch is refused before any package script runs), and that commit is the one the archives are built from, so automatic npm provenance names the same source commit. A tag that was pushed before its commit was ready is never moved on the registry's behalf: if validation fails, nothing was published, so fix `main`, delete the unpublished tag and push it again on the new commit.

The workflow has four boundaries:

- **Validate and freeze:** Node 22.19.0, clean locked dependencies without install hooks or restored Actions caches, source units/types, the full browser battery, then one build and five hook-free packs. Test the exact frozen archives through the installed CLI/MCP and required isolated Pi 1.5.2 host before uploading the candidate artifact. No OIDC permission is available here.
- **Publish GitHub Release:** Only after validation, a job with `contents: write` and no OIDC or npm credential creates the Release for the tag from its changelog section (title `X.Y.Z: <title>`), unless that tag already has one. It installs and builds nothing. If it fails, npm is not published.
- **Publish npm:** After the Release, a separate hosted runner, the `npm` environment, read-only GitHub history access and `id-token: write`. npm 11.19.0 performs OIDC/provenance with upload transport retries explicitly disabled (`--fetch-retries=0`); a retryable network response cannot silently replay the package PUT. No checkout dependencies, product builds or package lifecycle scripts run in this job. The script rechecks tag/commit, package order and archive SHA-512, checks all five registry names, then publishes web → core → adapters and waits for each exact version/integrity. The whole workflow is serialized without cancelling a running publication.
- **Verify registry installation:** A fresh non-OIDC job installs by public registry names, checks archive and installed-lock integrity against the frozen manifest, serves the actual board/client/plugin routes, exercises MCP's seven tools and runs the real isolated Pi/font/history cases. It does not reload any active user session or install Pi globally.

### Failure and recovery

Keep the `npm-candidate-<run-id>` archive set and `npm-outcome-<run-id>-<attempt>` receipt. They have 90-day artifact retention; download the evidence if longer retention is required. The publisher records `attempt_started` before invoking npm, `npm_accepted` after success and `registry_verified` only after exact-byte visibility. Registry absence after an attempt means wait/read or stop, never another upload.

Publication jobs **cannot be rerun automatically**: attempts after the first are refused, and a fresh run for the same tag checks prior runs of this workflow for it, including all job attempts. A previously started publisher requires explicit operator recovery even if no registry version is visible. Do not delete run history or edit the run title to bypass that guard. Runs whose publisher was skipped because validation or the GitHub Release job failed do not count as upload attempts; after fixing the cause, push the tag again on a commit of `main` (delete the unpublished tag first, and keep the old one as an `archive/` ref if its history matters). A failed registry verification after all uploads is not permission to publish again; rerun only the read-only verification job. The GitHub Release is published before npm, so an npm failure leaves a public Release for a version the registry may not have: say so on the Release, and, because a re-run skips a tag that already has one, edit or delete that Release deliberately before the retry rather than letting a stale one stand.

For partial or uncertain outcomes, inspect the original logs, frozen bytes, receipt and fresh registry metadata before choosing an explicit manual recovery or a new aligned version. Do not rebuild a failed release's archives, overwrite accepted versions, infer token rights from `npm whoami`, or run manual and CI publishing concurrently. A local/mock pass proves guard behavior, not a successful live OIDC exchange. The first real CI release was verified for 0.0.2; changes to workflow identity, environment bindings or account policy still require their own live authorization check.

## Readiness gates

- Freeze one coherent candidate after intended changes settle. Preserve unrelated work; root `dist/`, `web/dist/` and adapter `dist/` are generated publication output, not source development prerequisites.
- Align manifests, lockfile, versions and exact dependency pins. The workspace is `.`, `web`, `cli`, `mcp`, `pi`, `plugins/*`.
- Run [testing](testing.md): `npm test`, the source browser battery, MCP/contract/Pi checks and required `npm run test:release:pi`. A skipped Pi test is not installed-host proof.
- Inspect five tarballs: root, `web`, and each adapter. Check public exports/declarations, native client closure, sole file ownership, bins, manifests, licenses, excluded tests/caches and packaged documentation links. Root documentation links to separately packaged READMEs use absolute GitHub URLs. Repeat builds must not nest outputs or alter bytes.
- Local release checks install both local web/core tarballs, then adapters, into an empty consumer. They must not fetch unpublished product packages, link checkout code or rescue missing client files from a sibling directory. These checks are not registry-install evidence.
- Recheck each exact name/version immediately before publication. `E404` is neither reservation nor entitlement; name-similarity policy may appear only during PUT. An unexpected existing version requires an ownership/integrity decision, not an overwrite or automatic retry.
- For local publishing, confirm maintainer identity, `@divlet` organization rights, permission to publish all five packages publicly and current npm 2FA requirements. CI instead requires the exact trusted-publisher/environment bindings above; `npm whoami` is not an OIDC permission check. Never store credentials in the repository or request OTPs/tokens in chat. This guide itself authorizes no publication.
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

After an upload is attempted, a public `404` is not proof that it is safe to upload again. Persist an attempt checkpoint before invoking npm and record acceptance before waiting for registry visibility. Verify the exact version and frozen integrity, not merely the latest tag; first-publication visibility can take minutes. Retry only reads within a bounded wait. On timeout or an uncertain command outcome, retain the checkpoint and stop; never turn a negative visibility check into another upload. The operator handoff may resume a verified version without republishing it. A failed npm browser-auth callback is distinct from a package lookup failure: inspect its stage and fresh registry state before admitting one explicit package-targeted authentication retry. Preserve the failed attempt in history; a retry flag must not bypass an unreviewed upload outcome or change a published archive.

npm publication is **not atomic across five names**. If a later package fails, report the partial state and resume only missing publications after refreshing registry evidence. Never republish/unpublish successful packages to simulate atomicity; defective immutable bytes require a new aligned version and dependency pins.

The static landing is a separate delivery surface. Its workflow verifies the prepared native example cache and publishes only when its public-file fingerprint changes. npm publication neither enables Pages nor authorizes deployment.
