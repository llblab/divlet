// Node-ported BrowserRuntime composition only: browser byte admission remains a separate, closed capability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../lib/browser-runtime.ts';

const data = 'data:application/octet-stream;base64,AQID';
const compiler = { compile: () => '', unknown: () => ({}) };
const source = (src: string, assets = {}) => ({ schemaVersion: 1, assets, frames: [{
  id: 'index', name: 'Export proof', version: 1, rootId: 'root', artboard: { x: 0, y: 0, width: 300, height: 200 },
  nodes: { root: { id: 'root', type: 'element', tag: 'main', children: ['picture', 'label'] }, picture: { id: 'picture', type: 'element', tag: 'img', attrs: { src }, children: [] }, label: { id: 'label', type: 'text', content: 'A & B' } },
}] });
const state = (runtime: BrowserRuntime) => JSON.stringify({ source: runtime.source(), entries: [...runtime.documents], revision: runtime.revision, renderSeq: runtime.renderSeq, history: runtime.history, undo: runtime.undoStack, redo: runtime.redoStack });

for (const declared of [false, true]) test(`browser writer async full/fragment export uses ${declared ? 'Node-ported declared' : 'literal'} data without accepting a write`, async () => {
  const stored: string[] = [], events: string[] = [];
  const runtime = await BrowserRuntime.open({ source: source(declared ? 'asset:one' : data, declared ? { one: data, alias: data, unused: data } : {}), file: 'project.divlet', projectId: 'export-proof', compiler, persist: text => { stored.push(text); } });
  runtime.subscribe(type => events.push(type));
  const before = state(runtime);
  const pending = runtime.exportDocument('index', { expectedVersion: 1, expectedProjectVersion: 1 });
  assert.equal(typeof pending.then, 'function');
  const page = await pending;
  assert.equal(page.documentId, 'index'); assert.equal(page.version, 1); assert.equal(page.fileName, 'index.html');
  assert.ok(page.html.includes(`src="${data}"`)); assert.ok(page.html.includes('A &amp; B'));
  assert.ok(!page.html.includes('asset:')); assert.ok(!page.html.includes('data-divlet-id'));
  assert.ok(!page.html.includes('data-divlet-manifest')); assert.ok(!page.html.includes('divlet:connect'));
  const single = await runtime.exportDocument('index', { nodeId: 'picture' });
  assert.ok('nodeId' in single); assert.equal(single.nodeId, 'picture'); assert.equal(single.html, `<img src="${data}">\n`);
  const selected = await runtime.exportDocument('index', { nodeIds: ['picture', 'label'] });
  assert.ok('nodeIds' in selected); assert.deepEqual(selected.nodeIds, ['picture', 'label']); assert.equal(selected.html, `<img src="${data}">\n\nA &amp; B\n`);
  for (const options of [{ expectedVersion: 0 }, { expectedProjectVersion: 0 }]) await assert.rejects(runtime.exportDocument('index', options), { code: 'REVISION_CONFLICT' });
  for (const nodeIds of [[], ['missing'], Array(101).fill('picture')]) await assert.rejects(runtime.exportDocument('index', { nodeIds }), { code: 'NOT_FOUND' });
  assert.equal(state(runtime), before); assert.deepEqual(stored, []); assert.deepEqual(events, []);
  await runtime.close();
});

for (const [url, code] of [['asset:one?rev=1', 'UNSUPPORTED_EXPORT'], ['asset:missing', 'INVALID_ASSET']]) test(`Node-ported browser export refuses ${url} without changing accepted state`, async () => {
  const stored: string[] = [], events: string[] = [];
  const runtime = await BrowserRuntime.open({ source: source(url!, { one: data }), file: 'project.divlet', projectId: 'export-refusal', compiler, persist: text => { stored.push(text); } });
  runtime.subscribe(type => events.push(type));
  const before = state(runtime);
  for (const options of [{}, { nodeId: 'picture' }, { nodeIds: ['picture', 'label'] }]) await assert.rejects(runtime.exportDocument('index', options), { code });
  assert.equal(state(runtime), before); assert.deepEqual(stored, []); assert.deepEqual(events, []);
  await runtime.close();
});
