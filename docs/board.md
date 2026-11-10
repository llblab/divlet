# Using the board

[Back to the project README](../README.md) · [Agent integration](agents.md) · [Project format](format.md)

The board displays real HTML in each artboard. Use the canvas for direct edits, Layers for structure, History for accepted changes and the inspector for properties.

## Canvas, selection and panels

The interface uses few permanent labels. Hover for tooltips with keyboard shortcuts; `?` opens help, and `Ctrl K` opens all commands. The theme is available in Settings.

### Canvas

`Ctrl`/`⌘` + wheel or a pinch zooms only the canvas. Use the wheel, `Space` + drag or the middle mouse button to pan. Middle-button panning works everywhere except Play mode, where the page may handle it. `Shift 1` fits everything; `F` or `Shift 2` zooms to the selection, including a selected element. `0` resets to 100%. If resizing the window leaves every artboard offscreen, the board fits them into view again.

### Artboards

Drag the label or body in Select mode, with snapping to neighbors (`Alt` disables snapping; `Esc` cancels). Resize handles snap to device widths. Double-click the name or press `R` to rename; double-click the size above an artboard to edit it (`390 × 800`, `1280`, `16:9`). The same fields, aspect-ratio lock and 1:1 · 4:3 · 3:2 · 16:9 · 9:16 buttons are in the inspector. Groups support alignment, distribution and Tidy up.

### Pi

`A` opens the Agent tab's composer. Above the box a context header says what the request is about (*About A space for ideas › #nav*, or the whole board when nothing is selected), and while the conversation is empty three starting points fill the box without sending anything. The context header can wrap without overlapping the input and describes the request field for screen readers. The sidebar tabs adapt to their own row width, even when folded: narrow tabs put the icon and count above the complete label rather than truncating it, without growing the tab row. Breadcrumbs — artboard › container › … › element, with crumb clicks selecting that container — sit bottom centre between the tabs and the toolbar and wrap onto more lines when space is short. The hierarchy lives in Layers, not in the inspector. Layers has two sections: a compact artboard list at the top, showing about seven rows before scrolling and synchronized with canvas selection, and the selected artboard's tree below, starting at its root `main`. Element IDs are editable in the inspector; all references update, but parts of a component used by other frames cannot be renamed. `↵` sends, `⇧ ↵` inserts a newline and `↑` recalls previous requests. Requests queue while Pi is busy. The corner indicator shows the current activity and elapsed time; ■ stops Pi. Replies appear in the Agent tab, where each one has a Copy button; the tab keeps the conversation, History lists the changes it caused.

### Elements

One Select tool (`V`) handles artboards and every element, including the root. Hover highlights an element, click selects it and `Shift` + click adds it to the selection. Drag the page to move its artboard; drag a marquee on empty canvas to select artboards. Double-click edits what is under the pointer: element text, a text segment beside nested elements (such as part of a heading next to a `<span>`), or component-instance text. For images, links and inputs, it focuses the relevant inspector field (`src`, `href`, `placeholder`). `Esc` climbs the tree: element → parent → … → artboard → nothing. The other tool, Play (`P`), lets the page behave normally. `Enter`/`Shift Enter`/`Tab` and arrow keys navigate the tree (↑↓ for siblings, ← for parent, → for child). While editing text, `Tab` saves and moves to the next item; `Enter` in a list item starts the next item (`Ctrl Enter` only saves). `Ctrl G`/`Ctrl Shift G` wraps and unwraps; `Alt ↑/↓` reorders; `Ctrl D` duplicates; `Del` deletes with an Undo toast.

### Clipboard

`Ctrl C` copies selected elements as clean HTML and remembers an exact copy of their structure. `Ctrl V` inserts it inside the selected container or after the selected element, including across frames. External HTML becomes elements, plain text becomes paragraphs, and an image becomes an `<img>` stored in source-relative `assets/`. Pasting copied artboards duplicates them.

### Context menus

Right-click or long-press an artboard, element, layer or empty canvas for Ask Pi, rename, expand, fit height, rotate, duplicate, copy and paste, Copy HTML, Download HTML, make component, go to component, detach instance, change tag, add element and delete.

### Panels

Layers (`L`) provides search, rename, drag-and-drop and a + menu with presets and components; instances and components have distinct markers. History (`H`) lists every change made to the project (by you, Pi or files; the conversation with Pi is in the Agent tab); repeated changes from one gesture, such as nudges or alignment, fold into one ×N entry. Resize panels by dragging their edge; double-click to reset, and the width is remembered. For one or several selected elements, the inspector edits shared fields together: tag, ID, text, **Tailwind classes**, **Layout**, **Spacing**, **Effects**, attributes, inline styles and measured geometry. A class chip shows its color and CSS on hover; click to edit, × to remove, and use `Tab` for suggestions. Unknown classes are underlined. Layout includes display, position, a 3×3 child-alignment grid, separate Justify options (start/center/end, space between/around/evenly, stretch) and Align options (start/center/end, stretch, baseline), plus grid items and columns, 3×3 pinning, direction, wrap, gap and text alignment. Spacing is a compact nested margin/padding diagram with eight independent inputs: each edits only its own side in px, `auto` or percentages, writing classes such as `pt-4` and `pl-[13px]`. Quiet top/right/bottom/left captions identify the sides; M/P marks sit in the bottom-right corners of the corresponding tinted bands. There are no each/pairs/all linking switches. Pointer/focus still highlights the matching canvas band. Effects provides explicitly labelled Opacity, Z-index and Blur fields. Dropdown selector labels and values are vertically centred; labels use stronger contrast than values. Control grids adapt by content rather than one shared minimum: radius and border width remain adjacent, with their presets below; surface controls precede text colour/size/weight. At the desktop inspector's 280px minimum, artboard dimensions and compact controls retain two columns. Longer selectors can wrap inside their own controls, and tighter numeric grids can stack rather than clip values; positioned elements have named Top, Right, Bottom and Left offsets. Attribute controls provide tag-specific shortcuts and name/value suggestions. For an artboard, the inspector shows dimensions, tokens (`--color-brand` creates `bg-brand`) and Custom CSS with formatting and highlighting. The inspector is one vertical flow in a stable section order, without horizontal section tabs. Each section's own header opens or closes it, including with `Enter` or `Space` when focused; collapsed sections are remembered locally. Canvas shortcuts do not consume activation keys on native controls. Images have a preview, Replace… from source-relative `assets/`, Upload and alt text; instances have overrides.

The conversation stacks from the bottom, immediately above the composer/activity plaque: a short exchange stays near the input, and only an exchange taller than the available chat area becomes scrollable. New messages follow automatically while you are near the bottom, including after composer/activity resizing; scrolling up to read or focusing an older message keeps your place until you return to the bottom or send a new request. Folding the pane preserves that reading choice. Your chat messages use a warm sand/amber background in both light and dark themes, distinct from the neutral agent replies and the activity/error accents. While the agent is working, the activity plaque above the composer keeps its indicator and full wrapping description in the upper part, with elapsed time and Stop in a separate footer; Stop stays at the bottom right, including in a narrow panel. It is keyboard-accessible and requests an agent stop without Pi-specific wording. When the agent changes a layout, affected elements briefly highlight. Expanding an artboard with `E` opens the live page across the client viewport, with working links and navigation to the site. On narrow screens, panels become sheets and share the available height.

## Expanded view

A page expanded with `E` shows only its name at the top center; the entire label is a return button (`Esc` does the same). Drag the button anywhere, or use `Alt` + arrow keys while it is focused, to inspect the page underneath. Dragging does not exit expanded view; clicking does. The button stays within the viewport. The DIVLET corner indicator and other panels are hidden in this mode, with their state preserved.

## Open and save from the browser

Click the DIVLET button at the top left to open a menu with **Open project…** (`Ctrl O`), **Save a copy as…** (`Ctrl Shift S`) and Copy project folder path. The dialog lists project files and folders on disk. Existing `.divlet` and `.pen` files appear in the picker. One source opens directly; several open as a collection; an existing empty folder can start `project.divlet` with Create project here. Save a copy copies the selected source and its resources into a new or empty folder, excludes other project sources and generated directories, and rebuilds the copy's pages when it opens. The original is unchanged; destinations inside the project and nonempty folders are rejected with an explanation. If the copied `outputDir` would escape the new folder or reuse the original build, only the copy resets to its default output directory. This works for boards launched through `divlet` or from Pi.

## Settings

Open Settings with the gear in the bottom-right toolbar or `Ctrl ,`. **Build output** shows the selected source file and effective build path. Enter a relative output directory and choose **Apply**; leave it blank or choose **Reset to default** for `.divlet/<source stem>/`. A rejected path or occupied destination leaves the project unchanged and keeps your draft. If another writer changes the project, **Reload current settings** discards the draft and reads the latest version before you retry.

**Interface size** offers 100, 125, 150, 175 or 200% (also adjustable with `Ctrl Alt` + / −). Panels, menus, dialogs, tooltips and artboard labels scale; the canvas does not. Narrow-window layouts use the effective interface width: the window width divided by the interface scale.

## Where projects live

A project is one `<name>.divlet` file. Multiple sources in the same directory are independent projects, with separate boards, versions, history and generated output. Paths passed to the CLI, `/divlet <path>` or `open_divlet` follow these rules:

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

The launcher shows names, frame counts, modification ages and frame names. Names use a known `divlet.name` or the source stem, with no extension-version gate; unknown fields and old marker values remain inert. Summary labels are bounded, malformed-source messages never quote project JSON or credentials, and listing performs no rendering, asset approval or source writes. Counts are not a promise of render/edit readiness; opening the exact source still validates its resources and capabilities. Type a name and press `Enter` to create `<name>.divlet` directly in the collection. It opens only exact source files from its listing. Agent collection results include each project's absolute `file` target for a subsequent `open_divlet` call. A project selected there becomes current for the Pi session; an explicit `projectId` still selects another open project. Named source files use their filename stem in the board tab and project indicator, so sibling projects remain distinguishable; the default `project.divlet` uses its containing folder's name.

### Importing HTML and foreign formats

Static `.html`/`.htm` pages are admitted by the core. Foreign formats use **importer plugins** (`plugins/`, see [architecture](architecture.md)), today Pencil `.pen` and legacy `.divlet` files that still hold PEN sources. Explicitly opening either kind of input creates or reuses `<name>.divlet` beside it and opens that project; the imported bytes are never modified, an existing `<name>.divlet` is never overwritten, and a source that cannot be converted opens as itself with diagnostics. The one path that moves a file is a legacy `.divlet` still holding a PEN source: its bytes go to a free `<name>.pen` and the `.divlet` path then belongs to the converted project. The PEN importer turns every frame into HTML elements with Tailwind classes (an arbitrary-property class such as `[font-family:…]` where no utility exists), color variables into shared tokens and component instances into instances where they differ from their component only by overrides; `metadata.import` records the source, its format and its SHA-256. The generated HTML cache lives in `.divlet/<name>/`, and every later open and edit uses the Divlet project exactly like one made in Divlet.

Projects can be opened and edited at any filesystem location permitted by the OS. Referenced local resources resolve automatically, including absolute paths and files outside the project folder.

## Project files

```text
workspace/
  project.divlet       source: frames, components, shared tokens and CSS
  landing.divlet       another independent project
  assets/              authored images, relative to the source directory
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

Image uploads store new authored inputs under source-relative `assets/` (12 MiB per file) with exclusive, non-overwriting publication.

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
- **Shared styling:** Project tokens and CSS (`patch_divlet` without `frameId`) are visible in every frame. This is where a shared design system belongs.

On the board, use Make component in an element's menu and find components in the + menu (Add element). For an instance, the inspector shows text overrides, Go to, Reset and Detach. Double-clicking text inside an instance creates an override directly.

## Fluid and responsive layouts

An artboard's size is its iframe viewport; ordinary layout rules work inside it: flex, grid, percentages and `clamp()`. Use Tailwind variants (`md:`, `lg:`, `max-[719px]:`) for responsive behavior. Frame CSS is an exception for things classes cannot express, such as `@keyframes` and complex selectors. It lives in the `components` layer, so utility classes take precedence over frame or project CSS. One tree should work at several widths: change `artboard.width` to check it. A 390px frame copy (`frame_divlet duplicate`) uses the same components.

## Use the generated site independently

The active output directory is the build, not an editor cache that needs a second export. It contains frame HTML, Markdown route pages (`index.html`, `guide/start/index.html`, and so on), sidecar metadata and a deduplicated `_assets/` tree. CSS, fonts, images, SVG dependencies and explicitly linked local HTML are copied and rewritten to relative URLs. Authored resources remain beside the source; do not edit the generated copies as canonical assets.

Copy this directory to a static HTTP host, including one that serves it under a URL prefix. Divlet and the source workspace are not required to serve the copied build. Generated pages include compiled Tailwind CSS and no editor bridge or live-update connection. External URLs remain external; third-party resources still require their original hosts. Missing local resources produce `MISSING_ASSET` diagnostics and cannot work until the source resource is supplied.

Resource-only edits and Markdown changes refresh the build without changing frame versions. Invalid Markdown retains the last accepted site. Frame and route output names must not collide. Private/hidden files, `.divlet` sources, metadata, generated trees, escaping paths and symlink resources are not build inputs. An output directory cannot contain the authored resources or Markdown files it consumes.

Ownership checks and a `.divlet-write.lock` protect output writes across processes. If a writer crashes, stop that writer before manually removing its stale lock; do not remove the lock while another process is building. Keep `.trash` and the ownership manifest in your working build if you need preserved edits or further managed rebuilds.

## Keyboard shortcut reference

**Keyboard shortcuts** have a separate read-only window: `?` or `Ctrl K` → Keyboard shortcuts. Settings contains only preferences such as theme and interface size. The left panel grows with its content up to a maximum height, then scrolls.

For Markdown routes and template slots, see [Markdown sites](site.md).
