import test from 'node:test';
import { legacyProject } from './fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OutputStore, outputDirectory } from '../lib/output.ts';
import { openRuntime } from '../lib/runtime.js';
import { validateSettings, patchSettings, readProject, writeProject } from '../lib/project.ts';

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-output-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function runtimeAt(t, file, options = {}) {
  await legacyProject(file, { demo: options.createDemo !== false });
  const runtime = await openRuntime({ file, watch: false, ...options });
  t.after(() => runtime.close());
  return runtime;
}

test('output settings round-trip and null resets the default; only relative paths are accepted', () => {
  const settings = validateSettings({ outputDir: './public/landing' });
  assert.equal(readProject(JSON.parse(writeProject(settings, []))).settings.outputDir, './public/landing');
  assert.equal(patchSettings(settings, { outputDir: null }).outputDir, null);
  assert.ok(!Object.hasOwn(JSON.parse(writeProject(validateSettings(), [])), 'outputDir'));
  for (const outputDir of ['', ' ', '/', '/tmp/site', 'C:\\site', 'C:site', '\\server\\site', 'a\0b', 4, {}]) {
    assert.throws(() => validateSettings({ outputDir }), { code: 'INVALID_OUTPUT_DIR' });
  }
  assert.equal(outputDirectory('/work/landing.divlet'), '/work/.divlet/landing');
  assert.equal(outputDirectory('/work/landing.divlet', './public/landing'), '/work/public/landing');
  assert.equal(outputDirectory('/work/design/landing.divlet', '../public'), '/work/public');
  for (const outputDir of ['.', './', '..']) assert.throws(() => outputDirectory('/work/landing.divlet', outputDir), { code: 'INVALID_OUTPUT_DIR' });
});

test('named sources in one folder have independent source identity, defaults and generated files', async t => {
  const dir = await workspace(t);
  const a = await runtimeAt(t, path.join(dir, 'project.divlet'));
  const b = await runtimeAt(t, path.join(dir, 'landing.divlet'));
  assert.equal(a.projectDir, dir);
  assert.equal(a.outputDir, path.join(dir, '.divlet/project'));
  assert.equal(b.outputDir, path.join(dir, '.divlet/landing'));
  assert.notEqual(a.projectId, b.projectId);
  assert.equal(a.info().project.file, path.join(dir, 'project.divlet'));
  assert.equal(b.info().project.outputDir, null);
  assert.equal(a.info().documents[0].htmlPath, path.join(a.outputDir, 'welcome.html'));
  assert.equal((await fs.stat(path.join(b.outputDir, 'welcome.meta.json'))).isFile(), true);
  await assert.rejects(fs.stat(path.join(dir, 'divlet')), { code: 'ENOENT' });
  const original = await fs.readFile(b.projectPath, 'utf8');
  await a.patch({ documentId: 'welcome', expectedVersion: 1, patch: { nodes: { 'title-text': { content: 'Only A' } } } });
  assert.equal(await fs.readFile(b.projectPath, 'utf8'), original);
  assert.notEqual(b.read({ view: 'frame', documentId: 'welcome' }).nodes['title-text'].content, 'Only A');
});

test('outputDir moves the one active build and is persisted, undoable, redoable and reopened', async t => {
  const dir = await workspace(t);
  const runtime = await runtimeAt(t, path.join(dir, 'landing.divlet'));
  const originalDir = runtime.outputDir;
  await runtime.patchProject({ expectedVersion: 1, patch: { outputDir: './public/landing' } });
  assert.equal(runtime.outputDir, path.join(dir, 'public/landing'));
  assert.equal(runtime.info().project.outputDir, './public/landing');
  const entry = runtime.info().documents[0];
  assert.equal(entry.htmlPath, path.join(runtime.outputDir, 'welcome.html'));
  assert.equal(JSON.parse(await fs.readFile(entry.metaPath, 'utf8')).project, '../../landing.divlet');
  assert.equal(JSON.parse(await fs.readFile(runtime.projectPath, 'utf8')).outputDir, './public/landing');
  await runtime.undo();
  assert.equal(runtime.outputDir, originalDir);
  await runtime.redo();
  assert.equal(runtime.outputDir, path.join(dir, 'public/landing'));
  await runtime.close();
  const reopened = await runtimeAt(t, path.join(dir, 'landing.divlet'));
  assert.equal(reopened.outputDir, path.join(dir, 'public/landing'));
  assert.equal(reopened.info().diagnostics.length, 0);
});

test('a moved workspace reuses its relative output ownership without leaking absolute source paths', async t => {
  const dir = await workspace(t);
  const runtime = await runtimeAt(t, path.join(dir, 'original/landing.divlet'));
  const manifest = await fs.readFile(path.join(runtime.outputDir, '.divlet-build.json'), 'utf8');
  assert.ok(!manifest.includes(dir));
  await runtime.close();
  await fs.rename(path.join(dir, 'original'), path.join(dir, 'moved'));
  const moved = await runtimeAt(t, path.join(dir, 'moved/landing.divlet'));
  assert.equal(moved.info().diagnostics.length, 0);
  assert.equal(moved.outputDir, path.join(dir, 'moved/.divlet/landing'));
});

test('output conflicts reject a whole project patch before changing source, versions or history', async t => {
  const dir = await workspace(t);
  const runtime = await runtimeAt(t, path.join(dir, 'project.divlet'));
  await fs.mkdir(path.join(dir, 'public'));
  await fs.writeFile(path.join(dir, 'public/welcome.html'), 'A human owns this');
  const original = await fs.readFile(runtime.projectPath, 'utf8');
  const before = runtime.info();
  await assert.rejects(runtime.patchProject({ expectedVersion: 1, patch: { outputDir: 'public' } }), { code: 'OUTPUT_CONFLICT' });
  assert.equal(await fs.readFile(runtime.projectPath, 'utf8'), original);
  assert.deepEqual(runtime.info(), before);
  assert.equal(await fs.readFile(path.join(dir, 'public/welcome.html'), 'utf8'), 'A human owns this');
  await assert.rejects(fs.stat(path.join(dir, 'public/.divlet-build.json')), { code: 'ENOENT' });
});

test('an external output conflict stays pending across scans and cannot be silently overwritten', async t => {
  const dir = await workspace(t);
  const runtime = await runtimeAt(t, path.join(dir, 'project.divlet'));
  await fs.mkdir(path.join(dir, 'public'));
  await fs.writeFile(path.join(dir, 'public/welcome.html'), 'Foreign page');
  const source = JSON.parse(await fs.readFile(runtime.projectPath, 'utf8'));
  source.outputDir = 'public';
  const edited = JSON.stringify(source);
  await fs.writeFile(runtime.projectPath, edited);
  await runtime.scan();
  assert.equal(runtime.info().project.outputDir, null);
  assert.ok(runtime.info().diagnostics.some(item => item.path === runtime.projectPath));
  await runtime.scan();
  assert.ok(runtime.info().diagnostics.some(item => item.path === runtime.projectPath));
  await assert.rejects(runtime.patchProject({ expectedVersion: 1, patch: { name: 'Do not overwrite the pending source' } }), { code: 'EXTERNAL_PENDING' });
  assert.equal(await fs.readFile(runtime.projectPath, 'utf8'), edited);
});

test('the output manifest isolates projects even when they select the same custom directory', async t => {
  const dir = await workspace(t);
  const a = await runtimeAt(t, path.join(dir, 'one.divlet'));
  const b = await runtimeAt(t, path.join(dir, 'two.divlet'));
  await a.patchProject({ expectedVersion: 1, patch: { outputDir: 'public' } });
  const page = await fs.readFile(path.join(dir, 'public/welcome.html'));
  await assert.rejects(b.patchProject({ expectedVersion: 1, patch: { outputDir: 'public' } }), { code: 'OUTPUT_CONFLICT' });
  assert.deepEqual(await fs.readFile(path.join(dir, 'public/welcome.html')), page);
  assert.equal(b.info().project.version, 1);
});

test('owned hand edits are preserved while foreign files survive writes and removal', async t => {
  const dir = await workspace(t);
  const output = new OutputStore(path.join(dir, 'project.divlet'));
  await output.write(new Map([['index.html', 'First'], ['index.meta.json', '{}']]));
  await fs.writeFile(output.file('notes.txt'), 'Not generated');
  await fs.writeFile(output.file('index.html'), 'Human edit');
  await output.write(new Map([['index.html', 'Second']]));
  const trash = await fs.readdir(path.join(output.directory, '.trash'));
  assert.ok((await Promise.all(trash.map(file => fs.readFile(path.join(output.directory, '.trash', file), 'utf8')))).includes('Human edit'));
  await assert.rejects(output.remove(['index.html', 'notes.txt']), { code: 'OUTPUT_CONFLICT' });
  assert.equal(await fs.readFile(output.file('index.html'), 'utf8'), 'Second');
  await output.remove(['index.html']);
  await assert.rejects(fs.stat(output.file('index.html')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(output.file('notes.txt'), 'utf8'), 'Not generated');
});

test('concurrent output writers cannot claim one directory or lose ownership records', async t => {
  const dir = await workspace(t);
  const a = new OutputStore(path.join(dir, 'a.divlet'), 'public');
  const b = new OutputStore(path.join(dir, 'b.divlet'), 'public');
  const results = await Promise.allSettled([a.write(new Map([['a.html', 'A']])), b.write(new Map([['b.html', 'B']]))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => ['OUTPUT_BUSY', 'OUTPUT_CONFLICT'].includes(result.reason.code)));
  const manifest = JSON.parse(await fs.readFile(a.file('.divlet-build.json'), 'utf8'));
  const generated = (await fs.readdir(a.directory)).filter(name => name.endsWith('.html'));
  assert.deepEqual(generated.sort(), Object.keys(manifest.files).sort());
  await assert.rejects(fs.stat(a.file('.divlet-write.lock')), { code: 'ENOENT' });
});

test('removal and preservation symlinks reject before source, state or history change', async t => {
  const dir = await workspace(t);
  const runtime = await runtimeAt(t, path.join(dir, 'project.divlet'));
  const page = runtime.info().documents[0].htmlPath;
  const original = await fs.readFile(runtime.projectPath, 'utf8');
  const before = runtime.info();
  await fs.unlink(page);
  await fs.symlink(path.join(dir, 'foreign.html'), page);
  await assert.rejects(runtime.removeDocument({ documentId: 'welcome' }), { code: 'UNSAFE_PATH' });
  assert.equal(await fs.readFile(runtime.projectPath, 'utf8'), original);
  assert.deepEqual(runtime.info(), before);
  await fs.unlink(page);
  await fs.writeFile(page, 'Human edit');
  await fs.symlink(dir, path.join(runtime.outputDir, '.trash'));
  await assert.rejects(runtime.patch({ documentId: 'welcome', expectedVersion: 1, patch: { name: 'Refused' } }), { code: 'UNSAFE_PATH' });
  assert.equal(await fs.readFile(runtime.projectPath, 'utf8'), original);
  assert.deepEqual(runtime.info(), before);
});

test('opening refuses foreign expected HTML even when it would otherwise look hand-edited', async t => {
  const dir = await workspace(t);
  const file = path.join(dir, 'project.divlet');
  const runtime = await runtimeAt(t, file);
  const outputDir = runtime.outputDir;
  await runtime.close();
  await fs.unlink(path.join(outputDir, '.divlet-build.json'));
  await fs.unlink(path.join(outputDir, 'welcome.meta.json'));
  await fs.writeFile(path.join(outputDir, 'welcome.html'), 'Foreign');
  await assert.rejects(openRuntime({ file, watch: false }), { code: 'OUTPUT_CONFLICT' });
  assert.equal(await fs.readFile(path.join(outputDir, 'welcome.html'), 'utf8'), 'Foreign');
  await assert.rejects(fs.stat(path.join(outputDir, '.divlet-build.json')), { code: 'ENOENT' });
});

test('saving a copy excludes other projects, unrelated workspace files and generated trees', async t => {
  const dir = await workspace(t);
  const runtime = await runtimeAt(t, path.join(dir, 'source/one.divlet'));
  await fs.writeFile(path.join(runtime.projectDir, 'two.divlet'), 'Unrelated source');
  await fs.writeFile(path.join(runtime.projectDir, 'private.txt'), 'Not part of this project');
  await fs.mkdir(path.join(runtime.projectDir, 'assets'));
  await fs.writeFile(path.join(runtime.projectDir, 'assets/photo.svg'), '<svg/>');
  runtime.host = { open: async target => ({ url: 'http://example.invalid/', target }) };
  const target = path.join(dir, 'copy');
  await runtime.saveAs({ path: target });
  assert.deepEqual((await fs.readdir(target)).sort(), ['assets', 'one.divlet']);
  assert.equal(await fs.readFile(path.join(target, 'assets/photo.svg'), 'utf8'), '<svg/>');
});

test('generated file paths cannot also be parents of other planned artifacts', async t => {
  const dir = await workspace(t);
  const output = new OutputStore(path.join(dir, 'project.divlet'));
  await assert.rejects(output.write(new Map([['section.meta.json', '{}'], ['section.meta.json/index.html', 'Conflicting directory']])), { code: 'OUTPUT_CONFLICT' });
  await assert.rejects(fs.stat(output.directory), { code: 'ENOENT' });
});

test('output preflight rejects traversal, linked directories, linked files and malformed ownership without writes', async t => {
  const dir = await workspace(t);
  const output = new OutputStore(path.join(dir, 'project.divlet'));
  for (const name of ['../outside', '/outside', 'nested/../file', 'a\\b', '.divlet-build.json', '.trash/file']) {
    await assert.rejects(output.write(new Map([[name, 'No']])), error => ['UNSAFE_PATH', 'OUTPUT_CONFLICT'].includes(error.code));
  }
  await fs.mkdir(path.join(dir, 'elsewhere'));
  await fs.mkdir(path.join(dir, '.divlet'));
  await fs.symlink(path.join(dir, 'elsewhere'), output.directory);
  await assert.rejects(output.write(new Map([['index.html', 'No']])), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(path.join(dir, 'elsewhere')), []);
  await fs.unlink(output.directory);
  await output.write(new Map([['index.html', 'Yes']]));
  await fs.unlink(output.file('index.html'));
  await fs.symlink(path.join(dir, 'outside.html'), output.file('index.html'));
  await assert.rejects(output.write(new Map([['index.html', 'No']])), { code: 'UNSAFE_PATH' });
  await fs.unlink(output.file('index.html'));
  await fs.writeFile(output.file('.divlet-build.json'), '{broken');
  await assert.rejects(output.write(new Map([['index.html', 'No']])), { code: 'OUTPUT_CONFLICT' });
});
