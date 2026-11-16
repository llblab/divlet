// Private writer-policy witnesses, shared by Node and Chromium. No board/clipboard/storage-device activation or paint claim.
const one = 'data:image/png;base64,AQID', two = 'data:image/png;base64,BAUG';
const compiler = { compile: () => '', unknown: () => ({}) };
export const browserResourceSource = () => ({ schemaVersion: 1, metadata: { value: null }, assets: { one, alias: one, unused: two, empty: {} }, frames: [{
  id: 'index', name: 'Policy proof', version: 1, rootId: 'root', artboard: { x: 0, y: 0, width: 300, height: 200 },
  nodes: { root: { id: 'root', type: 'element', tag: 'main', children: ['picture', 'label'] }, picture: { id: 'picture', type: 'element', tag: 'img', attrs: { src: 'asset:one' }, children: [] }, label: { id: 'label', type: 'text', content: 'Before' } },
}] });
const options = source => ({ source, file: 'policy.divlet', projectId: 'policy-proof', compiler });
const check = (condition, message) => { if (!condition) throw Error(message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const code = async action => { try { await action(); return 'accepted'; } catch (error) { return error.code || error.name; } };
const snapshot = runtime => JSON.stringify({ settings: runtime.settings, entries: [...runtime.documents], info: runtime.info(), renderSeq: runtime.renderSeq, history: runtime.history, undo: runtime.undoStack, redo: runtime.redoStack, timeline: runtime.readTimeline() });
const descriptor = (file, size = 3) => ({ file, path: `asset:${file}`, mediaType: 'image/png', size });
export const browserResourceCases = [
  { name: 'a resource policy requires byte access and projection together, with no competing projector', async run({ BrowserRuntime, projectClosedPreview }) {
    let compiles = 0;
    const base = { ...options({ schemaVersion: 1, frames: [] }), compiler: { compile: () => { compiles++; return ''; }, unknown: () => ({}) } };
    const malformed = [null, {}, { requireAssetBytes() {} }, { projectPreview: projectClosedPreview }, { requireAssetBytes: true, projectPreview: projectClosedPreview }, { requireAssetBytes() {}, projectPreview: null }];
    const outcomes = [];
    for (const resourcePolicy of malformed) outcomes.push(await code(() => BrowserRuntime.open({ ...base, resourcePolicy })));
    outcomes.push(await code(() => BrowserRuntime.open({ ...base, resourcePolicy: { requireAssetBytes() {}, projectPreview: projectClosedPreview }, projectPreview: projectClosedPreview })));
    check(compiles === 0, 'invalid trusted configuration must refuse before preparation');
    return outcomes;
  }, expected: Array(7).fill('TypeError') },
  { name: 'one captured policy covers shared-tool byte edits, nullable grouped history, source, persist, reopen and export', async run({ BrowserRuntime, projectClosedPreview }) {
    let accesses = 0, projections = 0; const stored = [];
    const resourcePolicy = { requireAssetBytes: () => { accesses++; return { replacement: 'ignored' }; }, projectPreview: async (html, assets) => { projections++; return projectClosedPreview(html, assets); } };
    const input = browserResourceSource(), original = JSON.stringify(input);
    const runtime = await BrowserRuntime.open({ ...options(input), resourcePolicy, persist: text => { stored.push(text); } });
    check(accesses > 0 && projections === 1 && JSON.stringify(input) === original, 'open must admit and project detached source through the selected policy');
    // Capture functions, not a mutable policy object that could silently exchange admission/projection later.
    resourcePolicy.requireAssetBytes = () => { throw Error('exchanged access'); }; resourcePolicy.projectPreview = () => { throw Error('exchanged projection'); };
    const originalResources = [descriptor('one'), descriptor('alias'), descriptor('unused')];
    check(equal(runtime.info().project.resources, originalResources), 'descriptions include aliases/unused declarations without payloads');
    const leaked = runtime.info().project.resources; leaked[0].size = 999;
    check(equal(runtime.info().project.resources, originalResources), 'resource descriptions must be detached');
    check(runtime.render('index').html.includes(`src="${one}"`), 'initial preview derives embedded URLs');
    await runtime.callTool('divlet_patch', { expectedVersion: runtime.settings.version, patch: { assets: { one: two }, metadata: { value: [null] } }, group: 'together' });
    await runtime.callTool('divlet_patch', { frameId: 'index', expectedVersion: runtime.getEntry('index').document.version, patch: { nodes: { label: { content: 'After' } } }, group: 'together' });
    check(runtime.render('index').html.includes(`src="${two}"`) && runtime.render('index').html.includes('After'), 'accepted edits must prepare projected HTML');
    const changed = JSON.parse(runtime.source());
    check(equal(changed.assets, { one: two, alias: one, unused: two, empty: {} }) && changed.frames[0].nodes.picture.attrs.src === 'asset:one', 'source must retain names/aliases/unused data and authored references');
    await runtime.undo();
    check(runtime.settings.metadata.value === null && runtime.getEntry('index').document.nodes.label.content === 'Before' && equal(runtime.settings.assets, input.assets), 'grouped Undo restores exact nullable metadata, bytes and frame content');
    await runtime.redo();
    check(equal(runtime.settings.metadata.value, [null]) && runtime.getEntry('index').document.nodes.label.content === 'After' && equal(runtime.settings.assets, changed.assets), 'grouped Redo restores the complete candidate');
    const text = runtime.source(); check(stored.at(-1) === text && stored.length === 4, 'persist receives canonical complete source once per traversal/action');
    const reopened = await BrowserRuntime.open({ ...options(text), resourcePolicy: { requireAssetBytes() {}, projectPreview: projectClosedPreview } });
    check(reopened.source() === text && reopened.render('index').html === runtime.render('index').html && equal(reopened.info().project.resources, originalResources), 'explicit source reopen retains data, descriptions and preview');
    for (const selection of [{}, { nodeIds: ['picture', 'label'], expectedVersion: runtime.getEntry('index').document.version, expectedProjectVersion: runtime.settings.version }]) {
      const exported = await runtime.exportDocument('index', selection);
      check(exported.html.includes(`src="${two}"`) && !exported.html.includes('asset:') && !exported.html.includes('data-divlet-id'), 'page and selected fragments use the same standalone closure');
    }
    check(runtime.source() === text && !('fontUpload' in runtime.info().project.capabilities) && runtime.info().site === null, 'export changes no source and grants no upload/site capability');
    await runtime.close(); await reopened.close(); return true;
  }, expected: true },
  { name: 'invalid bytes and unsupported reached references refuse before state, descriptors, events or persistence change', async run({ BrowserRuntime, projectClosedPreview }) {
    const stored = [], events = [];
    const runtime = await BrowserRuntime.open({ ...options(browserResourceSource()), resourcePolicy: { requireAssetBytes() {}, projectPreview: projectClosedPreview }, persist: text => { stored.push(text); } });
    runtime.subscribe(type => events.push(type)); const before = snapshot(runtime), settings = runtime.settings, entry = runtime.getEntry('index');
    const outcomes = [];
    for (const assets of [{ one: 'data:image/png;base64,!' }, { 'bad/name': null }, { one: null }]) outcomes.push(await code(() => runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { assets } })));
    for (const src of ['asset:one?rev=1', 'asset:missing']) outcomes.push(await code(() => runtime.patch({ documentId: 'index', expectedVersion: 1, patch: { nodes: { picture: { attrs: { src } } } } })));
    check(snapshot(runtime) === before && runtime.settings === settings && runtime.getEntry('index') === entry && !stored.length && !events.length, 'refusal must preserve the complete accepted state and identity');
    await runtime.close(); return outcomes;
  }, expected: ['INVALID_ASSET', 'INVALID_ASSET', 'INVALID_ASSET', 'UNSUPPORTED_EXPORT', 'INVALID_ASSET'] },
  { name: 'a byte refusal during final serialization precedes entry/render allocation, storage and events', async run({ BrowserRuntime, projectClosedPreview }) {
    const outcomes = [];
    for (const action of ['frame', 'project', 'create', 'undo', 'redo']) {
      let deny = false, armed = false; const stored = [], events = [];
      const refusal = Object.assign(new Error('host bytes refused'), { code: 'HOST_BYTES' });
      const runtime = await BrowserRuntime.open({ ...options(browserResourceSource()), resourcePolicy: {
        requireAssetBytes: () => { if (deny) throw refusal; },
        projectPreview: async (html, assets) => { const result = await projectClosedPreview(html, assets); if (armed) deny = true; return result; },
      }, persist: text => { stored.push(text); } });
      const edit = content => runtime.patch({ documentId: 'index', expectedVersion: runtime.getEntry('index').document.version, patch: { nodes: { label: { content } } } });
      if (action === 'undo' || action === 'redo') await edit('Earlier');
      if (action === 'redo') await runtime.undo();
      runtime.subscribe(type => events.push(type));
      const before = snapshot(runtime), entry = runtime.getEntry('index'), writes = stored.length; armed = true;
      const operations = {
        frame: () => edit('Refused'), project: () => runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { name: 'Refused' } }),
        create: () => runtime.create({ document: { ...structuredClone(runtime.getEntry('index').document), id: 'added' } }),
        undo: () => runtime.undo(), redo: () => runtime.redo(),
      };
      outcomes.push(await code(operations[action]));
      check(snapshot(runtime) === before && runtime.getEntry('index') === entry && stored.length === writes && !events.length, 'late validation refusal must not allocate accepted render IDs or publish/persist');
      const sourceOutcome = await code(() => runtime.source());
      check(sourceOutcome === 'HOST_BYTES', `source serialization must use the same policy (${action}: ${outcomes.at(-1)}, source ${sourceOutcome}, deny ${deny})`);
      deny = false; armed = false;
      await edit('Live');
      check(stored.length === writes + 1 && runtime.render('index').html.includes('Live'), 'the writer queue must remain usable');
      await runtime.close();
    }
    return outcomes;
  }, expected: Array(5).fill('HOST_BYTES') },
  { name: 'policy refusals during history retain whole groups and resource descriptions; successful replay remains live', async run({ BrowserRuntime, projectClosedPreview }) {
    let deny = false; const stored = [], events = [];
    const runtime = await BrowserRuntime.open({ ...options(browserResourceSource()), resourcePolicy: { requireAssetBytes: () => { if (deny) throw Object.assign(Error('denied'), { code: 'HOST_BYTES' }); }, projectPreview: projectClosedPreview }, persist: text => { stored.push(text); } });
    await runtime.patchProject({ expectedVersion: 1, patch: { assets: { alias: null }, metadata: { value: ['next'] } }, group: 'history-refusal' });
    await runtime.patch({ documentId: 'index', expectedVersion: 1, patch: { nodes: { label: { content: 'Grouped' } } }, group: 'history-refusal' });
    check(equal(runtime.info().project.resources, [descriptor('one'), descriptor('unused')]), 'accepted deletion updates descriptions');
    runtime.subscribe(type => events.push(type)); const before = snapshot(runtime), writes = stored.length; deny = true;
    const outcome = await code(() => runtime.undo());
    check(snapshot(runtime) === before && stored.length === writes && !events.length, 'refused replay cannot change stacks, descriptions or storage');
    deny = false; await runtime.undo();
    check(equal(runtime.info().project.resources, [descriptor('one'), descriptor('unused'), descriptor('alias')]) && runtime.settings.metadata.value === null && runtime.getEntry('index').document.nodes.label.content === 'Before', 'successful grouped Undo restores descriptions, nullable settings and frame');
    await runtime.redo();
    check(equal(runtime.info().project.resources, [descriptor('one'), descriptor('unused')]), 'successful replay updates descriptions with accepted settings');
    await runtime.close(); return outcome;
  }, expected: 'CANNOT_UNDO' },
  { name: 'underlying storage rejection retains the existing diagnostic-and-accept host policy', async run({ BrowserRuntime, projectClosedPreview }) {
    const runtime = await BrowserRuntime.open({ ...options(browserResourceSource()), resourcePolicy: { requireAssetBytes() {}, projectPreview: projectClosedPreview }, persist: () => { throw Error('quota'); } });
    await runtime.patchProject({ expectedVersion: 1, patch: { assets: { one: two } } });
    check(runtime.settings.assets.one === two && runtime.render('index').html.includes(`src="${two}"`) && runtime.info().diagnostics.some(item => item.code === 'STORAGE_FAILED'), 'host storage failure must retain existing acceptance semantics');
    await runtime.close(); return true;
  }, expected: true },
];
