# Field notes — a PEN example

A small editorial canvas authored as a Pencil `.pen` file: forest-green type, a paper background, component references, typed variables and a locally authored landscape. Opening it converts it into a Divlet project.

```bash
npm run demo:pen
# or, from another directory:
node /path/to/divlet/adapters/cli/index.js /path/to/divlet/examples/pen/field-notes.pen
```

The first open writes `field-notes.divlet` beside the source (HTML elements with Tailwind classes, tokens from the color variables, instances kept as instances) and its generated pages in `.divlet/field-notes/`. The `.pen` is never modified; delete the generated `.divlet` to convert again.
