import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument, applyDocumentPatch } from '../lib/model.ts';
import { sameDocument, settingsHistoryPatch } from '../lib/acceptance.ts';
import { validateSettings } from '../lib/project.ts';
import { documentHistoryPatch, matchesDocumentHistoryPatch, summarizeChange, captureHistoryNulls } from '../lib/diff.ts';
import type { DocumentHistoryPatch } from '../lib/diff.ts';
import { sampleFrame } from './fixtures/frame-portability.js';

function styled() {
  const frame = sampleFrame();
  return validateDocument({ ...frame, nodes: { ...frame.nodes, root: { ...frame.nodes.root, style: { 'padding-left': '20px', padding: '10px' } } } });
}

test('native order-only changes have snapshots and an honest history summary', () => {
  const before = styled(), after = structuredClone(before);
  const root = after.nodes.root;
  assert.equal(root?.type, 'element');
  if (root?.type !== 'element') throw new Error('fixture');
  root.style = { padding: '10px', 'padding-left': '20px' };
  assert.equal(sameDocument(before, after), false);
  const item = documentHistoryPatch(before, after);
  assert.deepEqual(item.forward, {}); assert.deepEqual(item.inverse, {});
  assert.deepEqual(item.styleBlocks?.[0]?.before, [['padding-left', '20px'], ['padding', '10px']]);
  assert.deepEqual(item.styleBlocks?.[0]?.after, [['padding', '10px'], ['padding-left', '20px']]);
  assert.equal(matchesDocumentHistoryPatch(before, item, false), true);
  assert.equal(matchesDocumentHistoryPatch(after, item, true), true);
  assert.deepEqual(summarizeChange(before, after).nodes.changed, { root: ['style'] });
});

test('opaque metadata named style retains unordered JSON equality', () => {
  const before = applyDocumentPatch(styled(), { metadata: { style: { first: 1, second: 2 } } });
  const after = { ...before, metadata: { style: { second: 2, first: 1 } } };
  assert.equal(sameDocument(before, after), true);
  assert.deepEqual(documentHistoryPatch(before, after), { forward: {}, inverse: {} });
  assert.equal(summarizeChange(before, after).text, 'no change');
});

test('native snapshots do not alias later mutations of their source maps', () => {
  const before = styled(), after = applyDocumentPatch(before, { nodes: { root: { style: { 'padding-left': null } } } });
  const item = documentHistoryPatch(before, after);
  if (before.nodes.root?.type !== 'element' || after.nodes.root?.type !== 'element') throw new Error('fixture');
  before.nodes.root.style.padding = '99px'; after.nodes.root.style.padding = '88px';
  assert.deepEqual(item.styleBlocks?.[0]?.before, [['padding-left', '20px'], ['padding', '10px']]);
  assert.deepEqual(item.styleBlocks?.[0]?.after, [['padding', '10px']]);
});

test('non-style edits keep their existing sparse per-field guard', () => {
  const before = styled(), after = applyDocumentPatch(before, { name: 'Renamed' });
  const item = documentHistoryPatch(before, after);
  assert.equal(item.styleBlocks, undefined);
  assert.equal(matchesDocumentHistoryPatch(applyDocumentPatch(after, { metadata: { later: true } }), item, true), true);
  assert.equal(matchesDocumentHistoryPatch(applyDocumentPatch(after, { name: 'Later' }), item, true), false);
});

test('node lifecycle snapshots own independent data and guard the complete nullable node', () => {
  const before = styled();
  if (before.nodes.root?.type !== 'element') throw new Error('fixture');
  before.nodes.root.metadata = { literal: null, nested: { value: null } };
  const after = validateDocument({ ...before, rootId: 'replacement', nodes: { replacement: { id: 'replacement', type: 'element', tag: 'aside', children: [] } } });
  const item = documentHistoryPatch(before, after);
  assert.equal(item.styleBlocks, undefined, 'whole-node data already owns its ordered styles');
  assert.equal(item.nodeBlocks?.length, Object.keys(before.nodes).length + 1);
  assert.equal(matchesDocumentHistoryPatch(before, item, false), true);
  assert.equal(matchesDocumentHistoryPatch(after, item, true), true);
  const block = item.nodeBlocks?.find(block => block.nodeId === 'root');
  assert.deepEqual(block?.before?.metadata, { literal: null, nested: { value: null } });
  before.nodes.root.metadata.literal = 'later';
  assert.deepEqual(block?.before?.metadata, { literal: null, nested: { value: null } });
  assert.equal(matchesDocumentHistoryPatch(before, item, false), false, 'null is data rather than the absence of a patch member');
});

test('nullable slot capture is independent and skips unchanged nulls and atomic arrays', () => {
  const before = validateDocument({ ...styled(), metadata: { slot: null, untouched: null, array: [null] } });
  const after = validateDocument({ ...before, metadata: { slot: { nested: { value: null } }, untouched: null, array: [null, 1] } });
  const item = documentHistoryPatch(before, after);
  assert.deepEqual(item.nullBlocks, [{ path: ['metadata', 'slot'], before: null, after: { nested: { value: null } } }]);
  const slot = after.metadata.slot;
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) throw new Error('fixture');
  slot.nested = 'later';
  assert.deepEqual(item.nullBlocks?.[0]?.after, { nested: { value: null } });
  const renamed = documentHistoryPatch(before, applyDocumentPatch(before, { name: 'Renamed' }));
  assert.equal(renamed.nullBlocks, undefined, 'unchanged nullable data must not turn disjoint edits into conflicts');
});

test('project snapshot producer limits nullable guards to metadata, not outputDir defaults', () => {
  const before = validateSettings({ metadata: { slot: null } });
  const after = validateSettings({ metadata: { slot: { literal: null } }, outputDir: 'build' });
  const item = settingsHistoryPatch(before, after);
  assert.deepEqual(item.nullBlocks, [{ path: ['metadata', 'slot'], before: null, after: { literal: null } }]);
  after.metadata.slot = 'later';
  assert.deepEqual(item.nullBlocks?.[0]?.after, { literal: null });
  assert.equal(settingsHistoryPatch(before, { ...before, name: 'Renamed', outputDir: 'build' }).nullBlocks, undefined);
});

test('shared nullable capture leaves caller-owned roots and paths untouched', () => {
  const path = ['metadata'], value: Record<string, unknown> = { literal: null };
  const roots = Object.freeze([Object.freeze([null, value, path] as const)]);
  const before = JSON.stringify(roots), blocks = captureHistoryNulls(roots);
  assert.equal(JSON.stringify(roots), before);
  path.push('later'); value.literal = 'later';
  assert.deepEqual(blocks, [{ path: ['metadata'], before: null, after: { literal: null } }]);
});

function readonlyHistoryContract(item: DocumentHistoryPatch) {
  const nullable = item.nullBlocks?.[0];
  if (nullable) {
    // @ts-expect-error Captured paths cannot be redirected.
    nullable.path.push('other');
    // @ts-expect-error Captured endpoints cannot be replaced.
    nullable.before = null;
  }
  const node = item.nodeBlocks?.[0];
  if (node) {
    // @ts-expect-error A lifecycle snapshot target cannot be redirected.
    node.nodeId = 'other';
    // @ts-expect-error A captured endpoint cannot be replaced.
    node.before = undefined;
  }
  const block = item.styleBlocks?.[0];
  if (!block?.before) return;
  // @ts-expect-error Session snapshot arrays are readonly.
  block.before.push(['color', 'red']);
  // @ts-expect-error Snapshot tuple values are readonly.
  block.before[0]![1] = 'red';
  // @ts-expect-error A location cannot be redirected after capture.
  block.nodeId = 'other';
}
void readonlyHistoryContract;
