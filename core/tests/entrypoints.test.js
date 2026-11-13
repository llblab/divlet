// Package boundaries are installation boundaries: core → web, adapters → core; no copied clients or wrappers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const exists = async file => { try { return (await stat(file)).isFile(); } catch { return false; } };

test('@divlet/core is the shared product library, not a host or command package', async () => {
  assert.equal(pkg.name, '@divlet/core');
  assert.equal(pkg.exports['.'].default, './dist/core/index.js');
  assert.equal(pkg.exports['./runtime'].default, './dist/core/lib/runtime.js');
  assert.equal(pkg.bin, undefined);
  assert.equal(pkg.pi, undefined);
  assert.equal(pkg.exports['./pi'], undefined, 'the Pi adapter now belongs to @divlet/pi');
  assert.equal(pkg.peerDependencies?.typebox, undefined);
  for (const word of ['pi', 'pi-package']) assert.equal(pkg.keywords.includes(word), false);
  assert.equal(pkg.exports['./skill'], './skills/divlet/SKILL.md', 'the workflow remains product-owned');
  assert.equal(await exists(path.join(root, 'adapters')), false, 'there is one package owner per adapter');
  assert.equal(pkg.files.includes('packages'), false);
  assert.ok(pkg.workspaces.includes('.'), 'source adapters can resolve the product workspace without a registry release');
});

test('@divlet/web owns client files and portable ports with no reverse package dependency', async () => {
  const web = JSON.parse(await readFile(path.join(root, 'web/package.json'), 'utf8'));
  assert.equal(web.name, '@divlet/web'); assert.equal(web.version, pkg.version);
  assert.equal(pkg.dependencies['@divlet/web'], pkg.version);
  assert.ok(pkg.workspaces.includes('web'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(Object.keys(web[field] ?? {}).length, 0, `web has no ${field} back edge`);
  assert.deepEqual(web.exports['./session'], { 'divlet-source': './lib/board-session.ts', default: './dist/lib/board-session.js' });
  assert.deepEqual(web.exports['./host'], { 'divlet-source': './lib/board-host.ts', default: './dist/lib/board-host.js' });
  const { clientRoot } = await import('@divlet/web');
  assert.equal(clientRoot.href, new URL('../../web/', import.meta.url).href);
  const server = await readFile(path.join(root, 'core/lib/server.ts'), 'utf8');
  assert.match(server, /from '@divlet\/web'/);
  assert.doesNotMatch(server, /new URL\('\.\.\/\.\.\/web\//, 'the server uses a public locator, not a sibling path');
});

test('browser mapping replaces only the model style port and names real source bindings', async () => {
  assert.deepEqual(pkg.browser, {
    './core/lib/model-styles.ts': './core/lib/browser-styles.ts',
    './dist/core/lib/model-styles.js': './dist/core/lib/browser-styles.js',
  });
  for (const file of [Object.keys(pkg.browser)[0], Object.values(pkg.browser)[0]]) assert.ok(await exists(path.join(root, file)), file);
});

for (const name of ['cli', 'mcp', 'pi']) test(`@divlet/${name} owns its adapter, release version and installed entry`, async () => {
  const directory = path.join(root, 'packages', name);
  const adapter = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  assert.equal(adapter.name, `@divlet/${name}`);
  assert.notEqual(adapter.private, true);
  assert.equal(adapter.version, pkg.version);
  assert.equal(adapter.dependencies['@divlet/core'], pkg.version);
  assert.equal(adapter.dependencies['@divlet/web'], undefined, 'the core HTTP composition owns the web dependency');
  assert.equal(adapter.repository.directory, `packages/${name}`);
  assert.deepEqual(adapter.exports['.'], { 'divlet-source': './index.js', default: './dist/index.js' });
  assert.equal(adapter.files.includes('dist'), true);
  assert.equal(adapter.files.includes('tests'), false);
  const source = await readFile(path.join(directory, 'index.js'), 'utf8');
  if (name === 'pi') {
    assert.deepEqual(adapter.pi.extensions, ['./dist/index.js']);
    assert.match(source, /from '\.\/lib\/extension\.js'/, 'the implementation lives in this package');
    assert.ok(adapter.keywords.includes('pi-package'));
    assert.equal(adapter.peerDependencies.typebox, '*');
  } else {
    assert.deepEqual(adapter.bin, { [name === 'cli' ? 'divlet' : 'divlet-mcp']: './dist/index.js' });
    assert.match(source, /import\.meta\.main/, 'imports do not start the executable');
  }
});

test('public adapter imports start no process service or stdio listeners', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const before = [process.stdin.listenerCount('data'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const cli = await import('@divlet/cli');
    const mcp = await import('@divlet/mcp');
    const pi = await import('@divlet/pi');
    assert.equal(typeof cli.runCli, 'function');
    assert.equal(typeof mcp.runMcp, 'function');
    assert.equal(typeof pi.default, 'function');
    assert.deepEqual([process.stdin.listenerCount('data'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
  `], { cwd: root, stdio: 'pipe', timeout: 10000 });
});

test('published library targets are compiled; development targets name real source files', async () => {
  for (const [name, target] of Object.entries(pkg.exports)) {
    if (name === './skill') { assert.equal(await exists(path.join(root, target)), true); continue; }
    assert.match(target.default, /^\.\/dist\//);
    assert.equal(await exists(path.join(root, target['divlet-source'])), true, name);
  }
});
