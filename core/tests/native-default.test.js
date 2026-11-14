import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDemoDocument } from '../lib/model.ts';
import { initProject } from '../lib/projects.ts';
import { OutputStore } from '../lib/output.ts';
import { openRuntime } from '@divlet/core/runtime';

const hash = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-native-default-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }

test('the starter is an ordinary Divlet frame: elements with Tailwind classes, tokens and no PEN carriers', () => {
  const doc = createDemoDocument(), root = doc.nodes[doc.rootId];
  assert.equal(doc.id, 'welcome'); assert.equal(root.tag, 'main'); assert.ok(root.className.includes('grid')); assert.deepEqual(Object.keys(doc.tokens).sort(), ['--accent', '--surface']);
  assert.ok(!JSON.stringify(doc).includes('data-pen') && !JSON.stringify(doc).includes('"pen"'));
});

for (const suffix of ['html', 'meta.json']) test(`starter admission includes real ${suffix} output before exclusive source publication`, async t => {
  const root = await fixture(t), file = path.join(root, 'project.divlet'), output = new OutputStore(file);
  const doc = createDemoDocument();
  const filename = `${doc.id}.${suffix}`;
  await fs.mkdir(output.directory, { recursive: true }); const foreign = path.join(output.directory, filename); await fs.writeFile(foreign, 'foreign output');
  await assert.rejects(initProject(file, undefined, true), { code: 'OUTPUT_CONFLICT' }); await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign output');
});

for (const createDemo of [false, true]) test(`missing-source initialization (demo=${createDemo}) adopts the exact prepared starter generation with fresh clocks and no history`, async t => {
  const root = await fixture(t), file = path.join(root, 'project.divlet'), snapshots = [], preflight = OutputStore.prototype.preflight;
  t.mock.method(OutputStore.prototype, 'preflight', async function(files, ...args) { if (this.projectFile === file) snapshots.push(Object.fromEntries([...files].map(([name, data]) => [name, hash(data)]))); return preflight.call(this, files, ...args); });
  const runtime = await openRuntime({ file, watch: false, createDemo }); t.after(() => runtime.close());
  const source = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(source.schemaVersion, 1); assert.equal(Object.hasOwn(source, 'children'), false); assert.equal(source.frames.length, createDemo ? 1 : 0);
  assert.equal(runtime.info().project.format, 'divlet'); assert.equal(runtime.settings.version, 1); assert.equal(runtime.history.length, 0); assert.equal(runtime.documents.size, createDemo ? 1 : 0);
  assert.deepEqual(snapshots.at(-1), snapshots[0]);
  if (createDemo) { assert.ok(Object.keys(snapshots[0]).some(name => name.endsWith('.html'))); assert.ok(Object.keys(snapshots[0]).some(name => name.endsWith('.meta.json'))); }
  for (const [name, digest] of Object.entries(snapshots[0])) assert.equal(hash(await fs.readFile(path.join(runtime.outputDir, name))), digest);
  const bytes = hash(await fs.readFile(file)); await runtime.close(); const reopened = await openRuntime({ file, watch: false, createDemo: !createDemo }); t.after(() => reopened.close());
  assert.equal(hash(await fs.readFile(file)), bytes); assert.equal(reopened.documents.size, createDemo ? 1 : 0); assert.equal(reopened.settings.version, 1); assert.equal(reopened.history.length, 0);
});

test('invalid startup demo intent cannot authorize source publication', async t => {
  const root = await fixture(t);
  for (const [index, createDemo] of [null, 0, 'true', {}].entries()) {
    const file = path.join(root, `invalid-${index}/project.divlet`);
    await assert.rejects(openRuntime({ file, watch: false, createDemo }), { code: 'INVALID_PROJECT' }); await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
  }
});

test('a source-absent starter project can be edited and is saved as an ordinary Divlet project', async t => {
  const root = await fixture(t), runtime = await openRuntime({ cwd: path.join(root, 'source'), watch: false }); t.after(() => runtime.close());
  const entry = [...runtime.documents.values()][0], edited = await runtime.edit({ documentId: entry.document.id, expectedVersion: entry.document.version, expectedRender: entry.render, op: { type: 'text', id: 'brand-text', content: 'Default edit' } });
  assert.equal(edited.saved, true);
  const saved = JSON.parse(await fs.readFile(runtime.projectPath, 'utf8'));
  assert.equal(saved.schemaVersion, 1); assert.match(JSON.stringify(saved.frames[0]), /Default edit/);
});

test('existing source disappearance is refused even when a direct load caller asks for initialization', async t => {
  const root = await fixture(t), file = path.join(root, 'project.divlet'), runtime = await openRuntime({ file, watch: false }); t.after(() => runtime.close());
  await fs.unlink(file); await assert.rejects(runtime.load({ requireSource: false, createDemo: true }), { code: 'NOT_FOUND' }); await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
});

test('failed initial HTML cannot choose a source format, manufacture an empty project or move authored inputs', async t => {
  const root = await fixture(t), input = path.join(root, 'too-large.html'), bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 32); await fs.writeFile(input, bytes);
  await assert.rejects(openRuntime({ cwd: root, watch: false }), { code: 'INVALID_PROJECT' });
  await assert.rejects(fs.lstat(path.join(root, 'project.divlet')), { code: 'ENOENT' }); assert.equal(hash(await fs.readFile(input)), hash(bytes)); assert.deepEqual(await fs.readdir(root), ['too-large.html']);
});

