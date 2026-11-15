// Accepted-stack bookkeeping only: candidates/persistence remain writer-owned and expected points are authored here.
const session = api => {
  let id = 0;
  return { line: new api.HistoryLine(() => `p${++id}`), undo: [], redo: [] };
};
const group = (label, key = label, frame = label) => ({ group: key, label, items: [{ type: 'patch', documentId: frame }] });
const append = (state, entry, seq, firstSeq = seq, limit = 200) => state.line.commitGroup(state.undo, state.redo, entry, { seq, firstSeq }, limit);
const traverse = (api, state, direction, options = {}) => {
  const from = direction === 'undo' ? state.undo : state.redo, to = direction === 'undo' ? state.redo : state.undo;
  const plan = api.planHistoryTraversal(from, direction, options, 200), before = JSON.stringify(plan);
  state.line.commitTraversal(from, to, plan, direction, { seq: null, firstSeq: null, label: plan.label });
  if (JSON.stringify(plan) !== before) throw new Error('Stack commit mutated its traversal plan or original entries');
  return plan;
};
const labels = entries => entries.map(entry => entry.label);

export const historyCommitCases = [
  { name: 'accepted groups coalesce in place and retire every partial frontier', expected: { groups: 1, sameEntry: true, originalItems: true, labels: ['Final'], frames: ['a', 'b', 'c'], points: ['p1', 'p4'], seq: 4, firstSeq: 1 }, run: api => {
    const state = session(api), first = group('First', 'gesture', 'a'), items = first.items;
    append(state, first, 2, 1);
    append(state, group('Final', 'gesture', 'b'), 3, 777);
    append(state, group('', 'gesture', 'c'), 4, 888);
    const timeline = state.line.snapshot(state.undo, state.redo), current = timeline.points.at(-1);
    return { groups: state.undo.length, sameEntry: state.undo[0] === first, originalItems: first.items === items, labels: labels(state.undo), frames: first.items.map(item => item.documentId), points: timeline.points.map(point => point.id), seq: current.seq, firstSeq: current.firstSeq };
  } },
  { name: 'falsy and differently spelled group keys never merge', expected: { labels: ['One', 'Two', 'Three', 'Four'], points: ['p1', 'p2', 'p3', 'p4', 'p5'] }, run: api => {
    const state = session(api);
    for (const [index, entry] of [group('One', ''), group('Two', ''), group('Three', 'key'), group('Four', 'Key')].entries()) append(state, entry, index + 1);
    return { labels: labels(state.undo), points: state.line.snapshot(state.undo, state.redo).points.map(point => point.id) };
  } },
  { name: 'retention and a new branch clear Redo without replacing either stack', expected: { undo: ['B', 'D'], redo: [], points: ['p2', 'p3', 'p5'], boundary: 'retained', sameUndo: true, sameRedo: true, sameSurvivor: true }, run: api => {
    const state = session(api), undo = state.undo, redo = state.redo, a = group('A'), b = group('B'), c = group('C');
    append(state, a, 1, 1, 2); append(state, b, 2, 2, 2); append(state, c, 3, 3, 2);
    traverse(api, state, 'undo'); append(state, group('D'), 4, 4, 2);
    const timeline = state.line.snapshot(state.undo, state.redo);
    return { undo: labels(state.undo), redo: labels(state.redo), points: timeline.points.map(point => point.id), boundary: timeline.boundary, sameUndo: state.undo === undo, sameRedo: state.redo === redo, sameSurvivor: state.undo[0] === b };
  } },
  { name: 'multi-step commits move original entries in replay order and return to the same point', expected: { undone: { undo: ['A'], redo: ['C', 'B'], point: 'p2' }, redone: { undo: ['A', 'B', 'C'], redo: [], point: 'p4' }, identities: true }, run: api => {
    const state = session(api), entries = ['A', 'B', 'C'].map(name => group(name));
    entries.forEach((entry, index) => append(state, entry, index + 1));
    const undo = traverse(api, state, 'undo', { steps: 2 });
    const undone = { undo: labels(state.undo), redo: labels(state.redo), point: state.line.currentId };
    const redo = traverse(api, state, 'redo', { steps: 2 });
    return { undone, redone: { undo: labels(state.undo), redo: labels(state.redo), point: state.line.currentId }, identities: undo.entries[0] === entries[2] && undo.entries[1] === entries[1] && redo.entries[0] === entries[1] && redo.entries[1] === entries[2] && state.undo.every((entry, index) => entry === entries[index]) };
  } },
  { name: 'selective commits retain legacy stacks but expose only a nonlinear point', expected: { undo: ['A', 'C'], redo: ['B'], points: ['p5'], boundary: 'nonlinear', pastLimited: true, futureLimited: true }, run: api => {
    const state = session(api);
    append(state, group('A', 'A', 'a'), 1); append(state, group('B', 'B', 'b'), 2); append(state, group('C', 'C', 'a'), 3);
    traverse(api, state, 'undo', { documentId: 'b' });
    const timeline = state.line.snapshot(state.undo, state.redo);
    return { undo: labels(state.undo), redo: labels(state.redo), points: timeline.points.map(point => point.id), boundary: timeline.boundary, pastLimited: timeline.pastLimited, futureLimited: timeline.futureLimited };
  } },
  { name: 'extending a group after untracked acceptance cannot invent an old baseline', expected: { labels: ['Extended'], items: 2, points: ['p4'], boundary: 'nonlinear', firstSeq: 1 }, run: api => {
    const state = session(api);
    append(state, group('Initial', 'gesture'), 1);
    state.line.reset({ seq: 2, label: 'Untracked' });
    append(state, group('Extended', 'gesture'), 3);
    const timeline = state.line.snapshot(state.undo, state.redo);
    return { labels: labels(state.undo), items: state.undo[0].items.length, points: timeline.points.map(point => point.id), boundary: timeline.boundary, firstSeq: timeline.points[0].firstSeq };
  } },
  { name: 'accepted metadata defaults belong to lineage, not an audit sequence-derived point ID', expected: { label: 'Edit project', seq: 17, firstSeq: 9, id: 'p2' }, run: api => {
    const state = session(api), entry = { items: [], label: null };
    append(state, entry, 17, 9);
    const current = state.line.snapshot(state.undo, state.redo).points.at(-1);
    return { label: current.label, seq: current.seq, firstSeq: current.firstSeq, id: current.id };
  } },
];

export function captureHistoryCommit(api, run) {
  try { return { ok: true, value: run(api) }; }
  catch (error) { return { ok: false, code: error.code, message: error.message }; }
}
