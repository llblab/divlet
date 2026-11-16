// Shared project semantics with a trusted byte-access callback, never a project-selected policy or replacement validator.
const one = 'data:text/plain;base64,TQ==', two = 'data:text/plain;base64,TWE=';
export const projectAccessSource = () => ({ schemaVersion: 1, metadata: { value: null }, assets: { one }, frames: [] });
const check = (value, message) => { if (!value) throw Error(message); };
const code = action => { try { action(); return 'accepted'; } catch (error) { return error.code || error.name; } };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function endpoints(api, access) {
  const before = api.readProject(projectAccessSource(), access), frames = new Map();
  const after = api.validateSettings({ ...before.settings, assets: { one: two }, metadata: { value: [null] } }, access);
  return { before, after, frames, items: api.projectHistoryItems(frames, before.settings, frames, after) };
}
export const projectAccessCases = [
  { name: 'one callback binds settings, project read, sparse patch and serialization without rewriting declarations', run(api) {
    let calls = 0; const access = () => { calls++; return { replacement: 'ignored' }; };
    const input = { ...projectAccessSource(), assets: { one, alias: one, unused: two, empty: {} } }, original = JSON.stringify(input);
    const admitted = api.readProject(input, access), readCalls = calls;
    const next = api.patchSettings(admitted.settings, { assets: { alias: null, added: two } }, access), patchCalls = calls - readCalls;
    const text = api.writeProject(next, admitted.frames, access), writeCalls = calls - readCalls - patchCalls;
    const reopened = api.readProject(JSON.parse(text), access);
    check(readCalls > 0 && patchCalls > 0 && writeCalls > 0, 'every semantic operation must use the access callback');
    check(equal(reopened.settings.assets, { one, unused: two, empty: {}, added: two }), 'sparse deletion/aliases/unused names must retain canonical data');
    check(JSON.stringify(input) === original && admitted.settings.assets !== input.assets, 'admission must detach without changing input');
    return true;
  }, expected: true },
  { name: 'refusal identity reaches every byte-bearing project semantic operation', run(api) {
    const source = projectAccessSource(), admitted = api.readProject(source, () => {}), denied = new Error('host refusal');
    const access = () => { throw denied; };
    const actions = [() => api.validateSettings(source, access), () => api.readProject(source, access), () => api.patchSettings(admitted.settings, { assets: { one: two } }, access), () => api.patchSettings(admitted.settings, { name: 'Still byte-bearing' }, access), () => api.writeProject(admitted.settings, admitted.frames, access)];
    return actions.map(action => { try { action(); return false; } catch (error) { return error === denied; } });
  }, expected: [true, true, true, true, true] },
  { name: 'access preserves grammar/name refusal order and cannot replace shared validation', run(api) {
    let calls = 0; const denied = Object.assign(new Error('host refusal'), { code: 'HOST_BYTES' });
    const access = () => { calls++; throw denied; };
    const invalidPrefix = code(() => api.readProject({ ...projectAccessSource(), assets: { one: 'wrong-prefix' } }, access));
    const admitted = api.readProject(projectAccessSource(), () => {});
    const invalidDeletion = code(() => api.patchSettings(admitted.settings, { assets: { 'bad/name': null } }, access));
    const earlyCalls = calls;
    const refusedMime = code(() => api.readProject({ ...projectAccessSource(), assets: { one: 'data:INVALID;base64,!' } }, access));
    const unchangedValidator = code(() => api.readProject({ ...projectAccessSource(), assets: { one: 'data:INVALID;base64,!' } }, () => ({ one })));
    return { invalidPrefix, invalidDeletion, earlyCalls, refusedMime, calls, unchangedValidator };
  }, expected: { invalidPrefix: 'INVALID_ASSET', invalidDeletion: 'INVALID_ASSET', earlyCalls: 0, refusedMime: 'HOST_BYTES', calls: 1, unchangedValidator: 'INVALID_ASSET' } },
  { name: 'project replay carries access through patch admission and exact nullable restoration in both directions', run(api) {
    const access = () => {}, { before, after, frames, items } = endpoints(api, access);
    check(items.length === 1 && items[0].nullBlocks?.length, 'the fixture must exercise nullable endpoint restoration');
    const frozen = JSON.stringify({ before, after, items });
    let calls = 0; const traced = () => { calls++; };
    const redo = api.replayHistory(frames, before.settings, items, 'redo', traced), redoCalls = calls; calls = 0;
    const undo = api.replayHistory(frames, after, items, 'undo', traced), undoCalls = calls;
    check(equal(redo.settings.assets, after.assets) && equal(redo.settings.metadata, after.metadata), 'redo must restore byte and null endpoints');
    check(equal(undo.settings.assets, before.settings.assets) && equal(undo.settings.metadata, before.settings.metadata), 'undo must restore byte and null endpoints');
    api.assertProjectHistoryRoundTrip(frames, before.settings, frames, after, items, access);
    check(JSON.stringify({ before, after, items }) === frozen, 'replay/proof must not mutate accepted endpoints or history');
    return { redoCalls, undoCalls };
  }, expected: { redoCalls: 3, undoCalls: 3 } },
  { name: 'history replay preserves host refusal and round-trip proof preserves its existing wrapper', run(api) {
    const { before, after, frames, items } = endpoints(api, () => {}), denied = new Error('host refusal');
    const access = () => { throw denied; };
    let replayIdentity = false; try { api.replayHistory(frames, before.settings, items, 'redo', access); } catch (error) { replayIdentity = error === denied; }
    return { replayIdentity, proof: code(() => api.assertProjectHistoryRoundTrip(frames, before.settings, frames, after, items, access)) };
  }, expected: { replayIdentity: true, proof: 'UNSUPPORTED_SOURCE_REPLAY' } },
  { name: 'project data cannot select admission and a callback return cannot replace source', run(api) {
    const access = () => ({ assets: { injected: two } });
    const source = projectAccessSource(); source.metadata.access = 'allow';
    const admitted = api.readProject(source, access);
    return { assets: equal(admitted.settings.assets, source.assets), metadata: admitted.settings.metadata.access, topLevel: code(() => api.readProject({ ...source, access: 'allow' }, access)) };
  }, expected: { assets: true, metadata: 'allow', topLevel: 'INVALID_PROJECT' } },
  { name: 'non-functions never silently become byte permission', run(api) {
    return [null, false, 42].map(access => code(() => api.readProject(projectAccessSource(), access)));
  }, expected: ['TypeError', 'TypeError', 'TypeError'] },
];
