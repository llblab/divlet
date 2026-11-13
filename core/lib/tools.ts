/*
 * Owns: the portable half of the capability contract — the host-neutral parameter schema and its JSON Schema/TypeBox
 * renderings, the agent result vocabulary, the runtime interface a tool runs against and the canonical tool list. Excludes:
 * sessions, board discovery and anything that needs Node; `contract.ts` adds those and re-exports this module, so every host
 * (Pi, MCP, CLI, the browser board) describes and runs the same tools from this one list.
 */

/* ---- parameters: one description, rendered per host ------------------------------------------------ */

/**
 * The host-neutral schema. A tool's parameters are written once in this form; each host renders it — Pi as TypeBox, MCP as
 * JSON Schema — so a plugin or adapter that adds a tool describes it here and nowhere else.
 */
interface SchemaBase { optional?: boolean; description?: string }
export type Schema =
  | (SchemaBase & { kind: 'string'; maxLength?: number; minLength?: number })
  | (SchemaBase & { kind: 'integer'; minimum?: number; maximum?: number })
  | (SchemaBase & { kind: 'number'; minimum?: number; maximum?: number })
  | (SchemaBase & { kind: 'boolean' })
  | (SchemaBase & { kind: 'oneOf'; values: readonly string[] })
  | (SchemaBase & { kind: 'object'; properties: Record<string, Schema> | null })
  | (SchemaBase & { kind: 'array'; items: Schema; maxItems?: number })
  | (SchemaBase & { kind: 'union'; variants: Schema[] })
  | (SchemaBase & { kind: 'any' })
  | (SchemaBase & { kind: 'null' });
/** One tool's parameters, by name. */
export type ToolParameters = Record<string, Schema>;
/** JSON Schema as a host asks for it (the shape MCP `tools/list` answers). */
export type JsonSchema = Record<string, any>;

/** A host-neutral schema: the tool list is written once, Pi and MCP render it. */
export const S = {
  string: (options: Omit<Extract<Schema, { kind: 'string' }>, 'kind'> = {}): Schema => ({ kind: 'string', ...options }),
  integer: (options: Omit<Extract<Schema, { kind: 'integer' }>, 'kind'> = {}): Schema => ({ kind: 'integer', ...options }),
  number: (options: Omit<Extract<Schema, { kind: 'number' }>, 'kind'> = {}): Schema => ({ kind: 'number', ...options }),
  boolean: (options: Omit<Extract<Schema, { kind: 'boolean' }>, 'kind'> = {}): Schema => ({ kind: 'boolean', ...options }),
  /** One of a fixed set of strings. */
  oneOf: (values: readonly string[], options: Omit<Extract<Schema, { kind: 'oneOf' }>, 'kind' | 'values'> = {}): Schema => ({ kind: 'oneOf', values, ...options }),
  /** An object with these properties (`null` shape: any object). */
  object: (properties: Record<string, Schema> | null = null, options: Omit<Extract<Schema, { kind: 'object' }>, 'kind' | 'properties'> = {}): Schema => ({ kind: 'object', properties, ...options }),
  array: (items: Schema, options: Omit<Extract<Schema, { kind: 'array' }>, 'kind' | 'items'> = {}): Schema => ({ kind: 'array', items, ...options }),
  union: (variants: Schema[], options: Omit<Extract<Schema, { kind: 'union' }>, 'kind' | 'variants'> = {}): Schema => ({ kind: 'union', variants, ...options }),
  any: (options: Omit<Extract<Schema, { kind: 'any' }>, 'kind'> = {}): Schema => ({ kind: 'any', ...options }),
};
export const optional = (schema: Schema): Schema => ({ ...schema, optional: true });
export const nullable = (schema: Schema): Schema => ({ kind: 'union', variants: [schema, { kind: 'null' }] });

/** A JSON Schema property for one parameter (the shape MCP asks for). */
export function propertySchema(schema: Schema): JsonSchema {
  switch (schema.kind) {
    case 'string': return { type: 'string', ...(schema.maxLength ? { maxLength: schema.maxLength } : {}), ...(schema.minLength ? { minLength: schema.minLength } : {}), ...(schema.description ? { description: schema.description } : {}) };
    case 'integer': return { type: 'integer', ...(schema.minimum !== undefined ? { minimum: schema.minimum } : {}), ...(schema.maximum !== undefined ? { maximum: schema.maximum } : {}), ...(schema.description ? { description: schema.description } : {}) };
    case 'number': return { type: 'number', ...(schema.minimum !== undefined ? { minimum: schema.minimum } : {}), ...(schema.maximum !== undefined ? { maximum: schema.maximum } : {}), ...(schema.description ? { description: schema.description } : {}) };
    case 'boolean': return { type: 'boolean', ...(schema.description ? { description: schema.description } : {}) };
    case 'oneOf': return { type: 'string', enum: schema.values, ...(schema.description ? { description: schema.description } : {}) };
    case 'object': {
      if (schema.properties === null) return { type: 'object', additionalProperties: true, ...(schema.description ? { description: schema.description } : {}) };
      const shape = Object.fromEntries(Object.entries(schema.properties).map(([name, item]) => [name, propertySchema(item)]));
      const required = Object.entries(schema.properties).filter(([, item]) => !item.optional).map(([name]) => name);
      return { type: 'object', properties: shape, ...(required.length ? { required } : {}), additionalProperties: false, ...(schema.description ? { description: schema.description } : {}) };
    }
    case 'array': return { type: 'array', items: propertySchema(schema.items), ...(schema.maxItems !== undefined ? { maxItems: schema.maxItems } : {}), ...(schema.description ? { description: schema.description } : {}) };
    case 'null': return { type: 'null' };
    case 'union': return { anyOf: schema.variants.map(propertySchema), ...(schema.description ? { description: schema.description } : {}) };
    default: return schema.description ? { description: schema.description } : {};
  }
}

/** The `inputSchema` of a tool for MCP (`tools/list`). */
export function inputSchema(tool: Tool): JsonSchema {
  const shape = Object.fromEntries(Object.entries(tool.parameters).map(([name, schema]) => [name, propertySchema(schema)]));
  const required = Object.entries(tool.parameters).filter(([, schema]) => !schema.optional).map(([name]) => name);
  return { type: 'object', properties: shape, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** The subset of TypeBox a host needs to render the schema; the Pi adapter passes the real module. */
export interface TypeBoxApi {
  String(options?: Record<string, unknown>): unknown;
  Integer(options?: Record<string, unknown>): unknown;
  Number(options?: Record<string, unknown>): unknown;
  Boolean(options?: Record<string, unknown>): unknown;
  Literal(value: string): unknown;
  Union(items: unknown[]): unknown;
  Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  Record(key: unknown, value: unknown): unknown;
  Array(items: unknown, options?: Record<string, unknown>): unknown;
  Null(): unknown;
  Unknown(): unknown;
  Optional(item: unknown): unknown;
}

/** The same schema as TypeBox types, for the Pi extension. */
export function toTypeBox(schema: ToolParameters, Type: TypeBoxApi): unknown {
  const convert = (item: Schema): unknown => {
    let next;
    switch (item.kind) {
      case 'string': next = Type.String({ ...(item.maxLength ? { maxLength: item.maxLength } : {}), ...(item.description ? { description: item.description } : {}) }); break;
      case 'integer': next = Type.Integer({ ...(item.minimum !== undefined ? { minimum: item.minimum } : {}), ...(item.maximum !== undefined ? { maximum: item.maximum } : {}), ...(item.description ? { description: item.description } : {}) }); break;
      case 'number': next = Type.Number({ ...(item.minimum !== undefined ? { minimum: item.minimum } : {}), ...(item.maximum !== undefined ? { maximum: item.maximum } : {}), ...(item.description ? { description: item.description } : {}) }); break;
      case 'boolean': next = Type.Boolean({ ...(item.description ? { description: item.description } : {}) }); break;
      case 'oneOf': next = Type.Union(item.values.map(value => Type.Literal(value))); break;
      case 'object': next = item.properties === null ? Type.Record(Type.String(), Type.Unknown()) : Type.Object(Object.fromEntries(Object.entries(item.properties).map(([name, child]) => [name, convert(child)])), { additionalProperties: false }); break;
      case 'array': next = Type.Array(convert(item.items), { ...(item.maxItems !== undefined ? { maxItems: item.maxItems } : {}) }); break;
      case 'null': next = Type.Null(); break;
      case 'union': next = Type.Union(item.variants.map(convert)); break;
      default: next = Type.Unknown(); break;
    }
    return item.optional ? Type.Optional(next) : next;
  };
  return Type.Object(Object.fromEntries(Object.entries(schema).map(([name, item]) => [name, convert(item)])));
}

/* ---- results: one vocabulary for every host -------------------------------------------------------- */

const RENAMED: Record<string, string> = { documentId: 'frameId', documentIds: 'frameIds', documents: 'frames', document: 'frame' };
const VERBATIM = new Set(['nodes', 'descendants', 'metadata', 'tokens', 'assets', 'variables', 'theme', 'attrs', 'style', 'frontmatter', 'config']);
export const LARGE_FRAME_BYTES = 60_000;

/** Rename document → frame in tool results, leaving user data (node maps, metadata…) untouched. */
export function forAgent(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map(item => forAgent(item));
  if (!value || typeof value !== 'object' || (key !== undefined && VERBATIM.has(key))) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [RENAMED[name] ?? name, forAgent(item, name)]));
}

/** The project view for an agent: what it needs to choose a frame, without file paths and without one line per use. */
export function compactProject(info: any): any {
  if (!Array.isArray(info?.documents)) return info;
  const { documents, clientPlugins, stateVersion, ...rest } = info;
  return {
    ...rest,
    documents: (documents as any[]).map(({ id, name, version, artboard, instances, uses, usedBy, components, metadata }) => ({
      id, name, version, artboard, instances,
      ...(components?.length ? { components } : {}),
      ...(uses?.length ? { usesFramesOf: [...new Set((uses as unknown[]).map(ref => String(ref).split('/')[0]))], componentUses: uses.length } : {}),
      ...(usedBy?.length ? { usedBy } : {}),
      ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
    })),
  };
}

/** Components with their name and overridable texts, only the first few places used and a count. */
export function compactComponents(result: any): any {
  if (!Array.isArray(result?.components)) return result;
  return {
    ...result,
    components: (result.components as any[]).map(component => {
      const places = Array.isArray(component.instances) ? component.instances : [];
      if (places.length <= 5) return component;
      return { ...component, instances: places.slice(0, 5), instanceCount: places.length, instancesNote: 'Only the first 5 places are listed; read a frame (view:nodes, query) to find the others.' };
    }),
  };
}

/** An outline of a frame model: ids, tags, names and the start of text, three levels deep, with counts where it is cut. */
export function outlineOf(model: any, bytes: number): Record<string, unknown> {
  const nodes = model.nodes || {};
  const walk = (id: string, depth: number): Record<string, any> | null => {
    const node = nodes[id];
    if (!node) return null;
    if (node.type === 'text') return { id, text: String(node.content || '').slice(0, 40) };
    if (node.type === 'ref') return { id, ref: node.ref };
    const entry: Record<string, any> = { id, tag: node.tag };
    if (node.metadata?.name) entry.name = node.metadata.name;
    const kids = node.children || [];
    if (depth >= 3) { if (kids.length) entry.children = kids.length; return entry; }
    entry.children = kids.slice(0, 12).map((child: string) => walk(child, depth + 1)).filter(Boolean);
    if (kids.length > 12) entry.more = kids.length - 12;
    return entry;
  };
  return {
    documentId: model.id, version: model.version, name: model.name, artboard: model.artboard, large: true, bytes, nodes: Object.keys(nodes).length,
    outline: walk(model.rootId, 0),
    hint: `This frame is large (${Math.round(bytes / 1000)} KB). Read parts with view:nodes (ids, query, depth) or pass full:true to get the whole model.`,
  };
}

/* ---- the tools ------------------------------------------------------------------------------------ */

const VIEWS = ['project', 'frame', 'nodes', 'components', 'selection', 'preview', 'diagnostics', 'site', 'history'];
const FRAME_ACTIONS = ['create', 'duplicate', 'delete'];
const EDIT_OPS = ['insert', 'move', 'duplicate', 'remove', 'text', 'wrap', 'unwrap', 'detach', 'rename'];

/* ---- the contract's own types ---------------------------------------------------------------------- */

/** What a tool may ask of the board it runs on. `any` results are the runtime's own shapes, shaped for agents below. */
export interface BoardRuntime {
  info(): any;
  read(query: Record<string, unknown>): any;
  patch(args: Record<string, unknown>): Promise<any>;
  edit(args: Record<string, unknown>): Promise<any>;
  undo(args: Record<string, unknown>): Promise<any>;
  redo(args: Record<string, unknown>): Promise<any>;
  create(args: Record<string, unknown>): Promise<any>;
  getEntry(documentId: string): any;
  render(documentId: string): any;
  createArtboard(args: Record<string, unknown>): Promise<any>;
  removeDocument(args: Record<string, unknown>): Promise<any>;
  frame(args: Record<string, unknown>): Promise<any>;
  mark(args: Record<string, unknown>): any;
  close(): Promise<void>;
  [key: string]: any;
}
/** The context a tool runs with: the board that owns the project. */
export interface ToolContext { runtime: BoardRuntime }
/** One capability: named, described and parameterised once, rendered by every host. */
export interface Tool {
  name: string;
  /** Short human title (absent on hidden tools). */
  title?: string;
  kind: 'open' | 'runtime';
  description: string;
  /** One line a host may advertise instead of the description. */
  snippet?: string;
  hidden?: boolean;
  parameters: ToolParameters;
  /** Absent for `open_divlet`, which the session handles itself. */
  run?(context: ToolContext, params: any): any;
}
/** A runtime is required for every tool but `open_divlet`; the session resolves it before running one. */
export const TOOLS: Tool[] = [
  {
    name: 'open_divlet',
    title: 'Open divlet',
    kind: 'open',
    description: 'Open a layout project and start its local board: returns the board URL, the project version and the frames with their versions. A project is one .divlet file holding every frame (HTML elements with Tailwind classes), component, shared token and CSS; generated pages live in .divlet/<name>/. path may be a .divlet file, an importable foreign file (an existing .pen is converted once into the sibling .divlet, which is what opens; the source is never modified) or a folder/collection; collections return projects with absolute file targets and a launcher URL, and a project is selected by passing its file as path. An empty folder creates a Divlet project.divlet; createDemo controls its starter frame (false leaves zero frames). Without path the current directory is used. Reuses an open project — including one another client already opened. Optionally add a frame with document (a frame model) without overwriting an existing one.',
    snippet: 'Open a divlet layout project and get its board URL. Load the divlet skill for the workflow.',
    parameters: {
      path: optional(S.string({ description: 'Project .divlet file (or a foreign file an importer plugin converts, such as a .pen or a static .html page) or collection folder, relative to the client\'s working directory; defaults to it.' })),
      cwd: optional(S.string({ description: 'Same as path (older name).' })),
      port: optional(S.integer({ minimum: 0, maximum: 65535 })),
      createDemo: optional(S.boolean({ description: 'Seed a starter frame only when an ordinary source is missing. Default true; false creates an empty Divlet project.' })),
      document: optional(S.object()),
    },
  },
  {
    name: 'read_divlet',
    title: 'Read divlet',
    kind: 'runtime',
    description: 'Read the project. view:project (default) lists frames with versions and sizes, which frames provide the components each one uses (view:components lists the components) and the shared state; view:frame returns one frame model; view:nodes returns nodes of a frame (ids, query, depth, limit) with parent and ancestors; view:components lists every component as "frameId/nodeId" with its name, the text node IDs an instance can override and where it is used; view:selection is what the user selected on the board; view:preview is measured geometry of the rendered page (node rects, overflow flags, contentHeight); view:history is the action log (since = sequence number); view:diagnostics lists file problems; view:site describes the Markdown site (route = one composed page). Read a frame before patching it.',
    snippet: 'Inspect frames, nodes, components, the user selection and rendered geometry.',
    parameters: {
      projectId: optional(S.string()),
      view: optional(S.oneOf(VIEWS)),
      frameId: optional(S.string({ description: 'Frame to read; defaults to the selected or first frame.' })),
      since: optional(S.integer({ minimum: 0, description: 'For view:history, only return changes with a higher seq.' })),
      route: optional(S.string({ description: 'For view:site, a site path such as /guide/start/; omit to inspect the site configuration and content tree.' })),
      ids: optional(S.array(S.string(), { maxItems: 100 })),
      query: optional(S.string({ description: 'Case-insensitive node id, tag, text, class or metadata search.' })),
      depth: optional(S.integer({ minimum: 0, maximum: 8 })),
      limit: optional(S.integer({ minimum: 1, maximum: 100 })),
      full: optional(S.boolean({ description: 'For view:frame: return the whole model even when the frame is large (otherwise a large frame comes back as an outline).' })),
    },
    run({ runtime }: ToolContext, params: any) {
      const { projectId, frameId, view, full, ...query } = params;
      const result = runtime.read({ ...query, view: view === 'frame' ? 'document' : view, documentId: frameId });
      if (!view || view === 'project') return compactProject(result);
      if (view === 'components') return compactComponents(result);
      if (view === 'frame' && !full) {
        const bytes = JSON.stringify(result).length;
        if (bytes > LARGE_FRAME_BYTES) return outlineOf(result, bytes);
      }
      return result;
    },
  },
  {
    name: 'patch_divlet',
    title: 'Patch divlet',
    kind: 'runtime',
    description: 'Apply one atomic, validated partial patch. With frameId: patch that frame (name, head, artboard, nodes, tokens, css, metadata) at its current expectedVersion; nodes are addressed by stable IDs. Without frameId: patch the project (name, tokens, css, metadata, outputDir, assets) at its version. For frame patches objects merge, arrays replace and null removes a property or node. A node accepts tag, className, attrs, style, metadata and text content (a text node: content). Declare styles per element with nodes.<id>.styles = {padding-top:16px, color:#fff, font-family:Inter} as a JSON object of CSS property to value: each property becomes a Tailwind utility (an arbitrary-property class when no utility exists) and replaces the class that set it earlier; null removes it; no Tailwind knowledge needed. Or write Tailwind utilities in className directly (compiled locally; arbitrary values and variants work, for example bg-[#14121c] md:px-10 hover:underline). Tokens named --color-*, --font-*, --breakpoint-* become theme classes (--color-brand gives bg-brand); css is for what utilities cannot express. The result lists warnings, e.g. classes that do nothing. Components: set reusable:true on an element; an instance is a node { type: ref, ref: frameId/nodeId, descendants: { componentNodeId: { content|text|className|style|attrs|tag } } }; editing a component re-renders every frame that uses it. For inserting, moving, wrapping or removing nodes, edit_divlet is simpler.',
    snippet: 'Atomically change a frame or the shared project tokens/CSS by stable IDs.',
    parameters: {
      projectId: optional(S.string()),
      frameId: optional(S.string({ description: 'Frame to patch. Omit to patch project-level name, tokens, css, metadata, assets or outputDir (null resets its default).' })),
      expectedVersion: S.integer({ minimum: 1, description: 'Current version of the frame (or of the project when frameId is omitted).' }),
      label: optional(S.string({ maxLength: 200, description: 'Short intent shown in the undo menu and action log.' })),
      patch: S.object({
        name: optional(nullable(S.string())),
        head: optional(S.any({ description: 'Frame head patch: description (string, at most 2048 characters), icon (safe URL); objects merge and null removes fields or the whole head.' })),
        artboard: optional(S.object()),
        rootId: optional(S.string()),
        nodes: optional(S.object()),
        tokens: optional(S.object(null, { description: 'CSS custom properties. Tailwind theme names (--color-*, --font-*, --text-*, --radius-*, --shadow-*, --breakpoint-*, --spacing) also create classes.' })),
        css: optional(nullable(S.string({ description: 'Custom CSS — the exception: @keyframes, complex selectors, third-party content. Everything else goes into className.' }))),
        metadata: optional(nullable(S.object())),
        outputDir: optional(nullable(S.string({ description: 'Project-only relative build directory; null resets the source-stem default.' }))),
        assets: optional(nullable(S.object(null, { description: 'Project-only hierarchical resource patch: directories contain canonical base64 Data-URL leaves; null removes a leaf/directory or resets the whole tree. Reference exact declared paths with asset: URIs; read project.resources for payload-free descriptions.' }))),
      }),
    },
    async run({ runtime }: ToolContext, params: any) {
      const { projectId, frameId, ...change } = params;
      if (!frameId) return runtime.patchProject({ ...change, actor: 'agent' });
      return runtime.patch({ ...change, documentId: frameId, actor: 'agent' });
    },
  },
  {
    name: 'edit_divlet',
    title: 'Edit divlet',
    kind: 'runtime',
    description: 'Apply one operation to a frame by stable node IDs: insert (a preset, spec, html fragment or component instance), move, duplicate, remove, text, wrap, unwrap, detach (turn an instance into ordinary elements) or rename. Pass expectedVersion from the frame you read and a short label. Insert accepts spec (a node spec: tag, className, text, attrs, style, children, or ref for an instance), or html (a foreign fragment; classes, inline styles and safe attributes are kept; scripts and handlers are dropped; native asset references require spec instead); place with parentId plus index, after or before.',
    snippet: 'Insert elements, HTML or component instances; move, duplicate, wrap, unwrap, retext, detach, rename or remove nodes by ID.',
    parameters: {
      projectId: optional(S.string()),
      frameId: S.string(),
      expectedVersion: S.integer({ minimum: 1 }),
      label: optional(S.string({ maxLength: 200, description: 'Short intent shown in the undo menu and action log.' })),
      op: S.object({
        type: S.oneOf(EDIT_OPS),
        id: optional(S.string()),
        ids: optional(S.array(S.string(), { maxItems: 200 })),
        parentId: optional(S.string()),
        index: optional(S.integer({ minimum: 0 })),
        after: optional(S.string({ description: 'Place right after this sibling node.' })),
        before: optional(S.string({ description: 'Place right before this sibling node.' })),
        spec: optional(S.union([S.string(), S.object(), S.array(S.union([S.string(), S.object()]), { maxItems: 100 })], { description: 'Node spec(s) to insert: { preset|tag, className, text, attrs, style, children, ref (an instance of a component) }, or a preset/tag name.' })),
        content: optional(S.string()),
        to: optional(S.string({ description: 'For rename: the new node ID (a letter first, then letters, digits, - _ . : ).' })),
        html: optional(S.string({ maxLength: 524288, description: 'For insert: a foreign HTML fragment instead of spec (classes, inline styles and safe attributes are kept; scripts and handlers are dropped). Use a native spec, not HTML, to reference declared project assets.' })),
      }),
    },
    async run({ runtime }: ToolContext, params: any) {
      const { projectId, frameId, ...change } = params;
      return runtime.edit({ ...change, documentId: frameId, actor: 'agent' });
    },
  },
  {
    name: 'frame_divlet',
    title: 'Frames of divlet',
    kind: 'runtime',
    description: 'Create, duplicate or delete a frame (an artboard on the board: one page or screen at a viewport width). create: a blank frame (name, width, height; placed beside the others unless x/y are given) — fill it with edit_divlet. duplicate: a copy of frameId (optionally renamed or resized, e.g. width 390 for a phone); component reference targets remain shared. delete: remove frameId (refused while other frames use its components).',
    snippet: 'Create, duplicate or delete frames (artboards).',
    parameters: {
      projectId: optional(S.string()),
      action: S.oneOf(FRAME_ACTIONS),
      expectedVersion: optional(S.integer({ minimum: 1, description: 'Current version of the frame being duplicated or deleted (not needed for create).' })),
      frameId: optional(S.string({ description: 'For duplicate and delete: the frame to use.' })),
      name: optional(S.string({ maxLength: 512 })),
      width: optional(S.number({ minimum: 1, maximum: 16384, description: 'Viewport width in CSS px: 390 phone, 768 tablet, 1280 laptop, 1440 desktop.' })),
      height: optional(S.number({ minimum: 1, maximum: 16384 })),
      x: optional(S.number()),
      y: optional(S.number()),
      label: optional(S.string({ maxLength: 200 })),
    },
    async run({ runtime }: ToolContext, params: any) {
      const { action, frameId, expectedVersion, name, width, height, x, y, label } = params;
      if (action === 'delete') {
        if (!frameId) throw Object.assign(new Error('frame_divlet delete needs frameId.'), { code: 'INVALID_ARGUMENT' });
        return runtime.removeDocument({ documentId: frameId, expectedVersion, actor: 'agent', label });
      }
      if (action === 'duplicate' && !frameId) throw Object.assign(new Error('frame_divlet duplicate needs frameId.'), { code: 'INVALID_ARGUMENT' });
      const result = await runtime.createArtboard({ name, width, height, x, y, from: action === 'duplicate' ? frameId : undefined, expectedVersion, actor: 'agent', label });
      return { ...result, frame: (runtime.info().documents as any[]).find((doc: any) => doc.id === result.documentId) };
    },
  },
  {
    name: 'undo_divlet',
    title: 'Undo divlet',
    kind: 'runtime',
    description: 'Undo (or redo) the most recent accepted change, optionally only the latest one of a frame. Undo applies the inverse patch, so later unrelated edits stay intact; it fails with CANNOT_UNDO when later changes touched the same content.',
    snippet: 'Undo or redo the latest layout change.',
    parameters: { projectId: optional(S.string()), frameId: optional(S.string()), redo: optional(S.boolean()) },
    run({ runtime }: ToolContext, params: any) {
      return (params.redo ? runtime.redo : runtime.undo).call(runtime, { documentId: params.frameId, actor: 'agent' });
    },
  },
  {
    name: 'mark_divlet',
    title: 'Mark divlet work area',
    kind: 'runtime',
    description: 'Tell the user where you are about to work: the board animates the area until your turn ends (or you clear it), so they see what is being worked on and why. Call it before a non-trivial change or a long stretch of planning. frameId alone marks the whole frame; nodeIds marks elements inside it (any depth). note is a short human sentence (“restyling the pricing cards”) shown in the agent indicator. A new call replaces earlier marks unless add is true; clear: true removes them. It changes nothing in the project.',
    snippet: 'Announce the frame or elements you are working on; the board animates them.',
    parameters: {
      projectId: optional(S.string()),
      frameId: optional(S.string({ description: 'Frame to mark (required unless clear).' })),
      nodeIds: optional(S.array(S.string(), { maxItems: 50, description: 'Elements to mark; omit to mark the whole frame.' })),
      note: optional(S.string({ maxLength: 120, description: 'What you are about to do, in a few words.' })),
      add: optional(S.boolean({ description: 'Keep earlier marks instead of replacing them.' })),
      clear: optional(S.boolean({ description: 'Remove marks (of frameId, or all).' })),
    },
    run({ runtime }: ToolContext, params: any) {
      if (params.clear) return runtime.clearWork({ documentId: params.frameId });
      if (!params.frameId) throw Object.assign(new Error('mark_divlet needs frameId (or clear: true).'), { code: 'INVALID_ARGUMENT' });
      return runtime.markWork({ documentId: params.frameId, nodeIds: params.nodeIds, note: params.note, add: params.add });
    },
  },
  {
    // Not listed for hosts: it carries the frame model of `open_divlet { document }` to the owning board.
    name: 'create_frame',
    hidden: true,
    kind: 'runtime',
    description: 'Add a frame from a full frame model to the project that owns this board.',
    parameters: { document: S.object() },
    run({ runtime }: ToolContext, params: any) {
      if (!params?.document || typeof params.document !== 'object') throw Object.assign(new Error('create_frame needs a frame document.'), { code: 'INVALID_ARGUMENT' });
      return runtime.create({ document: params.document });
    },
  },
];

export const toolByName: ReadonlyMap<string, Tool> = new Map(TOOLS.map(tool => [tool.name, tool]));
export const toolList = ({ hidden = false }: { hidden?: boolean } = {}): Tool[] => TOOLS.filter(tool => hidden || !tool.hidden);
export const toolNames: Set<string> = new Set(TOOLS.map(tool => tool.name));

/** Run one runtime tool against a board's runtime (used by the session and by the board's own api/tool route). */
export async function runOnRuntime(name: string, args: unknown, runtime: BoardRuntime): Promise<any> {
  const tool = toolByName.get(name);
  if (!tool || tool.hidden || tool.kind !== 'runtime' || !tool.run) throw Object.assign(new Error(`A board cannot run the tool ${name}.`), { code: 'UNKNOWN_TOOL' });
  return tool.run({ runtime }, args ?? {});
}
