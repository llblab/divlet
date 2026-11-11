// These read-session properties execute unchanged in Node and native browser ESM.
const sample = () => ({ state: { projectId: 'demo', stateVersion: 1, documents: [{ id: 'index', version: 1 }] }, frames: new Map([['index', { id: 'index', version: 1, metadata: { name: 'Public example' } }]]) });

export const snapshotCases = [
  { name: 'immutable read capabilities and detached source/results', expected: {
    frozen: true, capabilities: ['readFrame', 'readState', 'subscribe'], projectId: 'demo', frameName: 'Public example', frames: 1, nextName: 'Public example', missing: 'NOT_FOUND',
  }, run: async create => {
    const input = sample(), reader = create(input);
    input.state.projectId = 'mutated'; input.frames.get('index').metadata.name = 'mutated'; input.frames.clear();
    const state = await reader.readState(), frame = await reader.readFrame('index');
    const projectId = state.projectId, frameName = frame.metadata.name;
    state.documents.length = 0; frame.metadata.name = 'changed';
    let missing = null;
    try { await reader.readFrame('missing'); } catch (error) { missing = error.code; }
    return { frozen: Object.isFrozen(reader), capabilities: Object.keys(reader).sort(), projectId, frameName, frames: (await reader.readState()).documents.length, nextName: (await reader.readFrame('index')).metadata.name, missing };
  } },
  { name: 'independent subscription cleanup and detached state events', expected: { first: [], second: ['connection', 'state'], projectId: 'demo' }, run: async create => {
    const reader = create(sample()), first = [], second = [];
    const stopFirst = reader.subscribe(event => first.push(event));
    const stopSecond = reader.subscribe(event => second.push(event));
    stopFirst(); stopFirst();
    await Promise.resolve();
    second[1].value.projectId = 'changed';
    stopSecond();
    return { first, second: second.map(event => event.type), projectId: (await reader.readState()).projectId };
  } },
  { name: 'reentrant unsubscribe suppresses queued state', expected: ['connection'], run: async create => {
    const reader = create(sample()), seen = [];
    const stop = reader.subscribe(event => { seen.push(event.type); stop(); });
    await Promise.resolve();
    return seen;
  } },
];
