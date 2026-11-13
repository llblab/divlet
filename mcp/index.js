#!/usr/bin/env node
/*
 * divlet over MCP (stdio), for any MCP client: Claude Desktop, an editor, a script.
 *
 *   npx -y @divlet/mcp [--cwd <dir>] [--project <file.divlet>] [--port <0..65535>] [--no-demo]
 *
 * Nothing starts at import time: the board opens when a tool asks for it, and the process ends when stdin closes or a
 * termination signal arrives, closing only the boards it owns (a board another client owns keeps running for that client).
 */
import path from 'node:path';
import { createSession } from '@divlet/core/contract';
import { createMcpServer, localBoardOpener, wireBoardAgent } from './lib/server.js';
import metadata from '#package' with { type: 'json' };

const VERSION = metadata.version;

function parseArgs(argv) {
  const options = { cwd: process.cwd(), project: undefined, port: 0, createDemo: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--version' || arg === '-v') { options.version = true; continue; }
    const value = argv[i + 1];
    if (arg === '--cwd' && value) { options.cwd = path.resolve(value); i++; continue; }
    if (arg === '--project' && value) { options.project = value; i++; continue; }
    if (arg === '--port' && value) { options.port = Number(value); i++; continue; }
    if (arg === '--no-demo') { options.createDemo = false; continue; }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('--port takes 0..65535.');
  return options;
}

const HELP = `divlet-mcp — divlet over MCP (stdio)

Usage: divlet-mcp [options]
  --cwd <dir>          working directory for relative paths and the default project (default: the current one)
  --project <path>     open this project the first time a tool needs one
  --port <n>           port for the board the first open starts (0 picks a free one)
  --no-demo            do not seed a starter frame when a new project is created
  --help, --version

Speaks MCP on stdin/stdout; diagnostics go to stderr. The board is the single writer of its project: if another client
already opened it, tool calls are forwarded to that board instead of opening a second one.`;

let session, server;

export function runMcp(argv = process.argv.slice(2)) {
  const options = (() => {
    try { return parseArgs(argv); } catch (error) { process.stderr.write(`divlet-mcp: ${error.message}\n`); process.exit(2); }
  })();
  if (options.help) { process.stdout.write(HELP + '\n'); process.exit(0); }
  if (options.version) { process.stdout.write(VERSION + '\n'); process.exit(0); }

  const log = message => process.stderr.write(`${message}\n`);
  session = createSession({
    cwd: options.cwd,
    openBoard: localBoardOpener(),
    // A board this server owns gets this client as its agent: a request typed on the board becomes a sampling request.
    onRuntime: runtime => wireBoardAgent(runtime, server, { log }),
  });
  server = createMcpServer({ session, send: chunk => process.stdout.write(chunk), log, argv: { ...options, version: VERSION } });

  let stopping = false;
  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    try { await session.close(); } catch { /* the process is going away */ }
    process.exit(code);
  }

  process.stdout.on('error', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));
  process.on('uncaughtException', error => { log(`divlet-mcp: ${error?.stack || error}`); stop(1); });
  process.on('unhandledRejection', error => { log(`divlet-mcp: ${error?.stack || error}`); });

  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    pending += chunk;
    let at;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (!line.trim()) continue;
      server.receive(line).catch(error => log(`divlet-mcp: ${error?.message || error}`));
    }
  });
  process.stdin.on('end', () => {
    // A last message may arrive without its newline.
    if (pending.trim()) server.receive(pending).catch(() => {});
    stop(0);
  });

  log(`divlet-mcp ${VERSION} ready (stdio${options.project ? `, project ${path.resolve(options.cwd, options.project)}` : ''})`);
  return { session, server };
}

export { session, server };
if (import.meta.main) runMcp();
