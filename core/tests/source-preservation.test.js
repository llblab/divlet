import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { DivletRuntime, openRuntime } from '@divlet/core/runtime';
import { sampleFrame } from './fixtures/frame-portability.js';

async function sourceFixture(t, outputDir = null) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-source-open-'));
  const file = path.join(directory, 'authored.divlet');
  const { schemaVersion, ...frame } = sampleFrame();
  const source = JSON.stringify({ frames: [frame], metadata: { note: 'One\r\nTwo\ud800', version: 'opaque' }, outputDir, schemaVersion }, null, '\t').replace(/\n/g, '\r\n').replace('"Hello"', '"\\u0048ello"') + '\r\n \t';
  await fs.writeFile(file, source);
  const context = { directory, file, source, runtime: new DivletRuntime({ file, watch: false }) };
  t.after(async () => { await context.runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return context;
}

for (const outputDir of [null, 'build-cache']) test(`initial open preserves authored bytes while generating ${outputDir ?? 'default'} cache`, async t => {
  const { runtime, file, source } = await sourceFixture(t, outputDir);
  const before = await fs.lstat(file, { bigint: true });
  const sourceWrites = [];
  const write = runtime.atomicWrite.bind(runtime);
  runtime.atomicWrite = async (target, text) => { if (target === runtime.projectPath) sourceWrites.push(text); return write(target, text); };
  await runtime.start({ requireSource: true, createDemo: false });
  assert.deepEqual(await fs.readFile(file), Buffer.from(source));
  const after = await fs.lstat(file, { bigint: true });
  assert.deepEqual([after.ino, after.mtimeNs], [before.ino, before.mtimeNs], 'opening is not a same-byte source rewrite either');
  assert.deepEqual(sourceWrites, []);
  assert.equal(runtime.knownHashes.get(file), createHash('sha256').update(source).digest('hex'), 'the writer tracks authored disk text, not hypothetical serialization');
  assert.equal(runtime.read({ view: 'document', documentId: 'test' }).nodes.label.content, 'Hello');
  const entry = runtime.info().documents[0];
  assert.match(await fs.readFile(entry.htmlPath, 'utf8'), /Hello/);
  assert.equal(JSON.parse(await fs.readFile(entry.metaPath, 'utf8')).version, 1);
  assert.equal(entry.savedVersion, 1);
  const point = runtime.historyHead().pointId;
  await runtime.scan();
  assert.equal(runtime.revision, 1, 'the unchanged source does not echo as an external edit');
  assert.equal(runtime.history.length, 0);
  assert.equal(runtime.historyHead().pointId, point);
  assert.equal(await fs.readFile(file, 'utf8'), source);
});

test('a missing owned cache rebuilds on reopen without reserializing the source', async t => {
  const context = await sourceFixture(t);
  await context.runtime.start({ requireSource: true, createDemo: false });
  const outputDir = context.runtime.outputDir;
  await context.runtime.close();
  await fs.rm(outputDir, { recursive: true, force: true });
  context.runtime = await openRuntime({ file: context.file, watch: false, createDemo: false });
  assert.equal(await fs.readFile(context.file, 'utf8'), context.source);
  assert.match(await fs.readFile(context.runtime.info().documents[0].htmlPath, 'utf8'), /Hello/);
});

test('explicit edits, Undo and Redo still persist after a byte-preserving open', async t => {
  const { runtime, file, source } = await sourceFixture(t);
  await runtime.start({ requireSource: true, createDemo: false });
  await runtime.patch({ documentId: 'test', expectedVersion: 1, patch: { nodes: { label: { content: 'Edited' } } } });
  const edited = await fs.readFile(file, 'utf8');
  assert.notEqual(edited, source);
  assert.equal(JSON.parse(edited).frames[0].nodes.label.content, 'Edited');
  assert.equal(JSON.parse(edited).frames[0].version, 2);
  await runtime.undo();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).frames[0].nodes.label.content, 'Hello');
  await runtime.redo();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).frames[0].nodes.label.content, 'Edited');
  assert.equal(runtime.settings.metadata.note, 'One\r\nTwo\ud800');
});

for (const raceRead of [2, 3]) test(`cache-only source adoption refuses a race at source read ${raceRead}`, async t => {
  const { runtime, file } = await sourceFixture(t);
  const newest = '{"schemaVersion":1,"name":"Newer authored source","frames":[]}';
  let sourceReads = 0;
  const read = runtime.fileContents.bind(runtime);
  runtime.fileContents = async (target, ...args) => {
    if (target === runtime.projectPath && ++sourceReads === raceRead) await fs.writeFile(file, newest);
    return read(target, ...args);
  };
  await assert.rejects(runtime.start({ requireSource: true, createDemo: false }), { code: 'FILE_CONFLICT' });
  assert.equal(sourceReads, raceRead, 'both the initial and final writer checks remain active');
  assert.equal(await fs.readFile(file, 'utf8'), newest);
  assert.equal(runtime.documents.size, 0, 'the stale candidate never becomes accepted state');
  assert.equal(runtime.revision, 0);
});
