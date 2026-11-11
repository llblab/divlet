// Release check: pack the package, install the tarball into an empty directory (dependencies come from the registry or its
// cache) and prove that what a user gets works: the CLI and the MCP server answer, a board starts, and the board and a plugin's
// client module are served. The MCP check runs the installed bin over stdio with no Pi installed — standalone usage. Nothing is
// published. Run it with `npm run test:release` before any release.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleBrowserModel } from '../../../scripts/browser-model.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const work = await mkdtemp(path.join(os.tmpdir(), 'divlet-release-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: root, encoding: 'utf8' }))[0];
  assert.ok(packed.entryCount > 50 && packed.entryCount < 400, `a plausible number of files (${packed.entryCount})`);
  const leaked = packed.files.map(file => file.path).filter(file => /(^|\/)(tests?|artifacts|node_modules|\.divlet)(\/|$)|\.test\./.test(file));
  assert.deepEqual(leaked, [], 'no tests, artifacts or caches in the package');

  const target = path.join(work, 'try');
  await mkdir(path.join(target, 'proj'), { recursive: true });
  await mkdir(path.join(target, 'landing-example'));
  await writeFile(path.join(target, 'package.json'), '{"name":"try","private":true,"type":"module"}');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', path.join(work, packed.filename)], { cwd: target, stdio: 'pipe' });

  // A real consumer selects the compiled browser binding without checkout sources or a provider bootstrap.
  const browserBundle = await bundleBrowserModel(target);
  assert.ok(browserBundle.inputs.some(file => /core\/lib\/browser-styles\.js$/.test(file)), 'the installed browser port is shipped and selected');
  const browserModel = await import(`data:text/javascript;base64,${Buffer.from(browserBundle.code).toString('base64')}`);
  const browserFrame = browserModel.createDemoDocument();
  assert.equal(browserModel.validateDocument(browserFrame).schemaVersion, 1);
  assert.throws(() => browserModel.applyDocumentPatch(browserFrame, { nodes: { root: { styles: { color: 'red' } } } }), { code: 'NO_STYLE_ENGINE' });

  // Installed paths are the published build: `dist/` holds the compiled JavaScript the package exports.
  assert.equal(packed.files.some(file => /^dist\/(?:packages|adapters)\//.test(file.path)), false, 'the product contains no adapter implementations');
  const adapters = [];
  for (const name of ['cli', 'mcp', 'pi']) {
    const adapter = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: path.join(root, 'packages', name), encoding: 'utf8' }))[0];
    assert.equal(adapter.name, `@divlet/${name}`);
    assert.equal(adapter.version, packed.version);
    assert.equal(adapter.files.some(file => /(?:^|\/)(?:tests|core|web)(?:\/|$)/.test(file.path)), false, 'an adapter contains only its implementation, not another product');
    assert.equal(adapter.files.some(file => file.path.split('/').filter(part => part === 'dist').length > 1), false, 'generated output never nests inside itself');
    assert.ok(adapter.files.some(file => file.path === 'dist/LICENSE'), 'every independently distributed adapter includes the shared MIT notice');
    if (name !== 'pi') assert.ok(adapter.files.find(file => file.path === 'dist/index.js').mode & 0o111);
    adapters.push(path.join(work, adapter.filename));
  }
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', ...adapters.slice(0, 2)], { cwd: target, stdio: 'pipe' });
  const help = execFileSync(process.execPath, [path.join(target, 'node_modules', '.bin', 'divlet'), '--help'], { encoding: 'utf8' });
  assert.match(help, /divlet \[path\]/, 'the CLI answers --help');
  assert.equal(execFileSync(process.execPath, [path.join(target, 'node_modules/.bin/divlet-mcp'), '--version'], { encoding: 'utf8' }).trim(), packed.version);
  assert.equal(await readFile(path.join(target, 'node_modules/divlet/package.json'), 'utf8').then(text => JSON.parse(text).pi), undefined);
  await assert.rejects(readFile(path.join(target, 'node_modules/typebox/package.json')), { code: 'ENOENT' }, 'CLI/MCP do not install Pi peers');
  await writeFile(path.join(target, 'cli-smoke.mjs'), `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import path from 'node:path';
    const child = spawn(process.execPath, [path.resolve('node_modules/.bin/divlet'), '--cwd', path.resolve('cli-proj'), '--no-watch'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const exited = new Promise(resolve => child.on('exit', resolve));
    try {
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CLI did not open a board: ' + errors)), 10000);
        child.once('exit', code => { clearTimeout(timer); reject(new Error('CLI exited before opening: ' + code + ' ' + errors)); });
        child.stdout.on('data', chunk => { output += chunk; const match = /divlet (http:\\/\\/[^\\s]+)/.exec(output); if (match) { clearTimeout(timer); resolve(match[1]); } });
      });
      assert.equal((await fetch(url)).status, 200);
      console.log('CLI board served');
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited; clearTimeout(timer);
    }
  `);
  execFileSync(process.execPath, ['cli-smoke.mjs'], { cwd: target, encoding: 'utf8', timeout: 20000 });

  await writeFile(path.join(target, 'smoke.mjs'), `
    import path from 'node:path';
    import assert from 'node:assert/strict';
    import { openRuntime } from 'divlet';
    import { readFile, copyFile } from 'node:fs/promises';
    import { compileClasses, resolveStyleEngine, setStyleEngines } from 'divlet/engine';
    import { pathToFileURL } from 'node:url';
    const runtime = await openRuntime({ file: path.resolve('proj/project.divlet'), watch: false, createDemo: true });
    const info = runtime.info();
    assert.equal(JSON.parse(await readFile('proj/project.divlet', 'utf8')).schemaVersion, 1, 'the installed product writes the initial native format');
    assert.throws(() => runtime.reuseImage({}), { code: 'UNSUPPORTED_OPERATION' });
    assert.deepEqual(runtime.info(), info, 'retired compatibility entry leaves installed owner state unchanged');
    const served = async file => (await fetch(new URL(file, info.url))).status;
    const board = { frames: info.documents.length, index: await served('./'), board: await served('board.js'), lib: await served('lib/store.js'), panel: await served('plugins/tailwind/panel.js') };
    await runtime.close();
    await copyFile('node_modules/divlet/examples/landing/landing.divlet', 'landing-example/landing.divlet');
    const landing = await openRuntime({ file: path.resolve('landing-example/landing.divlet'), watch: false, createDemo: false });
    try {
      assert.deepEqual(landing.info().diagnostics, []);
      const html = await readFile(path.join(landing.outputDir, 'index.html'), 'utf8');
      assert.match(html, /rel="icon" href="data:image\\/svg\\+xml;base64,/);
      assert.equal(landing.staticSources.size, 0, 'the installed example needs no omitted asset file');
    } finally { await landing.close(); }
    // Internal packaging probe: the versioned descriptor is not yet a default or a new public subpath.
    const { createRenderer } = await import(pathToFileURL(path.resolve('node_modules/divlet/dist/plugins/tailwind/index.js')).href);
    const renderer = createRenderer();
    setStyleEngines([renderer]);
    const requirement = { id: renderer.id, version: renderer.version };
    if (resolveStyleEngine(requirement) !== renderer || !(await compileClasses({}, ['p-4'], process.cwd(), requirement)).includes('.p-4')) throw new Error('Installed versioned renderer failed');
    console.log(JSON.stringify({ ...board, renderer: renderer.version }));
    process.exit(0);
  `);
  const runtimeTypes = await readFile(path.join(target, 'node_modules/divlet/dist/core/lib/runtime.d.ts'), 'utf8');
  assert.match(runtimeTypes, /reuseImage\(input\?:\s*\{\s*\}\):\s*any;/, 'the previously emitted compatibility signature remains');
  assert.match(runtimeTypes, /@deprecated Image reuse was retired/, 'the unsupported method is not advertised as a working feature');
  const result = JSON.parse(execFileSync(process.execPath, ['smoke.mjs'], { cwd: target, encoding: 'utf8' }).trim().split('\n').pop());
  const { renderer, ...board } = result;
  assert.deepEqual(board, { frames: 1, index: 200, board: 200, lib: 200, panel: 200 }, 'the installed package starts a board and serves it');
  assert.match(renderer, /^divlet-tailwind-1-[a-f0-9]{64}$/, 'the installed build establishes and executes an exact renderer identity');

  // The MCP server from the installed package: initialize, list the shared tools, open a project, read it, and stop on EOF.
  await writeFile(path.join(target, 'mcp-smoke.mjs'), `
    import { existsSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    import path from 'node:path';
    // The installed command itself (the npx entry point), falling back to the entry file.
    const bin = path.resolve('node_modules/.bin/divlet-mcp');
    if (!existsSync(bin)) throw new Error('The @divlet/mcp executable is missing');
    const child = spawn(process.execPath, [bin, '--cwd', path.resolve('proj'), '--no-demo'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    console.log(JSON.stringify({ protocol: out[0]?.result?.protocolVersion, tools, kind: opened?.kind, url: opened?.url ? 'http://…' : null, frames: opened?.frames?.length, stderr: stderr.trim().split('\\n')[0] }));
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
  assert.equal(mcp.url, 'http://…', 'and opens a board: ' + JSON.stringify(mcp));
  assert.equal(mcp.frames, 1);
  // Only the Pi adapter needs the peer supplied by its host; CLI/MCP above run without it or the Pi SDK.
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', adapters[2]], { cwd: target, stdio: 'pipe' });
  await writeFile(path.join(target, 'pi-smoke.mjs'), `
    import assert from 'node:assert/strict';
    import adapter from '@divlet/pi';
    import { existsSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    import path from 'node:path';
    assert.equal(typeof adapter, 'function');
    const skill = fileURLToPath(import.meta.resolve('divlet/skill'));
    assert.ok(existsSync(skill));
    const registered = [], handlers = new Map();
    adapter({ registerCommand() {}, registerTool(tool) { registered.push(tool.name); }, on(name, handler) { handlers.set(name, handler); }, getThinkingLevel() { return 'off'; } });
    assert.equal(registered.length, 7);
    assert.ok(path.dirname(skill).endsWith('skills/divlet'));
    assert.deepEqual(await handlers.get('resources_discover')(), { skillPaths: [path.dirname(skill)] });
  `);
  execFileSync(process.execPath, ['pi-smoke.mjs'], { cwd: target, stdio: 'pipe' });
  console.log(JSON.stringify({ status: 'passed', files: packed.entryCount, packedKB: Math.round(packed.size / 1024), ...result, pluginTypes: true, browserModelBundle: true, mcpProtocol: mcp.protocol, mcpTools: mcp.tools.length, adapterPackages: ['@divlet/cli', '@divlet/mcp', '@divlet/pi'] }));
} finally { await rm(work, { recursive: true, force: true }); }
