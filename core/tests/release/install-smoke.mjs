// Release check: pack the package, install the tarball into an empty directory (dependencies come from the registry or its
// cache) and prove that what a user gets works: the CLI and the MCP server answer, a board starts, and the board and a plugin's
// client module are served. The MCP check runs the installed bin over stdio with no Pi installed — standalone usage. Nothing is
// published. Run it with `npm run test:release` before any release.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const work = await mkdtemp(path.join(os.tmpdir(), 'divlet-release-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: root, encoding: 'utf8' }))[0];
  assert.ok(packed.entryCount > 50 && packed.entryCount < 400, `a plausible number of files (${packed.entryCount})`);
  const leaked = packed.files.map(file => file.path).filter(file => /(^|\/)(tests?|artifacts|node_modules|\.divlet)(\/|$)|\.test\./.test(file));
  assert.deepEqual(leaked, [], 'no tests, artifacts or caches in the package');

  const target = path.join(work, 'try');
  await mkdir(path.join(target, 'proj'), { recursive: true });
  await writeFile(path.join(target, 'package.json'), '{"name":"try","private":true,"type":"module"}');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', path.join(work, packed.filename)], { cwd: target, stdio: 'pipe' });

  // Installed paths are the published build: `dist/` holds the compiled JavaScript the package exports.
  const help = execFileSync(process.execPath, [path.join(target, 'node_modules', 'divlet', 'dist', 'adapters', 'cli', 'index.js'), '--help'], { encoding: 'utf8' });
  assert.match(help, /divlet \[path\]/, 'the CLI answers --help');

  await writeFile(path.join(target, 'smoke.mjs'), `
    import path from 'node:path';
    import { openRuntime } from 'divlet';
    const runtime = await openRuntime({ file: path.resolve('proj/project.divlet'), watch: false, createDemo: true });
    const info = runtime.info();
    const served = async file => (await fetch(new URL(file, info.url))).status;
    console.log(JSON.stringify({ frames: info.documents.length, index: await served('./'), board: await served('board.js'), lib: await served('lib/store.js'), panel: await served('plugins/tailwind/panel.js') }));
    await runtime.close();
    process.exit(0);
  `);
  const result = JSON.parse(execFileSync(process.execPath, ['smoke.mjs'], { cwd: target, encoding: 'utf8' }).trim().split('\n').pop());
  assert.deepEqual(result, { frames: 1, index: 200, board: 200, lib: 200, panel: 200 }, 'the installed package starts a board and serves it');

  // The MCP server from the installed package: initialize, list the shared tools, open a project, read it, and stop on EOF.
  await writeFile(path.join(target, 'mcp-smoke.mjs'), `
    import { existsSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    import path from 'node:path';
    // The installed command itself (the npx entry point), falling back to the entry file.
    const bin = path.resolve('node_modules/.bin/divlet-mcp');
    const entry = path.resolve('node_modules/divlet/dist/adapters/mcp/index.js');
    const command = existsSync(bin) ? bin : process.execPath;
    const child = spawn(command, [bin ? '' : entry, '--cwd', path.resolve('proj'), '--no-demo'].filter(Boolean), { stdio: ['pipe', 'pipe', 'pipe'] });
    const send = message => child.stdin.write(JSON.stringify(message) + '\\n');
    let buffer = '', out = [], stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { buffer += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
    const waitFor = () => new Promise((resolve, reject) => { const tick = () => {
      let at; while ((at = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.trim()) out.push(JSON.parse(line)); }
      if (out.length >= 3) return resolve();
      if (child.exitCode !== null) return reject(new Error('MCP server exited (' + child.exitCode + '): ' + stderr));
      setTimeout(tick, 20);
    }; tick(); });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'open_divlet', arguments: {} } });
    await waitFor();
    child.stdin.end();
    await exited;
    const tools = out.find(message => message.id === 2)?.result?.tools?.map(tool => tool.name) ?? [];
    const opened = JSON.parse(out.find(message => message.id === 3)?.result?.content?.[0]?.text ?? 'null');
    console.log(JSON.stringify({ protocol: out[0]?.result?.protocolVersion, tools, url: opened?.url ? 'http://…' : null, frames: opened?.frames?.length, stderr: stderr.trim().split('\\n')[0] }));
    process.exit(0);
  `);
  // The contracts are types a plugin author compiles against: they resolve from the installed package and need no Node types.
  await writeFile(path.join(target, 'plugin.ts'), `
    import type { Importer } from 'divlet/plugins';
    import type { StyleEngine } from 'divlet/engine';
    import { S, optional } from 'divlet/contract';
    const demo: Importer = { id: 'demo', label: 'Demo', extensions: ['.demo'], claims: async () => false, convert: () => ({ text: '{}' }) };
    const plain: StyleEngine = { id: 'plain' };
    const parameter = optional(S.string({ description: 'x', maxLength: 4 }));
    console.log(demo.id, plain.id, parameter.kind);
  `);
  execFileSync(path.join(root, 'node_modules', '.bin', 'tsc'), ['--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2024', 'plugin.ts'], { cwd: target, stdio: 'pipe' });

  const mcp = JSON.parse(execFileSync(process.execPath, ['mcp-smoke.mjs'], { cwd: target, encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(mcp.protocol, '2025-06-18', 'the installed MCP server answers initialize');
  assert.deepEqual(mcp.tools, ['open_divlet', 'read_divlet', 'patch_divlet', 'edit_divlet', 'frame_divlet', 'undo_divlet', 'mark_divlet'], 'the installed MCP server lists the shared tools');
  assert.equal(mcp.url, 'http://…', 'and opens a board');
  assert.equal(mcp.frames, 1);
  // The separately published Pi wrapper must resolve the already installed product, not an unpublished registry version.
  const wrapper = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: path.join(root, 'packages/divlet-pi'), encoding: 'utf8' }))[0];
  assert.equal(wrapper.name, 'divlet-pi');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', path.join(work, wrapper.filename)], { cwd: target, stdio: 'pipe' });
  await writeFile(path.join(target, 'pi-smoke.mjs'), `
    import assert from 'node:assert/strict';
    import wrapper from 'divlet-pi';
    import adapter from 'divlet/pi';
    assert.equal(typeof wrapper, 'function');
    assert.equal(wrapper, adapter);
  `);
  execFileSync(process.execPath, ['pi-smoke.mjs'], { cwd: target, stdio: 'pipe' });
  console.log(JSON.stringify({ status: 'passed', files: packed.entryCount, packedKB: Math.round(packed.size / 1024), ...result, pluginTypes: true, mcpProtocol: mcp.protocol, mcpTools: mcp.tools.length, piWrapper: true }));
} finally { await rm(work, { recursive: true, force: true }); }
