# The Divlet format

A Divlet project is one JSON file, `<name>.divlet`: frames (artboards) made of HTML elements styled with Tailwind classes, shared tokens and project CSS. Generated pages live beside it in `.divlet/<name>/`. The format is web-first: the model renders to HTML and the generated pages are cached. Valid edits to the project source update the board; hand edits to generated HTML are currently reported rather than imported.

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

- `tokens` are CSS custom properties; names such as `--color-*`, `--font-*`, `--breakpoint-*` become Tailwind theme classes (`--color-brand` → `bg-brand`).
- `css` is the escape hatch for what utilities cannot express.
- `metadata` is free application data; `metadata.import` is written by importer plugins.
- `outputDir` is a relative directory that replaces the default `.divlet/<name>/`.

## Frame document

`{ id, name, version, artboard: { x, y, width, height }, rootId, tokens, css, metadata, nodes }` where `nodes` maps an id to one of:

| Node | Shape |
| --- | --- |
| element | `{ id, type: "element", tag, attrs, className, style, metadata, children: [ids], reusable? }` |
| text | `{ id, type: "text", content, metadata }` |
| instance | `{ id, type: "ref", ref: "frameId/nodeId", descendants, metadata }` |

`className` holds Tailwind utilities (arbitrary values and variants work: `bg-[#14121c] md:px-10 hover:underline`). `style` is for inline declarations. An element marked `reusable: true` is a component; an instance's `descendants` map overrides component nodes by their ids (`tag`, `className`, `style`, `attrs`, `metadata`, `text` for an element's text, `content` for a text node; `className` replaces, `style`/`attrs` merge, `null` removes).

## Declarative styles

A node patch may carry `styles: { property: value }`. Each declaration becomes a Tailwind utility (an arbitrary-property class such as `[font-family:Georgia,_serif]` when no utility exists) and replaces the class that set the same property; `null` removes it; `padding`/`margin` sides are merged. The same transpiler (`plugins/tailwind/lib/styles.js`, reached through the core's engine seam) converts imported styles, so people and agents who do not know Tailwind never write class names.

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

Importer plugins convert foreign sources into this format and are described in [architecture](architecture.md#core-and-plugins).
