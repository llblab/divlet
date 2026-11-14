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

## Native HTML admission

HTML input belongs to the core, not to an optional importer plugin. The core admits external `.html`/`.htm` pages into the native supported profile: parsing, supported sanitization, initial identity assignment and import provenance. Unsupported input may be rejected; lossy conversion must report what was removed or transformed. Explicit opening, adding a page to a project and importing the source again must share this admission policy without requiring importer registration or a style engine.

Keep three contracts distinct: external-page admission, guarded reverse editing of a managed projection, and clean static export. Their parsing/validation primitives may be shared, but lossy external sanitization must not erase native identity or provenance during cache reconciliation. A source page is not a second canonical project file; explicit opening creates or reuses a sibling `.divlet` without overwriting the original or an existing destination.

## Native CSS and the base inspector

CSS authoring is a mandatory core capability, not a fallback supplied by a style plugin. The core owns native declarations, shared stylesheets, CSS custom properties and semantic style edits through the same validated acceptance path in Node and browser hosts. A plain HTML/CSS project must remain creatable, editable, saveable and rebuildable when no style plugin is installed or registered. Neither a utility compiler nor a remote compilation service is required for that path; the browser still owns cascade evaluation, layout and painting.

The ordinary inspector controls also belong to the core: Layout, Spacing, Border, typography, colours, sizes and effects remain available without Tailwind. A plugin may contribute controls specific to its representation, but must not be the only owner of these base property editors. Changing plugin availability must not duplicate or remove the base controls, reorder their sections, or turn editor preferences and measured geometry into project content.

For example, setting right padding to `4 px` in the inspector produces an authored `padding-right: 4px` edit, updates the rendered element and survives save/reopen and Undo/Redo without converting a declaration to a utility class. Inline CSS is a sufficient first implementation; shared CSS and variables remain native too. Persisted declaration order and emission follow the [approved format profile](format.md#approved-first-release-profile), not a new inline-only model or a schema-number change. The editing input is distinct from stored fields; this contract does not introduce another wire syntax.

A later inline-to-stylesheet packer may be an explicit, cascade-preserving transformation of the same native model. It is not a prerequisite for core style editing, the base inspector or browser Tailwind support, and must not silently extract or rewrite authored styles on read.

## Plugin boundaries

### PEN importer

The PEN importer owns PEN-specific parsing and interpretation, including geometry, variables, components and overrides. It returns a validated native web candidate and diagnostics without rewriting imported bytes or promising a lossless PEN round trip. Existing destination projects must not be overwritten.

A sufficient result uses ordinary HTML/SVG/CSS. Importing PEN must not require Tailwind or another declaration-to-class engine. Optional style normalization is a subsequent, separately owned transformation, not a precondition for representing PEN geometry.

### Tailwind style plugin

Tailwind is an optional atomic-class representation policy, utility compiler and representation-specific inspector contribution. It may be enabled by default; it does not define the native document model or own the base property editors. Its UI adds the class editor, utility suggestions and supported variants rather than a second Layout/Spacing/Border/Appearance implementation.

The property controls and class editor are reactively linked through one authored CSS meaning and one accepted project, not independent styling stores. A core property edit can be represented as utilities under an explicitly selected plugin policy; editing a supported utility must update the corresponding property readback and use the same guarded writer/history operation. Repeating synchronization must not commit a second edit, reset selection/focus or overwrite a focused draft. Browser measurements are derived observations, not a flattened replacement for authored CSS.

Its transformations must:

- Preserve cascade, responsive conditions, states and authored values; retain ordinary CSS and opaque classes when equivalence is not established. Never flatten a responsive or stateful rule into an unconditional inline value.
- Be idempotent: repeating normalization does not accumulate changes.
- Reconcile superseded inline declarations and utilities instead of leaving competing representations that defeat the requested edit.
- Run at an explicit boundary such as an import, edit or conversion operation, not silently rewrite a project merely because it was read.
- Expose the actual persisted representation in the inspector rather than maintaining hidden authoritative styling state.

Disabling a plugin for a dependent project is an explicit, validated conversion: materialize the necessary styling as ordinary CSS without losing appearance, or refuse with an explanation. Merely hiding the panel or returning an empty compiled stylesheet is not a successful disable operation. A missing required plugin must be diagnosed; preserved cache output must not disguise an incomplete rebuild as a valid one.

### Composition

Core model, validation and generic registries depend on public capability contracts, not concrete plugin implementations. Composition code selects and registers built-in or optional providers. Native style semantics and base inspector controls must stay independent of those concrete providers in both hosts. An importer is not required to read an existing native project. A plugin cannot widen the core's executable-content policy or bypass its transaction and filesystem boundaries.

### Standalone landing composition

The product's static standalone landing board must enable the Tailwind plugin, including its linked class editor and a browser-capable transformation/compiler path. After initial loading, an edit that introduces a supported utility absent from the prepared stylesheet must compile and render in that browser, without a Node backend, host binding or runtime remote compiler. A build-time CSS snapshot may accelerate initial display; it is not evidence of functioning Tailwind editing. Provider code and required inputs belong in the declared static application closure, not an unrequested network fetch or blanket Node polyfill.

This is the landing application's composition, not a mandatory dependency of the kernel or every browser host. A browser composition that omits Tailwind must still expose the same native CSS operations and base property controls. Both compositions use the shared acceptance, history and persistence contracts; reliable offline reopening, embedded assets/fonts and a real WebMCP agent remain separately evidenced capabilities. Existing [browser-runtime evidence](browser-runtime.md#current-evidence) describes what is implemented today; [BROWSER-DEMO](../BACKLOG.md) owns the remaining standalone integration.

## Browser-host portability investigation

The incremental shared semantic kernel with explicit browser/Node hosts follows these boundaries, not an alternative model or a second validation implementation. See [browser runtime exploration](browser-runtime.md) for current Node dependencies, offline/demo modes, Service Worker scope and WebMCP/bridge distinctions. The investigation does not move connected accepted-state authority into an untrusted client, make arbitrary scripts part of the project profile, or establish a new format/release gate.

## Stabilization boundary

This architectural contract leaves persisted field names, dependency profiles, override-conflict algorithms and migration APIs to the [approved format profile](format.md#approved-first-release-profile). That profile is approved for implementation, not already delivered or frozen; its compatibility decisions still require implementation evidence and final freeze approval. The wire schema version, content revisions and rendering dependencies are separate concerns; a stable JSON shape alone does not guarantee a stable rendering environment.

**The model defines what is edited. Editor state defines what is being worked on. The browser determines how it is laid out and painted. Plugins extend ways of working without replacing these roles.**
