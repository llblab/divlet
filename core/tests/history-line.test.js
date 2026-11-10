import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryLine } from '../lib/history.ts';

const fixture = () => { let seed = 0; return new HistoryLine(() => `point-${++seed}`); };
const info = (seq, label = `Edit ${seq}`) => ({ seq, label });

test('point identity follows retained stack edges, with fresh grouped frontiers and immutable read results', () => {
  const line = fixture(), undo = [], redo = [], entry = {};
  const base = line.currentId;
  undo.push(entry); line.accept(entry, info(1), false);
  const partial = line.currentId;
  line.accept(entry, info(3), true);
  const final = line.currentId;
  assert.notEqual(final, partial);
  const snapshot = line.snapshot(undo, redo);
  assert.deepEqual(snapshot.points.map(point => point.id), [base, final]);
  assert.equal(snapshot.points[1].firstSeq, 1); assert.equal(snapshot.points[1].seq, 3);
  snapshot.points[0].label = 'Changed by caller';
  assert.equal(line.snapshot(undo, redo).points[0].label, 'Opened project');
  line.move([undo.pop()], 'undo', info(4)); redo.push(entry);
  assert.equal(line.currentId, base);
  assert.deepEqual(line.snapshot(undo, redo).points.map(point => point.id), [base, final]);
  line.move([redo.pop()], 'redo', info(5)); undo.push(entry);
  assert.equal(line.currentId, final);
  assert.equal(line.snapshot(undo, redo).index, 1);
});

test('selective and untracked changes cut only advertised reachability, including a merge across the cut', () => {
  const line = fixture(), first = {}, second = {}, undo = [first, second], redo = [];
  line.accept(first, info(1), false); line.accept(second, info(2), false);
  const old = line.snapshot(undo, redo).points.map(point => point.id);
  line.move([first], 'undo', info(3)); undo.splice(0, 1); redo.push(first);
  let snapshot = line.snapshot(undo, redo);
  assert.equal(snapshot.boundary, 'nonlinear'); assert.equal(snapshot.pastLimited, true); assert.equal(snapshot.futureLimited, true);
  assert.equal(snapshot.points.length, 1);
  assert.ok(!old.includes(snapshot.current));
  line.accept(second, info(4), true); redo.length = 0;
  assert.equal(line.snapshot(undo, redo).points.length, 1, 'merging an old group cannot invent an edge across the cut');
  line.reset({ seq: 5, label: 'Untracked change' });
  snapshot = line.snapshot(undo, redo);
  assert.equal(snapshot.boundary, 'untracked'); assert.equal(snapshot.pastLimited, true);
  const fresh = {}; undo.push(fresh); line.accept(fresh, info(6), false);
  assert.equal(line.snapshot(undo, redo).points.length, 2, 'new edits grow a proven segment from the new baseline');
});

test('retention and branches expose only live edges, with bounded Unicode-safe labels', () => {
  const line = fixture(), undo = [], redo = [];
  const initial = line.currentId;
  for (let seq = 1; seq <= 4; seq++) {
    const entry = {}; undo.push(entry); line.accept(entry, info(seq, '😀'.repeat(200)), false);
    if (undo.length > 2) undo.shift();
  }
  const snapshot = line.snapshot(undo, redo);
  assert.equal(snapshot.points.length, 3); assert.equal(snapshot.boundary, 'retained');
  assert.ok(!snapshot.points.some(point => point.id === initial));
  assert.equal([...snapshot.points.at(-1).label].length, 160);
  const entry = undo.pop(); line.move([entry], 'undo', info(5)); redo.push(entry);
  const future = line.snapshot(undo, redo).points.at(-1).id;
  const branch = {}; undo.push(branch); line.accept(branch, info(6), false); redo.length = 0;
  assert.ok(!line.snapshot(undo, redo).points.some(point => point.id === future));
});
