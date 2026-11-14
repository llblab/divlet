# The Divlet format

**Status: first-release specification candidate; not frozen.** This document owns the persisted format. It describes the current schema and identifies boundaries that must be settled before a compatibility promise is made. The accepted [web-native core contract](web-native.md) owns the architectural direction; [BACKLOG.md](../BACKLOG.md) owns the remaining preparation and approval gates. No schema version or runtime behavior changes merely because this candidate exists.

## Scope and conformance

A Divlet project is one UTF-8 JSON file, `<name>.divlet`. It contains a supported static HTML/SVG/CSS model: frames, elements, text, components, instances, authored CSS, CSS variables, metadata and resource references. The JSON file is canonical. The browser lays out and paints its HTML projection.

The words **must**, **must not** and **may** below describe the candidate contract, not an already published standard. Current implementation notes are distinguished from unresolved freeze boundaries. The executable admission boundaries are `readProject` in `core/lib/project.ts` and `validateDocument` in `core/lib/model.ts`; TypeScript types describe accepted values but do not validate foreign input.

The format does not standardize editor selection, hover, panels, viewport navigation, observations, HTTP capabilities, tool parameters, npm package versions or a pixel-identical result across browser/font environments. Authored artboard geometry is content; measured element rectangles are not. Generated output and clean static export are not additional canonical project formats.

## Versions and compatibility

- Native project envelopes and standalone frame documents use `schemaVersion: 1`. This is the unfrozen first-format baseline; no released compatibility contract exists for speculative schema 2 or 3. Keep 1 throughout pre-freeze development rather than advancing it for unpublished design iterations. npm release numbers are independent.
- Standalone frame documents passed to the validator/codec use `schemaVersion: 1`. Frames stored inside a project omit that field; the reader supplies 1, and currently also accepts an explicit 1. Project and standalone-frame shapes remain distinct even though both use the same initial schema marker.
- Project `version` is a positive safe-integer revision for project settings; each frame has its own positive safe-integer `version`. Neither is a schema version or an aggregate clock for every change in the file. Runtime render/revision counters are separate.
- The current reader rejects an unsupported project schema version and unknown project/frame/node fields. Extensions belong under metadata, not invented top-level fields.
- Once frozen, changing the meaning of an existing valid file must not be hidden behind an unchanged schema version. A breaking change needs an explicit schema/migration decision; a migration must not silently replace authored source.

**Implementation boundary:** the [approved profile](#approved-first-release-profile) selects compatibility, migration, numeric, duplicate-member and capacity rules for implementation. The current reader does not yet implement that complete draft-profile update. Proposed fields are not accepted merely because they carry the same schema marker. An object-based validator cannot prove that the original JSON text had unique member names. This candidate does not promise byte-preserving JSON serialization or support for future schema versions.

The implementation currently parses JSON numbers as JavaScript binary64 values. A lexical `9007199254740993` is already `9007199254740992` before model validation; `1e-400` becomes zero at the same stage. Metadata `-0` survives admission but `JSON.stringify` writes positive zero. Parse-time rounding must not be misreported as corruption by the project writer. The approved direction is finite binary64 values with equivalent signed zeros, using application-defined strings for precision-sensitive values; exact lexical/decimal preservation would require a different admission representation. This is an implementation target, not a newly frozen numeric promise. The [approved first-release profile](#approved-first-release-profile) below owns the related CSS, identity, dependency and migration choices.

## Project file

This is a complete valid source example, not JSON with placeholder comments:

```json
{
  "schemaVersion": 1,
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
| `schemaVersion` | Required; exactly 1. |
| `frames` | Required array, including an empty array. Frame IDs must be unique in the project. Array order is retained. |
| `name` | Well-formed string, at most 512 UTF-16 code units, normalized to LF; omitted/null defaults to `Untitled project`. |
| `version` | Positive safe integer; omitted or null defaults to 1. |
| `tokens` | CSS custom-property map; omitted or null defaults to `{}`. |
| `css` | Authored CSS string; omitted or null defaults to `""`. |
| `metadata` | Application-data object; omitted or null defaults to `{}`. Native and foreign admission write provenance under `metadata.import`. |
| `outputDir` | Relative output directory or null; omitted/null selects `.divlet/<source stem>/`. |
| `assets` | Hierarchical canonical Data-URL tree; omitted defaults to `{}`. Stored null is invalid; a patch null resets/removes. See [resource ownership](#approved-embedded-resource-ownership). |

The source filename/path identifies the project to the editor; the envelope has no stored project `id`. `outputDir` is an output location, not a base URL for authored resources. Its current settings validator rejects absolute paths, backslashes, control characters, blank values and drive prefixes. Output ownership and collision checks apply in addition; a relative string is not permission to overwrite a directory.

Project and frame names share the same character, length and LF-normalization rules. Their presence/default rules remain contextual: project settings supply an omitted/null name, while a frame requires one. Project, frame and node metadata share the safe JSON validator described below; a project-level payload is not an escape hatch around that profile.

## Frame document

A stored frame has `{ id, name, head?, version, artboard, rootId, tokens, css, metadata, nodes }`. `id`, `name`, `version`, `artboard`, `rootId` and `nodes` are required. Tokens, CSS and metadata default as in the project. Frame names pass the same well-formed-string and line-ending normalization as project names.

The optional `head` object is an explicit additive field in the working draft, not interpreted metadata. It admits only `description` (a well-formed string of at most 2048 UTF-16 code units) and `icon` (a well-formed URL string of at most 8192 units, subject to the same executable-scheme refusal as ordinary resource attributes). Unknown fields, null stored values and nonstrings are refused. Absent head stays absent; an explicitly empty object remains distinguishable in the native preview manifest. Frame patches merge it and permit null removal of a member or the whole object. The title remains `name`; the document language remains `en`. No arbitrary head tags, scripts, MIME/sizes hints or executable metadata are admitted.

The codec emits supported description/icon fields into the real HTML head, safely escaped, and refuses duplicate or conflicting supported physical values. Strict decoding refuses unsupported icon attributes rather than discarding them; lossy external HTML admission can normalize them to the supported URL-only profile. Icons join the ordinary resource graph for static bundling and source-relative project copies; this does not add general external/absolute-resource relocation to Save a copy. Existing inputs gain no head field or changed meaning, and any explicit draft conversion must retain an explicitly authored head and its resource base.

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

HTML attributes normalize to lowercase on HTML elements; SVG attributes retain case. Duplicate normalized HTML attribute names are rejected. Attribute values are strings; boolean HTML attributes use the empty string. Attribute maps must not contain `class`, `style`, `srcdoc`, `on*` handlers or `data-divlet-*` instrumentation; classes and inline CSS have their own fields. URL-bearing attributes have scheme checks; executable URL schemes are not supported. `data:` URLs are supported in resource attributes (`src`, `poster`, `srcset`), CSS URLs and `head.icon`, including percent-encoded and base64 images. The existing string/document budgets still apply; URLs are preserved rather than fetched or decoded by the model. Ordinary link navigation, SVG `href`/`xlink:href` and form destinations do not gain `data:` document-navigation authority. Preview CSP independently constrains resource loading and already permits data images and fonts. These inline URLs do not implement the planned shared binary-resource table.

Void elements cannot have children. Structural checks reject block content inside paragraphs, nested links/buttons/forms/headings, unsupported children of table/select containers and misplaced list items. A textarea has at most one text child. SVG-only elements must be inside SVG and HTML elements cannot be inserted into SVG. A component's expanded result must satisfy the same content model; being an instance does not exempt it.

Table roles require their direct parent context, including at frame roots: `caption`/`colgroup`/`thead`/`tbody`/`tfoot` belong to `table`, `tr` to a row group, `td`/`th` to `tr`, and `col` to `colgroup`. A root `table` remains supported; contextless roots such as `tr`, `td` and `tbody` are refused at model admission. One table grammar supplies both parent and child checks, also after component expansion. Text directly inside these table containers may contain only HTML whitespace (TAB, LF, FF, CR and SPACE), not JavaScript's wider trim set: NBSP and EM SPACE would otherwise be moved outside the table and lost on native round trip. Paragraph checks also reject `details`, `dialog`, `figcaption` and `summary`, including through intermediate descendants, because the browser closes the paragraph before them. These checks preserve the supported tag sets; they are not a claim of complete HTML conformance.

## Components, identity and overrides

An element with `reusable: true` defines a component subtree. A ref names `nodeId` in its own frame or `frameId/nodeId` in another frame. The target must exist and be a reusable element. Missing targets and direct/transitive component cycles are rejected.

`descendants` maps component addresses to partial overrides. A direct address is a component node ID; crossing a nested instance adds `/`-separated node IDs. It is not a DOM selector or a generated flattened node ID. The current address grammar admits at most 16 segments, with expansion budgets applied separately.

Supported override fields are `tag`, `className`, `style`, `attrs`, `metadata`, `text` and `content`. `className` replaces the class string. Style, attributes and metadata merge by key, with null member values removing keys. A text node accepts `content` and metadata, not element fields. An element accepts `text` only when it has no children or a single text child; mixed content must be addressed through its text nodes. Top-level null is not a universal override reset operation.

Internal node IDs, DOM `attrs.id` and instance occurrence addresses are distinct. Expansion produces a derived tree; the canonical project retains its reusable definitions and ref nodes. Generated part IDs and browser instrumentation must not become accidental substitutes for those stored identities.

**Implementation boundary:** WEB-4 owns implementation and evidence for the approved component rules below; none of the current behaviors is a frozen guarantee.

- **Effective override writes:** `{button:{text:"parent"},caption:{content:"child"}}` and its reversed address-member order both pass admission but produce different text when `caption` is the button's text child. The approved policy rejects conflicting effective writes and coalesces identical normalized writes instead of introducing hidden precedence. Detection must resolve nested-instance aliases, not compare address strings alone.
- **CSS/token scope:** a cross-frame component keeps its class references, but only project and consuming-frame CSS/tokens enter the expanded document. A source-frame `.cta` rule and `--accent` token therefore do not travel with the component. The approved profile deliberately selects consumer scope, with shared project styles available for common definitions; it does not concatenate source stylesheets or import source tokens.
- **DOM occurrence references:** two instances can both retain `attrs.id:"cta"` while their internal node identities remain distinct. The issue is DOM reference ambiguity, not collapsed native identity. The approved profile refuses duplicate nonempty expanded DOM IDs rather than automatically renaming linked `for`, ARIA and SVG references. Duplication is reproduced; enforcement and browser evidence for the reference forms are still pending.

## CSS, tokens and resources

`className` contains ordinary HTML class names. `style` maps CSS property names to string values; numbers are not implicit pixel values. `tokens` maps CSS custom-property names matching `--[A-Za-z_][A-Za-z0-9_-]*` to declaration values. Both regular declarations and tokens are parsed so a value cannot escape its declaration. Authored CSS remains authored CSS; compiled utility CSS is derived output.

Currently, an expanded frame's tokens are project tokens followed by frame tokens, with the frame's value winning on the same name. Its CSS is project CSS followed by frame CSS. This describes those two levels, not inheritance of CSS from a referenced component's source frame.

Projection currently emits tokens as unlayered `:root` declarations and wraps joined authored CSS in `@layer components`, with a theme/base/components/utilities order prelude, even without an engine. A Chromium probe with a blue token and a later authored red `:root` rule renders blue; emitting the same declarations as ordinary CSS renders red. Codec round trips strip/recreate the wrapper, so they do not establish native cascade equivalence. Inline `style` objects have a separate ordering issue: `padding-left:20px` followed by `padding:10px` renders 10px left padding, while reversing their object members renders 20px; current deep comparison considers the models equal. The approved profile resolves both choices; their implementation and evidence remain prerequisites for freeze.

CSS must parse and must not contain a closing style tag, executable CSS, `@import` or build directives such as `@plugin`, `@config`, `@source`, `@tailwind` and `@reference`. Admission parses grammar only: source-map comments are not decoded, loaded or used as parser configuration. Authored stylesheet text remains intact, and declaration/token shape checks still apply. Ordinary responsive/state rules remain CSS. A plugin may interpret token namespaces and compile utilities, but it does not define the native meaning of a CSS variable or class attribute.

Resources are authored references in attributes, inline declarations and stylesheets; local references resolve from their authored source location, not from a generated `_assets` path. Local filesystem access, bounded resource reads, link refusal and portable bundling are enforced by resource/output planning. Saving a project does not grant an arbitrary HTTP filesystem route. External resources and installed fonts are not promised to be immutable.

**Freeze boundary:** necessary rendering dependencies must be represented and checked rather than guessed from class spelling or an existing cache. The current schema admits no dependency-profile fields; WEB-3 owns implementation of the approved `requires` contract below. That extension is not current admission. Missing engines and engine disable behavior must not silently change a dependent project's appearance.

## Metadata and operational limits

Metadata is the extension point, not permission to add executable node kinds or bypass validation. It admits arbitrary application-defined objects, arrays and JSON scalar values within the safe profile, without an application-specific field schema. Numbers must be finite; functions, undefined values, bigint, symbols, non-JSON objects and cycles are not accepted. Object member names `__proto__`, `constructor` and `prototype` are reserved throughout the safe JSON profile. Other application keys remain extensible; an `onClick` key inside metadata is data, not an HTML event handler.

Metadata strings are opaque JSON data, not rendered text: the name/text normalization rules must not silently rewrite their contents. A writer must retain supported application data through semantic read/write operations. Import provenance under `metadata.import` records source information; it is not an instruction to overwrite or merge a source file. Project/frame/node metadata and stored override patches use the shared validator before serialization or expansion can erase or coerce an unsupported value. Override metadata is checked before its null deletions are applied; whole-frame JSON validation also checks stored values/keys. Finite-number admission alone is not the complete [numeric-interchange policy](#versions-and-compatibility).

Current implementation budgets are caller-owned profiles, not metadata-selected privileges: normal frame validation uses 2000 nodes, depth 64 and a 2 MiB serialized input budget; common text/CSS fields have field-specific limits, metadata objects (including stored override patches) have a 65536-UTF-16-code-unit serialized-length check, and the project admits at most 200 frames. File-loading and projection paths have separate budgets, including a 32 MiB source-read limit and larger trusted projection profiles. These are implementation admission limits until the compatibility/profile decision is made; this candidate does not claim one capacity for every API or resource.

The size check applies to the stored patch, not just the expanded result: a null-deletion map of 70009 serialized code units is refused even if expansion would erase it. Boundary tests admit 65536 units and refuse 65537 for both ordinary metadata and override payloads, using non-ASCII keys to distinguish this limit from UTF-8 bytes. Supported null deletions and recursive application-data merges remain intact, and admission does not mutate the authored patch.

## Declarative styles

A node patch may carry `styles: { property: value }`; this is an editing input, not a stored node field. Currently it delegates to the active style engine and reports `NO_STYLE_ENGINE` without one; direct `style` declarations remain available. The native fallback and cascade-preserving normalization required by the [target contract](web-native.md#tailwind-style-plugin) remain WEB-1 implementation work. PEN conversion now emits ordinary project CSS and data-attribute selector hooks without a declaration-to-class engine. This does not change node syntax or activate optional utility normalization; cold provider/bootstrap independence remains WEB-2 work.

## Approved embedded-resource ownership

**Implemented bounded schema-1 storage and accepted-state projection; not a format freeze or completed font UI.** The unfrozen schema-1 project must own the bytes of its file assets inside the `.divlet` file, not depend on a sibling authored `assets/` directory or on its generated cache. This is native project storage, not merely a portable export option. Keep the JSON container. The approved storage representation is a project-level hierarchical `assets` object beside `frames`. Directory values are nested objects; file values are standard Data URL strings: `data:<media-type>;base64,<payload>`. Base64 is the canonical payload encoding in that table; `file:base64` and `blob:base64` are not replacement URL schemes. This representation contains MIME and bytes without an additional encoding wrapper or opaque metadata. A key at the root can name a unique abstract resource directly; a nested key describes its relative file path below generated `assets/`. Declared names and hierarchy are authored identity, not disposable digest labels. The reference grammar below is used by native settings/read/write, guarded patches/history and the prepared resource graph. Legacy filesystem references remain supported without silent extraction; converting existing foreign/local resource graphs completely into the tree is still separate work.

Literal Data URLs at a use site are an explicit inline form: leave them inline, even when their bytes equal a declared asset or another literal. Only a reference opts into the reusable file resource. Do not automatically extract, replace or deduplicate inline URLs. Repeated references to the same declared key share its owned output file. Preserve separately declared keys and their file paths even when their payloads match; byte interning must not silently rename or collapse authored entries. An explicit import/normalization operation may reuse a compatible existing key after comparing decoded bytes, not URL spelling or visual similarity, and rewriting the affected references as one validated accepted-state operation. A digest may index candidates but does not replace byte equality. Do not rewrite arbitrary text or inert metadata, or migrate existing sources without authorization.

Resource identity must preserve interpretation as well as bytes. Do not discard MIME declarations, per-use fragments or relative CSS/SVG dependency bases when sharing storage or generated files. The reference/descriptor design must preserve distinct interpretations or refuse ambiguous normalization; equal raw bytes alone do not justify sharing an emitted file whose MIME or resolved dependencies differ. Editable SVG nodes remain nodes, not automatically rasterized or opaque file assets. Normal agent reads should describe IDs, types, sizes and uses without dumping binary payloads into prompts.

Model, CSS, font/image and head-icon references must resolve to stable project-owned resources. Imports/uploads admit the bytes through bounded reads and validation before committing them with authored state. Resource names, MIME declarations and payloads do not grant filesystem, executable-content or network authority; do not silently fetch external URLs to fill a bundle. Preserve admitted bytes and reusable image/SVG/component semantics.

The generated form materializes pages and resources under one output directory: `.divlet/<name>/<frame>.html` alongside `.divlet/<name>/assets/`. Each declared file leaf maps to the same relative path under generated `assets/`; references across frames/pages share that path, independent of use count. An unreferenced Data URL literal at a use site remains inline. The file tree and the inline form are both native format semantics, not an optimization that toggles when a second use appears. That resource directory is disposable output, never canonical input. Deleting the whole cache must not lose project asset bytes; an otherwise supported project must rebuild without the original asset files. Update source/model validation, serialization, upload/drop, import, copying, history/atomic acceptance, resource resolution and public output together; moving files into a cache without embedding them first is not an implementation of this requirement.

The shared byte-decoding seam is `core/lib/assets.ts`, used by native project settings and output preparation. It validates detached directory trees and canonical base64/MIME leaves without source or filesystem mutation, preserves named duplicates and rejects unsafe/aliasing portable paths, non-JSON/accessor/cyclic shapes and over-budget input. Its initial bounded profile follows existing resource/source capacities: 400 file leaves, 20 MiB decoded per file, 32 MiB encoded data/key work, 10000 total entries, depth 64, 2048-code-unit relative paths, 255-byte path components and 1024-character media types. The complete serialized source must also fit the 32 MiB reopening budget, including frames and JSON overhead. Sparse asset patches use the same bounded tree walker with null deletions and validate names before merge; stored nulls are invalid. Empty named directories and separate aliases survive, while an empty top-level tree is the omitted default. An unescaped `#` in a leaf MIME header is refused rather than changing Data-URL interpretation.

### Explicit declared-asset references

**URI codec, native resource contexts and project declaration resolution implemented.** A reusable reference uses `asset:<encoded-path>[?<query>][#<fragment>]`. The lowercase `asset:` scheme has no authority or leading slash. Each path component is the exact declared key, UTF-8 percent-encoded with uppercase hex except for RFC 3986 unreserved characters; slashes separate directory keys. For example, `asset:fonts/Regular%20Italic.woff2` names `assets.fonts["Regular Italic.woff2"]`, and `asset:icons/logo.svg#mark` keeps a per-use SVG fragment. Decode once only: `%252F` names a literal `%2F` component, not a directory separator. Never case-fold or Unicode-normalize a reference into a different authored key. The tree decoder separately refuses portable aliases.

Paths share the tree's portable-name constraints: no empty/private/dot/parent components, separators inside a component, control characters, reserved device/prototype names or unsafe trailing dots/spaces; components fit 255 UTF-8 bytes, decoded paths 2048 UTF-16 code units and at most 64 directories plus a leaf. Query/fragment suffixes are opaque RFC 3986 ASCII text, with valid percent triplets and a 2048-character bound; encode spaces and non-ASCII characters there. Preserve their spelling and do not include them in asset lookup. The complete encoded URI has a conservative 26630-character bound. This syntax never authorizes filesystem or network access.

`core/lib/asset-reference.ts` owns `assetReference(path, suffix)` and `readAssetReference(input)`, plus the shared path/name validator. `resolveAssetDependency(basePath, relativeUrl)` resolves literal `.`/`..` within the declared namespace, refuses root escape/encoded traversal/authorities and produces the same explicit URI; it never consults the original filesystem. Non-asset URLs, including literal Data URLs and existing relative file URLs, return `null` from recognition rather than being extracted or reinterpreted. Malformed explicit references report `INVALID_ASSET` without echoing arbitrary payloads. This codec consumes URL values after their HTML/CSS carrier syntax has been decoded. The shared frame validator admits it in `src`/`poster`, `head.icon`, and `href`/`xlink:href` on supported SVG `use` nodes, not navigation or form destinations. Other SVG href consumers remain refused; this does not add unsupported `image`/`feImage` tags or broaden the literal Data-URL profile. Raw component overrides validate URI syntax first and defer href classification until expansion validates the actual tag; changing the tag or inherited href cannot bypass that check. Inert text, metadata and non-URL attributes are not scanned for references. External HTML direct URL attributes remain outside the native namespace. Open/re-import validates the converted whole native candidate and complete disk plan before exclusive sibling publication; dropped-page preparation checks its own CSS/srcset/current compiler output without borrowing the receiving project's asset tree. Clipboard HTML for declared resources is explicitly exported with embedded bytes instead of sending project URIs or session URLs; internal board specs retain their reusable references. Foreign HTML fragments keep supported literal Data URLs but refuse native resource URL attributes; their sanitized fragment and current compiled-class CSS are also checked without a receiver namespace before mutation. Tools use native node specs to intentionally reference declared resources. A missing declaration never falls back to a similarly named filesystem file.

The private `buildStatic({ assets })` seam accepts a separately validated Data-URL tree and emits reached files under their declared `assets/<path>` names. It shares file/byte budgets and collision reservation with legacy resources, retains literal Data URLs and named aliases, and fails missing declarations without filesystem fallback. CSS/SVG dependencies resolve against each asset's declared path; query/fragment spelling survives. Canonical-carrier mapping retains `asset:` references, while prepared HTML/CSS gets prefix-portable relative file URLs. The result separately records declared MIME (`mediaTypes`) and MIME/content fingerprints (`assetSources`), including them in preview cache versions; previews cannot expand the accepted public graph. No files are published by this helper.

The shared builder has a deliberately conservative text profile: CSS/SVG are interpreted by declared MIME rather than filename, with UTF-8/US-ASCII checks. SVG uses an XML parser/serializer with explicit XML 1.0 character, declaration and namespace guards rather than relying on parser recovery. It preserves inert metadata and character-reference line ends, and applies the source node/depth bounds. Lossy charset changes, HTML resource closure, SVG DTD/entities, `xml:base`, foreign/active content and processing-instruction dependencies, and indirect CSS carriers outside the existing literal-copy profile are refused. CSS import discovery is case-insensitive; escaped at-keywords that PostCSS cannot represent faithfully are refused rather than losing dependencies. PostCSS source-map comments stay inert. Native SVG file projection additionally refuses file/network dependencies inside SVG assets: only same-document references and literal inline data are supported there, rather than promising browser image-context external-resource loading. Declared file-based SVG `use` references are also refused: their prepared top-level page syntax is valid, but opaque-origin sandboxed previews cannot load them faithfully. Inline SVG nodes with same-document `use` remain supported; the frame URI codec is not a serving capability. The standalone builder can prepare a broader dependency graph, but that is not native SVG admission. MIME metadata alone does not prove faithful delivery on an arbitrary static host.

Project reads expose `project.resources` descriptions (declared path/URI, MIME and size), not the `assets` payload tree. New image uploads and image drops append bytes through the serialized settings writer, with stable unique keys; the old sibling upload staging/hardlink store is retired. Whole-project copies retain used and unused native bytes; in declared mode they copy only required legacy file inputs, not an unrelated sibling asset directory. No automatic migration of existing external files or literal inline URLs is implied.

`runtime.exportDocument` is asynchronous. Whole-frame clean HTML embeds declared resources, including ordinary CSS `@font-face` bytes, independently of original files or a live board. Node fragments embed their explicit resource references but do not reconstruct inherited/global stylesheet semantics; use a whole-frame export for complete font styling. Single-file export refuses resource query semantics, external SVG `use` references and cycles that cannot be preserved by Data URLs, or an over-budget expanded HTML result; save a project copy instead. Bundle/source copies retain those references unchanged. The core family selector edits ordinary inline CSS and discovers declared families through browser CSSOM; it adds no font metadata or format field. The native device uploader adds TTF/OTF/WOFF 1 or null-transform WOFF2 bytes and ordinary face rules together; far-zoom capture uses a separate bounded, render-guarded font-CSS read for referenced declared or accepted legacy local-file bytes. Editor frame previews and capture use the same accepted public resource graph, preserving declared MIME before shared HTTP extension defaults. Resource changes advance render identity without source absorption or authored version/history changes; capture performs no filesystem read and does not depend on generated disk files. Legacy binary resources with misleading text suffixes retain opaque bytes and canonical extension-default MIME instead of lossy text parsing or HTML helper injection; this is not automatic text-encoding conversion or a broader text-dependency closure profile. Strict canonical relocation still refuses such uninterpreted text carriers rather than bypassing its dependency validation. It preserves ordinary descriptors/conditions without adding source fields; missing/network/linked/imported/dynamic dependencies and authored file-URL query/fragment semantics retain live rendering rather than a fallback-font thumbnail. Legacy capture is a transient byte projection, not canonical embedding, broader upload admission or font-program attestation.

`core/lib/font.ts` is a private bounded face-metadata seam, not a font-program validator. `readFont(Uint8Array)` reads a single OpenType TTF/OTF face or supported WOFF 1/null-transform WOFF2 wrapper: exact Unicode typographic/fallback family and subfamily names (per name ID: Windows English first, then supported Unicode-platform records, then the first other supported Windows Unicode record; not host-locale selection), CSS weight/stretch descriptors, and representable static or `wght`/`wdth`/`ital`/`slnt` ranges. It validates all table bounds/overlap before inspection, supported Unicode encoding IDs, format-one language references, versioned name/OS/2/style-flag/axis records, the shared 20 MiB byte budget and 10000-table work cap, and a 512-code-unit text-name profile. Transformed WOFF2/collection/legacy containers, WOFF extended metadata/private blocks, unrepresentable or ambiguous axis combinations, malformed metadata and flagged restricted embedding refuse with `INVALID_FONT`; acceptance is not a license attestation. Other axes remain in the unchanged font bytes, not a new metadata field. The Node-owned `font-woff.ts` seam checks WOFF 1 header/flavor/length, sorted unique tags, aligned contiguous nonoverlapping table blocks, zero padding, exact aggregate expanded size and per-table checksums (with the standard zeroed head adjustment). It admits raw or single-zlib-stream tables under independent 20 MiB encoded and aggregate expanded bounds, at most 4095 tables, with exact output length and consumed-input checks. It temporarily reconstructs SFNT metadata input, then uses the same name/OS/2/axis validator; it never publishes the reconstructed font. WOFF source bytes remain verbatim `font/woff` leaves with `.woff` names, ordinary face CSS, common export/capture/copy/history semantics and no new wire field. Container version fields are not schema markers and are not rewritten. Encoded/reconstructed payload bounds are not a whole-process memory cap and do not constrain the browser's earlier `FontFace.load()` decoder. The device uploader separately requires successful browser font decoding before sending binary bytes to `api/fonts`. `runtime.saveFont({name,data,expectedVersion})` copies bounded input, checks the project version inside the writer queue, interprets metadata, allocates a non-overwriting `fonts/` leaf and accepts its ordinary project `@font-face` rules plus the common asset patch as one validated/undoable candidate. The filename affects only a new safe key; actual MIME/extension and descriptors come from bytes. Registration does not edit selected nodes; choosing Family is a separate gesture. Companion files may join one exactly spelled family only when every existing matching face has understood, unconditional descriptors and the new style/weight/stretch coverage is disjoint. Inclusive ranges, default normal/400/100% and supported weight/width keywords are compared explicitly; normal and italic may be separated, while oblique styles are conservatively treated as intersecting either. Existing explicit-angle styles, authored conditional/layered rules, aliases, duplicate/important/dynamic/unknown descriptors, unknown or unquoted escaped family syntax, identities outside the host's Unicode comparison profile, imports and unowned/mutable stylesheets refuse with `FONT_CONFLICT`. The codec-owned projected `components` wrapper is distinguished from authored layers through source/projection provenance; it does not make an authored layer eligible. No old rule is rewritten or old file replaced. Adding a disjoint companion intentionally changes matching for requests previously served by a nearest/synthesized face, not the meaning or bytes of an existing covered face. Family collision comparison conservatively covers case expansions and sigma variants without rewriting names; it can refuse additional aliases and is not a locale-sensitive rename. This initial profile is advertised as `project.capabilities.fontUpload` on writable native boards, not mutable Markdown-site or read-only hosts. Stored source remains schema 1 with no font metadata field or alternate store. Node-only callers receive metadata/candidate validation, not an independent browser-program-validity guarantee. The browser `FontFace` constructor takes the literal family name; CSS declarations require a separately quoted/escaped family value. Metadata inspection cannot establish glyph validity, font availability or faithful capture.

### WOFF2 admission gate

`readFont` and device registration admit a restricted single-face null-transform WOFF2 profile, for both TrueType and CFF-based OpenType. Each `glyf`/`loca` table must use version 3, every other table version 0; transformed/unknown versions, collections and extended metadata/private blocks still refuse even when the browser can decode them. These are metadata/upload restrictions, not a ban on opaque project-owned `font/woff2` resources rendering through ordinary CSS.

The implemented profile distinguishes **null transforms** from the remaining transformed glyph/metrics gate:

- **Null-transform path:** `font-woff2.ts` validates the 48-byte single-face header, known/explicit printable unique tags, canonical UInt32 Base128 lengths, null versions, paired glyph tables, compressed range and zero trailing padding before decoding. Raw/reconstructed budgets are derived from the directory, at most 20 MiB with 4095 tables. Node Brotli enforces `maxOutputLength` with the large-window extension disabled (standard window at most 16 MiB), exact aggregate decoded length and consumed compressed bytes. Temporary SFNT construction sorts the directory and computes checksums, then uses the existing metadata validator. Original WOFF2 bytes remain `font/woff2` leaves with `.woff2` names through common CSS/history/export/capture/cache paths; no decoder dependency or font-specific source field is added. Payload/window limits are not a whole-process memory guarantee or bounds on the browser's earlier `FontFace.load()` work.
- **Transformed path:** A maintained decoder must expose enforceable actual-output and decoder-working-memory limits before processing, bounded failure/deadline isolation that cannot abort the board, and a reproducible pinned implementation. A fixed output writer alone does not constrain Brotli or glyph-reconstruction allocations. Preserve original bytes and exact family identity; reconstructed SFNT remains temporary metadata input, not canonical source.
- **Header semantics:** [WOFF2 Recommendation §3.2](https://www.w3.org/TR/2018/REC-WOFF2-20180301/#woff20Header) makes `totalSfntSize` advisory: transformed reconstruction can differ substantially. Do not allocate from it or use equality with it as an output-budget proof. Compute/enforce actual bounds at the owning decoder boundary instead.
- **Isolation semantics:** [Node 22.19 worker limits](https://nodejs.org/download/release/v22.19.0/docs/api/worker_threads.html#new-workerfilename-options) do not cap external data such as ArrayBuffers. A timeout or V8 old-generation limit is not a WebAssembly/native working-memory bound. Any proposed fixed-memory implementation needs artifact-level proof that growth cannot exceed its limit, plus malformed/over-budget recovery tests.

The evaluated public APIs do not satisfy the transformed-path contract: `wawoff2@2.0.1` exposes `decompress(buffer)` without a caller output/memory limit, and its compiled glue permits heap growth up to 2 GiB; `woff2@1.0.0` allocates output from `ComputeWOFF2FinalSize` before conversion and requires a native build. Neither is selected as a product dependency. [Google's pinned decoder](https://github.com/google/woff2/blob/7b67e12355fe7da148db5c19d4261f0a498a9537/src/woff2_dec.cc) offers bounded output interfaces but also allocates an independent transformed-data buffer, so adopting a wrapper requires more than setting the output size. This is a finding about these evaluated APIs, not proof that every decoder is unsuitable.

Each example has its own folder, for example `examples/landing/landing.divlet` with its generated cache under `examples/landing/.divlet/landing/`. This directory rule does not itself decide whether separate authored Markdown/site inputs are absorbed into the project; that is distinct from eliminating external file-asset ownership.

## Generated output

```text
.divlet/<name>/
  <frame>.html            generated page
  <frame>.meta.json       identity and hashes of the page
  .divlet-build.json      generated-file ownership and hashes
  _assets/                bundled resources
  .trash/                 preserved hand edits and removed pages
```

The ownership manifest can additionally record `mediaTypes`, a dictionary from owned file names to canonical printable MIME strings (at most 1024 characters). It is generated provenance, not project content, content sniffing or public/HTTP authority. `OutputStore.preflight(files, removed, { mediaTypes })` validates a complete replacement map before mutation; `write`/`writeLocked` accept the same metadata, preserve it during partial writes when omitted, and remove entries with deleted files. Keys must name planned or owned files. Existing manifests without the field remain valid. Native source/runtime publication forwards the complete map, including during partial cache repair. A resource path, even one ending in `.meta.json`, never self-attests editor-sidecar provenance.

The landing public-set owner also recognizes hierarchical `assets/` resource paths. These require owned MIME compatible with the conventional static-host extension and supported UTF-8/US-ASCII text interpretation; unsupported names/types/parameters or missing provenance refuse publication rather than silently omitting a dependency. MIME cannot authorize sidecars or arbitrary owned files for publication. Compatible metadata-only changes do not change the public-byte fingerprint. This is a prepared-copy policy, not proof of actual headers on every static host. The local board separately serves only its accepted public graph and uses the declared MIME before extension-based HTML handling.

Legacy projects without a declared tree retain `_assets/`; native declared-resource builds use `assets/` beside the pages. Preview URLs are separate token-scoped derived addresses with resource fingerprints; canonical project references never become those URLs. Public files are captured before editor sidecars enter the disk plan. Only reached assets become public outputs; unreferenced bytes remain in the canonical project.

Edits to the model regenerate the page. Hand-edited generated pages are currently diagnosed and preserved on regeneration, not reconciled back into the model. The managed reverse-editing contract remains distinct from strict codec round trips and clean export; implementing that editor capability is WEB-5. Output files belong to one project and must not overwrite unowned files or share another project's destination.

## Importing

The core admits external `.html`/`.htm` pages directly into this format without an HTML importer registration or style engine. Foreign formats use importer plugins. Both paths retain bounded source reads, provenance and non-overwriting sibling publication; see [architecture](architecture.md#core-and-plugins). Lossy external sanitization must not be substituted for reconciliation of an edited native projection.

## Evidence and freeze boundary

`npm run test:format` runs the candidate baseline from a source checkout: five accepted JSON inputs and 20 rejected cases under `core/tests/fixtures/format/`, explicit normalization expectations, semantic project read/write checks, component-address behavior and the complete example/tag profiles in this document. The corpus is plain JSON, not a second validator. Error codes identify this implementation's refusal boundaries; they do not prescribe another implementation's diagnostic wording. Every accepted frame's expanded static HTML projection also round-trips; this is not reverse editing of a managed component projection. The model/component suites cover rejected root and misplaced table roles, valid row instances and table text; the codec suite checks admitted roots and simple parent/child trees across the supported HTML tags, with positive table controls and a guard against achieving fidelity by dropping tags.

Existing model, component, codec, output and native HTML suites provide further implementation evidence, not a declaration of complete standard conformance. The baseline does not prove resource closure, every operational limit, rendering dependencies or unresolved component policies. The preparation gate in [BACKLOG.md](../BACKLOG.md) owns the remaining decisions and approval.

### Reader-boundary witnesses

`npm run test:format:audit` emits the paired project/frame reader report; the format baseline now runs it as a regression gate. Inputs and diagnostic unblockers are retained in `core/tests/fixtures/format/reader-boundaries.json`. It exits 1 if a retained invariant regresses. Passing these witnesses does not establish complete format conformance or settle the remaining freeze decisions.

- **`metadata-number-overflow`:** metadata `{"value":1e400}` is refused by both readers before serialization can replace it with `null`.
- **`metadata-safe-keys`:** both readers reject unsafe object member names in metadata.
- **`name-line-endings`:** both readers normalize CRLF/CR names to LF without trimming other whitespace.
- **`name-unpaired-surrogate`:** both readers reject unrepresentable names. Project-name failures keep the implementation's `INVALID_PROJECT` code; frame-name failures use `INVALID_DOCUMENT`.

The same baseline checks that metadata remains opaque/extensible, non-JSON API values are rejected, and public override types admit null attribute deletions while literal element attributes remain strings. Runtime regressions verify that invalid metadata cannot replace accepted source/output/state and that invalid authored bytes remain available for correction.

### Freeze assessment: format versus implementation

The independent assessment of `6435d97` produced the six concrete numeric/component/context/budget counterexamples documented in their owning sections above. Two reviewer lenses supplied usable reports and a verifier separately reproduced the findings; the final judge assessed synthesis quality, not the repository. This is evidence for the stated boundaries, not whole-format or publication approval. The paired reader audit remains relational: simultaneous rejection can satisfy agreement, so explicit accepted/rejected expectations must accompany it.

- **Persisted design gates:** numeric/compatibility rules, CSS emission/declaration ordering (the WEB-1 format sub-boundary), component scope/conflicts/DOM references (WEB-4), and necessary rendering dependencies (WEB-3) have an approved direction but still need implementation and evidence before their meaning is frozen. The current `prepareFrame` compiles class candidates through the active engine; the no-engine compiler returns empty CSS. The project reader has no enforced dependency profile. A cache or class spelling is not a reliable declaration of that dependency, and this assessment does not invent its fields.
- **Native style editing (WEB-1):** `styles` is an editing input, not a stored node field. Fallback/cascade editing repair is not by itself a reason to redesign the wire shape. Authored CSS emission and inline declaration ordering are separate persisted-meaning questions, evidenced above; they cannot all be dismissed as editor-only work.
- **Composition and foreign conversion (WEB-2):** choosing concrete providers outside generic registries and emitting ordinary CSS from PEN are implementation boundaries. Their completion is not automatically a prerequisite for freezing every native field.
- **Managed HTML editing (WEB-5):** the editor feature can be staged independently only if its identity/provenance needs fit the chosen model. A later design that needs different persisted identities, resource meaning or dependency fields must reopen that decision before freeze; an ordinary codec round trip does not prove it is solved.

The canonical backlog owns the remaining policy preparation and approval gates; this document records their semantic rationale, not a second task list. Actual freeze needs an explicit approved candidate, resolved persisted-semantics blockers and passing evidence for that candidate. Publication, tagging and deployment require separate authorization.

## Approved first-release profile

**Approved for implementation, not frozen or fully implemented.** User approval covers this direction, not compatibility freeze or publication. Project and standalone-frame envelopes both remain schema 1 while the first format is unfrozen. Implement the profile coherently without inventing schema 2/3 or treating an unchanged marker as permission to accept unsupported fields. Read-only probes against `9a3a11e` reproduced the remaining order/scope/ID/numeric/dependency witnesses and the two Chromium CSS counterexamples below.

The ordered CSS foundation in `core/lib/declarations.ts` supplies immutable property operations and a shared serializer for existing codec emitters. `model.ts` additionally exports opt-in `validDeclarations(input, id, nullable?)`: literal pairs retain repeated fallbacks/order, override-operation pairs may delete with null, and both share the legacy declaration safety/normalization guard. It validates shape and per-value bounds without mutating input; frame admission still owns aggregate budgets. The codec still adapts current style maps through `Object.entries`; document/project readers do not yet admit declaration-list fields, and this does not activate native CSS emission, new envelopes or migration. The [renderer seam](architecture.md#layout) also has exact requirement resolution and opt-in required compilation. A compiler-only bundled descriptor now pins its stylesheet base and identifies installed dependencies/configuration/stylesheets, independently of installation paths. Project readers/render preparation and default selection still use the draft path; `requires`, trusted composition and complete resource/inspector integration remain open.

### Value and compatibility rules

Use finite binary64 numbers, treating signed zeros as equivalent and normalizing decoded numeric zero to positive zero. Large-integer rounding and underflow occur during binary64 decoding; precision-sensitive application values use strings. Keep opaque metadata strings unchanged, including their existing JSON/UTF-16 contents. Object member order is insignificant; arrays and authored CSS text retain order. Refuse duplicate JSON member names, including escape-equivalent spellings such as `"a"` and `"\u0061"`, at the native text-decoding boundary before object validation loses that evidence. Object-only APIs cannot attest the spelling of their caller's original JSON text.

The opt-in `parseNativeJson(text, limits)` export from `@divlet/core/model` implements text-level duplicate-name refusal and finite binary64/positive-zero decoding in the portable `validation.ts` owner. It requires host-selected UTF-8 `bytes` and JSON-container `nesting` budgets, independent of DOM depth; source fields cannot raise them. Names are compared after JSON escape decoding, without Unicode normalization. The platform parser owns JSON syntax; an iterative value walk avoids recursive-reviver stack limits and leaves opaque strings unchanged. It returns `unknown`, not an admitted document, and sanitized `INVALID_JSON` diagnostics never quote source values (optional offsets count UTF-16 code units). Existing file/browser readers are not switched by this helper; object-only normalization/equality and coherent entrypoint adoption remain open.

Keep identifier grammar, field types and geometry bounds explicit. Counts, depth, byte/text/metadata budgets remain declared implementation capacities, not document-selected privileges or a promise that every reader accepts arbitrarily large projects. The reference implementation retains its documented limits and uniform metadata budget. A capacity refusal must be explicit and non-destructive, never truncate content. Unknown structural fields and unsupported schemas remain refusals; safe application extension data stays under metadata.

### Native CSS and ordered inline declarations

Emit merged tokens as ordinary `:root` declarations, then project CSS followed by consuming-frame CSS, then any declared provider's compiled stylesheet. Preserve authored CSS verbatim: neither the core nor a provider implicitly moves it into another cascade layer. A provider may emit its own versioned layers; authors wanting component-layer priority write that layer explicitly. Consequently, unlayered authored CSS can beat layered utilities under normal browser rules. Style normalization must retain native declarations or refuse when equivalence is not established; enabling a compiler is not permission to rewrite the cascade.

Replace literal element `style` maps with **ordered declaration pairs**, e.g. `[["padding-left","20px"],["padding","10px"]]`. Each pair contains a validated property and string value; repeated properties are allowed for ordered CSS fallbacks. Absence/null defaults to an empty list. Swapping these pairs deliberately changes left padding from 10px to 20px; sorting unrelated JSON object members does not. Existing executable-content restrictions still apply.

Keep overrides partial rather than replacing a component's entire inline block: `Override.style` becomes an ordered sequence of property operations, with a string setting a property and null removing it. A set replaces all matching declarations with one at the first matching position, or appends when absent; a remove deletes all matches. Ordinary property names match case-insensitively; custom properties remain case-sensitive. Remove-then-set explicitly moves a property to the end. This preserves existing unique-property merge behavior while making ordering explicit. The `styles` declarative editing input remains a property map, not a newly stored node field.

The alternatives have real costs: retaining ordered JSON objects avoids the shape change but requires order-preserving parsers and order-aware equality everywhere; sorting style-map keys is simpler but changes existing inline CSS and cannot retain every declaration sequence. Ordered pairs make the necessary order native to JSON and carry repeated fallbacks without a hidden second representation.

### Overrides and component context

Within one instance's unordered `descendants` map, resolve every address and nested-root alias to its effective occurrence before applying writes. Coalesce identical normalized writes; refuse different writes to the same effective destination, including element `text` versus its text child's `content`, and metadata replacement/deletion of an ancestor another write modifies. Disjoint fields and metadata leaves remain composable. An ordered style-operation block is one destination: competing blocks for the same occurrence must be consolidated under one address, not concatenated in member order. Reordering the map must not change text, generated text-part identity or provenance.

The cloned definition and its nested-instance overrides form lower layers; an enclosing instance's overrides apply after them. This fixed structural precedence is not a conflict between unordered peers. Preserve the existing distinction that a ref's own metadata overlays the expanded root by top-level key, retaining literal null values; descendant metadata patches instead merge recursively and use null deletion.

Select **consumer CSS/token scope**: clone subtree declarations and class references, but do not import the source frame's stylesheet or token map. Project CSS/tokens and the consuming frame provide the context. A component that needs shared definitions puts them at project level. Source-scope styling would need additional cascade/collision rules; blind concatenation is rejected.

### DOM occurrence references

Keep authored IDs and ID references literal in the consuming document, not implicitly relative to a component. Require nonempty DOM IDs to be unique across each final expanded/composed page, including inline SVG and visible definitions; separate iframes may reuse an ID. Do not rename IDs on read or silently detach instances. Authors/importers can supply explicit per-occurrence ID and reference overrides. In particular, foreign conversion that creates reusable SVG definitions may need matching occurrence overrides before the candidate can be admitted.

Diagnose known missing local ID references after expansion/composition; do not claim complete CSS-selector/reference closure. Browser evidence must cover valid `for`, ARIA ID lists and SVG fragments as well as duplicate refusal. Automatic namespace rebasing is deferred: it would need a complete reference/provenance contract, not just a string prefix.

### Explicit rendering requirements

Add one mandatory project-level `requires` object. `{}` means native HTML/CSS only, even when an installed engine recognizes a class such as `p-4`. The only initial optional member is `styleEngine: { id, version }`; unknown requirement/descriptor fields are refused. The ID uses the existing safe-identifier grammar; version is an exact, case-sensitive, nonempty printable ASCII token of at most 128 characters, not a semver range. Providers advertise that renderer compatibility identity and must change it when effective compiler/configuration/dependency semantics change; an npm package version alone need not identify them sufficiently.

The opt-in `validateRequirements(input)` export from `@divlet/core/project` implements this structural shape in `core/lib/requirements.ts`, with only portable validation primitives at runtime. It retains unknown identities, copies accepted data, rejects missing/null profiles and undeclared or non-JSON data fields, and preserves printable ASCII (U+0020–U+007E) version bytes exactly rather than trimming or interpreting ranges. The shared native vocabulary owns `ProjectRequirements`/`StyleEngineRequirement`; the engine subpath retains its existing type export. Project readers and settings patches still refuse the `requires` field until the coherent cutover; this helper neither activates it nor resolves a provider.

A structural reader retains a valid unknown requirement without loading a provider. Preparing/rebuilding requires the declared identity and compilation capability, with no fallback to the first installed engine, guessed class meanings or an old cache. Missing/mismatched providers refuse the rebuild while preserving accepted state and authored bytes. IDs/versions never authorize package installation, executable loading from project paths or network fetches. Disabling a required engine needs an explicitly validated native-CSS conversion, or refusal without mutation.

This keeps compact utility source with derived compiled CSS. The alternative is explicit materialization of all necessary utility CSS as canonical native source, avoiding the requirement field but changing authoring/source ownership and increasing source size. Silently freezing cached compiler output into authored CSS is not that conversion.

### Target envelopes and migration

Keep project and standalone frame **schema 1** until the first format freeze. Required dependencies and ordered styles change the draft wire shape, but do not create released schema generations before one has been frozen. Update readers, writers and consumers together; do not add a second draft/version field as a substitute counter. Stored frames still omit their standalone envelope marker. Content revisions and npm versions retain their separate meaning.

This illustrates the approved target native profile; **the current reader still refuses it**:

```json
{
  "schemaVersion": 1,
  "requires": {},
  "frames": [
    {
      "id": "inline",
      "name": "Inline",
      "version": 1,
      "artboard": { "x": 0, "y": 0, "width": 390, "height": 400 },
      "rootId": "root",
      "nodes": {
        "root": {
          "id": "root",
          "type": "element",
          "tag": "main",
          "style": [["padding-left", "20px"], ["padding", "10px"]]
        }
      }
    }
  ]
}
```

A compiler-dependent project would instead declare, for example, `"requires":{"styleEngine":{"id":"tailwind","version":"EXAMPLE-EXACT-RENDERER"}}`. That version is illustrative, not an installed-provider claim.

The eventual frozen reader must support its exact agreed envelope, not every historical unpublished draft or hypothetical future version. There is no schema-number-only migration to implement here. If an authored draft needs structural/style conversion to the finalized profile, make that conversion explicit and validated; never silently reinterpret a compiler-dependent file as plain CSS. Preserve original bytes; produce an approved sibling copy with a fresh owned output destination. Preserve existing map declaration order when converting to lists and preserve existing override operation order. Choose the actual rendering profile explicitly. To retain the old appearance, make the old implicit CSS layer wrappers/order explicit in authored CSS; adopting native cascade instead is a visible choice. Conflicting overrides, duplicate IDs and lexical ambiguities require diagnosis/owner correction rather than guessed repairs. Opening alone must neither migrate nor overwrite.

### Implementation owners and approval evidence

This proposal adds no implementation evidence merely by being written. Before an exact candidate can be frozen:

- **Value/reader owners — `model.ts`, `project.ts` and native text decoding:** zero normalization, overflow refusal, string preservation, escape-equivalent duplicate-key refusal and unsupported-schema refusal; retain reader-boundary regressions.
- **WEB-1 CSS boundary — model/codec/render and their style consumers:** ordered declarations/patches, repeated fallbacks and order-aware equality; Chromium must distinguish 10px/20px declaration orders and give red for a later unlayered red root rule over a blue token. Explicit legacy layer conversion must preserve the old blue result. Native emitters/export must agree; not every style-editor feature is a freeze prerequisite.
- **WEB-4 expansion/identity:** reversed conflicting text/alias maps refuse in either order; non-conflicting writes compose; style blocks have explicit order; consumer scope is intentional; IDs remain unique and references/selection/provenance survive valid instances. Include importer-created SVG occurrence cases.
- **WEB-3 requirements — project/settings types, the public engine contract, renderer and runtime:** pure CSS rebuilds with no provider and ignores available utility compilers; missing/version-mismatched required providers and refused disables preserve source/history/output. Deleting the cache must not hide a missing dependency. Provider matching belongs in rendering, not the pure data validator.
- **Native migration/output owners:** explicit structural/style draft conversions preserve declared CSS order/cascade, resource bases and output isolation; no implicit source overwrite, metadata erasure or ambiguity repair. This is an obligation of the approved transition, not an existing migration command.

**Final approval gate:** the direction is approved for scoped implementation. Compatibility freeze still requires the implemented exact candidate, passing evidence and explicit final approval. Publication remains separate.
