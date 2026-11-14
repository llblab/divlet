// Host-independent replay witnesses: expected endpoints are authored here, not obtained from a second replay algorithm.
const frame = id => ({ schemaVersion: 1, id, name: id, version: 5, artboard: { x: 0, y: 0, width: 200, height: 100 }, rootId: 'root', nodes: {
  root: { id: 'root', type: 'element', tag: 'main', style: { 'padding-left': '20px', padding: '10px' }, children: ['label'] },
  label: { id: 'label', type: 'text', content: 'Alpha' },
} });
function context(api, ids = ['a']) {
  const { frames, settings } = api.readProject({ schemaVersion: 1, version: 7, name: 'Project', frames: ids.map(frame) });
  return { frames: new Map(frames.map(document => [document.id, document])), settings };
}
const patch = (documentId, from, to) => ({ type: 'patch', documentId, inverse: { nodes: { label: { content: from } } }, forward: { nodes: { label: { content: to } } } });
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
function replay(api, before, items, direction) {
  for (const document of before.frames.values()) freeze(document);
  freeze(before.settings); freeze(items);
  const input = () => JSON.stringify([[...before.frames], before.settings, items]);
  const snapshot = input();
  try { return api.replayHistory(before.frames, before.settings, items, direction); }
  finally { if (input() !== snapshot) throw new Error('History replay mutated its source map, documents, settings or items'); }
}
const endpoint = candidate => ({ ids: [...candidate.frames.keys()], versions: [...candidate.frames.values()].map(document => document.version), text: [...candidate.frames.values()].map(document => document.nodes.label.content), settingsVersion: candidate.settings.version });

function overrideContext(api, descendants) {
  const source = frame('a'); source.nodes.root.children = ['definition', 'instance'];
  source.nodes.definition = { id: 'definition', type: 'element', tag: 'section', reusable: true, children: ['label'], style: { padding: '10px', color: 'black' } };
  source.nodes.instance = { id: 'instance', type: 'ref', ref: 'a/definition', descendants };
  const admitted = api.readProject({ schemaVersion: 1, frames: [source] });
  return { frames: new Map([['a', admitted.frames[0]]]), settings: admitted.settings };
}

function styleStep(api, before, patch) {
  const after = { ...api.applyDocumentPatch(before, patch), version: before.version + 1 };
  return { after, item: { type: 'patch', documentId: before.id, ...api.documentHistoryPatch(before, after) } };
}

export function literalStyleReplay(api) {
  const before = context(api), original = before.frames.get('a');
  const { after, item } = styleStep(api, original, { nodes: { root: { style: { 'padding-left': null } } } });
  const removed = { ...before, frames: new Map([['a', after]]) };
  const restored = replay(api, removed, [item], 'undo');
  const redone = replay(api, restored, [item], 'redo');
  return [original, after, restored.frames.get('a'), redone.frames.get('a')];
}

export const historyReplayCases = [
  { name: 'project transaction planning proves mixed settings/style/membership/order replay', expected: { types: ['project', 'patch', 'delete', 'create', 'order'], redo: ['d', 'c', 'a'], undo: ['a', 'b', 'c'], style: [['padding', '10px'], ['padding-left', '20px']], createdMetadata: { literal: null } }, run: api => {
    const before = context(api, ['a', 'b', 'c']), original = before.frames.get('a');
    const changed = api.validateDocument({ ...original, nodes: { ...original.nodes, root: { ...original.nodes.root, style: { padding: '10px', 'padding-left': '20px' } } } });
    const created = api.validateDocument({ ...frame('d'), metadata: { literal: null } });
    const next = new Map([['d', created], ['c', before.frames.get('c')], ['a', changed]]), settings = { ...before.settings, name: 'Next' };
    const items = api.projectHistoryItems(before.frames, before.settings, next, settings);
    const bytes = JSON.stringify([[...before.frames], before.settings, [...next], settings, items]);
    api.assertProjectHistoryRoundTrip(before.frames, before.settings, next, settings, items);
    if (JSON.stringify([[...before.frames], before.settings, [...next], settings, items]) !== bytes) throw new Error('Transaction proof mutated its inputs');
    const redo = replay(api, before, items, 'redo'), undo = replay(api, redo, items, 'undo');
    return { types: items.map(item => item.type), redo: [...redo.frames.keys()], undo: [...undo.frames.keys()], style: Object.entries(redo.frames.get('a').nodes.root.style), createdMetadata: redo.frames.get('d').metadata };
  } },
  { name: 'transaction proof refuses lossy project metadata null', error: 'UNSUPPORTED_SOURCE_REPLAY', run: api => {
    const before = context(api), nextSettings = { ...before.settings, metadata: { literal: null } };
    return api.assertProjectHistoryRoundTrip(before.frames, before.settings, before.frames, nextSettings, api.projectHistoryItems(before.frames, before.settings, before.frames, nextSettings));
  } },
  { name: 'transaction proof retains node lifecycle metadata and override nulls', expected: { metadata: { literal: null }, attrs: { title: null }, style: [['padding', null]] }, run: api => {
    const before = overrideContext(api, { definition: { style: { padding: null }, attrs: { title: null } } }), frame = before.frames.get('a');
    const original = api.validateDocument({ ...frame, nodes: { ...frame.nodes, instance: { ...frame.nodes.instance, metadata: { literal: null } } } });
    const previous = new Map([['a', original]]), removed = api.applyDocumentPatch(original, { nodes: { root: { children: ['definition'] }, instance: null } }), next = new Map([['a', removed]]);
    const items = api.projectHistoryItems(previous, before.settings, next, before.settings);
    api.assertProjectHistoryRoundTrip(previous, before.settings, next, before.settings, items);
    const restored = replay(api, { ...before, frames: next }, items, 'undo').frames.get('a').nodes.instance;
    return { metadata: restored.metadata, attrs: restored.descendants.definition.attrs, style: Object.entries(restored.descendants.definition.style) };
  } },
  ...['element', 'text'].map(type => ({ name: `${type} lifecycle restores nested null data without snapshot aliasing`, expected: { literal: null, nested: { value: null }, array: [null, { value: null }] }, run: api => {
    const before = context(api), frame = before.frames.get('a'), id = type === 'element' ? 'root' : 'label';
    const original = api.validateDocument({ ...frame, nodes: { ...frame.nodes, [id]: { ...frame.nodes[id], metadata: { literal: null, nested: { value: null }, array: [null, { value: null }] } } } });
    const removed = api.validateDocument({ ...frame, rootId: 'replacement', nodes: { replacement: { id: 'replacement', type: 'element', tag: 'aside', children: [] } } });
    const item = { type: 'patch', documentId: 'a', ...api.documentHistoryPatch(original, removed) };
    // Captured lifecycle records are independent data; later source mutation cannot alter them.
    original.nodes[id].metadata.nested.value = 'later';
    const restored = replay(api, { ...before, frames: new Map([['a', removed]]) }, [item], 'undo');
    const node = restored.frames.get('a').nodes[id];
    node.metadata.nested.value = 'mutated candidate';
    const again = replay(api, { ...before, frames: new Map([['a', removed]]) }, [item], 'undo');
    return again.frames.get('a').nodes[id].metadata;
  } })),
  { name: 'lifecycle guard refuses later stored-null changes to the captured node', error: 'CANNOT_UNDO', run: api => {
    const before = context(api), original = before.frames.get('a');
    const step = styleStep(api, original, { nodes: { root: { children: [] }, label: null } });
    const restored = replay(api, { ...before, frames: new Map([['a', step.after]]) }, [step.item], 'undo');
    const frame = restored.frames.get('a');
    const later = api.validateDocument({ ...frame, nodes: { ...frame.nodes, label: { ...frame.nodes.label, metadata: { literal: null } } } });
    return replay(api, { ...before, frames: new Map([['a', later]]) }, [step.item], 'redo');
  } },
  { name: 'lifecycle guard refuses value-equal reordered style blocks', error: 'CANNOT_UNDO', run: api => {
    const before = context(api), original = before.frames.get('a');
    const replacement = api.validateDocument({ ...original, rootId: 'replacement', nodes: { replacement: { id: 'replacement', type: 'element', tag: 'aside', children: [] } } });
    const item = { type: 'patch', documentId: 'a', ...api.documentHistoryPatch(replacement, original) };
    const later = api.validateDocument({ ...original, nodes: { ...original.nodes, root: { ...original.nodes.root, style: { padding: '10px', 'padding-left': '20px' } } } });
    return replay(api, { ...before, frames: new Map([['a', later]]) }, [item], 'undo');
  } },
  { name: 'lifecycle replay retains unrelated later fields on surviving nodes', expected: { literal: null, later: 'retained' }, run: api => {
    const before = context(api), frame = before.frames.get('a');
    const original = api.validateDocument({ ...frame, nodes: { ...frame.nodes, label: { ...frame.nodes.label, metadata: { literal: null } } } });
    const step = styleStep(api, original, { nodes: { root: { children: [] }, label: null } });
    const later = api.applyDocumentPatch(step.after, { nodes: { root: { attrs: { title: 'retained' } } } });
    const restored = replay(api, { ...before, frames: new Map([['a', later]]) }, [step.item], 'undo').frames.get('a');
    return { ...restored.nodes.label.metadata, later: restored.nodes.root.attrs.title };
  } },
  { name: 'restored lifecycle snapshots still require final model admission', error: 'INVALID_DOCUMENT', run: api => {
    const before = context(api), step = styleStep(api, before.frames.get('a'), { nodes: { root: { children: [] }, label: null } });
    const item = structuredClone(step.item); item.nodeBlocks[0].before.id = 'wrong';
    return replay(api, { ...before, frames: new Map([['a', step.after]]) }, [item], 'undo');
  } },
  { name: 'lifecycle snapshots do not bypass ordinary patch admission', error: 'INVALID_DOCUMENT', run: api => {
    const before = context(api), step = styleStep(api, before.frames.get('a'), { nodes: { root: { children: [] }, label: null } });
    const item = { ...step.item, forward: { ...step.item.forward, id: 'other' }, inverse: { ...step.item.inverse, id: 'a' } };
    return replay(api, before, [item], 'redo');
  } },
  { name: 'transaction proof retains opaque null changes within retained nodes', expected: { literal: null }, run: api => {
    const before = context(api), frame = before.frames.get('a');
    const changed = api.validateDocument({ ...frame, nodes: { ...frame.nodes, label: { ...frame.nodes.label, metadata: { literal: null } } } }), next = new Map([['a', changed]]);
    const items = api.projectHistoryItems(before.frames, before.settings, next, before.settings);
    api.assertProjectHistoryRoundTrip(before.frames, before.settings, next, before.settings, items);
    return replay(api, before, items, 'redo').frames.get('a').nodes.label.metadata;
  } },
  ...[
    ['absence', {}, { slot: null }],
    ['prototype-named own member', {}, { toString: null }],
    ['deletion', { slot: null }, {}],
    ['scalar', { slot: null }, { slot: false }],
    ['record', { slot: null }, { slot: { literal: null, nested: { value: null } } }],
    ['array', { slot: null }, { slot: [null, { value: null }] }],
    ['new subtree', {}, { slot: { literal: null } }],
    ['removed subtree', { slot: { literal: null } }, {}],
    ['scalar to record', { slot: 'text' }, { slot: { length: null } }],
    ['record to array', { slot: { length: null } }, { slot: [null] }],
  ].map(([name, from, to]) => ({ name: `nullable data slots replay ${name} without interpreting null as deletion`, expected: { undo: from, redo: to }, run: api => {
    const before = context(api), frame = before.frames.get('a');
    const original = api.validateDocument({ ...frame, metadata: from }), after = api.validateDocument({ ...frame, metadata: to });
    const item = { type: 'patch', documentId: 'a', ...api.documentHistoryPatch(original, after) };
    const redo = replay(api, { ...before, frames: new Map([['a', original]]) }, [item], 'redo');
    const undo = replay(api, redo, [item], 'undo');
    return { undo: undo.frames.get('a').metadata, redo: redo.frames.get('a').metadata };
  } })),
  ...[
    ['creation', {}, { definition: { attrs: { title: null }, metadata: { literal: null }, style: { padding: null } } }],
    ['removal', { definition: { attrs: { title: null }, metadata: { literal: null }, style: { padding: null } } }, {}],
    ['container omission', { definition: { attrs: { title: null } } }, { definition: {} }],
    ['value replacement', { definition: { attrs: { title: null }, metadata: { literal: null } } }, { definition: { attrs: { title: 'Changed' }, metadata: { literal: 'Changed' } } }],
  ].map(([name, from, to]) => ({ name: `nullable override ${name} composes attribute/metadata and style history`, expected: { undo: from, redo: to }, run: api => {
    const before = overrideContext(api, from), frame = before.frames.get('a');
    const after = api.validateDocument({ ...frame, nodes: { ...frame.nodes, instance: { ...frame.nodes.instance, descendants: to } } });
    const item = { type: 'patch', documentId: 'a', ...api.documentHistoryPatch(frame, after) };
    const redo = replay(api, before, [item], 'redo'), undo = replay(api, redo, [item], 'undo');
    return { undo: undo.frames.get('a').nodes.instance.descendants, redo: redo.frames.get('a').nodes.instance.descendants };
  } })),
  { name: 'node lifecycle treats prototype-named IDs as own data slots', expected: { id: 'toString', metadata: { literal: null } }, run: api => {
    const before = context(api), frame = before.frames.get('a');
    const original = api.validateDocument({ ...frame, nodes: { ...frame.nodes, root: { ...frame.nodes.root, children: ['label', 'toString'] }, toString: { id: 'toString', type: 'text', content: 'Literal', metadata: { literal: null } } } });
    const after = frame;
    const item = { type: 'patch', documentId: 'a', ...api.documentHistoryPatch(original, after) };
    const redo = replay(api, { ...before, frames: new Map([['a', original]]) }, [item], 'redo'), undo = replay(api, redo, [item], 'undo');
    const node = undo.frames.get('a').nodes.toString;
    return { id: node.id, metadata: node.metadata };
  } },
  { name: 'nullable data slots preserve disjoint later metadata leaves', expected: { slot: null, sibling: 'later' }, run: api => {
    const before = context(api), frame = before.frames.get('a');
    const original = api.validateDocument({ ...frame, metadata: { slot: null } });
    const step = styleStep(api, original, { metadata: { slot: 'Changed' } });
    const later = api.applyDocumentPatch(step.after, { metadata: { sibling: 'later' } });
    return replay(api, { ...before, frames: new Map([['a', later]]) }, [step.item], 'undo').frames.get('a').metadata;
  } },
  { name: 'nullable replacement refuses later changes inside its captured record', error: 'CANNOT_UNDO', run: api => {
    const before = context(api), frame = before.frames.get('a');
    const original = api.validateDocument({ ...frame, metadata: { slot: null } });
    const step = styleStep(api, original, { metadata: { slot: { value: 'Changed' } } });
    const later = api.applyDocumentPatch(step.after, { metadata: { slot: { sibling: 'later' } } });
    return replay(api, { ...before, frames: new Map([['a', later]]) }, [step.item], 'undo');
  } },
  { name: 'null slot guards distinguish a missing key from actual null data', error: 'CANNOT_UNDO', run: api => {
    const before = context(api), frame = before.frames.get('a');
    const original = api.validateDocument({ ...frame, metadata: { slot: null } }), after = api.validateDocument({ ...frame, metadata: {} });
    const item = { type: 'patch', documentId: 'a', ...api.documentHistoryPatch(original, after) };
    return replay(api, { ...before, frames: new Map([['a', original]]) }, [item], 'undo');
  } },
  { name: 'restored nullable slots still require final model admission', error: 'INVALID_DOCUMENT', run: api => {
    const before = context(api), frame = before.frames.get('a');
    const original = api.validateDocument({ ...frame, metadata: { slot: null } });
    const step = styleStep(api, original, { metadata: { slot: 'Changed' } });
    const item = structuredClone(step.item); item.nullBlocks[0].before = Infinity;
    return replay(api, { ...before, frames: new Map([['a', step.after]]) }, [item], 'undo');
  } },
  { name: 'nullable slots do not bypass ordinary patch admission', error: 'INVALID_DOCUMENT', run: api => {
    const before = context(api), frame = before.frames.get('a');
    const original = api.validateDocument({ ...frame, metadata: { slot: null } });
    const step = styleStep(api, original, { metadata: { slot: 'Changed' } });
    const item = { ...step.item, forward: { ...step.item.forward, id: 'other' }, inverse: { ...step.item.inverse, id: 'a' } };
    return replay(api, { ...before, frames: new Map([['a', original]]) }, [item], 'redo');
  } },
  { name: 'transaction proof retains untouched metadata null through a style change', expected: { literal: null }, run: api => {
    const before = context(api), frame = before.frames.get('a');
    const original = api.validateDocument({ ...frame, metadata: { literal: null } }), previous = new Map([['a', original]]);
    const next = new Map([['a', api.applyDocumentPatch(original, { nodes: { root: { style: { padding: '12px' } } } })]]);
    api.assertProjectHistoryRoundTrip(previous, before.settings, next, before.settings, api.projectHistoryItems(previous, before.settings, next, before.settings));
    return next.get('a').metadata;
  } },
  { name: 'transaction proof refuses a missing order-only history item', error: 'UNSUPPORTED_SOURCE_REPLAY', run: api => {
    const before = context(api), frame = before.frames.get('a');
    const next = new Map([['a', api.validateDocument({ ...frame, nodes: { ...frame.nodes, root: { ...frame.nodes.root, style: { padding: '10px', 'padding-left': '20px' } } } })]]);
    return api.assertProjectHistoryRoundTrip(before.frames, before.settings, next, before.settings, []);
  } },

  { name: 'literal whole-block history restores order and repeats in both directions', expected: { styles: [[['padding-left', '20px'], ['padding', '10px']], [['padding', '10px']], [['padding-left', '20px'], ['padding', '10px']], [['padding', '10px']]], versions: [5, 6, 7, 8] }, run: api => {
    const documents = literalStyleReplay(api);
    return { styles: documents.map(document => Object.entries(document.nodes.root.style)), versions: documents.map(document => document.version) };
  } },
  { name: 'value-equal traversal still commits a changed declaration order', expected: { style: [['padding-left', '20px'], ['padding', '10px']], identity: false, version: 8 }, run: api => {
    const before = context(api), original = before.frames.get('a');
    const first = styleStep(api, original, { nodes: { root: { style: { 'padding-left': null } } } });
    const second = styleStep(api, first.after, { nodes: { root: { style: { 'padding-left': '20px' } } } });
    const current = { ...before, frames: new Map([['a', second.after]]) };
    const undo = replay(api, current, [first.item, second.item], 'undo').frames.get('a');
    return { style: Object.entries(undo.nodes.root.style), identity: undo === second.after, version: undo.version };
  } },
  { name: 'later edits in the same style block refuse without erasing another property', error: 'CANNOT_UNDO', run: api => {
    const before = context(api), step = styleStep(api, before.frames.get('a'), { nodes: { root: { style: { 'padding-left': null } } } });
    const later = api.applyDocumentPatch(step.after, { nodes: { root: { style: { 'padding-right': '30px' } } } });
    return replay(api, { ...before, frames: new Map([['a', later]]) }, [step.item], 'undo');
  } },
  { name: 'order-only later edits are overlapping native style changes', error: 'CANNOT_UNDO', run: api => {
    const before = context(api), step = styleStep(api, before.frames.get('a'), { nodes: { root: { style: { padding: '12px' } } } });
    const later = api.validateDocument({ ...step.after, nodes: { ...step.after.nodes, root: { ...step.after.nodes.root, style: { padding: '12px', 'padding-left': '20px' } } } });
    return replay(api, { ...before, frames: new Map([['a', later]]) }, [step.item], 'undo');
  } },
  { name: 'unrelated metadata survives whole-style-block replay', expected: { style: [['padding-left', '20px'], ['padding', '10px']], metadata: { later: true } }, run: api => {
    const before = context(api), step = styleStep(api, before.frames.get('a'), { nodes: { root: { style: { 'padding-left': null } } } });
    const later = api.applyDocumentPatch(step.after, { metadata: { later: true } });
    const undo = replay(api, { ...before, frames: new Map([['a', later]]) }, [step.item], 'undo').frames.get('a');
    return { style: Object.entries(undo.nodes.root.style), metadata: undo.metadata };
  } },
  { name: 'whole override blocks restore stored-null operations, not sparse deletions', expected: [[['padding', null], ['color', 'red']], [['padding', '4px'], ['color', 'red']]], run: api => {
    const before = overrideContext(api, { definition: { style: { padding: null, color: 'red' } } }), original = before.frames.get('a');
    const step = styleStep(api, original, { nodes: { instance: { descendants: { definition: { style: { padding: '4px' } } } } } });
    const current = { ...before, frames: new Map([['a', step.after]]) };
    const undo = replay(api, current, [step.item], 'undo');
    const redo = replay(api, undo, [step.item], 'redo');
    return [undo, redo].map(value => Object.entries(value.frames.get('a').nodes.instance.descendants.definition.style));
  } },
  ...[{}, { definition: {} }, { definition: { style: {} } }].map((descendants, index) => ({
    name: `override absent/empty containers replay exactly (${index})`, expected: { undo: descendants, redo: { definition: { style: { padding: null } } } }, run: api => {
      const before = overrideContext(api, descendants), original = before.frames.get('a');
      const after = api.validateDocument({ ...original, nodes: { ...original.nodes, instance: { ...original.nodes.instance, descendants: { definition: { style: { padding: null } } } } } });
      const item = { type: 'patch', documentId: 'a', ...api.documentHistoryPatch(original, after) };
      const current = { ...before, frames: new Map([['a', after]]) };
      const undo = replay(api, current, [item], 'undo'), redo = replay(api, undo, [item], 'redo');
      return { undo: undo.frames.get('a').nodes.instance.descendants, redo: redo.frames.get('a').nodes.instance.descendants };
    },
  })),
  { name: 'whole-node patch creation and removal retain stored-null style operations', expected: { removed: false, restored: [['padding', null], ['color', 'red']] }, run: api => {
    const before = overrideContext(api, { definition: { style: { padding: null, color: 'red' } } }), original = before.frames.get('a');
    const step = styleStep(api, original, { nodes: { root: { children: ['definition'] }, instance: null } });
    const current = { ...before, frames: new Map([['a', step.after]]) };
    const undo = replay(api, current, [step.item], 'undo'), redo = replay(api, undo, [step.item], 'redo');
    return { removed: Object.hasOwn(redo.frames.get('a').nodes, 'instance'), restored: Object.entries(undo.frames.get('a').nodes.instance.descendants.definition.style) };
  } },
  { name: 'style snapshots do not bypass ordinary patch-field admission', error: 'INVALID_DOCUMENT', run: api => {
    const before = context(api), step = styleStep(api, before.frames.get('a'), { nodes: { root: { style: { padding: '12px' } } } });
    const item = { ...step.item, forward: { ...step.item.forward, id: 'other' }, inverse: { ...step.item.inverse, id: 'a' } };
    return replay(api, before, [item], 'redo');
  } },
  { name: 'lifecycle replay refuses value-equal changed declaration order', error: 'CANNOT_UNDO', run: api => {
    const before = context(api), original = before.frames.get('a');
    const current = api.validateDocument({ ...original, nodes: { ...original.nodes, root: { ...original.nodes.root, style: { padding: '10px', 'padding-left': '20px' } } } });
    return replay(api, { ...before, frames: new Map([['a', current]]) }, [{ type: 'create', documentId: 'a', document: original }], 'undo');
  } },
  { name: 'a late whole-block conflict cannot leak an earlier replay item', error: 'CANNOT_UNDO', run: api => {
    const before = context(api), step = styleStep(api, before.frames.get('a'), { nodes: { root: { style: { padding: '12px' } } } });
    const current = api.applyDocumentPatch(step.after, { nodes: { root: { style: { color: 'red' } } } });
    return replay(api, { ...before, frames: new Map([['a', current]]) }, [step.item, patch('a', 'Beta', 'Alpha')], 'undo');
  } },

  { name: 'grouped patches replay forward once and undo in reverse, one version per endpoint', expected: {
    redo: { ids: ['a'], versions: [6], text: ['Gamma'], settingsVersion: 7 }, undo: { ids: ['a'], versions: [7], text: ['Alpha'], settingsVersion: 7 },
  }, run: api => {
    const before = context(api), items = [patch('a', 'Alpha', 'Beta'), patch('a', 'Beta', 'Gamma')];
    const redo = replay(api, before, items, 'redo'), undo = replay(api, redo, items, 'undo');
    return { redo: endpoint(redo), undo: endpoint(undo) };
  } },
  { name: 'multi-frame patches coalesce each touched version independently', expected: { ids: ['a', 'b'], versions: [6, 6], text: ['A', 'B'], settingsVersion: 7 }, run: api => endpoint(replay(api, context(api, ['a', 'b']), [patch('a', 'Alpha', 'A'), patch('b', 'Alpha', 'B')], 'redo')) },
  { name: 'net-zero traversal retains document identity and version', expected: { identity: true, version: 5, settingsVersion: 7 }, run: api => {
    const before = context(api), next = replay(api, before, [patch('a', 'Alpha', 'Beta'), patch('a', 'Beta', 'Alpha')], 'redo');
    return { identity: next.frames.get('a') === before.frames.get('a'), version: next.frames.get('a').version, settingsVersion: next.settings.version };
  } },
  { name: 'project patches coalesce version and replay both directions', expected: { redo: ['Third', 8], undo: ['Project', 9] }, run: api => {
    const before = context(api), items = [
      { type: 'project', inverse: { name: 'Project' }, forward: { name: 'Second' } },
      { type: 'project', inverse: { name: 'Second' }, forward: { name: 'Third' } },
    ];
    const redo = replay(api, before, items, 'redo'), undo = replay(api, redo, items, 'undo');
    return { redo: [redo.settings.name, redo.settings.version], undo: [undo.settings.name, undo.settings.version] };
  } },
  { name: 'null output directory matches normalized absence during replay', expected: { undo: ['build', 8], redo: [null, 9] }, run: api => {
    const before = context(api), items = [{ type: 'project', inverse: { outputDir: 'build' }, forward: { outputDir: null } }];
    const undo = replay(api, before, items, 'undo'), redo = replay(api, undo, items, 'redo');
    return { undo: [undo.settings.outputDir, undo.settings.version], redo: [redo.settings.outputDir, redo.settings.version] };
  } },
  { name: 'create and delete replay restore original frame slots', expected: { created: ['a', 'b', 'c'], undone: ['a', 'c'], deleted: ['a', 'c'], restored: ['a', 'b', 'c'], restoredStyle: [['padding-left', '20px'], ['padding', '10px']] }, run: api => {
    const before = context(api, ['a', 'c']), document = api.validateDocument(frame('b'));
    const create = [{ type: 'create', documentId: 'b', index: 1, document }];
    const created = replay(api, before, create, 'redo'), undone = replay(api, created, create, 'undo');
    const remove = [{ type: 'delete', documentId: 'b', index: 1, document }];
    const deleted = replay(api, created, remove, 'redo'), restored = replay(api, deleted, remove, 'undo');
    return { created: [...created.frames.keys()], undone: [...undone.frames.keys()], deleted: [...deleted.frames.keys()], restored: [...restored.frames.keys()], restoredStyle: Object.entries(restored.frames.get('b').nodes.root.style) };
  } },
  { name: 'frame order replay keeps unrelated later frames in their slots', expected: { redo: ['c', 'x', 'a', 'b'], undo: ['a', 'x', 'b', 'c'], identity: true }, run: api => {
    const before = context(api, ['a', 'x', 'b', 'c']), items = [{ type: 'order', inverse: ['a', 'b', 'c'], forward: ['c', 'a', 'b'] }];
    const redo = replay(api, before, items, 'redo'), undo = replay(api, redo, items, 'undo');
    return { redo: [...redo.frames.keys()], undo: [...undo.frames.keys()], identity: [...before.frames].every(([id, document]) => redo.frames.get(id) === document && undo.frames.get(id) === document) };
  } },
  { name: 'a later overlapping order refuses without mutating inputs', error: 'CANNOT_UNDO', run: api => replay(api, context(api, ['b', 'x', 'a', 'c']), [{ type: 'order', inverse: ['a', 'b', 'c'], forward: ['c', 'a', 'b'] }], 'redo') },
  { name: 'a later patch conflict cannot leak an earlier candidate edit', error: 'CANNOT_UNDO', run: api => replay(api, context(api), [patch('a', 'Alpha', 'Beta'), patch('a', 'Other', 'Gamma')], 'redo') },
  { name: 'invalid later patch leaves the accepted input intact', error: 'INVALID_DOCUMENT', run: api => replay(api, context(api), [patch('a', 'Alpha', 'Beta'), { type: 'patch', documentId: 'a', inverse: { nodes: { label: { ...frame('a').nodes.label, content: 'Beta', metadata: {} } } }, forward: { nodes: { label: null } } }], 'redo') },
  { name: 'changed lifecycle frame refuses removal', error: 'CANNOT_UNDO', run: api => {
    const before = context(api), document = api.validateDocument({ ...frame('a'), name: 'Historical' });
    return replay(api, before, [{ type: 'create', documentId: 'a', document }], 'undo');
  } },
  { name: 'occupied lifecycle slot refuses restoration', error: 'CANNOT_UNDO', run: api => replay(api, context(api), [{ type: 'delete', documentId: 'a', document: api.validateDocument(frame('a')) }], 'undo') },
  { name: 'unknown internal item refuses rather than advancing a no-op stack', error: 'CANNOT_UNDO', run: api => replay(api, context(api), [{ type: 'unknown' }], 'redo') },
];

export function captureHistoryReplay(api, run) {
  try { return { ok: true, value: run(api) }; }
  catch (error) { return { ok: false, code: error.code, message: error.message }; }
}
