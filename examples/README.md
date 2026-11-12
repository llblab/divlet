# Editable examples

The product's English onboarding page is a real Divlet project: [landing/landing.divlet](landing/landing.divlet), with one responsive frame named `index`. It is the source for the public landing page, not an HTML page maintained separately.

From a checkout:

```bash
npm run demo             # Open examples/landing/landing.divlet on the board
npm run landing:build    # Regenerate and verify the owned cache
npm run landing:check    # Check freshness in a private relocated copy; change nothing here
npm run landing:hash     # Fingerprint the exact Pages public set
npm run test:landing     # Chromium: light/dark, narrow/wide, prefix and fragment navigation
```

Edit the project through its board or the validated source. CSS, text, literal SVG and section links live in the project; `head.icon` embeds the favicon as a `data:image/svg+xml;base64` URL. There is no external landing assets input. This example uses literal inline resources; the general declared-resource contract lives in the format reference. A board is the single writer: build tooling attaches when one is open, and never closes someone else's board. If that owner has not accepted source edits or its cache is stale, resolve it there rather than starting another writer.

`examples/landing/.divlet/landing/` is a narrowly tracked derived artifact. Its ownership manifest and sidecar allow a fresh clone to regenerate without overwriting unowned files. Do not edit generated HTML, remove live locks or commit recovery trash. The npm package keeps this native source, but excludes the cache and repository-only build scripts. The commands above are checkout commands, not a packaged CLI build API.

## GitHub Pages

The existing Landing workflow uses Node.js 22 to check the nested source/cache and verify freshness in a sandbox, then copies prepared output to the root of `gh-pages` only when its public fingerprint differs. The shared `scripts/landing-hash.mjs` owns both the file list and the fingerprint: `index.html` and owned portable image/font/CSS resources under `_assets/`, plus hierarchical `assets/` resources when their owned MIME is compatible with conventional static hosting. Missing or incompatible MIME refuses the latter rather than guessing from a name. The native writer supplies this provenance, but this prepared-copy policy does not establish actual headers on every static host. Sidecars, the ownership manifest, private data, locks, trash and unowned files never enter the public set.

Publication adds `.nojekyll` so GitHub serves `_assets/`, plus `.landing-hash` as the branch's fingerprint record. It does not patch the page or compile a second implementation. A metadata-only regeneration with identical public bytes produces no deployment commit. Serve Pages from the `gh-pages` branch root; configuration, remote synchronization and an actual deployment still need maintainer authorization. Preparing this project does not push or deploy it.

The native project and frame use unfrozen `schemaVersion: 1`, including explicit optional `head.description` and `head.icon`. Generic typed binary-resource tables and cache-independent file-asset storage remain unimplemented FORMAT-ASSETS work. Static-host navigation is tested; expanded viewing opens the prepared page directly. The separate scaled-canvas Play preview still has a tracked `<base>` fragment-navigation limitation; a portable export does not prove that editor-preview path.

## Other scenarios

The studio layout in `examples/studio/` and the [Markdown handbook](handbook/content/index.md) remain independent scenarios. `npm run demo:site` opens `examples/handbook/`, whose template, Markdown, `site.json` and guide assets remain separate authored inputs, not one portable `.divlet` file. All three native examples use unfrozen `schemaVersion: 1`. Authored PEN examples have been removed from this repository; the PEN importer and its tests remain supported. New empty workspaces retain the existing starter until the separately tracked template-initialization work is implemented.

[Project README](../README.md) · [Board and files](../docs/board.md) · [Format](../docs/format.md) · [Testing](../docs/testing.md)
