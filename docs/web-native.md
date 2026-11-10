# Web-native core contract

**Status: accepted target architecture, not a claim of complete implementation.** This document owns the intended semantics and boundaries of the web-native core. It does not introduce a new JSON schema or declare the format frozen. The [format reference](format.md) and [architecture guide](architecture.md) describe current behavior; [BACKLOG.md](../BACKLOG.md) owns the remaining implementation work and its acceptance checks.

## Purpose

**Divlet is an editable web model with a browser projection.** JSON provides document structure, identity and authoring operations. HTML/CSS provides the browser representation. The browser performs layout and painting in each artboard's iframe; the document does not require a custom canvas renderer or a framework virtual DOM.

The core knows one native document model: a supported static profile of HTML, SVG and CSS. It is not an opaque container for interchangeable design models, and it does not execute arbitrary application scripts or event handlers.

## Three separate layers

### Saved project model

The `.divlet` JSON file is canonical. It stores artboards and their authored board geometry; elements, text and child relationships; stable node identities; component definitions, instances and overrides; class names, inline declarations, shared CSS and CSS variables; metadata and resource references. Necessary rendering dependencies must be identifiable reproducibly rather than guessed from class spelling.

- `className` means ordinary HTML classes, not necessarily Tailwind utilities.
- Tokens are CSS custom properties. A plugin may interpret selected namespaces, but that interpretation is not required to understand a CSS variable.
- Internal node identity is distinct from a DOM `id` attribute. An instance occurrence must be distinguishable from its component definition and other occurrences.
- Component override semantics must not depend on JSON object member order. Conflicting writes must be rejected or resolved by an explicit, order-independent precedence rule.
- Component CSS/token scope and references between DOM IDs must have explicit semantics. Reuse must not silently introduce ambiguous IDs or broken local references.

### Editor state

Selection, hover, active tools, viewport zoom/pan and panel state address the saved model without becoming document content by default. Remembered UI preferences belong outside the project unless a separate, explicit format decision makes them authored data.

Selecting an object does not change the project's content revision. Re-rendering preserves a valid selection; deleted objects are removed from it. Element rectangles, text metrics, overflow and other browser observations are derived state, not a second saved layout system. Authored artboard geometry remains project content.

### Browser projection

```text
.divlet model <-> managed HTML/CSS cache -> iframe
```

The managed cache is a generated, editable projection with sufficient provenance to map browser objects and file edits back to model identities. Preview instrumentation may differ from a clean static export, but must not change authored layout semantics. A clean export is not required to preserve the reverse-editing contract.

The cache is reconstructible from the project and its declared dependencies. Compiled styles and rewritten resource URLs must not become accidental replacements for authored source data when reading an edited cache.

## One acceptance path

Board actions, Pi/MCP tools, external JSON edits and edits of managed HTML all produce candidates for the same accepted project:

1. Bind the input to the state it was based on, using the appropriate revision or source identity.
2. Decode the candidate and apply explicitly selected transformations.
3. Validate the final model, component graph, CSS, resources and supported capabilities.
4. Prepare the browser projection and preflight output ownership before accepting the change.
5. Accept through the single project's writer, update the appropriate revisions/history, and publish the prepared output.

A rejected candidate leaves accepted state intact; authored edits are retained for diagnosis or recovery. A stale HTML projection cannot silently overwrite a newer JSON edit. Own generated writes must not create an import loop. Plugins return candidates and diagnostics; they do not bypass core validation, history or source/output publication.

Reverse editing must preserve identity and component semantics. An edit expressible as an allowed override may update that override. An unsupported or ambiguous structural edit must be refused or require an explicit structural operation, never silently detach an instance. Text identities, nested instance addresses, resource provenance and generated-versus-authored CSS are part of this contract, not details that can be discarded by a generic HTML import.

## Plugin boundaries

### HTML importer

The HTML importer admits external pages into the native supported profile: parsing, supported sanitization, initial identity assignment and import provenance. Unsupported input may be rejected; lossy conversion must report what was removed or transformed.

It does not own the native HTML codec, normal browser rendering, selection mapping or reverse editing of the managed cache. An external `.html` import is not equivalent to reading an edited native projection.

### PEN importer

The PEN importer owns PEN-specific parsing and interpretation, including geometry, variables, components and overrides. It returns a validated native web candidate and diagnostics without rewriting imported bytes or promising a lossless PEN round trip. Existing destination projects must not be overwritten.

A sufficient result uses ordinary HTML/SVG/CSS. Importing PEN must not require Tailwind or another declaration-to-class engine. Optional style normalization is a subsequent, separately owned transformation, not a precondition for representing PEN geometry.

### Tailwind style plugin

Tailwind is an optional style representation policy, utility compiler and inspector contribution. It may be enabled by default; it does not define the native document model. Without it, creating, editing, saving and rendering a plain HTML/CSS project must still work, including declarative style edits.

Its transformations must:

- Preserve cascade, responsive conditions, states and authored values; retain ordinary CSS when equivalence is not established.
- Be idempotent: repeating normalization does not accumulate changes.
- Reconcile superseded inline declarations and utilities instead of leaving competing representations that defeat the requested edit.
- Run at an explicit boundary such as an import, edit or conversion operation, not silently rewrite a project merely because it was read.
- Expose the actual persisted representation in the inspector rather than maintaining hidden authoritative styling state.

Disabling a plugin for a dependent project is an explicit, validated conversion: materialize the necessary styling as ordinary CSS without losing appearance, or refuse with an explanation. Merely hiding the panel or returning an empty compiled stylesheet is not a successful disable operation. A missing required plugin must be diagnosed; preserved cache output must not disguise an incomplete rebuild as a valid one.

### Composition

Core model, validation and generic registries depend on public capability contracts, not concrete plugin implementations. Composition code selects and registers built-in or optional providers. An importer is not required to read an existing native project. A plugin cannot widen the core's executable-content policy or bypass its transaction and filesystem boundaries.

## Stabilization boundary

This contract does not prescribe new persisted field names, a dependency-profile schema, an override-conflict algorithm or a plugin migration API. Those choices need explicit compatibility decisions and regressions before the corresponding format promise is frozen. The wire schema version, content revisions and rendering dependencies are separate concerns; a stable JSON shape alone does not guarantee a stable rendering environment.

**The model defines what is edited. Editor state defines what is being worked on. The browser determines how it is laid out and painted. Plugins extend ways of working without replacing these roles.**
