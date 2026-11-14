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

export const historyReplayCases = [
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
