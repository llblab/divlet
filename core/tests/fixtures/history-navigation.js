// Navigation decisions use authored expectations and writer-owned snapshots, never audit sequence numbers.
const timeline = () => ({ current: 'p2', index: 2, points: ['p0', 'p1', 'p2', 'p3', 'p4'].map(id => ({ id })) });
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
function plan(api, value, pointId, expectedPoint) {
  const request = api.validateHistoryNavigation(pointId, expectedPoint);
  freeze(value); freeze(request);
  const before = JSON.stringify([value, request]);
  try { return api.planHistoryNavigation(value, request); }
  finally { if (JSON.stringify([value, request]) !== before) throw new Error('Navigation mutated its timeline or request'); }
}
const conflict = 'History changed since it was read. Read the current timeline before navigating.';
const unavailable = 'That state point is no longer on the retained current history segment.';
export const historyNavigationCases = [
  { name: 'earlier retained point plans a whole backward traversal', expected: { changed: true, direction: 'undo', steps: 2 }, run: api => plan(api, timeline(), 'p0', 'p2') },
  { name: 'adjacent earlier point plans one Undo', expected: { changed: true, direction: 'undo', steps: 1 }, run: api => plan(api, timeline(), 'p1', 'p2') },
  { name: 'adjacent later point plans one Redo', expected: { changed: true, direction: 'redo', steps: 1 }, run: api => plan(api, timeline(), 'p3', 'p2') },
  { name: 'later retained point plans the full forward traversal', expected: { changed: true, direction: 'redo', steps: 2 }, run: api => plan(api, timeline(), 'p4', 'p2') },
  { name: 'matching current target is a no-op without direction or steps', expected: { changed: false }, run: api => plan(api, timeline(), 'p2', 'p2') },
  { name: 'stale expected point refuses even an otherwise available target', error: 'HISTORY_CONFLICT', message: conflict, run: api => plan(api, timeline(), 'p0', 'p1') },
  { name: 'stale expected point refuses before a current-target no-op', error: 'HISTORY_CONFLICT', message: conflict, run: api => plan(api, timeline(), 'p2', 'p1') },
  { name: 'stale expected point takes precedence over missing-target refusal', error: 'HISTORY_CONFLICT', message: conflict, run: api => plan(api, timeline(), 'missing', 'p1') },
  { name: 'unadvertised point refuses against a current expected point', error: 'HISTORY_POINT_UNAVAILABLE', message: unavailable, run: api => plan(api, timeline(), 'missing', 'p2') },
  { name: 'point IDs are exact opaque strings, not trimmed or case-folded', expected: [{ changed: true, direction: 'undo', steps: 1 }, 'HISTORY_POINT_UNAVAILABLE'], run: api => {
    const value = { current: 'Current', index: 1, points: [{ id: ' Old ' }, { id: 'Current' }] };
    const result = plan(api, value, ' Old ', 'Current');
    try { plan(api, value, 'old', 'Current'); return [result, 'accepted']; } catch (error) { return [result, error.code]; }
  } },
  { name: 'invalid address regions refuse before timeline access', expected: { codes: Array(24).fill('INVALID_QUERY'), reads: 0 }, run: api => {
    let reads = 0;
    const invalid = [undefined, null, 1, 0, true, false, '', {}, [], new String('p2'), 1n, Symbol('point')];
    const codes = invalid.flatMap(value => [[value, 'p2'], ['p2', value]].map(([pointId, expectedPoint]) => {
      try { const request = api.validateHistoryNavigation(pointId, expectedPoint); reads++; api.planHistoryNavigation(timeline(), request); return 'accepted'; }
      catch (error) { return error.code; }
    }));
    return { codes, reads };
  } },
  { name: 'navigation plans leave live lineage unchanged and permit the caller to choose forward return', expected: { undo: { changed: true, direction: 'undo', steps: 2 }, redo: { changed: true, direction: 'redo', steps: 2 }, unchanged: true }, run: api => {
    let id = 0;
    const line = new api.HistoryLine(() => `point-${++id}`), base = line.currentId, first = {}, second = {};
    line.accept(first, { seq: 1, label: 'First' }, false); line.accept(second, { seq: 2, label: 'Second' }, false);
    const head = line.currentId, undo = plan(api, line.snapshot([first, second], []), base, head), unchanged = line.currentId === head;
    line.move([second, first], 'undo', { seq: 3, label: 'Caller accepts Undo' });
    const redo = plan(api, line.snapshot([], [second, first]), head, line.currentId);
    return { undo, redo, unchanged: unchanged && line.currentId === base };
  } },
  { name: 'an untracked boundary does not authorize navigation to a retained legacy entry', error: 'HISTORY_POINT_UNAVAILABLE', message: unavailable, run: api => {
    let id = 0;
    const line = new api.HistoryLine(() => `point-${++id}`), base = line.currentId, entry = {};
    line.accept(entry, { seq: 1, label: 'Tracked' }, false); line.reset({ seq: 2, label: 'Untracked edit' });
    return plan(api, line.snapshot([entry], []), base, line.currentId);
  } },
];
export function captureHistoryNavigation(api, run) {
  try { return { ok: true, value: run(api) }; }
  catch (error) { return { ok: false, code: error.code, message: error.message }; }
}
