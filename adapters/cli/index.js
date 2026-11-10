#!/usr/bin/env node
import path from 'node:path';
import { openRuntime } from '../../core/lib/runtime.js';
import { launch, makeHost } from '../../core/lib/launch.ts';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`divlet [path] [--port <0..65535>] [--no-demo] [--no-watch]

Opens the project at <path> (default: the current directory):
  <path>.divlet                  open that project (created if absent)
  <path>.pen or <path>.html      convert once into the <name>.divlet beside it and open that; the imported file is kept as it was
  <folder>/project.divlet        default when the folder has no projects
  <folder>/*.{divlet,pen}        one opens directly; several show a launcher (.html files open only by path)
Local resources are resolved automatically, including files outside the project folder; no approval flags are needed.
Grants require one selected project, never extend to siblings, and remain fixed until restart.
Generated pages default to .divlet/<filename stem>/; set project outputDir to change it.
Set { "projects": "folder" } in <path>/divlet.config.json to use another collection folder.
Port 0 chooses a free port. Install in Pi with: pi install npm:divlet-pi (after npm publication) or pi install /absolute/path/to/divlet (from a copy)`);
  process.exit(0);
}
let target = process.cwd();
let port = 0;
let createDemo = true;
let watch = true;
const externalFiles = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if ((arg === '--cwd' || arg === '--dir') && args[i + 1]) target = path.resolve(args[++i]);
  else if (arg === '--port' && args[i + 1]) port = Number(args[++i]);
  else if (arg === '--asset-file' && args[i + 1] && !args[i + 1].startsWith('-')) externalFiles.push(path.resolve(args[++i]));
  else if (arg === '--no-demo') createDemo = false;
  else if (arg === '--no-watch') watch = false;
  else if (!arg.startsWith('-')) target = path.resolve(arg);
  else { console.error(`Unknown or incomplete argument: ${arg}`); process.exit(1); }
}
if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error('Port must be an integer from 0 to 65535.'); process.exit(1); }
try {
  const runtimes = new Map();
  const hubs = new Map();
  const openBoard = async location => {
    const key = path.resolve(location.file);
    if (!runtimes.has(key)) {
      const runtime = await openRuntime({ ...location, port: runtimes.size ? 0 : port, createDemo, watch });
      runtime.host = host;
      runtimes.set(key, runtime);
    }
    return runtimes.get(key);
  };
  const host = makeHost({ openBoard: (location) => openBoard(location), hubs });
  const opened = await launch(target, { openBoard, hubs, ...(externalFiles.length ? { externalFiles } : {}) });
  if (opened.kind === 'project') {
    const info = opened.runtime.info();
    const imported = opened.imported ? `Imported ${path.basename(opened.imported.from)} → ${path.basename(opened.imported.to)} (${opened.imported.frames} frames as HTML + Tailwind: ${opened.imported.utilities} utility and ${opened.imported.arbitrary} arbitrary-property classes; the source is kept as ${path.basename(opened.imported.from)})\n` : '';
    console.log(`divlet ${info.url}\nProject: ${info.project.file} · ${info.documents.length} frame${info.documents.length === 1 ? '' : 's'}\n${imported}The Agent tab works when the board is opened from Pi (/divlet) or by an MCP client. Press Ctrl+C to stop.`);
  } else {
    console.log(`divlet ${opened.hub.url}\n${opened.projects.length} project${opened.projects.length === 1 ? '' : 's'} in ${opened.collection} — pick one in the browser, or name a new one. Press Ctrl+C to stop.`);
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const hub of hubs.values()) await hub.close();
    for (const runtime of runtimes.values()) await runtime.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error(`divlet: ${error.message}`);
  process.exitCode = 1;
}
