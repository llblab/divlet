# The Divlet format

**Status: first-release specification candidate; not frozen.** This document owns the persisted format. It describes the current schema and identifies boundaries that must be settled before a compatibility promise is made. The accepted [web-native core contract](web-native.md) owns the architectural direction; [BACKLOG.md](../BACKLOG.md) owns the remaining preparation and approval gates. No schema version or runtime behavior changes merely because this candidate exists.

## Scope and conformance

A Divlet project is one UTF-8 JSON file, `<name>.divlet`. It contains a supported static HTML/SVG/CSS model: frames, elements, text, components, instances, authored CSS, CSS variables, metadata and resource references. The JSON file is canonical. The browser lays out and paints its HTML projection.

The words **must**, **must not** and **may** below describe the candidate contract, not an already published standard. Current implementation notes are distinguished from unresolved freeze boundaries. The executable admission boundaries are `readProject` in `core/lib/project.ts` and `validateDocument` in `core/lib/model.ts`; TypeScript types describe accepted values but do not validate foreign input.

The format does not standardize editor selection, hover, panels, viewport navigation, observations, HTTP capabilities, tool parameters, npm package versions or a pixel-identical result across browser/font environments. Authored artboard geometry is content; measured element rectangles are not. Generated output and clean static export are not additional canonical project formats.

## Versions and compatibility

- The current project envelope uses `schemaVersion: 2`. The first npm release does not imply renumbering it to 1.
- Standalone frame documents passed to the validator/codec use `schemaVersion: 1`. Frames stored inside a project omit that field; the reader supplies 1, and currently also accepts an explicit 1. This is a distinction between envelopes, not two npm release versions.
- Project `version` is a positive safe-integer revision for project settings; each frame has its own positive safe-integer `version`. Neither is a schema version or an aggregate clock for every change in the file. Runtime render/revision counters are separate.
- The current reader rejects an unsupported project schema version and unknown project/frame/node fields. Extensions belong under metadata, not invented top-level fields.
- Once frozen, changing the meaning of an existing valid file must not be hidden behind an unchanged schema version. A breaking change needs an explicit schema/migration decision; a migration must not silently replace authored source.

**Freeze boundary:** the supported compatibility range, migration policy, numeric equivalence, treatment of lexical JSON duplicate members and the status of current operational limits still need an explicit decision. An object-based validator cannot prove that the original JSON text had unique member names. This candidate does not promise byte-preserving JSON serialization or support for future schema versions.

The implementation currently parses JSON numbers as JavaScript binary64 values. A lexical `9007199254740993` is already `9007199254740992` before model validation; `1e-400` becomes zero at the same stage. Metadata `-0` survives admission but `JSON.stringify` writes positive zero. Parse-time rounding must not be misreported as corruption by the project writer. The smallest recommended profile is finite binary64 values with equivalent signed zeros, using application-defined strings for precision-sensitive values; exact lexical/decimal preservation would require a different admission representation. This is a recommendation for approval, not a newly frozen numeric promise.

## Project file

This is a complete valid source example, not JSON with placeholder comments:

```json
{
  "schemaVersion": 2,
  "name": "Landing",
  "version": 1,
  "tokens": { "--color-brand": "#d7b474" },
  "css": "html,body{margin:0}",
  "metadata": {},
  "frames": [
    {
      "id": "home",
      "name": "Home",
      "version": 1,
      "artboard": { "x": 0, "y": 0, "width": 390, "height": 844 },
      "rootId": "root",
      "nodes": {
        "root": { "id": "root", "type": "element", "tag": "main", "children": ["greeting"] },
        "greeting": { "id": "greeting", "type": "text", "content": "Hello, web." }
      }
    }
  ]
}
```

| Field | Current admission and meaning |
| --- | --- |
| `schemaVersion` | Required; exactly 2. |
| `frames` | Required array, including an empty array. Frame IDs must be unique in the project. Array order is retained. |
| `name` | Well-formed string, at most 512 UTF-16 code units, normalized to LF; omitted/null defaults to `Untitled project`. |
| `version` | Positive safe integer; omitted or null defaults to 1. |
| `tokens` | CSS custom-property map; omitted or null defaults to `{}`. |
| `css` | Authored CSS string; omitted or null defaults to `""`. |
| `metadata` | Application-data object; omitted or null defaults to `{}`. Native and foreign admission write provenance under `metadata.import`. |
| `outputDir` | Relative output directory or null; omitted/null selects `.divlet/<source stem>/`. |

The source filename/path identifies the project to the editor; the envelope has no stored project `id`. `outputDir` is an output location, not a base URL for authored resources. Its current settings validator rejects absolute paths, backslashes, control characters, blank values and drive prefixes. Output ownership and collision checks apply in addition; a relative string is not permission to overwrite a directory.

Project and frame names share the same character, length and LF-normalization rules. Their presence/default rules remain contextual: project settings supply an omitted/null name, while a frame requires one. Project, frame and node metadata share the safe JSON validator described below; a project-level payload is not an escape hatch around that profile.

## Frame document

A stored frame has `{ id, name, version, artboard, rootId, tokens, css, metadata, nodes }`. `id`, `name`, `version`, `artboard`, `rootId` and `nodes` are required. Tokens, CSS and metadata default as in the project. Frame names pass the same well-formed-string and line-ending normalization as project names.

Identifiers match `[A-Za-z][A-Za-z0-9_.:-]{0,95}`: 1–96 ASCII characters, starting with a letter. A frame ID is unique in its project. A node ID is unique in its frame; another frame may use the same node ID. Every node map key must equal that node's `id`. Reserved safe-JSON object member names are not usable node-map keys, even when they match the identifier grammar; a frame ID is a string value rather than such a key.

`artboard` contains exactly `x`, `y`, `width` and `height`, all finite numbers in CSS pixels; fractions are allowed. The current reader accepts width/height from 1 through 16384 and coordinates whose absolute values are at most 10000000. This is authored board geometry, not browser-measured child layout.

The nodes must form one rooted tree: `rootId` names an element, every node is reachable from it, each non-root node has one parent, and cycles, unknown children and repeated child references are rejected. Child arrays define order; JSON node-map member order does not define DOM order. Instance targets are checked against the whole project after local frame validation.

## Nodes

| Node | Stored fields |
| --- | --- |
| Element | `{ id, type: "element", tag, attrs, className, style, metadata, children, reusable? }` |
| Text | `{ id, type: "text", content, metadata }` |
| Instance | `{ id, type: "ref", ref, descendants, metadata }` |

An element requires `tag`. `attrs`, `style` and `metadata` default to `{}`, `className` to `""` and `children` to `[]`; their current reader also uses those defaults for null. `reusable` accepts a boolean, with false/absence normalized to an ordinary element and true retained as the component marker. Text requires string `content`, including an empty string. Instances require `ref`; `descendants` defaults to `{}`. Unknown fields are rejected for each node kind.

Rendered strings must be representable in the supported HTML profile. The frame validator normalizes CRLF/CR to LF in names, text, classes, attribute values and declarations, and rejects NUL and unpaired surrogates in those strings. Metadata is not a substitute for authored text and has its own JSON validation boundary.

### Supported HTML and SVG

This is a static-content profile, not arbitrary HTML applications. The current HTML tag set is:

```text
a abbr address article aside b bdi bdo blockquote br button caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr i img input ins kbd label legend li main mark menu meter nav ol optgroup option output p picture pre progress q rp rt ruby s samp section select small source span strong sub summary sup table tbody td textarea tfoot th thead time tr track u ul var video audio wbr
```

An `svg` may enter the SVG namespace; its supported tags retain their case:

```text
svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask pattern filter feGaussianBlur use symbol title desc
```

HTML attributes normalize to lowercase on HTML elements; SVG attributes retain case. Duplicate normalized HTML attribute names are rejected. Attribute values are strings; boolean HTML attributes use the empty string. Attribute maps must not contain `class`, `style`, `srcdoc`, `on*` handlers or `data-divlet-*` instrumentation; classes and inline CSS have their own fields. URL-bearing attributes have scheme checks; executable URL schemes are not supported.

Void elements cannot have children. Structural checks reject block content inside paragraphs, nested links/buttons/forms/headings, unsupported children of table/select containers and misplaced list items. A textarea has at most one text child. SVG-only elements must be inside SVG and HTML elements cannot be inserted into SVG. A component's expanded result must satisfy the same content model; being an instance does not exempt it.

Table roles require their direct parent context, including at frame roots: `caption`/`colgroup`/`thead`/`tbody`/`tfoot` belong to `table`, `tr` to a row group, `td`/`th` to `tr`, and `col` to `colgroup`. A root `table` remains supported; contextless roots such as `tr`, `td` and `tbody` are refused at model admission. One table grammar supplies both parent and child checks, also after component expansion. Text directly inside these table containers may contain only HTML whitespace (TAB, LF, FF, CR and SPACE), not JavaScript's wider trim set: NBSP and EM SPACE would otherwise be moved outside the table and lost on native round trip. Paragraph checks also reject `details`, `dialog`, `figcaption` and `summary`, including through intermediate descendants, because the browser closes the paragraph before them. These checks preserve the supported tag sets; they are not a claim of complete HTML conformance.

## Components, identity and overrides

An element with `reusable: true` defines a component subtree. A ref names `nodeId` in its own frame or `frameId/nodeId` in another frame. The target must exist and be a reusable element. Missing targets and direct/transitive component cycles are rejected.

`descendants` maps component addresses to partial overrides. A direct address is a component node ID; crossing a nested instance adds `/`-separated node IDs. It is not a DOM selector or a generated flattened node ID. The current address grammar admits at most 16 segments, with expansion budgets applied separately.

Supported override fields are `tag`, `className`, `style`, `attrs`, `metadata`, `text` and `content`. `className` replaces the class string. Style, attributes and metadata merge by key, with null member values removing keys. A text node accepts `content` and metadata, not element fields. An element accepts `text` only when it has no children or a single text child; mixed content must be addressed through its text nodes. Top-level null is not a universal override reset operation.

Internal node IDs, DOM `attrs.id` and instance occurrence addresses are distinct. Expansion produces a derived tree; the canonical project retains its reusable definitions and ref nodes. Generated part IDs and browser instrumentation must not become accidental substitutes for those stored identities.

**Freeze boundary:** the following component semantics must be explicit; WEB-4 owns their resolution, and none of the current behaviors below is a frozen guarantee.

- **Effective override writes:** `{button:{text:"parent"},caption:{content:"child"}}` and its reversed address-member order both pass admission but produce different text when `caption` is the button's text child. Rejecting conflicting effective writes is the smallest recommended policy, rather than introducing hidden precedence or new fields. Detection must resolve nested-instance aliases, not compare address strings alone.
- **CSS/token scope:** a cross-frame component keeps its class references, but only project and consuming-frame CSS/tokens enter the expanded document. A source-frame `.cta` rule and `--accent` token therefore do not travel with the component. Consumer scope is a coherent contract if deliberately selected; source scope needs explicit cascade/collision rules. Neither profile should be implied by blindly concatenating stylesheets. Shared project styles are an existing authoring option, not proof that the scope decision is settled.
- **DOM occurrence references:** two instances can both retain `attrs.id:"cta"` while their internal node identities remain distinct. The issue is DOM reference ambiguity, not collapsed native identity. Refusing duplicate expanded DOM IDs is simpler than remapping but restricts admitted files; automatic renaming must handle linked `for`, ARIA and SVG references as well. Duplication is reproduced; browser behavior for each reference form has not been established by this assessment.

## CSS, tokens and resources

`className` contains ordinary HTML class names. `style` maps CSS property names to string values; numbers are not implicit pixel values. `tokens` maps CSS custom-property names matching `--[A-Za-z_][A-Za-z0-9_-]*` to declaration values. Both regular declarations and tokens are parsed so a value cannot escape its declaration. Authored CSS remains authored CSS; compiled utility CSS is derived output.

Currently, an expanded frame's tokens are project tokens followed by frame tokens, with the frame's value winning on the same name. Its CSS is project CSS followed by frame CSS. This describes those two levels, not inheritance of CSS from a referenced component's source frame.

CSS must parse and must not contain a closing style tag, executable CSS, `@import` or build directives such as `@plugin`, `@config`, `@source`, `@tailwind` and `@reference`. Ordinary responsive/state rules remain CSS. A plugin may interpret token namespaces and compile utilities, but it does not define the native meaning of a CSS variable or class attribute.

Resources are authored references in attributes, inline declarations and stylesheets; local references resolve from their authored source location, not from a generated `_assets` path. Local filesystem access, bounded resource reads, link refusal and portable bundling are enforced by resource/output planning. Saving a project does not grant an arbitrary HTTP filesystem route. External resources and installed fonts are not promised to be immutable.

**Freeze boundary:** necessary rendering dependencies must be represented and checked rather than guessed from class spelling or an existing cache. No dependency-profile fields are invented by this candidate; WEB-3 owns that schema/compatibility decision. Missing engines and engine disable behavior must not silently change a dependent project's appearance.

## Metadata and operational limits

Metadata is the extension point, not permission to add executable node kinds or bypass validation. It admits arbitrary application-defined objects, arrays and JSON scalar values within the safe profile, without an application-specific field schema. Numbers must be finite; functions, undefined values, bigint, symbols, non-JSON objects and cycles are not accepted. Object member names `__proto__`, `constructor` and `prototype` are reserved throughout the safe JSON profile. Other application keys remain extensible; an `onClick` key inside metadata is data, not an HTML event handler.

Metadata strings are opaque JSON data, not rendered text: the name/text normalization rules must not silently rewrite their contents. A writer must retain supported application data through semantic read/write operations. Import provenance under `metadata.import` records source information; it is not an instruction to overwrite or merge a source file. Project/frame/node metadata and stored override patches use the shared validator before serialization or expansion can erase or coerce an unsupported value. Override metadata is checked before its null deletions are applied; whole-frame JSON validation also checks stored values/keys. Finite-number admission alone is not the complete [numeric-interchange policy](#versions-and-compatibility).

Current implementation budgets are caller-owned profiles, not metadata-selected privileges: normal frame validation uses 2000 nodes, depth 64 and a 2 MiB serialized input budget; common text/CSS fields have field-specific limits, metadata objects (including stored override patches) have a 65536-UTF-16-code-unit serialized-length check, and the project admits at most 200 frames. File-loading and projection paths have separate budgets, including a 32 MiB source-read limit and larger trusted projection profiles. These are implementation admission limits until the compatibility/profile decision is made; this candidate does not claim one capacity for every API or resource.

The size check applies to the stored patch, not just the expanded result: a null-deletion map of 70009 serialized code units is refused even if expansion would erase it. Boundary tests admit 65536 units and refuse 65537 for both ordinary metadata and override payloads, using non-ASCII keys to distinguish this limit from UTF-8 bytes. Supported null deletions and recursive application-data merges remain intact, and admission does not mutate the authored patch.

## Declarative styles

A node patch may carry `styles: { property: value }`; this is an editing input, not a stored node field. Currently it delegates to the active style engine and reports `NO_STYLE_ENGINE` without one; direct `style` declarations remain available. The native fallback and cascade-preserving normalization required by the [target contract](web-native.md#tailwind-style-plugin) remain WEB-1 implementation work. The current PEN converter also uses the Tailwind declaration codec; decoupling it is WEB-2 work, not a new node syntax.

## Generated output

```text
.divlet/<name>/
  <frame>.html            generated page
  <frame>.meta.json       identity and hashes of the page
  .divlet-build.json      generated-file ownership and hashes
  _assets/                bundled resources
  .trash/                 preserved hand edits and removed pages
```

Edits to the model regenerate the page. Hand-edited generated pages are currently diagnosed and preserved on regeneration, not reconciled back into the model. The managed reverse-editing contract remains distinct from strict codec round trips and clean export; implementing that editor capability is WEB-5. Output files belong to one project and must not overwrite unowned files or share another project's destination.

## Importing

The core admits external `.html`/`.htm` pages directly into this format without an HTML importer registration or style engine. Foreign formats use importer plugins. Both paths retain bounded source reads, provenance and non-overwriting sibling publication; see [architecture](architecture.md#core-and-plugins). Lossy external sanitization must not be substituted for reconciliation of an edited native projection.

## Evidence and freeze boundary

`npm run test:format` runs the candidate baseline from a source checkout: four accepted JSON inputs and 20 rejected cases under `core/tests/fixtures/format/`, explicit normalization expectations, semantic project read/write checks, component-address behavior and the complete example/tag profiles in this document. The corpus is plain JSON, not a second validator. Error codes identify this implementation's refusal boundaries; they do not prescribe another implementation's diagnostic wording. Every accepted frame's expanded static HTML projection also round-trips; this is not reverse editing of a managed component projection. The model/component suites cover rejected root and misplaced table roles, valid row instances and table text; the codec suite checks admitted roots and simple parent/child trees across the supported HTML tags, with positive table controls and a guard against achieving fidelity by dropping tags.

Existing model, component, codec, output and native HTML suites provide further implementation evidence, not a declaration of complete standard conformance. The baseline does not prove resource closure, every operational limit, rendering dependencies or unresolved component policies. The preparation gate in [BACKLOG.md](../BACKLOG.md) owns the remaining assessment.

### Reader-boundary witnesses

`npm run test:format:audit` emits the paired project/frame reader report; the format baseline now runs it as a regression gate. Inputs and diagnostic unblockers are retained in `core/tests/fixtures/format/reader-boundaries.json`. It exits 1 if a retained invariant regresses. Passing these witnesses does not establish complete format conformance or settle the remaining freeze decisions.

- **`metadata-number-overflow`:** metadata `{"value":1e400}` is refused by both readers before serialization can replace it with `null`.
- **`metadata-safe-keys`:** both readers reject unsafe object member names in metadata.
- **`name-line-endings`:** both readers normalize CRLF/CR names to LF without trimming other whitespace.
- **`name-unpaired-surrogate`:** both readers reject unrepresentable names. Project-name failures keep the implementation's `INVALID_PROJECT` code; frame-name failures use `INVALID_DOCUMENT`.

The same baseline checks that metadata remains opaque/extensible, non-JSON API values are rejected, and public override types admit null attribute deletions while literal element attributes remain strings. Runtime regressions verify that invalid metadata cannot replace accepted source/output/state and that invalid authored bytes remain available for correction.

### Freeze assessment: format versus implementation

The independent assessment of `6435d97` produced the six concrete numeric/component/context/budget counterexamples documented in their owning sections above. Two reviewer lenses supplied usable reports and a verifier separately reproduced the findings; the final judge assessed synthesis quality, not the repository. This is evidence for the stated boundaries, not whole-format or publication approval. The paired reader audit remains relational: simultaneous rejection can satisfy agreement, so explicit accepted/rejected expectations must accompany it.

- **Persisted design gates:** numeric/compatibility rules, component scope/conflicts/DOM references (WEB-4), and necessary rendering dependencies (WEB-3) must be selected before their meaning is frozen. The current `prepareFrame` compiles class candidates through the active engine; the no-engine compiler returns empty CSS. The project reader has no enforced dependency profile. A cache or class spelling is not a reliable declaration of that dependency, and this assessment does not invent its fields.
- **Native style editing (WEB-1):** `styles` is an editing input, not a stored node field. The existing `style`/CSS representation can express the native result; a fallback/cascade repair is not by itself a reason to redesign the wire shape.
- **Composition and foreign conversion (WEB-2):** choosing concrete providers outside generic registries and emitting ordinary CSS from PEN are implementation boundaries. Their completion is not automatically a prerequisite for freezing every native field.
- **Managed HTML editing (WEB-5):** the editor feature can be staged independently only if its identity/provenance needs fit the chosen model. A later design that needs different persisted identities, resource meaning or dependency fields must reopen that decision before freeze; an ordinary codec round trip does not prove it is solved.

The canonical backlog owns the remaining policy preparation and approval gates; this document records their semantic rationale, not a second task list. Actual freeze needs an explicit approved candidate, resolved persisted-semantics blockers and passing evidence for that candidate. Publication, tagging and deployment require separate authorization.
