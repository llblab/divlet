/*
 * Owns: the optional WebMCP surface — the same canonical tool registry registered with a browser's `document.modelContext`
 * when, and only when, the browser actually provides it. Excludes: feature emulation (nothing is installed on `document` when
 * the API is missing), a second tool list or a second execution path.
 *
 * Shape follows the WebMCP Community Group draft (12 November 2026): `registerTool(tool, { signal })`, where aborting the
 * signal unregisters, and `execute(input, { signal })` resolving to a JSON-serializable value. The draft defines tools only;
 * MCP resources and prompts have no WebMCP counterpart here.
 */
import type { ToolRegistry } from './mcp-tools.ts';

interface WebMcpToolInit {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean };
  execute(input: object, options: { signal: AbortSignal }): Promise<unknown>;
}

/** The part of the draft's `ModelContext` this adapter uses. */
export interface WebMcpModelContext {
  registerTool(tool: WebMcpToolInit, options?: { signal?: AbortSignal }): Promise<unknown> | unknown;
}

const isModelContext = (value: unknown): value is WebMcpModelContext => !!value && typeof (value as any).registerTool === 'function';

/**
 * Register every tool of `registry` with WebMCP. Resolves to the names that registered (an empty list when the browser has no
 * `document.modelContext`, for example outside a secure context) and a function that unregisters them. Failures of individual
 * registrations are reported, never thrown: WebMCP is a compatibility surface, not a requirement.
 */
export async function registerWebMcpTools(registry: ToolRegistry, context: unknown = (globalThis as any).document?.modelContext): Promise<{ registered: string[]; failed: Array<{ name: string; message: string }>; unregister: () => void }> {
  const controller = new AbortController();
  const unregister = () => controller.abort();
  if (!isModelContext(context)) return { registered: [], failed: [], unregister };
  const registered: string[] = [], failed: Array<{ name: string; message: string }> = [];
  for (const descriptor of registry.descriptors) {
    const readOnly = descriptor.annotations?.readOnlyHint === true;
    const init: WebMcpToolInit = {
      name: descriptor.name,
      ...(descriptor.title ? { title: descriptor.title } : {}),
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      annotations: { readOnlyHint: readOnly, consequentialHint: !readOnly && descriptor.annotations?.destructiveHint !== false },
      async execute(input, options) {
        const outcome = await registry.run(descriptor.name, input, { signal: options?.signal });
        if (outcome.ok) return outcome.value;
        throw Object.assign(new Error(`${outcome.error.code}: ${outcome.error.message}`), { code: outcome.error.code });
      },
    };
    try { await context.registerTool(init, { signal: controller.signal }); registered.push(descriptor.name); }
    catch (error) { failed.push({ name: descriptor.name, message: String((error as Error)?.message || error) }); }
  }
  return { registered, failed, unregister };
}
