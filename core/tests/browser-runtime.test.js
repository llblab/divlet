// Shared vectors for the two project writers: the same contract tool calls run against the Node runtime and the browser
// runtime must produce the same models, versions, summaries, refusals, rendered pages and Undo/Redo outcomes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../lib/runtime.js';
import { BrowserRuntime } from '../lib/browser-runtime.ts';
import { runOnRuntime } from '../lib/tools.ts';
import { compileClasses, unknownClasses } from '../lib/engine.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const landing = await fs.readFile(path.join(root, 'examples/landing/landing.divlet'), 'utf8');
const engine = { compile: (tokens, candidates) => compileClasses(tokens, candidates, root), unknown: input => unknownClasses({ ...input, base: root }) };

async function pair() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-browser-runtime-'));
  const file = path.join(directory, 'landing.divlet');
  await fs.writeFile(file, landing);
  const node = await openRuntime({ file, watch: false, createDemo: false });
  const stored = [];
  const browser = await BrowserRuntime.open({ source: landing, file: 'landing.divlet', projectId: 'browser-copy', compiler: engine, persist: text => { stored.push(text); } });
  return { node, browser, stored, close: async () => { await node.close(); await browser.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

/** Run one call on both writers; both must succeed alike or refuse with the same code. */
async function both(writers, name, args) {
  const outcome = async runtime => { try { return { ok: true, value: await runOnRuntime(name, structuredClone(args), runtime) }; } catch (error) { return { ok: false, code: error.code, message: error.message }; } };
  const [node, browser] = [await outcome(writers.node), await outcome(writers.browser)];
  assert.equal(browser.ok, node.ok, `${name}: ${JSON.stringify(node.ok ? null : node.code)} vs ${JSON.stringify(browser.ok ? null : browser.code)} (${browser.message ?? node.message ?? ''})`);
  if (!node.ok) assert.equal(browser.code, node.code, `${name} refuses alike`);
  return { node: node.value, browser: browser.value, code: node.code };
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

test('the browser writer opens a project exactly as the Node runtime renders it', async () => {
  const writers = await pair();
  try {
    sameState(writers, 'open');
    const read = await both(writers, 'read_divlet', {});
    assert.deepEqual(read.browser.documents, read.node.documents.map(({ id, name, version, artboard, instances, components, usesFramesOf, componentUses, usedBy, metadata }) => JSON.parse(JSON.stringify({ id, name, version, artboard, instances, components, usesFramesOf, componentUses, usedBy, metadata }))));
    assert.equal(writers.browser.source(), landing, 'the serialized project is the source it opened');
  } finally { await writers.close(); }
});

test('patches, structural edits, components, frames, refusals and history agree step by step', async () => {
  const writers = await pair();
  try {
    const step = async (label, name, args) => { const result = await both(writers, name, args); if (result.node) assert.deepEqual(pick(result.browser, RESULT), pick(result.node, RESULT), `${label}: result`); sameState(writers, label); return result; };
    const frame = 'index';
    const v = () => writers.node.documents.get(frame).document.version;
    await step('text patch', 'patch_divlet', { frameId: frame, expectedVersion: v(), label: 'retitle', patch: { nodes: { 'text-11': { content: 'divlet in a browser' }, 'node-10': { style: { color: 'rgb(200, 0, 0)' } } } } });
    const stale = await step('stale patch', 'patch_divlet', { frameId: frame, expectedVersion: 1, patch: { name: 'x' } });
    assert.equal(stale.code, 'REVISION_CONFLICT');
    await step('no-op patch', 'patch_divlet', { frameId: frame, expectedVersion: v(), patch: { nodes: { 'text-11': { content: 'divlet in a browser' } } } });
    await step('insert', 'edit_divlet', { frameId: frame, expectedVersion: v(), op: { type: 'insert', parentId: 'node-2', index: 0, spec: { tag: 'p', className: 'eyebrow', text: 'Inserted from both writers' } } });
    await step('html insert', 'edit_divlet', { frameId: frame, expectedVersion: v(), op: { type: 'insert', parentId: 'node-2', index: 1, html: '<span class="pill" onclick="evil()">Safe <b>bold</b></span><script>alert(1)</script>' } });
    const inserted = writers.node.documents.get(frame).document.nodes['node-2'].children[0];
    await step('move', 'edit_divlet', { frameId: frame, expectedVersion: v(), op: { type: 'move', id: inserted, parentId: 'node-2', index: 2 } });
    await step('wrap', 'edit_divlet', { frameId: frame, expectedVersion: v(), op: { type: 'wrap', ids: [inserted] } });
    await step('bad op', 'edit_divlet', { frameId: frame, expectedVersion: v(), op: { type: 'remove', id: 'missing-node' } });
    await step('component', 'patch_divlet', { frameId: frame, expectedVersion: v(), patch: { nodes: { 'node-4': { reusable: true } } } });
    await step('new frame', 'frame_divlet', { action: 'create', name: 'Phone', width: 390, height: 844 });
    await step('instance', 'edit_divlet', { frameId: 'phone', expectedVersion: 1, op: { type: 'insert', parentId: 'root', spec: { ref: 'index/node-4' } } });
    await step('component edit rerenders dependents', 'patch_divlet', { frameId: frame, expectedVersion: v(), patch: { nodes: { 'text-11': { content: 'shared mark' } } } });
    await step('delete in use', 'frame_divlet', { action: 'delete', frameId: frame, expectedVersion: v() });
    await step('duplicate', 'frame_divlet', { action: 'duplicate', frameId: 'phone', expectedVersion: writers.node.documents.get('phone').document.version, width: 768 });
    await step('project tokens', 'patch_divlet', { expectedVersion: writers.node.settings.version, patch: { tokens: { '--brand': '#5b5bf0' }, css: ':root { --gap: 12px; }' } });
    await step('undo project', 'undo_divlet', {});
    await step('undo duplicate', 'undo_divlet', {});
    await step('redo duplicate', 'undo_divlet', { redo: true });
    await step('undo frame-scoped', 'undo_divlet', { frameId: frame });
    await step('mark', 'mark_divlet', { frameId: frame, nodeIds: ['node-2'], note: 'checking parity' });
    await step('mark unknown', 'mark_divlet', { frameId: frame, nodeIds: ['nope'] });
    await step('read nodes', 'read_divlet', { view: 'nodes', frameId: frame, query: 'shared', limit: 5 });
    const components = await both(writers, 'read_divlet', { view: 'components' });
    assert.deepEqual(components.browser, components.node);
    const history = await both(writers, 'read_divlet', { view: 'history', since: 2 });
    assert.deepEqual(history.browser.changes.map(change => change.summary), history.node.changes.map(change => change.summary.replace(' (its files are in divlet/.trash)', '')));
    assert.equal(history.browser.timeline.points.length, history.node.timeline.points.length);
    const frameRead = await both(writers, 'read_divlet', { view: 'frame', frameId: 'phone' });
    assert.deepEqual(frameRead.browser, frameRead.node);
    assert.equal(writers.browser.source(), await fs.readFile(writers.node.projectPath, 'utf8'), 'both writers serialize the same project');
    assert.equal(writers.stored.at(-1), writers.browser.source(), 'every accepted change reached the persistence callback');
  } finally { await writers.close(); }
});

test('the browser writer refuses what only the Node host can do, without changing state', async () => {
  const writers = await pair();
  try {
    const before = writers.browser.source();
    await assert.rejects(writers.browser.callTool('open_divlet', {}), error => error.code === 'UNKNOWN_TOOL');
    await assert.rejects(runOnRuntime('patch_divlet', { expectedVersion: 1, patch: { assets: { 'logo.png': 'data:image/png;base64,iVBORw0KGgo=' } } }, writers.browser), error => error.code === 'ASSETS_UNAVAILABLE');
    await assert.rejects(runOnRuntime('read_divlet', { view: 'site' }, writers.browser), error => error.code === 'NO_SITE');
    assert.equal(writers.browser.source(), before);
    assert.deepEqual(writers.browser.tools().map(tool => tool.name), ['read_divlet', 'patch_divlet', 'edit_divlet', 'frame_divlet', 'undo_divlet', 'mark_divlet']);
  } finally { await writers.close(); }
});

test('a failing store keeps the accepted change and reports a diagnostic', async () => {
  const browser = await BrowserRuntime.open({ source: landing, file: 'landing.divlet', projectId: 'p', compiler: engine, persist: () => { throw new Error('quota exceeded'); } });
  const version = browser.read({ view: 'document', documentId: 'index' }).version;
  const result = await runOnRuntime('patch_divlet', { frameId: 'index', expectedVersion: version, patch: { name: 'Renamed' } }, browser);
  assert.equal(result.version, version + 1);
  assert.deepEqual(browser.info().diagnostics.map(item => item.code), ['STORAGE_FAILED']);
  await browser.close();
});
