# Changelog

Implemented product outcomes live here. Contributor constraints are in [AGENTS.md](AGENTS.md), current contracts in [docs/](docs/README.md), and remaining work in [BACKLOG.md](BACKLOG.md).

## 0.0.1

Initial release of divlet: a local HTML/SVG/CSS layout board for agents. The native project format remains an unfrozen schema-1 draft; this release does not activate the approved future ordered-CSS/renderer profile or promise frozen compatibility.

### Product and agent integration

- **One product, three real adapters.** `divlet` supplies the library, board, bundled plugins and portable workflow skill. `@divlet/cli`, `@divlet/mcp` and `@divlet/pi` own their commands and implementations, with exact matching product dependencies. Node.js 22.19 or later is required; CLI and MCP do not require Pi.
- **Seven shared validated tools.** Pi and MCP use the same open/read/patch/structural-edit/frame/history/work-mark contract, revisions and refusal codes. Board requests carry the submitted selection snapshot and compact context rather than following later selection changes. MCP sampling and Pi model/thinking controls appear only when the host advertises them; session settings are not project content.
- **One live writer per project.** Other clients attach to the owning board and share its revisions and history. Importing the library or an adapter starts no service. Installed packages use compiled exports; checkout development runs TypeScript sources without a build.

### Native projects and files

- **Real web content in independently owned files.** A `.divlet` contains frames, shared tokens/CSS, reusable components, property overrides and inert metadata. Valid external edits are accepted; invalid or stale candidates preserve the last working state. Discovery and the launcher distinguish exact project files, including same-named projects.
- **Bounded HTML admission and foreign-format conversion.** Static HTML imports use the core sanitizer; PEN interpretation belongs to its importer plugin. Conversion creates a non-overwriting sibling project and preserves the original. Markdown sites retain routed pages and shared templates.
- **Embedded resources with explicit identity.** Image uploads and declared files retain their bytes in a hierarchical Data-URL asset tree, materialized only as rebuildable output. Explicit `asset:` references preserve names, MIME and dependency bases; literal Data URLs stay inline. Existing filesystem inputs remain supported without silent absorption.
- **Owned static output and export.** Generated HTML/resources have per-project provenance, collision/link refusal and repairable sidecars. Supported local dependencies survive portable publication below a URL prefix. Clean per-frame HTML export embeds supported resources; ambiguous query, SVG-use, cycle or expanded-size semantics refuse rather than silently change meaning. Save a copy creates an independently identified project.
- **Device fonts use ordinary CSS and common assets.** Family selection preserves understood fallback stacks and inline priority. TTF/OTF, bounded WOFF 1 and restricted null-transform WOFF2 registration retain exact submitted bytes and append only proven disjoint companions. Upload and selection are separate Undo steps. Static CFF2 and independently encoded CFF1 WOFF fixtures exercise actual browser matching and portable loading.

### Board and editing

- **Long-lived live artboards.** Lazy iframes retain identity through edits, zoom and selection. Expanded browsing is separate from authenticated editing; known page/fragment links reveal their artboards, and projected missing-page links report the unsupported destination. Browser-generated snapshots embed proven font bytes; stale or unprovable captures keep the live page instead of showing fallback-font text.
- **Direct, responsive inspection.** Layers, bottom breadcrumbs, one vertical inspector flow and adaptive toolbars expose layout, typography, appearance and metadata. Spacing uses outside-in box bands with independent side values and measured content dimensions. Border has two synchronized views and one writer. Controls retain whole values, keyboard access and useful narrow/200% layouts.
- **Guarded whole-project history.** Grouped and multi-step Undo/Redo validate the complete candidate, refuse overlapping later edits and persist before moving stack authority. Frame lifecycle/order replay preserves authored positions. History state points name proven stack endpoints, not audit sequence numbers.
- **Stable conversation and feedback.** The agent pane follows arrivals near the bottom without stealing older reading positions. Activity/Stop moves as one surface when the sidebar folds. Delayed agent-start notices defer for a bounded interval to preserve the ordinary Undo window, and deleted artboards no longer publish queued measurements.

### Safety and boundaries

- **Local, bounded access.** The board binds to loopback with token-scoped routes, Host/Origin checks, CSP and request bounds. Filesystem operations use regular-file/no-link checks, byte/count budgets and non-overwriting publication. Trusted project access is not an arbitrary HTTP filesystem route.
- **Authenticated previews.** Editing traffic uses a current document-bound MessagePort with capability rotation, sandboxing and referrer protection. A matching iframe window alone is not authentication. Stale observations, captures and async reads cannot replace newer accepted state.
- **Explicit current limits.** Arbitrary application scripts, managed-HTML reverse editing, an offline browser writer and automatic public-safe snapshot curation are not implemented. Transformed WOFF2, font collections/optional container blocks, ambiguous face merging, wider linked/imported/dynamic font capture and native external SVG-use remain refused or gated. Variable CFF2 and arbitrary font-program compatibility are not established by static fixtures.
- **Separate evidence layers.** Source/unit/browser, local installed-tarball, registry-install, static-host and format-freeze evidence are distinct. Strict Node/core types and a small checked client transport slice do not imply whole-client typing. The portable browser semantic slice is not a complete offline editor.

Pre-release implementation and retired-experiment history remains in Git. See [testing](docs/testing.md) for executable checks and their coverage limits; future work is tracked only in the backlog.
