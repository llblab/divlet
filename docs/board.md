# Using the board

[Back to the project README](../README.md) · [Agent integration](agents.md) · [Project format](format.md)

The board displays real HTML in each artboard. Use the canvas for direct edits, Layers for structure, History for accepted changes and the inspector for properties. The divlet mark pairs an open angle bracket with a filled angular D/play wedge, sharing 45° diagonals; the pen-nib silhouette nods to the project's earlier name, NIB.

## Canvas, selection and panels

The interface uses few permanent labels. Hover for tooltips with keyboard shortcuts; tooltip copy wraps instead of ending in an ellipsis, with width constrained to the available screen; `?` opens help, and `Ctrl K` opens all commands. The theme is available in Settings.

### Canvas

`Ctrl`/`⌘` + wheel or a pinch zooms only the canvas. Use the wheel, `Space` + drag or the middle mouse button to pan. Middle-button panning works everywhere except Play mode, where the page may handle it. `Shift 1` fits everything; `F` or `Shift 2` zooms to the selection, including a selected element. `0` resets to 100%. If resizing the window leaves every artboard offscreen, the board fits them into view again.

### Artboards

Drag the label or body in Select mode, with snapping to neighbors (`Alt` disables snapping; `Esc` cancels). Resize handles snap to device widths. Double-click the name or press `R` to rename; double-click the size above an artboard to edit it (`390 × 800`, `1280`, `16:9`). The same fields, aspect-ratio lock and 1:1 · 4:3 · 3:2 · 16:9 · 9:16 buttons are in the inspector. Groups support alignment, distribution and Tidy up. **Fit height to content** lives in the inspector's lower action row, not as a duplicate button in the geometry block; the normal height input remains available.

### Pi

The Agent tab follows the host's reported connection state. Without an agent, it shows “Connect an agent to this page” and the exact connection command in a read-only, selectable field with a Copy button in its top-right corner; Copy uses that displayed value. Local boards show `/divlet <project file>` for Pi and also mention sampling-capable MCP clients. The “No conversation yet…” invitation appears only with a connected conversational host. Existing messages remain visible across disconnection. Tool-only browser MCP hosts instead explain that the conversation stays in the agent and edits appear in History; they do not offer an unusable composer.

`A` opens the connected Agent tab's composer. Above the box a context header says what the request is about (*About A space for ideas › #nav*, or the whole board when nothing is selected), and while the conversation is empty three starting points fill the box without sending anything. The context header can wrap without overlapping the input and describes the request field for screen readers. The sidebar tabs adapt to their own row width, even when folded: icons always stay to the left of complete labels, never above them. Counts may wrap beneath the label in the text column when needed, without growing the tab row. For an element, breadcrumbs show artboard › container › … › element at bottom centre between the tabs and toolbar, wrapping when space is short. Selecting the whole artboard shows the artboard as the current crumb, then › and a `root` crumb for the next level. Click it (or focus it and press Enter/Space) to select the actual root; the artboard crumb selects the artboard again, with keyboard focus preserved. A late root-data read never takes selection back after another navigation. The hierarchy lives in Layers, not in the inspector. Layers has two sections: a compact artboard list at the top, showing about seven rows before scrolling and synchronized with canvas selection, and the selected artboard's tree below, starting at its root `main`. Element IDs are editable in the inspector; all references update, but parts of a component used by other frames cannot be renamed. Send stays at the footer's bottom-right corner, whether selectors/key hints share its row or wrap above it. `↵` sends, `⇧ ↵` inserts a newline and `↑` recalls previous requests. Requests queue while Pi is busy. The corner indicator shows the current activity and elapsed time; ■ stops Pi. Replies appear in the Agent tab, where each one has a Copy button; the tab keeps the conversation, History lists the changes it caused.

### Elements

One Select tool (`V`) handles artboards and every element, including the root. Hover highlights an element, click selects it and `Shift` + click adds it to the selection. Drag the page to move its artboard; drag a marquee on empty canvas to select artboards. Double-click edits what is under the pointer: element text, a text segment beside nested elements (such as part of a heading next to a `<span>`), or component-instance text. For images, links and inputs, it focuses the relevant inspector field (`src`, `href`, `placeholder`). `Esc` climbs the tree: element → parent → … → artboard → nothing. The other tool, Play (`P`), lets the page behave normally. `Enter`/`Shift Enter`/`Tab` and arrow keys navigate the tree (↑↓ for siblings, ← for parent, → for child). While editing text, `Tab` saves and moves to the next item; `Enter` in a list item starts the next item (`Ctrl Enter` only saves). `Ctrl G`/`Ctrl Shift G` wraps and unwraps; `Alt ↑/↓` reorders; `Ctrl D` duplicates; `Del` deletes with an Undo toast.

### Clipboard

`Ctrl C` copies selected elements as clean HTML and remembers an exact copy of their structure. `Ctrl V` inserts it inside the selected container or after the selected element, including across frames. External HTML becomes elements, plain text becomes paragraphs, and an image becomes an `<img>` whose reusable bytes are embedded in the project. Declared image URLs are embedded when writing system clipboard HTML; the internal copy keeps reusable project references. Pasting copied artboards duplicates them.

### Context menus

Right-click or long-press an artboard, element, layer or empty canvas for Ask Pi, expand, fit height, rotate, duplicate, copy and paste, Copy HTML, Download HTML, make component, go to component, detach instance, change tag, add element and delete.

### Panels

Layers (`L`) provides search, rename, drag-and-drop and a + menu with presets and components; instances and components have distinct markers. History (`H`) shows retained **Project states**: choosing a state restores the whole project after that grouped edit, including frame placement and project settings. Current marks the accepted state; Ahead marks a retained forward state. New edits discard the old future. Enter/Space activate rows; arrows/Home/End move focus without editing the canvas. Boundary text explains session opening, selective/untracked changes and retention limits. A separate **Activity log** disclosure keeps readable actions (by you, Pi or files), grouping repeated events from one gesture; it is not another set of historical addresses. The conversation is in Agent. On an older board without navigation support, History remains explicitly reveal-only; no second writer is created. These states are session-only and do not survive a board-server restart. Resize panels by dragging their edge or focusing the edge and using ←/→ (Shift takes larger steps); double-click to reset. The left sidebar's default and minimum match the measured outer DIVLET/search row, including its gap and borders; its desktop maximum remains 560 logical interface pixels. Left-sidebar and inspector widths are independent primary preferences, stored in logical interface pixels under `divlet:width:sidebar` and `divlet:width:inspector` in `localStorage`. A saved width overrides automatic/default sizing across reloads and selection changes. The measured minimum, narrow windows, phone sheets and interface scaling may temporarily constrain the rendered panel without replacing that choice; widening the window restores it. Escape, pointer cancellation, capture loss or window blur cancels a drag without overwriting the preference. Same-origin tabs follow storage changes. If writes are blocked, the chosen width survives only in the current page session. Browser storage is specific to the browser profile and origin, including the port: a new board on a different port does not inherit these preferences, and browser-cleared data cannot be recovered here. In Effects, dragging Z-index changes whole, unitless numbers, including negatives; an `auto` value starts the gesture at zero without being rewritten by a plain click. Shift accelerates by ten, arrows step, and Escape or pointer cancellation restores the pre-gesture value. A completed scrub is undoable. The read-only measured X/Y/W/H and overflow indicator sit at the very end of the element inspector, after Metadata. For one or several selected elements, the inspector edits shared fields together: tag, ID, text, **Tailwind classes**, **Layout**, **Spacing**, **Border**, **Effects**, **Appearance**, attributes, inline styles and measured geometry. A class chip shows its color and CSS on hover; click to edit, × to remove, and use `Tab` for suggestions. Unknown classes are underlined. Layout includes display, a 3×3 child-alignment grid, separate Justify options (start/center/end, space between/around/evenly, stretch) and Align options (start/center/end, stretch, baseline), plus grid items and columns, 3×3 pinning, direction, wrap and gap; self-alignment remains here for items in flex/grid parents. Spacing provides the Position mode selector and a developer-tools-style CSS box model: unoutlined position offsets, orange margin, yellow border and green padding bands surround blue content-size inputs. The bands are schematic, not proportional. Eight independent margin/padding inputs retain their authored values (px, `auto` or percentages), with measured fallbacks, and write classes such as `pt-4` and `pl-[13px]`; pointer/focus highlights the matching canvas band. Top/Right/Bottom/Left offset editors live only in the outer position band, including for static elements; offsets follow ordinary CSS and take effect when a non-static Position mode is chosen. All four border widths are independently editable here and in the **Border** disclosure immediately below Spacing. Both views edit the same native inline properties: changing one updates its inactive counterpart without moving keyboard focus or adding another write. Undo and refused writes restore the same accepted values in both. The Border section also owns line style (Solid, Dashed, Dotted, Double, Groove, Ridge, Inset, Outset, None and Hidden), colour, and radius with presets; these controls are no longer scattered through Appearance. Choosing one line style applies it to all four sides, replacing per-side style overrides but preserving widths and colours. None/Hidden hide the line without deleting authored widths; Default removes the explicit uniform line-style declaration. Appearance keeps background fill and text colour/size/weight, with the text-alignment buttons beside typography rather than in Layout. Its core-owned Family selector offers Default (stylesheet/inherited), system-ui, sans-serif, serif, monospace and literal authored project/frame @font-face families. It writes native inline CSS without changing utility classes, including with no style engine. Named choices retain literal fallback stacks and inline importance; selecting another declared face replaces its head rather than growing the stack. Default removes the direct family override, not stylesheet rules or classes. Mixed authored values are explicit. Ambiguous inline font/all shorthands and named replacement of dynamic fallback values refuse rather than guessing. The always-visible inline-CSS note distinguishes authored choices from the cascade winner: important stylesheet/class rules may still win, and this control never silently escalates priority. A rare name longer than the available width stays whole in a keyboard-pannable control; neither text squashing nor ellipsis hides it. On writable native boards, the small Upload font button beside Family opens a device chooser for TTF/OTF/WOFF 1 or null-transform WOFF2 (at most 20 MiB encoded and reconstructed, subject to the complete project budget). It decodes the program in the browser, then registers shared bytes and ordinary project CSS in one Undo step. Choose the new family separately; upload does not silently edit the selection. Regular/bold/italic companions may share one exactly named family when their literal style/weight/stretch ranges are disjoint; each file is stored once, independently undoable, and the menu still has one family choice. Existing files/rules are never replaced. Overlaps, aliases, authored conditional/layered or ambiguous descriptors, transformed WOFF2/collection fonts, WOFF extended metadata/private blocks and mutable site inputs still refuse. The button is absent without the advertised capability. Font uploads survive project copying/cache rebuilding and whole-frame HTML export; far-zoom snapshots embed referenced native and accepted local-file fonts and retain the live page when faithful preparation is unavailable. Local resources in editor frames load from the accepted public graph; file changes refresh the render without becoming project content or history. Network, linked/imported CSS, dynamic carriers and authored file-URL query/fragment dependencies remain outside the capture profile. The centre shows fractional, untransformed CSS content width × height, excluding padding/borders according to box-sizing, not the measured border-box W/H in the final footer. For one measured element, typing a nonnegative pixel size writes native inline width/height with the current render's padding/border adjustment. If a fresh measurement is unavailable or the frame changes while preparing the edit, it refuses rather than applying stale geometry. Clearing removes the corresponding inline declaration. Tab proceeds from Position mode through each band's top/right/bottom/left inputs, outside in, then width and height; Shift+Tab reverses that order, and both keys leave the widget normally. Committing with Tab keeps the next field focused, and queued edits compose even while an earlier request is pending. Unavailable or multi-selection measurements show `—` rather than invented dimensions. Full layer names sit inside their bands, with a shared px marker and no each/pairs/all linking switches. At phone/200% widths, side values stagger to stay readable without losing the nested model. Long signed/fractional values earn extra rows within their band instead of being clipped or shrinking to illegible type; the inspector may need scrolling. Effects provides explicitly labelled Opacity, Z-index and Blur fields. Dropdown selector values stay whole on one line, including Default and long choices such as Extra bold 800. Fields move below one another when their content widths do not fit side by side; labels, values and carets remain vertically centred. At very narrow widths only the label may abbreviate, with its full accessible name and tooltip retained. Labels use stronger contrast than values. Control grids adapt by content rather than one shared minimum: the radius field stays compact beside its wrapping presets; surface controls precede text colour/size/weight. At the desktop inspector's 280px minimum, artboard dimensions and compact controls retain two columns. Selector fields and tighter numeric grids can stack rather than split or clip their values; positioned elements have named Top, Right, Bottom and Left offsets. Attribute controls provide tag-specific shortcuts and name/value suggestions. For an artboard, the inspector shows dimensions, tokens (`--color-brand` creates `bg-brand`) and Custom CSS with formatting and highlighting. The inspector is one vertical flow in a stable section order, without horizontal section tabs. Each section's own header opens or closes it, including with `Enter` or `Space` when focused; collapsed sections are remembered locally. Canvas shortcuts do not consume activation keys on native controls. Images have a preview, Replace… from declared project images or legacy local images, Upload and alt text; instances have overrides.

The core **Inline style** editor preserves case-sensitive CSS custom-property names in direct property input and simple declaration paste: `--Ink` and `--ink` remain two different authored values. Ordinary property names normalize to lowercase. These edits use the same validated writer and Undo/Redo with or without a style engine. Declaration paste is still a limited semicolon-split convenience, not a full CSS syntax editor; it does not promise quoted-semicolon parsing or repeated-declaration preservation.

The conversation stacks from the bottom, immediately above the composer/activity plaque: a short exchange stays near the input, and only an exchange taller than the available chat area becomes scrollable. New messages follow automatically while you are near the bottom, including after composer/activity resizing; scrolling up to read or focusing an older message keeps your place until you return to the bottom or send a new request. Folding the pane preserves that reading choice. Your chat messages use a cool blue background in light mode and deep navy in dark mode, distinct from the neutral agent replies and the activity/error accents. While the agent is working, the activity plaque above the composer keeps its indicator and full wrapping description in the upper part, with elapsed time and Stop in a separate footer; Stop stays at the bottom right, including in a narrow panel. It is keyboard-accessible and requests an agent stop without Pi-specific wording. When the entire left sidebar is folded, that same plaque moves directly above Layers / History / Agent at the remembered sidebar width (full sheet width on phones); the tabs do not move and Stop still works without opening the pane. In this floating form the spinner occupies the bottom-left grid cell on the same centre line as the timer and Stop, with the description spanning the full width above. Opening Agent returns the original plaque above its composer, not a copy. Idle removes the floating shell; expanded browsing hides the whole footer. Very long floating activity scrolls inside its bounded text area so time and Stop remain visible, and phone inspectors/breadcrumbs stay above the measured footer. When the agent changes a layout, affected elements briefly highlight. Expanding an artboard with `E` opens the live page across the client viewport, with working links and navigation to the site. On narrow screens, panels become sheets and share the available height.

## Expanded view

A page expanded with `E` immediately opens the prepared, read-only page with working links and fragments. Expanding a Markdown site's template opens its actual home/content route, not placeholders followed by a second “Open site” step. Other frames open their own public page even when the project also has a site. One collapse button stays at the top center: the page's name followed by four inward-pointing arrows on the right (`Esc` does the same). On the standalone landing it reads “Edit on the board”; it collapses the expanded page into the canvas, rather than navigating back in browser history. Drag the button anywhere, or use `Alt` + arrow keys while it is focused, to inspect the page underneath. Dragging does not exit expanded view; clicking does. The button stays within the viewport. The DIVLET corner indicator and other panels are hidden in this mode, with their state preserved. Navigation stays in the same browsing iframe; it has no editor channel. Returning restores the previous mode/camera and a fresh authenticated preview of the latest accepted source. Temporary form values in the browsing page are not authored edits. The separate scaled-canvas Play tool still uses the editor preview; its known source-resource-base navigation limitation is tracked in the backlog.

## Open and save from the browser

Click the DIVLET button at the top left to open a menu with **Open project…** (`Ctrl O`), **Save a copy as…** (`Ctrl Shift S`) and Copy project folder path. The dialog lists project files and folders on disk. It shares its filesystem browser with the Settings folder chooser: type a path, use Parent folder or walk the list; Down enters the rows and Up returns to the path field. Existing `.divlet` and `.pen` files appear in project-opening mode; folder-only modes hide files. Old listing replies cannot replace a newer path or revive a closed picker. One source opens directly; several open as a collection; an existing empty folder can start `project.divlet` with Create project here. Save a copy copies the selected source and its resources into a new or empty folder, excludes other project sources and generated directories, and rebuilds the copy's pages when it opens. The original is unchanged; destinations inside the project and nonempty folders are rejected with an explanation. If the copied `outputDir` would escape the new folder or reuse the original build, only the copy resets to its default output directory. This works for boards launched through `divlet` or from Pi.

## Settings

Open Settings with the gear in the bottom-right toolbar or `Ctrl ,`. **Build output** shows the selected source file and effective build path. Type a relative output directory or use **Choose the output folder** to browse with the same path/list controls as Open project. **Use this folder** only fills the relative draft; **Apply** still saves explicitly. Leave it blank or choose **Reset to default** for `.divlet/<source stem>/`. A rejected path or occupied destination leaves the project unchanged and keeps your draft. If another writer changes the project, **Reload current settings** discards the draft and reads the latest version before you retry.

**Interface size** offers 100, 125, 150, 175 or 200% (also adjustable with `Ctrl Alt` + / −). Panels, menus, dialogs, tooltips and artboard labels scale; the canvas does not. Narrow-window layouts use the effective interface width: the window width divided by the interface scale.

## Where projects live

A project is one `<name>.divlet` file. Multiple sources in the same directory are independent projects, with separate boards, versions, history and generated output. Paths passed to the CLI, `/divlet <path>` or `divlet_open` follow these rules:

| Selected path | What happens |
| --- | --- |
| A `.divlet` file | Opens exactly that project, or creates that source if absent. |
| An existing `.pen` file | Imports it once into the sibling `<name>.divlet` and opens that project; the `.pen` is never rewritten. |
| An existing `.html` page | Converts it once into the sibling `<name>.divlet` (one frame; scripts, handlers and external stylesheets are dropped) and opens that project. `.html` files in a folder are never offered as projects. |
| A folder with one project file | Opens that project. |
| A folder with several project files | Opens the launcher. |
| An empty workspace | Creates `project.divlet` directly in that folder. |

Source reads use bounded regular-file descriptors rather than trusting a pathname size check. If a file changes during a read, Divlet refuses the unstable snapshot and keeps accepted state; reload or rescan explicitly after it is stable. A source already discovered as existing (or its directory) missing before the first read returns `NOT_FOUND`, never an empty legacy replacement. New `.divlet` creation remains available; missing `.pen` files are never initialized.

Collections can also contain project files in immediate child directories; `Designs/`, `designs/` and the relative `projects` folder in `divlet.config.json` remain optional discovery conveniences. There is no special `divlet/` workspace folder.

The launcher shows names, frame counts, modification ages and frame names. Names use a known `divlet.name` or the source stem, with no extension-version gate; unknown fields and old marker values remain inert. Summary labels are bounded, malformed-source messages never quote project JSON or credentials, and listing performs no rendering, asset approval or source writes. Counts are not a promise of render/edit readiness; opening the exact source still validates its resources and capabilities. Type a name and press `Enter` to create `<name>.divlet` directly in the collection. It opens only exact source files from its listing. Agent collection results include each project's absolute `file` target for a subsequent `divlet_open` call. A project selected there becomes current for the Pi session; an explicit `projectId` still selects another open project. Named source files use their filename stem in the board tab and project indicator, so sibling projects remain distinguishable; the default `project.divlet` uses its containing folder's name.

### Importing HTML and foreign formats

Static `.html`/`.htm` pages are admitted by the core. Foreign formats use **importer plugins** (`plugins/`, see [architecture](architecture.md)), today Pencil `.pen` and legacy `.divlet` files that still hold PEN sources. Explicitly opening either kind of input creates or reuses `<name>.divlet` beside it and opens that project; the imported bytes are never modified, an existing `<name>.divlet` is never overwritten, and a source that cannot be converted opens as itself with diagnostics. The one path that moves a file is a legacy `.divlet` still holding a PEN source: its bytes go to a free `<name>.pen` and the `.divlet` path then belongs to the converted project. The PEN importer turns frames into ordinary HTML/SVG/CSS without a style engine: declarations use collision-avoiding data-attribute selectors, explicit variable references use shared CSS tokens, and matching component instances remain instances with overrides. Authored classes, inline priority and shared CSS order are preserved; literal colours are not implicitly converted to variable references. Ambiguous aliases, projection-only CSS references and native capacity overflows refuse publication rather than silently dropping styling; `metadata.import` records the source, its format and its SHA-256. The generated HTML cache lives in `.divlet/<name>/`, and every later open and edit uses the Divlet project exactly like one made in Divlet.

Projects can be opened and edited at any filesystem location permitted by the OS. Referenced local resources resolve automatically, including absolute paths and files outside the project folder.

## Project files

```text
workspace/
  project.divlet       source: frames, components, shared tokens and CSS
  landing.divlet       another independent project
  assets/              legacy local inputs, when still referenced
  site.json, content/  optional Markdown site sources
  .divlet/
    project/
      <frame>.html
      <frame>.meta.json
      .divlet-build.json  generated-file ownership and hashes
      .trash/             preserved hand edits, removed pages and imported sources
    landing/
      <frame>.html
      <frame>.meta.json
```

- **Project source.** The tools and board edit the selected `.divlet` file. Hand edits are validated too: an external edit becomes a logged, undoable change, and an invalid one is kept read-only while the last good state stays on screen.
- **Output directory.** By default results live in `.divlet/<source-filename-stem>/`. Set project `outputDir` to a relative directory to use another one; a destination is never shared between projects.
- **Generated outputs.** `.html` and `.meta.json` are generated. The ownership manifest prevents sharing a destination between projects or overwriting unowned files. Hand edits to owned pages are preserved in the output's `.trash` on regeneration; deleting a generated page restores it. Do not discard `.trash` if it contains work you need.
- **HTML imports.** On implicit missing-source opening, admitted nearby HTML can seed a project if no other `.divlet` source exists.

The stored project and node shapes are documented in the [format reference](format.md).

Image uploads store reusable bytes in the project asset tree (12 MiB per file), through the same serialized settings writer and Undo/Redo as other content. Same-name uploads allocate new declared keys without replacing earlier bytes; no sibling upload store is created. Existing local-file resources remain supported until explicitly converted.

## Components

A component node:

```json
{
  "id": "button",
  "type": "element",
  "tag": "button",
  "reusable": true,
  "className": "rounded-xl bg-[var(--accent)] px-5 py-3",
  "children": ["button-label"]
}
```

An instance of that component, overriding its text child:

```json
{
  "id": "cta",
  "type": "ref",
  "ref": "components/button",
  "descendants": {
    "button-label": { "content": "Sign up" }
  }
}
```

- **Component:** An element with `"reusable": true`. A frame named Components is a convenient place to keep them.
- **Instance:** A `ref` node addressed as `"frameId/nodeId"`, or just `"nodeId"` within the same frame.
- **Overrides:** In `descendants`, a key is a component node ID; `"nested-instance/node"` reaches inside a nested instance. Values set a text node's `content`, or an element's `text`, `className`, `tag`, `style`, `attrs` and `metadata`.
- **Validation:** The runtime refuses to remove a used component or a frame containing one. It also rejects overrides of missing nodes, cycles and invalid nesting after expansion. Errors name the frame and instance.
- **Shared styling:** Project tokens and CSS (`divlet_patch` without `frameId`) are visible in every frame. This is where a shared design system belongs.

On the board, use Make component in an element's menu and find components in the + menu (Add element). For an instance, the inspector shows text overrides, Go to, Reset and Detach. Double-clicking text inside an instance creates an override directly.

## Fluid and responsive layouts

An artboard's size is its iframe viewport; ordinary layout rules work inside it: flex, grid, percentages and `clamp()`. Use Tailwind variants (`md:`, `lg:`, `max-[719px]:`) for responsive behavior. Frame CSS is an exception for things classes cannot express, such as `@keyframes` and complex selectors. It lives in the `components` layer, so utility classes take precedence over frame or project CSS. One tree should work at several widths: change `artboard.width` to check it. A 390px frame copy (`divlet_frame_manage duplicate`) uses the same components.

## Use the generated site independently

The active output directory is the build, not an editor cache that needs a second export. It contains frame HTML, Markdown route pages (`index.html`, `guide/start/index.html`, and so on), sidecar metadata and reached resources: named `assets/` for declared bytes, or the retained `_assets/` legacy build. CSS, fonts, images, SVG dependencies and explicitly linked local HTML are copied and rewritten to relative URLs. Declared resources live inside the source file; existing local-file references still resolve beside it. Do not edit generated copies as canonical assets. Whole-frame HTML download embeds declared image/font bytes; single-file query/SVG-use cases that cannot retain meaning are refused in favor of a project copy.

Copy this directory to a static HTTP host, including one that serves it under a URL prefix. Divlet and the source workspace are not required to serve the copied build. Generated pages include compiled Tailwind CSS and no editor bridge or live-update connection. External URLs remain external; third-party resources still require their original hosts. Missing local resources produce `MISSING_ASSET` diagnostics and cannot work until the source resource is supplied.

Resource-only edits and Markdown changes refresh the build without changing frame versions. Invalid Markdown retains the last accepted site. Frame and route output names must not collide. Private/hidden files, `.divlet` sources, metadata, generated trees, escaping paths and symlink resources are not build inputs. An output directory cannot contain the authored resources or Markdown files it consumes.

Ownership checks and a `.divlet-write.lock` protect output writes across processes. If a writer crashes, stop that writer before manually removing its stale lock; do not remove the lock while another process is building. Keep `.trash` and the ownership manifest in your working build if you need preserved edits or further managed rebuilds.

## Keyboard shortcut reference

**Keyboard shortcuts** have a separate read-only window: `?` or `Ctrl K` → Keyboard shortcuts. Settings contains only preferences such as theme and interface size. The left panel grows with its content up to a maximum height, then scrolls.

For Markdown routes and template slots, see [Markdown sites](site.md).
