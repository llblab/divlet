import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeHtml } from '../lib/codec.ts';
import { openRuntime } from '../lib/runtime.js';
import { styleEngine, setStyleEngines } from '../lib/engine.ts';

test('the core runs with plain CSS when no style engine is installed', async t => {
  const engines = [styleEngine()];
  t.after(() => setStyleEngines(engines));
  setStyleEngines([]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-no-engine-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = await openRuntime({ file: path.join(root, 'project.divlet'), watch: false, createDemo: false });
  t.after(() => runtime.close?.());
  await runtime.create({ document: decodeHtml('<main id="root" class="card p-8"><p id="note">Hello</p></main>', { fallbackId: 'plain' }) });
  const info = runtime.info();
  assert.equal(info.documents.length, 1);
  assert.deepEqual(info.clientPlugins, []);
  const explained = await runtime.explainClasses({ documentId: 'plain', names: ['card', 'p-8'] });
  assert.deepEqual(explained.classes, {});
  assert.deepEqual((await runtime.suggestClasses({ documentId: 'plain', query: 'p-' })).items, []);
  const read = runtime.read({ view: 'frame', documentId: 'plain' });
  assert.match(JSON.stringify(read), /Hello/);
});
