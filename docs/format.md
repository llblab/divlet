# The Divlet format

A Divlet project is one JSON file, `<name>.divlet`: frames (artboards) made of HTML/SVG elements, class names, inline declarations, shared CSS variables and project CSS. Generated pages live beside it in `.divlet/<name>/`. The model renders to HTML and the generated pages are cached. Valid edits to the project source update the board; hand edits to generated HTML are currently reported rather than imported.

This reference describes the current wire format and behavior. The accepted [web-native core contract](web-native.md) defines the target boundaries, including optional Tailwind normalization and reverse-editable managed HTML. It is not a declaration that those paths are complete or that this schema is frozen; remaining work is in [BACKLOG.md](../BACKLOG.md).

## Project file

```json
{
  "schemaVersion": 2,
  "name": "Landing",
  "version": 1,
  "tokens": { "--color-brand": "#d7b474" },
  "css": "html,body{margin:0}",
  "metadata": { "import": { "source": "landing.pen", "format": "pen", "sha256": "…", "bytes": 1234 } },
  "outputDir": null,
  "frames": [ /* frame documents */ ]
}
```

- `tokens` are CSS custom properties. With the bundled Tailwind engine, namespaces such as `--color-*`, `--font-*` and `--breakpoint-*` also become theme utilities (`--color-brand` → `bg-brand`); that interpretation belongs to the engine.
- `css` holds ordinary authored CSS, including rules not expressed as utilities.
- `metadata` is free application data; `metadata.import` is written by importer plugins.
- `outputDir` is a relative directory that replaces the default `.divlet/<name>/`.

## Frame document

`{ id, name, version, artboard: { x, y, width, height }, rootId, tokens, css, metadata, nodes }` where `nodes` maps an id to one of:

| Node | Shape |
| --- | --- |
| element | `{ id, type: "element", tag, attrs, className, style, metadata, children: [ids], reusable? }` |
| text | `{ id, type: "text", content, metadata }` |
| instance | `{ id, type: "ref", ref: "frameId/nodeId", descendants, metadata }` |

`className` holds HTML class names. With the bundled Tailwind engine, utilities, arbitrary values and variants work, such as `bg-[#14121c] md:px-10 hover:underline`. `style` is for inline declarations. An element marked `reusable: true` is a component; an instance's `descendants` map overrides component nodes by their ids (`tag`, `className`, `style`, `attrs`, `metadata`, `text` for an element's text, `content` for a text node; `className` replaces, `style`/`attrs` merge, `null` removes).

## Declarative styles

A node patch may carry `styles: { property: value }`; this is an editing input, not a stored node field. Currently the core delegates it to the active style engine. The bundled Tailwind engine produces utilities (an arbitrary-property class such as `[font-family:Georgia,_serif]` when no utility exists), replaces classes owning that property, handles `null` removal and merges padding/margin sides. Its transpiler (`plugins/tailwind/lib/styles.js`) is also used by the current PEN converter.

Without an engine, this `styles` path currently reports `NO_STYLE_ENGINE`; direct `style` declarations remain available. The native fallback and cascade-preserving normalization required by the [target contract](web-native.md#tailwind-style-plugin) are remaining implementation work, not additional guarantees of this reference.

## Generated output

```text
.divlet/<name>/
  <frame>.html            one page per frame, Tailwind compiled locally
  <frame>.meta.json       identity and hashes of the page
  .divlet-build.json      generated-file ownership and hashes
  _assets/                resources of the pages
  .trash/                 preserved hand edits and removed pages
```

Edits to the model regenerate the page. Hand-edited generated pages are diagnosed and preserved in the output's `.trash` on regeneration, not reconciled back into the model. Output files are owned by one project: they are never overwritten when unowned, and a destination is never shared between projects.

## Importing

The core admits external `.html`/`.htm` pages directly into this format; no HTML importer plugin or style engine is required. Foreign formats use importer plugins. Both paths retain bounded source reads, import provenance and non-overwriting sibling publication; see [architecture](architecture.md#core-and-plugins). External-page admission is not reverse editing of an existing managed HTML projection.
