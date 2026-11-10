/*
 * The Pi adapter. Pi itself, its skill, its command, its agent bridge and its launcher behaviour live here; the operations are
 * the shared contract in `core/lib/contract.ts`, so an MCP client gets the same semantics, validation and revision checks.
 *
 * A Pi session is one client of the boards: it opens a project (or attaches to the board another client already owns), and it
 * mirrors the agent's state on every board it opened. Nothing starts at import time beyond registering with Pi.
 */
import path from 'node:path';
import { Type } from 'typebox';
import { fileURLToPath } from 'node:url';
import { compactComponents, compactProject, createSession, forAgent, openView, toTypeBox, toolList } from '../../../core/lib/contract.ts';
import { makeHost } from '../../../core/lib/launch.ts';
import { openRuntime } from '../../../core/lib/runtime.js';

// The skill belongs to the product, not to this adapter: it lives at the package root so any host can load it.
const SKILL_DIR = fileURLToPath(new URL('../../../skills/divlet', import.meta.url));
const DIVLET_TOOLS = new Set(toolList().map((tool) => tool.name));
const TOOL_ACTIVITY = { read_divlet: 'reading', patch_divlet: 'editing', edit_divlet: 'editing', undo_divlet: 'undoing', open_divlet: 'opening the board', mark_divlet: 'planning', frame_divlet: 'editing' };

/** Text of the last assistant message in a run (string content or text blocks). */
export function lastAssistantText(messages) {
  for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
    if (message?.role !== 'assistant') continue;
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n') : '';
    if (text.trim()) return text.trim();
  }
  return '';
}

export { compactComponents, compactProject, forAgent };

export default function divletExtension(pi) {
  /** The directory of the client that last used a tool: a board-driven open retargets it (the launcher's pick is a choice). */
  let lastCwd = null;
  const hubs = new Map();
  const opening = new Map();
  const seen = new Map();
  /* Agents see one vocabulary, the one of the project file: frames (not documents). */
  const reply = (value) => { const shown = forAgent(value); return { content: [{ type: 'text', text: JSON.stringify(shown, null, 2) }], details: shown }; };

  /* Pi on the board: requests typed in the browser become user messages; the agent's
     state, current tool and final answer are mirrored back to every open board. */
  const agent = { busy: false, activity: null, lastCtx: null, run: null, pending: [], idleTimer: 0 };
  const session = createSession({
    cwd: process.cwd(),
    openBoard: async ({ file, args = {} }) => {
      // One board per project file in this process; it registers itself so other clients attach to it.
      const key = path.resolve(file);
      if (session.runtimes.has(key)) return session.runtimes.get(key);
      if (!opening.has(key)) {
        opening.set(key, openRuntime({ file: key, cwd: args.cwd, port: args.port ?? 0, createDemo: args.createDemo ?? true, externalFiles: args.externalFiles })
          .then((runtime) => {
            runtime.host = makeHost({ openBoard: (location) => hostOpenBoard(location), hubs });
            // Opening a project (from a tool or from the launcher) makes it the project this Pi directory works on.
            session.activate(lastCwd ?? session.cwd, key);
            return runtime;
          })
          .finally(() => opening.delete(key)));
      }
      return opening.get(key);
    },
    onRuntime: runtime => attach(runtime),
  });
  const broadcast = (patch) => { for (const runtime of session.runtimes.values()) runtime.setAgent(patch); };

  /** The board opener `launch` and the boards ask for: one project file, or a host-driven open from a board. */
  async function hostOpenBoard(location, args = {}, cwd) {
    const opened = await session.call('open_divlet', { path: location.file, ...(location.externalFiles ? { externalFiles: location.externalFiles } : {}) }, { cwd: cwd ?? lastCwd ?? session.cwd });
    if (opened.kind === 'collection') return { info: () => ({ url: opened.launcher }) };
    session.activate(cwd ?? lastCwd ?? session.cwd, opened.info.project.file);
    return { info: () => opened.info };
  }

  /** Thinking levels Pi accepts, in the order the board lists them; the host clamps what a model cannot do. */
  const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  /**
   * What this host can change about the session that answers the board — something an MCP client cannot offer at all. The board
   * shows these as two chips and hides them when they are null; `model.options` is the scoped list when the session scopes
   * models, else a bounded slice of what is available, and `value` is `provider/id`.
   */
  function controls(ctx) {
    const model = ctx?.model;
    const scoped = (ctx?.scopedModels || []).map((entry) => entry.model);
    const available = scoped.length ? scoped : (() => { try { return ctx?.modelRegistry?.getAvailable?.() ?? []; } catch { return []; } })();
    const options = available.slice(0, 40).map((item) => ({ id: `${item.provider}/${item.id}`, label: item.id }));
    const current = model ? `${model.provider}/${model.id}` : null;
    if (current && !options.some((option) => option.id === current)) options.unshift({ id: current, label: model.id });
    return {
      model: options.length ? { value: current ?? options[0].id, options } : null,
      thinking: { value: pi.getThinkingLevel?.() ?? 'off', options: THINKING },
    };
  }
  const repaintControls = (ctx) => {
    const next = controls(ctx ?? agent.lastCtx);
    for (const runtime of session.runtimes.values()) runtime.setAgent({ controls: next });
  };

  function attach(runtime) {
    runtime.setAgent({ connected: true, busy: agent.busy, activity: agent.activity, controls: controls(agent.lastCtx) });
    runtime.on('ask', ({ message, seq }) => {
      if (agent.run) agent.run.asks.push({ runtime, seq });
      else (agent.pending ??= []).push({ runtime, seq });
      pi.sendUserMessage(message, { deliverAs: 'followUp' });
    });
    runtime.on('stop', () => { try { agent.lastCtx?.abort?.(); } catch {} });
    // A chip on the board asks for a different model or thinking level: apply it in Pi, then tell every board what took effect
    // (the host clamps a level the model cannot do, and refuses a model without credentials).
    runtime.on('agent-setting', async ({ model, thinking }) => {
      const ctx = agent.lastCtx;
      try {
        if (model) {
          const [provider, ...rest] = String(model).split('/');
          const found = ctx?.modelRegistry?.find?.(provider, rest.join('/'));
          if (!found) throw new Error(`Pi does not know the model ${model}.`);
          const ok = await pi.setModel(found);
          if (!ok) throw new Error(`No credentials for ${model}; the model was not changed.`);
        }
        if (thinking) pi.setThinkingLevel(thinking);
        repaintControls(ctx);
      } catch (error) {
        runtime.say({ text: `Could not change the agent's setting: ${error?.message || error}` });
        repaintControls(ctx);
      }
    });
  }

  function describeTool(event) {
    if (!DIVLET_TOOLS.has(event.toolName)) return `using ${event.toolName}`;
    const id = event.args?.frameId ?? event.args?.documentId;
    const doc = id && [...session.runtimes.values()].map((runtime) => runtime.documents.get(id)?.document).find(Boolean);
    if (event.toolName === 'mark_divlet' && event.args?.note) return String(event.args.note).slice(0, 80);
    const verb = TOOL_ACTIVITY[event.toolName] ?? event.toolName;
    return doc ? `${verb} “${doc.name}”` : verb;
  }

  /** The runtime this Pi directory is working on (for the agent's per-turn context). */
  const runtimeAt = cwd => {
    const file = session.active.get(path.resolve(cwd));
    const runtime = file && session.runtimes.get(file);
    return runtime && !runtime.closed ? runtime : null;
  };

  // Every tool is the shared contract, rendered for Pi: one schema, one implementation, one set of error codes.
  for (const tool of toolList()) {
    pi.registerTool({
      name: tool.name,
      label: tool.title,
      description: tool.description,
      ...(tool.snippet ? { promptSnippet: tool.snippet } : {}),
      parameters: toTypeBox(tool.parameters, Type),
      async execute(_callId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        lastCwd = ctx.cwd;
        const value = await session.call(tool.name, params ?? {}, { cwd: ctx.cwd, signal });
        if (tool.name === 'open_divlet') return reply(openView(value));
        return reply(value);
      },
    });
  }

  pi.registerCommand('divlet', {
    description: 'Open divlet for this directory, or /divlet <project.divlet or collection folder>.',
    handler: async (args, ctx) => {
      lastCwd = ctx.cwd;
      const opened = await session.call('open_divlet', { path: args.trim() || undefined }, { cwd: ctx.cwd });
      if (opened.kind === 'collection') {
        if (ctx.hasUI) ctx.ui.notify(`divlet: ${opened.launcher}`, 'info');
        pi.sendMessage({ customType: 'divlet', content: `divlet projects (${opened.projects.length}) in ${opened.collection}: ${opened.launcher}\nPick or create one in the browser, or use /divlet <project folder>.`, display: true }, { triggerTurn: false });
        return;
      }
      const info = opened.info;
      if (ctx.hasUI) ctx.ui.notify(`divlet: ${info.url}`, 'info');
      pi.sendMessage({ customType: 'divlet', content: `divlet is ready: ${info.url}\nProject file: ${info.project.file} · ${info.documents.length} frame${info.documents.length === 1 ? '' : 's'}\nOpen the URL in a browser: select something and press A to ask Pi, Ctrl K for every command, ? for shortcuts.`, display: true }, { triggerTurn: false });
    },
  });

  pi.on('before_agent_start', async (_event, ctx) => {
    const runtime = runtimeAt(ctx.cwd);
    if (!runtime) return;
    const info = runtime.info();
    const parts = [];
    const activity = runtime.readHistory({ since: seen.get(runtime) ?? 0, limit: 40 }).changes.filter((change) => change.actor !== 'agent' && change.actor !== 'system' && change.kind !== 'ask' && change.kind !== 'reply');
    seen.set(runtime, runtime.seq);
    // Context blocks use the compact prompt metadata shared with the other adapters: `[tag|key:value|…]` on one line, its value on
    // the same line, lists from the next line in Markdown, and a `next:` list for what to do with them.
    const block = (header, summary, sections) => [`[${header.join('|')}] ${summary}`, ...sections].join('\n');
    if (activity.length) {
      const changes = activity.map((change) => `- #${change.seq} ${change.actor}${change.kind === 'patch' ? '' : ` ${change.kind}`} ${change.documentId ?? 'project'} v${change.fromVersion ?? 0}→v${change.toVersion ?? '—'}: ${String(change.summary ?? '').replace(/\s+/g, ' ').trim()}${change.touched.length ? ` [${change.touched.slice(0, 8).join(', ')}]` : ''}`);
      parts.push(block(['divlet', `project:${info.projectId}`, `changes:${changes.length}`], 'made by the user or by file edits since your last turn', [...changes, 'next:', '- read_divlet view:history for details']));
    }
    if (info.selection?.ids?.length) {
      const frames = info.documents.filter((doc) => info.selection.ids.includes(doc.id));
      const nodes = info.selection.selectedNodes;
      const header = ['divlet', `project:${info.projectId}`, `frames:${frames.length}`];
      if (nodes) header.push(`nodes:${nodes.nodeIds.length}`);
      const sections = ['frames:', ...frames.map(({ id, name, version, artboard }) => `- ${id} · v${version} · “${String(name).replace(/\s+/g, ' ').trim()}” · ${artboard.width}×${artboard.height}`)];
      if (nodes) sections.push(`elements in ${nodes.documentId}:`, ...nodes.nodeIds.map((id) => `- ${nodes.documentId}/${id}`));
      parts.push(block(header, 'selection at prompt start', [...sections, 'next:', '- use these explicit IDs for references such as “these screens” or “this button”; later selection changes do not retarget this request', '- read node state with read_divlet before applying patches']));
    }
    if (!parts.length) return;
    return { message: { customType: 'divlet-selection', content: parts.join('\n\n'), display: false } };
  });

  const idle = () => {
    clearTimeout(agent.idleTimer);
    agent.busy = false;
    agent.activity = null;
    broadcast({ busy: false, activity: null });
  };

  // The skill that explains the project format and the tools ships in this extension's folder.
  pi.on('resources_discover', async () => ({ skillPaths: [SKILL_DIR] }));

  // The board's chips need the session before the first turn: a fresh session has no model or thinking level to show until Pi
  // hands one to an event, and `session_start` is the earliest that ctx exists.
  pi.on('session_start', async (_event, ctx) => { agent.lastCtx = ctx ?? agent.lastCtx; repaintControls(ctx); });
  pi.on('model_select', async (event, ctx) => { agent.lastCtx = ctx ?? agent.lastCtx; repaintControls(ctx); });
  pi.on('thinking_level_select', async (_event, ctx) => { agent.lastCtx = ctx ?? agent.lastCtx; repaintControls(ctx); });

  pi.on('agent_start', async (_event, ctx) => {
    clearTimeout(agent.idleTimer);
    agent.lastCtx = ctx ?? agent.lastCtx;
    agent.run = { asks: agent.pending ?? [], touched: false };
    agent.pending = [];
    agent.busy = true;
    agent.activity = 'thinking';
    broadcast({ busy: true, activity: 'thinking', queued: 0 });
  });

  pi.on('tool_execution_start', async (event, ctx) => {
    agent.lastCtx = ctx ?? agent.lastCtx;
    if (DIVLET_TOOLS.has(event.toolName) && agent.run) agent.run.touched = true;
    agent.activity = describeTool(event);
    broadcast({ busy: true, activity: agent.activity });
  });

  pi.on('tool_execution_end', async () => {
    // While an area is marked, its note says what the agent is doing.
    const note = [...session.runtimes.values()].flatMap((runtime) => runtime.work).findLast((area) => area.note)?.note;
    agent.activity = note || 'thinking';
    if (agent.busy) broadcast({ activity: agent.activity });
  });

  pi.on('agent_end', async (event) => {
    const run = agent.run;
    agent.run = null;
    // agent_settled is the real idle signal; this only covers hosts that never send it.
    clearTimeout(agent.idleTimer);
    agent.idleTimer = setTimeout(idle, 4000);
    agent.idleTimer.unref?.();
    if (!run || (!run.asks.length && !run.touched)) return;
    const text = lastAssistantText(event?.messages);
    if (!text) return;
    const targets = run.asks.length ? run.asks : [...session.runtimes.values()].map((runtime) => ({ runtime }));
    const done = new Set();
    for (const { runtime, seq } of targets) {
      if (done.has(runtime) || runtime.closed) continue;
      done.add(runtime);
      runtime.say({ text, seq });
    }
  });

  pi.on('agent_settled', async () => idle());

  pi.on('session_shutdown', async () => {
    await Promise.allSettled([...opening.values()]);
    clearTimeout(agent.idleTimer);
    Object.assign(agent, { busy: false, activity: null, lastCtx: null, run: null, pending: [] });
    seen.clear();
    await session.close();
  });
}
