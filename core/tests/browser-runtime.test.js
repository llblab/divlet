// Shared vectors for the two project writers: the same contract tool calls run against the Node runtime and the browser
// runtime must produce the same models, versions, summaries, refusals, rendered pages and Undo/Redo outcomes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '@divlet/core/runtime';
import { BrowserRuntime } from '../lib/browser-runtime.ts';
import { runOnRuntime } from '../lib/tools.ts';
import { compileClasses, unknownClasses } from '../lib/engine.ts';
import { parseNativeJson } from '../lib/model.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const landing = await fs.readFile(path.join(root, 'examples/landing/landing.divlet'), 'utf8');
const engine = { compile: (tokens, candidates) => compileClasses(tokens, candidates, root), unknown: input => unknownClasses({ ...input, base: root }) };

const editable = JSON.stringify({ schemaVersion: 1, frames: [{
  id: 'index', name: 'Editable parity', version: 1, artboard: { x: 0, y: 0, width: 390, height: 844 }, rootId: 'root',
  nodes: {
    root: { id: 'root', type: 'element', tag: 'main', children: ['content'] },
    content: { id: 'content', type: 'element', tag: 'section', children: ['mark'] },
    mark: { id: 'mark', type: 'element', tag: 'div', children: ['label'] },
    label: { id: 'label', type: 'text', content: 'Editable text' },
  },
}] });

async function pair(source = landing) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-browser-runtime-'));
  const file = path.join(directory, 'landing.divlet');
  await fs.writeFile(file, source);
  const node = await openRuntime({ file, watch: false, createDemo: false });
  const stored = [];
  const browser = await BrowserRuntime.open({ source, file: 'landing.divlet', projectId: 'browser-copy', compiler: engine, persist: text => { stored.push(text); } });
  return { node, browser, stored, close: async () => { await node.close(); await browser.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

/** Run one call on both writers; both must succeed alike or refuse with the same code. */
async function both(writers, name, args) {
  const outcome = async runtime => { try { return { ok: true, value: await runOnRuntime(name, structuredClone(args), runtime) }; } catch (error) { return { ok: false, code: error.code, message: error.message }; } };
  const [node, browser] = [await outcome(writers.node), await outcome(writers.browser)];
  assert.equal(browser.ok, node.ok, `${name}: ${JSON.stringify(node.ok ? null : node.code)} vs ${JSON.stringify(browser.ok ? null : browser.code)} (${browser.message ?? node.message ?? ''})`);
  if (!node.ok) assert.equal(browser.code, node.code, `${name} refuses alike`);
  return { ok: node.ok, node: node.value, browser: browser.value, code: node.code };
}

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value && key in value).map(key => [key, value[key]]));
const RESULT = ['documentId', 'version', 'revision', 'seq', 'summary', 'changedNodeIds', 'rerendered', 'saved', 'ids', 'removed', 'project'];

function sameState(writers, label) {
  const ids = [...writers.node.documents.keys()];
  assert.deepEqual([...writers.browser.documents.keys()], ids, `${label}: frame order`);
  assert.deepEqual(writers.browser.settings, writers.node.settings, `${label}: project settings`);
  for (const id of ids) {
    const [node, browser] = [writers.node.documents.get(id), writers.browser.documents.get(id)];
    assert.deepEqual(browser.document, node.document, `${label}: model of ${id}`);
    assert.equal(browser.html, node.html, `${label}: rendered page of ${id}`);
    assert.deepEqual(browser.uses, node.uses, `${label}: component uses of ${id}`);
  }
  assert.deepEqual(writers.browser.historyHead().canUndo, writers.node.historyHead().canUndo);
  // The Node host also says where a removed frame's generated files went; the browser host has no files.
  const log = runtime => runtime.history.map(change => [change.kind, change.documentId, change.summary.replace(' (its files are in divlet/.trash)', '')]);
  assert.deepEqual(log(writers.browser), log(writers.node), `${label}: action log`);
}

test('opt-in native text refusal does not silently replace draft readers or touch accepted writers', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-draft-json-'));
  const file = path.join(directory, 'draft.divlet');
  const source = '{"schemaVersion":1,"metadata":{"choice":"old","choice":"draft","zero":-0},"frames":[]}';
  let node, browser;
  const persisted = [];
  try {
    await fs.writeFile(file, source);
    node = await openRuntime({ file, watch: false, createDemo: false });
    browser = await BrowserRuntime.open({ source, file: 'draft.divlet', projectId: 'draft', persist: text => persisted.push(text) });
    const acceptedDisk = await fs.readFile(file, 'utf8');
    assert.equal(acceptedDisk, source, 'opening retains duplicate-key evidence until explicit profile conversion');
    assert.throws(() => parseNativeJson(source, { bytes: 1024, nesting: 8 }), { code: 'INVALID_JSON' });
    for (const runtime of [node, browser]) {
      assert.deepEqual(runtime.settings.metadata, { choice: 'draft', zero: -0 }, 'draft text readers remain unchanged until coherent cutover');
      assert.equal(runtime.revision, 1);
      assert.equal(runtime.history.length, 0);
    }
    assert.equal(await fs.readFile(file, 'utf8'), acceptedDisk, 'decoder refusal causes no additional disk publication');
    assert.deepEqual(persisted, [], 'refusal never publishes a browser candidate');
  } finally {
    await node?.close(); await browser?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the browser writer opens a project exactly as the Node runtime renders it', async () => {
  const writers = await pair();
  try {
    sameState(writers, 'open');
    const read = await both(writers, 'divlet_read', {});
    assert.deepEqual(read.browser.documents, read.node.documents.map(({ id, name, version, artboard, instances, components, usesFramesOf, componentUses, usedBy, metadata }) => JSON.parse(JSON.stringify({ id, name, version, artboard, instances, components, usesFramesOf, componentUses, usedBy, metadata }))));
    assert.equal(writers.browser.source(), landing, 'the serialized project is the source it opened');
  } finally { await writers.close(); }
});

test('patches, structural edits, components, frames, refusals and history agree step by step', async () => {
  const writers = await pair(editable);
  try {
    const step = async (label, name, args, error) => {
      const result = await both(writers, name, args);
      assert.equal(result.ok, !error, `${label}: expected ${error ?? 'success'}, received ${result.code ?? 'success'}`);
      if (error) assert.equal(result.code, error, label);
      else assert.deepEqual(pick(result.browser, RESULT), pick(result.node, RESULT), `${label}: result`);
      sameState(writers, label);
      return result;
    };
    const frame = 'index';
    const v = () => writers.node.documents.get(frame).document.version;
    await step('text patch', 'divlet_patch', { frameId: frame, expectedVersion: v(), label: 'retitle', patch: { nodes: { 'label': { content: 'divlet in a browser' }, 'mark': { style: { color: 'rgb(200, 0, 0)' } } } } });
    const stale = await step('stale patch', 'divlet_patch', { frameId: frame, expectedVersion: 1, patch: { name: 'x' } }, 'REVISION_CONFLICT');
    assert.equal(stale.code, 'REVISION_CONFLICT');
    await step('no-op patch', 'divlet_patch', { frameId: frame, expectedVersion: v(), patch: { nodes: { 'label': { content: 'divlet in a browser' } } } });
    await step('insert', 'divlet_edit', { frameId: frame, expectedVersion: v(), op: { type: 'insert', parentId: 'content', index: 0, spec: { tag: 'p', className: 'eyebrow', text: 'Inserted from both writers' } } });
    await step('html insert', 'divlet_edit', { frameId: frame, expectedVersion: v(), op: { type: 'insert', parentId: 'content', index: 1, html: '<span class="pill" onclick="evil()">Safe <b>bold</b></span><script>alert(1)</script>' } });
    const inserted = writers.node.documents.get(frame).document.nodes['content'].children[0];
    await step('move', 'divlet_edit', { frameId: frame, expectedVersion: v(), op: { type: 'move', id: inserted, parentId: 'content', index: 2 } });
    await step('wrap', 'divlet_edit', { frameId: frame, expectedVersion: v(), op: { type: 'wrap', ids: [inserted] } });
    await step('bad op', 'divlet_edit', { frameId: frame, expectedVersion: v(), op: { type: 'remove', id: 'missing-node' } }, 'NOT_FOUND');
    await step('component', 'divlet_patch', { frameId: frame, expectedVersion: v(), patch: { nodes: { 'mark': { reusable: true } } } });
    await step('new frame', 'divlet_frame_manage', { action: 'create', name: 'Phone', width: 390, height: 844 });
    await step('instance', 'divlet_edit', { frameId: 'phone', expectedVersion: 1, op: { type: 'insert', parentId: 'root', spec: { ref: 'index/mark' } } });
    await step('component edit rerenders dependents', 'divlet_patch', { frameId: frame, expectedVersion: v(), patch: { nodes: { 'label': { content: 'shared mark' } } } });
    await step('delete in use', 'divlet_frame_manage', { action: 'delete', frameId: frame, expectedVersion: v() }, 'COMPONENT_IN_USE');
    await step('duplicate', 'divlet_frame_manage', { action: 'duplicate', frameId: 'phone', expectedVersion: writers.node.documents.get('phone').document.version, width: 768 });
    await step('project tokens', 'divlet_patch', { expectedVersion: writers.node.settings.version, patch: { tokens: { '--brand': '#5b5bf0' }, css: ':root { --gap: 12px; }' } });
    await step('undo project', 'divlet_undo', {});
    await step('undo duplicate', 'divlet_undo', {});
    await step('redo duplicate', 'divlet_undo', { redo: true });
    await step('undo frame-scoped', 'divlet_undo', { frameId: frame });
    await step('mark', 'divlet_mark', { frameId: frame, nodeIds: ['content'], note: 'checking parity' });
    await step('mark unknown', 'divlet_mark', { frameId: frame, nodeIds: ['nope'] }, 'NOT_FOUND');
    await step('read nodes', 'divlet_read', { view: 'nodes', frameId: frame, query: 'shared', limit: 5 });
    const components = await both(writers, 'divlet_read', { view: 'components' });
    assert.deepEqual(components.browser, components.node);
    const history = await both(writers, 'divlet_read', { view: 'history', since: 2 });
    assert.deepEqual(history.browser.changes.map(change => change.summary), history.node.changes.map(change => change.summary.replace(' (its files are in divlet/.trash)', '')));
    assert.equal(history.browser.timeline.points.length, history.node.timeline.points.length);
    const frameRead = await both(writers, 'divlet_read', { view: 'frame', frameId: 'phone' });
    assert.deepEqual(frameRead.browser, frameRead.node);
    assert.equal(writers.browser.source(), await fs.readFile(writers.node.projectPath, 'utf8'), 'both writers serialize the same project');
    assert.equal(writers.stored.at(-1), writers.browser.source(), 'every accepted change reached the persistence callback');
  } finally { await writers.close(); }
});

test('shared replay keeps multi-step traversal atomic and preserves both writers on a late conflict', async () => {
  const writers = await pair(editable);
  try {
    const runtimes = [writers.node, writers.browser];
    const initialPoints = runtimes.map(runtime => runtime.historyHead().pointId);
    for (const runtime of runtimes) {
      await runtime.patch({ documentId: 'index', expectedVersion: runtime.getEntry('index').document.version, patch: { nodes: { 'label': { content: 'Grouped text' } } } });
      await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { name: 'Grouped project' } });
    }
    sameState(writers, 'two independent history groups');
    const endpoints = runtimes.map(runtime => runtime.historyHead().pointId);
    let stored = writers.stored.length;
    for (const runtime of runtimes) await runtime.undo({ steps: 2 });
    assert.equal(writers.stored.length, stored + 1, 'one browser persistence callback for the full traversal');
    assert.deepEqual(runtimes.map(runtime => runtime.historyHead().pointId), initialPoints);
    sameState(writers, 'multi-step Undo');
    stored = writers.stored.length;
    for (const runtime of runtimes) await runtime.redo({ steps: 2 });
    assert.equal(writers.stored.length, stored + 1);
    assert.deepEqual(runtimes.map(runtime => runtime.historyHead().pointId), endpoints);
    sameState(writers, 'multi-step Redo');
    for (const runtime of runtimes) await runtime.patch({ documentId: 'index', expectedVersion: runtime.getEntry('index').document.version, patch: { nodes: { 'label': { content: 'Later overlapping content' } } }, undoable: false });
    const snapshot = runtime => structuredClone({
      settings: runtime.settings, documents: [...runtime.documents].map(([id, item]) => [id, item.document, item.render, item.html]),
      selection: runtime.selection, revision: runtime.revision, history: runtime.history,
      undo: runtime.undoStack, redo: runtime.redoStack, timeline: runtime.readTimeline(),
    });
    const before = runtimes.map(snapshot), disk = await fs.readFile(writers.node.projectPath, 'utf8'), browserSource = writers.browser.source();
    stored = writers.stored.length;
    for (let i = 0; i < runtimes.length; i++) {
      await assert.rejects(runtimes[i].undo({ steps: 2 }), error => error.code === 'CANNOT_UNDO' && /Later changes touched the same content/.test(error.message));
      assert.deepEqual(snapshot(runtimes[i]), before[i], 'the candidate project-field prefix does not become accepted or move stack/point authority');
    }
    assert.equal(writers.stored.length, stored);
    assert.equal(writers.browser.source(), browserSource);
    assert.equal(await fs.readFile(writers.node.projectPath, 'utf8'), disk);
    sameState(writers, 'refused multi-step traversal');
  } finally { await writers.close(); }
});

test('the browser writer refuses what only the Node host can do, without changing state', async () => {
  const writers = await pair();
  try {
    const before = writers.browser.source();
    for (const name of ['divlet_open', 'open_divlet', 'create_frame', 'unknown']) await assert.rejects(writers.browser.callTool(name, {}), error => error.code === 'UNKNOWN_TOOL');
    assert.deepEqual(await writers.browser.callTool('read_divlet', {}), await writers.browser.callTool('divlet_read', {}));
    await assert.rejects(runOnRuntime('divlet_patch', { expectedVersion: 1, patch: { assets: { 'logo.png': 'data:image/png;base64,iVBORw0KGgo=' } } }, writers.browser), error => error.code === 'ASSETS_UNAVAILABLE');
    await assert.rejects(runOnRuntime('divlet_read', { view: 'site' }, writers.browser), error => error.code === 'NO_SITE');
    assert.equal(writers.browser.source(), before);
    assert.deepEqual(writers.browser.tools().map(tool => tool.name), ['divlet_read', 'divlet_patch', 'divlet_edit', 'divlet_frame_manage', 'divlet_undo', 'divlet_mark']);
  } finally { await writers.close(); }
});

test('a failing store keeps the accepted change and reports a diagnostic', async () => {
  const browser = await BrowserRuntime.open({ source: landing, file: 'landing.divlet', projectId: 'p', compiler: engine, persist: () => { throw new Error('quota exceeded'); } });
  const version = browser.read({ view: 'document', documentId: 'index' }).version;
  const result = await browser.callTool('patch_divlet', { frameId: 'index', expectedVersion: version, patch: { name: 'Renamed' } });
  assert.equal(result.version, version + 1);
  assert.deepEqual(browser.info().diagnostics.map(item => item.code), ['STORAGE_FAILED']);
  await browser.close();
});
