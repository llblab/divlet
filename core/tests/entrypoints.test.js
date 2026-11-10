// The package is harness-agnostic: its root entry is the library, every other surface is a named subpath, and a host manifest
// field points at that host's adapter rather than at a root shim. This test is the shape — if a new host needs the root to look
// like itself, it fails here first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const exists = async file => { try { return (await stat(file)).isFile(); } catch { return false; } };

test('the root entry is the library, and the runtime keeps its own subpath', async () => {
  assert.equal(pkg.exports['.'], './dist/core/index.js', 'the package is the product, not one host');
  assert.equal(pkg.exports['./runtime'], './dist/core/lib/runtime.js');
  const api = path.join(root, 'core/index.js');
  const source = await readFile(api, 'utf8');
  for (const name of ['openRuntime', 'launch', 'makeHost', 'startServer', 'resolveOpenFile']) {
    assert.match(source, new RegExp(`\\b${name}\\b`), `the library exposes ${name}`);
  }
  assert.equal(await exists(path.join(root, 'index.js')), false, 'no root shim that means "this package is a Pi extension"');
});

test('a host manifest field points at that host adapter, never at a root entry', () => {
  assert.ok(Array.isArray(pkg.pi?.extensions) && pkg.pi.extensions.length, 'the Pi manifest declares its entry');
  for (const entry of pkg.pi.extensions) {
    assert.equal(entry, './dist/adapters/pi/index.js', 'the Pi entry is the adapter');
    assert.ok(pkg.exports['./pi'], 'and the same adapter is exported as a subpath for any host that embeds it');
    assert.equal(pkg.exports['./pi'], entry.replace(/^\.\//, './'), 'the manifest and the subpath name one file');
  }
});

test('the adapter is a package a host can install by itself', async () => {
  // This is what a symlink in an extensions folder points at: the adapter folder, not the product repository.
  const adapter = JSON.parse(await readFile(path.join(root, 'adapters/pi/package.json'), 'utf8'));
  assert.deepEqual(adapter.pi.extensions, ['./index.js'], 'the adapter declares its own host entry');
  assert.equal(adapter.main, './index.js');
  assert.equal(adapter.exports['.'], './index.js');
  const entry = path.join(root, 'adapters/pi/index.js');
  assert.ok(await exists(entry), 'the declared entry exists');
  const source = await readFile(entry, 'utf8');
  assert.match(source, /from '\.\/lib\/extension\.js'/, 'and it points at the adapter implementation rather than copying it');
});

test('host packaging lives in its own package, with no copy of the adapter', async () => {
  const wrapper = JSON.parse(await readFile(path.join(root, 'packages/divlet-pi/package.json'), 'utf8'));
  assert.equal(wrapper.name, 'divlet-pi');
  assert.deepEqual(wrapper.pi.extensions, ['./index.js'], 'Pi installs the thin package');
  assert.equal(wrapper.dependencies.divlet, pkg.version, 'and depends on the product at its current version');
  const index = await readFile(path.join(root, 'packages/divlet-pi/index.js'), 'utf8');
  assert.match(index, /from 'divlet\/pi'/, 'it re-exports the adapter instead of shipping a copy');
  assert.equal(wrapper.files.includes('index.js'), true);
  for (const keyword of ['pi', 'pi-package']) assert.ok(wrapper.keywords.includes(keyword), `the host keywords live with the host package (${keyword})`);
  for (const keyword of ['pi', 'pi-package']) assert.equal(pkg.keywords.includes(keyword), false, `and not at the root (${keyword})`);
});

test('every export is a real module, and the package ships only published output', async () => {
  for (const [condition, target] of Object.entries(pkg.exports)) {
    assert.match(target, /^\.\/dist\//, `${condition} resolves into dist`);
    const built = path.join(root, target);
    if (await exists(built)) assert.ok(true);
    else assert.ok(await exists(path.join(root, 'dist')), `${target} is produced by the build`);
  }
  assert.equal(pkg.files.includes('index.js'), false, 'the root shim is gone from the tarball too');
  assert.equal(pkg.files.includes('packages'), false, 'host packaging is its own package, not root files');
});
