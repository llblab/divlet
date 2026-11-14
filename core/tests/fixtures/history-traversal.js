// Read-only session traversal witnesses; expected indexes/order/labels are authored independently of the planner.
const item = (marker, documentId) => ({ type: 'patch', marker, documentId });
const group = (label, documentId = 'a') => ({ label, items: [item(`${label}1`, documentId), item(`${label}2`, documentId)] });
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
function plan(api, stack, direction, options = {}, limit = 200) {
  freeze(stack); freeze(options);
  const before = JSON.stringify(stack);
  try {
    const result = api.planHistoryTraversal(stack, direction, options, limit);
    if (!result.entries.every((entry, index) => entry === stack[result.indexes[index]])) throw new Error('Traversal lost original entry identities');
    return result;
  } finally { if (JSON.stringify(stack) !== before) throw new Error('Traversal mutated source stack or entries'); }
}
const describe = value => ({ indexes: value.indexes, entries: value.entries.map(entry => entry.label), ordered: value.ordered.map(entry => entry.label), markers: value.ordered.flatMap(entry => entry.items.map(item => item.marker)), label: value.label });

export const historyTraversalCases = [
  { name: 'default single Undo preserves the saved label and complete group', expected: { indexes: [1], entries: ['Second'], ordered: ['Second'], markers: ['Second1', 'Second2'], label: 'Second' }, run: api => describe(plan(api, [group('First'), group('Second')], 'undo')) },
  { name: 'multi Undo composes groups before exactly one item reversal', expected: { indexes: [2, 1], entries: ['Third', 'Second'], ordered: ['Second', 'Third'], markers: ['Second1', 'Second2', 'Third1', 'Third2'], label: 'undo 2 steps', applied: ['Third2', 'Third1', 'Second2', 'Second1'] }, run: api => {
    const result = describe(plan(api, [group('First'), group('Second'), group('Third')], 'undo', { steps: 2 }));
    return { ...result, applied: [...result.markers].reverse() };
  } },
  { name: 'Redo uses actual traversal order from the reversed destination stack', expected: { indexes: [1, 0], entries: ['Second', 'Third'], ordered: ['Second', 'Third'], markers: ['Second1', 'Second2', 'Third1', 'Third2'], label: 'redo 2 steps' }, run: api => describe(plan(api, [group('Third'), group('Second')], 'redo', { steps: 2 })) },
  { name: 'frame-scoped traversal skips unrelated groups without splitting selected groups', expected: { indexes: [2, 0], entries: ['Mixed', 'First'], ordered: ['First', 'Mixed'], markers: ['First1', 'First2', 'Other frame', 'Chosen frame'], label: 'undo 2 steps' }, run: api => describe(plan(api, [
    group('First'), group('Skipped', 'b'), { label: 'Mixed', items: [item('Other frame', 'b'), item('Chosen frame', 'a')] }, group('Newest skipped', 'c'),
  ], 'undo', { documentId: 'a', steps: 2 })) },
  { name: 'plural session addresses select the entire group', expected: { indexes: [0], entries: ['Order'], ordered: ['Order'], markers: ['order'], label: 'Order' }, run: api => describe(plan(api, [{ label: 'Order', items: [{ type: 'order', marker: 'order', documentIds: ['a', 'b'] }] }, group('Skipped', 'c')], 'undo', { documentId: 'b' })) },
  { name: 'frame IDs stay case-sensitive and unnormalized', expected: { indexes: [0], entries: ['Upper'], ordered: ['Upper'], markers: ['Upper1', 'Upper2'], label: 'Upper' }, run: api => describe(plan(api, [group('Upper', 'A'), group('Lower', 'a')], 'redo', { documentId: 'A' })) },
  { name: 'empty frame scope retains the existing unfiltered behavior', expected: { indexes: [1], entries: ['Second'], ordered: ['Second'], markers: ['Second1', 'Second2'], label: 'Second' }, run: api => describe(plan(api, [group('First'), group('Second', 'b')], 'undo', { documentId: '' })) },
  { name: 'single-step labels are opaque rather than normalized by traversal', expected: { same: true, label: { opaque: true }, absent: true }, run: api => {
    const label = { opaque: true }, stack = [{ label, items: [item('value', 'a')] }];
    const result = plan(api, stack, 'undo'), absent = plan(api, [{ items: [] }], 'redo');
    return { same: result.label === label, label: result.label, absent: Object.hasOwn(absent, 'label') && absent.label === undefined };
  } },
  { name: 'maximum retained traversal bound is inclusive', expected: { count: 200, first: 199, last: 0, label: 'undo 200 steps' }, run: api => {
    const result = plan(api, Array.from({ length: 200 }, (_, i) => group(`Step${i}`)), 'undo', { steps: 200 });
    return { count: result.indexes.length, first: result.indexes[0], last: result.indexes.at(-1), label: result.label };
  } },
  { name: 'selected group composition drives dependent patches through the real replay kernel', expected: { undo: ['Alpha', 6], redo: ['Gamma', 7], original: 'Gamma' }, run: api => {
    const { frames, settings } = api.readProject({ schemaVersion: 1, frames: [{ id: 'a', name: 'a', version: 5, artboard: { x: 0, y: 0, width: 100, height: 100 }, rootId: 'root', nodes: { root: { id: 'root', type: 'element', tag: 'main', children: ['label'] }, label: { id: 'label', type: 'text', content: 'Gamma' } } }] });
    const patch = (label, from, to) => ({ label, items: [{ type: 'patch', documentId: 'a', inverse: { nodes: { label: { content: from } } }, forward: { nodes: { label: { content: to } } } }] });
    const stack = [patch('First', 'Alpha', 'Beta'), patch('Second', 'Beta', 'Gamma')];
    const undoPlan = plan(api, stack, 'undo', { steps: 2 });
    const undo = api.replayHistory(new Map(frames.map(document => [document.id, document])), settings, undoPlan.ordered.flatMap(entry => entry.items), 'undo');
    const redoPlan = plan(api, [...undoPlan.entries], 'redo', { steps: 2 });
    const redo = api.replayHistory(undo.frames, undo.settings, redoPlan.ordered.flatMap(entry => entry.items), 'redo');
    return { undo: [undo.frames.get('a').nodes.label.content, undo.frames.get('a').version], redo: [redo.frames.get('a').nodes.label.content, redo.frames.get('a').version], original: frames[0].nodes.label.content };
  } },
  { name: 'invalid step regions refuse before inspecting even an empty stack', expected: Array.from({ length: 16 }, () => ['INVALID_QUERY', 'steps must be an integer from 1 to 200.']), run: api => [0, -0, -1, 1.5, NaN, Infinity, '1', true, false, null, {}, [], 201, 1n, Symbol('step'), new Number(1)].map(steps => {
    try { plan(api, [], 'undo', { steps }); return ['accepted']; } catch (error) { return [error.code, error.message]; }
  }) },
  { name: 'writer-supplied bound is used in validation and its diagnostic', expected: ['INVALID_QUERY', 'steps must be an integer from 1 to 3.'], run: api => {
    try { plan(api, [], 'redo', { steps: 4 }, 3); return ['accepted']; } catch (error) { return [error.code, error.message]; }
  } },
  { name: 'empty Undo refuses with the legacy single-step message', error: 'NOTHING_TO_UNDO', message: 'Nothing to undo.', run: api => plan(api, [], 'undo') },
  { name: 'empty Redo refuses with the legacy single-step message', error: 'NOTHING_TO_UNDO', message: 'Nothing to redo.', run: api => plan(api, [], 'redo') },
  { name: 'insufficient matching groups refuse the whole requested traversal', error: 'NOTHING_TO_UNDO', message: 'Not enough history to undo 2 steps.', run: api => plan(api, [group('First'), group('Unrelated', 'b')], 'undo', { documentId: 'a', steps: 2 }) },
  { name: 'missing frame match refuses without falling back to unscoped history', error: 'NOTHING_TO_UNDO', message: 'Nothing to redo.', run: api => plan(api, [group('Unrelated', 'b')], 'redo', { documentId: 'missing' }) },
];
export function captureHistoryTraversal(api, run) {
  try { return { ok: true, value: run(api) }; }
  catch (error) { return { ok: false, code: error.code, message: error.message }; }
}
