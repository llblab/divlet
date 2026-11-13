# Site routing and Markdown

A site combines one accepted frame from `project.divlet` as a shared template with a directory of Markdown pages. The runtime composes and validates the complete site, then publishes the accepted snapshot. The template remains editable through the existing model tools; Markdown remains a set of independent source files.

## Source ownership

| Source | Owns | Editing path |
| --- | --- | --- |
| `site.json` beside the selected `.divlet` source | Template binding, content directory and slot IDs | Edit the JSON file |
| Template frame in `project.divlet` | Shared layout and metadata | `divlet_patch` or a valid project-file edit |
| Content `.md` files | Page content and page metadata | Edit individual files |
| Composed route documents | Derived template + Markdown projection | Read-only; edit their sources |

The runtime does not add editable frames for individual routes. It generates route HTML and metadata into the managed output directory, always derived from the shared template and Markdown rather than independent editable page copies. Parallel agents can edit separate Markdown files while the layout agent edits the template.

## Configuration

Create `site.json` beside the selected source:

```json
{
  "schemaVersion": 1,
  "title": "My documentation",
  "templateId": "docs-template",
  "contentDir": "content",
  "slots": {
    "content": "content-slot",
    "title": "title-slot",
    "navigation": "navigation-slot"
  }
}
```

`title` is a required nonempty site title. `templateId` references the ID of an accepted frame in `project.divlet`. `contentDir` is relative to the source's parent directory and defaults to `content`. The optional `viewport` object supplies `width` and `height` for the composed model; otherwise the template's artboard dimensions apply. The standalone site still reflows to the actual browser viewport.

The schema is strict: unsupported configuration fields fail with a diagnostic. Paths must stay inside the source's parent directory; symbolic links are not supported for content sources or content directories.

## Template slots

Slots reference stable model node IDs, not CSS selectors or HTML `id` attributes. The required `content` slot receives rendered Markdown. Optional `title` and `navigation` slots receive the page title and generated navigation.

The slot element survives composition. Its existing children are replaced, so its classes, styles and metadata continue to control presentation. Placeholder children are useful when editing the template directly on the board.

Slots must exist, reference different element nodes, and have no ancestor/descendant overlap. Use a block container such as `article`, `section` or `div` for Markdown content and a `nav` container for navigation. The final model must satisfy the normal divlet HTML topology checks; inserting a grid of block elements into a paragraph is invalid.

Content and navigation slots accept `div`, `main`, `section`, `article`, `aside`, `nav`, `header` or `footer`. A title slot can be another non-void element, such as `h1`.

The template is an ordinary frame. Read its current version, then patch its CSS or stable nodes through `divlet_patch`. A successful template-source change rebuilds the site. It can reference project components outside the slots; slots must address the template's own element nodes, not nodes inside an instance. Changes to directly or transitively referenced components, or shared project CSS/tokens, also rebuild the routes without changing the template's source version. Snapshot caching includes the expanded template model and shared theme, not unrelated frame revisions or the compiler's cumulative stylesheet. Unrelated component and project-name edits, and unchanged scans, keep the accepted snapshot. Per-page structural overrides are not supported.

## File-based routes

| Path relative to the content directory | Site path |
| --- | --- |
| `index.md` | `/` |
| `guide/index.md` | `/guide/` |
| `guide/start.md` | `/guide/start/` |
| `reference/api.md` | `/reference/api/` |

Routes use URL-encoded path segments and a trailing slash. A known route requested without its trailing slash redirects to its canonical path. Unknown routes return HTTP 404. Routes are served below the local server's token-scoped `site/` prefix; use the returned URL instead of assuming the server root is the site root.

`guide.md` and `guide/index.md` map to the same route and therefore conflict. The candidate site is rejected rather than choosing one. Directory structure also supplies the navigation hierarchy; an optional directory `index.md` provides the landing page for that group.

## Markdown and metadata

Pages support ordinary Markdown and GitHub-flavored constructs within divlet's static HTML profile. YAML frontmatter may contain:

| Field | Purpose |
| --- | --- |
| `title` | Page title and navigation label |
| `description` | Page description in the route metadata |
| `order` | Numeric navigation ordering |
| `draft` | Exclude the page from the accepted site |

```markdown
---
title: First steps
description: Create and connect a page.
order: 20
---

Start with the [guide](./index.md).

## Your first route

Create a Markdown file and save it.
```

Headings receive anchors for fragment links. Frontmatter is removed before Markdown rendering. Raw HTML in Markdown is rejected; place authored structure in the divlet template. Executable scripts, event handlers and unsupported URL schemes remain outside the accepted profile.

When `title` is omitted, the first Markdown heading supplies it, falling back to the filename. `order` defaults to `0`; siblings with equal order sort by title. Draft pages have no published route.

The runtime supports at most 200 Markdown source files, a tree depth of 32 directories, and 16 MiB of aggregate Markdown input, with a 4 MiB per-file bound. The ordinary model's node, depth and text limits also apply to each composed page.

## Links and assets

A Markdown link such as `./start.md#your-first-route` resolves against the Markdown source's directory, then maps to its site route while preserving the fragment. Root-relative page links such as `/guide/` resolve below this site's server prefix.

Local Markdown images resolve against their source file's directory. Local template assets resolve against the template's own file directory. The runtime rewrites these URLs to the confined `files/` endpoint; a single page base URL would not correctly represent both origins. Missing local assets can return 404 while the page remains editable. Existing symbolic-link paths and paths outside the source directory are rejected.

URL rewriting covers element attributes, plain `srcset` candidates, authored document CSS, inline styles and tokens. CSS URL escapes and complex/data `srcset` forms are rejected explicitly. URLs inside arbitrary Tailwind class values are not rewritten; use authored CSS or absolute URLs for those assets. The combined Markdown source tree is limited to 16 MiB.

Use ordinary local files for shared images. External HTTP(S) URLs remain external. Relative URLs in template CSS and inline styles are resolved from the template source location.

CSS `url()` values support plain or quoted URLs without CSS escape sequences. Site `srcset` values use comma-separated plain URLs with optional width or density descriptors; data URLs and URL whitespace in `srcset` are unsupported.

## Static output

The same accepted routes are built as `index.html` files in the active `.divlet/<source stem>/` or configured `outputDir`: `/` becomes `index.html`, `/guide/start/` becomes `guide/start/index.html`. Each route receives a metadata sidecar identifying its source and template. Frame and route artifact names must not collide.

Local resources are bundled into `_assets/`; navigation and asset URLs become relative to each output page. Copy the output directory to an ordinary static HTTP host, including under a URL prefix, without keeping Divlet running. These generated pages do not contain the editor bridge or live-update connection. External resources stay external. Missing local resources produce warnings; invalid content retains the previous accepted build. Removing routes or the configuration removes their owned outputs while preserving manual edits in output `.trash`.

## Reading and live updates

`divlet_read` accepts:

```json
{ "view": "site" }
```

This returns the accepted configuration, site version, URL, route list and content tree, or `null` when the site is disabled. To inspect a composed route and its source provenance:

```json
{ "view": "site", "route": "/guide/start/" }
```

The composed document includes metadata linking it to its template and Markdown source. It does not become an ordinary patch target. Apply layout patches to the template and content edits to the Markdown file.

The board provides an **Open site** link. Site pages use normal browser navigation and a trusted Server-Sent Events listener. After an accepted site change, the current route reloads at its existing URL, including its query string and fragment. This site view uses full-page reloads; the board's ordinary document previews retain their existing incremental reconciliation behavior.

Any artboard can also expand inside the web client's viewport. Its **Open site** control navigates the same iframe to the routed site. The sandboxed frame receives accepted site versions from the parent board connection through a source-checked message bridge; it does not need cross-origin SSE access. Resetting exits expanded mode and loads the current accepted original artboard, including template edits made while browsing.

Markdown, configuration and external `project.divlet` edits are picked up by the runtime's scanner. Template changes through `divlet_patch` trigger a rebuild directly. Navigation is rebuilt when page titles, ordering or membership change.

## Failure and round-trip boundaries

The runtime prepares a complete candidate before replacing the accepted site. Invalid Markdown, configuration, route collisions or slot composition retain the last working snapshot and add a diagnostic. Removing `site.json` explicitly disables the site. Removing a page from a successfully rebuilt site removes its route.

JSON ↔ HTML round trips apply to the template and the existing static model profile. Generated route HTML does not encode the original Markdown syntax and cannot reconstruct its source file. Site export, authored JavaScript and application-style client-side routing are not implemented.

Run the included example with `npm run demo:site`. Its sources live in `examples/handbook/`: the native `project.divlet` template, `site.json`, Markdown under `content/`, and guide/template asset inputs remain independently owned sources. The complete Markdown site is not a single portable `.divlet` file.
