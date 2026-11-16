// Authored shared Node/Chromium witnesses. The projector is trusted composition, never read from the project.
export const previewCandidateSource = { schemaVersion: 1, frames: [{
  id: 'index', name: 'Preview candidate', version: 1, rootId: 'root',
  artboard: { x: 0, y: 0, width: 300, height: 200 },
  nodes: { root: { id: 'root', type: 'element', tag: 'main', children: ['text'] }, text: { id: 'text', type: 'text', content: 'Initial' } },
}] };
const check = (condition, message) => { if (!condition) throw Error(message); };
const compiler = { compile: () => '', unknown: () => ({}) };
const code = async action => { try { await action(); return 'accepted'; } catch (error) { return error.code || error.name; } };

export async function previewCandidateCases({ BrowserRuntime, projectClosedPreview, PREVIEW_HTML_BYTES }) {
  const results = [];
  const exact = '<html><head></head><body>' + 'x'.repeat(PREVIEW_HTML_BYTES - 39) + '</body></html>';
  check(new TextEncoder().encode(exact).length === PREVIEW_HTML_BYTES, 'Exact HTML fixture boundary');
  check(await projectClosedPreview(exact, {}) === exact, 'Resource-free boundary is an exact no-op');
  const tooLarge = exact + 'x';
  results.push({ name: 'resource-free projection boundary', exact: exact.length, oversized: await code(() => projectClosedPreview(tooLarge, {})) });
  const unicode = 'λ'.repeat(PREVIEW_HTML_BYTES / 2);
  check(await projectClosedPreview(unicode, {}) === unicode, 'UTF-8 boundary remains accepted');
  results.push({ name: 'UTF-8 projection boundary', oversized: await code(() => projectClosedPreview(unicode + 'x', {})) });
  const persisted = [], events = [];
  const options = { source: previewCandidateSource, file: 'project.divlet', projectId: 'preview-proof', compiler, persist: text => persisted.push(text) };
  results.push({ name: 'initial writer refusal', error: await code(() => BrowserRuntime.open({ ...options, projectPreview: () => tooLarge })), persisted: persisted.length });
  let mode = 'pass', entered, release;
  const projectPreview = async (html, assets) => {
    if (mode === 'hold') { entered(); await new Promise(resolve => { release = resolve; }); }
    if (mode === 'large') return tooLarge;
    if (mode === 'invalid') return 7;
    if (mode === 'mutate') { assets.accidental = 'data:application/octet-stream;base64,AQID'; throw Error('Projection failed after changing its detached input'); }
    return projectClosedPreview(html, assets);
  };
  const runtime = await BrowserRuntime.open({ ...options, projectPreview });
  const stop = runtime.subscribe((type, value) => events.push({ type, value }));
  const snapshot = () => JSON.stringify({ source: runtime.source(), documents: [...runtime.documents], settings: runtime.settings, revision: runtime.revision, renderSeq: runtime.renderSeq, history: runtime.readHistory(), undo: runtime.undoStack, redo: runtime.redoStack, selection: runtime.selection, work: runtime.work, diagnostics: [...runtime.diagnostics], groupCounter: runtime.groupCounter, persisted, events });
  const patch = text => runtime.patch({ documentId: 'index', expectedVersion: runtime.getEntry('index').document.version, patch: { nodes: { text: { content: text } } } });
  const refuse = async (name, action, expected = 'FILE_TOO_LARGE') => {
    let message;
    const before = snapshot(), error = await code(async () => { try { return await action(); } catch (error) { message = error.message; throw error; } });
    check(error === expected, `${name}: ${error}`);
    if (expected === 'CANNOT_UNDO') check(message.includes('projected preview exceeds the 4 MiB limit'), `${name}: preserve the projection refusal cause`);
    check(snapshot() === before, `${name}: refusal changed accepted state, persistence or publication`);
    results.push({ name, error, retained: true });
  };
  try {
    await patch('Accepted');
    const source = runtime.source();
    mode = 'large';
    await refuse('live writer refusal', () => patch('Refused'));
    await refuse('project candidate refusal', () => runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { css: 'main{padding:17px}' } }));
    await refuse('create candidate refusal', () => runtime.create({ document: { ...runtime.getEntry('index').document, id: 'second', version: 1 } }));
    await refuse('undo candidate refusal', () => runtime.undo(), 'CANNOT_UNDO');
    mode = 'pass'; await runtime.undo();
    mode = 'large'; await refuse('redo candidate refusal', () => runtime.redo(), 'CANNOT_UNDO');
    mode = 'pass'; await runtime.redo();
    check(runtime.getEntry('index').document.nodes.text.content === 'Accepted', 'Undo/Redo content');
    check(JSON.parse(source).frames[0].nodes.text.content === 'Accepted', 'Canonical source contains authored text');
    mode = 'invalid'; await refuse('non-text projection refusal', () => patch('Invalid'), 'INVALID_DOCUMENT');
    mode = 'mutate'; await refuse('projection input isolation', () => patch('Isolated'), 'INVALID_DOCUMENT');
    mode = 'hold';
    const started = new Promise(resolve => { entered = resolve; });
    const before = snapshot();
    const first = patch('Queued'); await started;
    check(snapshot() === before, 'Pending projection cannot accept/persist/publish');
    const stale = code(() => patch('Stale'));
    release(); await first;
    check(await stale === 'REVISION_CONFLICT', 'Queued expected version must be checked after projection completes');
    check(runtime.getEntry('index').document.nodes.text.content === 'Queued', 'Queue retained first commit');
    results.push({ name: 'awaited projection in writer queue', retainedWhilePending: true, stale: 'REVISION_CONFLICT' });
    mode = 'pass';
    await refuse('asset patch gate unchanged', () => runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { assets: { image: 'data:image/png;base64,AQID' } } }), 'ASSETS_UNAVAILABLE');
  } finally { stop(); await runtime.close(); }
  return [...results, ...await latePreviewCandidateCases({ BrowserRuntime, projectClosedPreview, PREVIEW_HTML_BYTES })];
}

/** Earlier successful preparation must not commit even a render number before a later frame refuses. */
export async function latePreviewCandidateCases({ BrowserRuntime, projectClosedPreview, PREVIEW_HTML_BYTES }) {
  const definition = structuredClone(previewCandidateSource.frames[0]);
  definition.id = 'definition'; definition.name = 'Definition';
  definition.nodes.root.children = ['part'];
  definition.nodes.part = { id: 'part', type: 'element', tag: 'section', reusable: true, children: ['text'] };
  const consumer = structuredClone(previewCandidateSource.frames[0]);
  consumer.id = 'consumer'; consumer.name = 'Consumer'; consumer.artboard.x = 400;
  consumer.nodes = { root: { id: 'root', type: 'element', tag: 'main', children: ['instance'] }, instance: { id: 'instance', type: 'ref', ref: 'definition/part' } };
  const source = { schemaVersion: 1, frames: [definition, consumer] };
  const input = JSON.stringify(source), persisted = [], events = [], results = [];
  const oversized = 'x'.repeat(PREVIEW_HTML_BYTES + 1);
  let refuseConsumer = true, trace = [], baseline = new Map(), pendingProbe, partialState = false;
  const projectPreview = async (html, assets) => {
    const id = /<title>(Definition|Consumer)<\/title>/.exec(html)?.[1].toLowerCase();
    check(id, 'Prepared fixture identifies its frame');
    if (refuseConsumer && id === 'consumer') {
      partialState = !!pendingProbe && !pendingProbe();
      trace.push({ id, result: 'oversized' }); return oversized;
    }
    const projected = await projectClosedPreview(html, assets);
    trace.push({ id, result: 'pass', changed: projected !== baseline.get(id) });
    return projected;
  };
  const options = { source, file: 'project.divlet', projectId: 'late-preview-proof', compiler, projectPreview, persist: text => persisted.push(text) };
  const initial = await code(() => BrowserRuntime.open(options));
  check(initial === 'FILE_TOO_LARGE' && persisted.length === 0 && JSON.stringify(source) === input, 'Late initial refusal preserves input and storage');
  check(JSON.stringify(trace) === JSON.stringify([{ id: 'definition', result: 'pass', changed: true }, { id: 'consumer', result: 'oversized' }]), 'Initial refusal is late, after one successful projection');
  results.push({ name: 'late initial multi-frame refusal', error: initial, firstPassed: true });
  refuseConsumer = false;
  const runtime = await BrowserRuntime.open(options);
  const stop = runtime.subscribe((type, value) => events.push({ type, value }));
  const snapshot = () => JSON.stringify({ source: runtime.source(), entries: [...runtime.documents], settings: runtime.settings, revision: runtime.revision, stateVersion: runtime.stateVersion, renderSeq: runtime.renderSeq, history: runtime.readHistory(), undo: runtime.undoStack, redo: runtime.redoStack, selection: runtime.selection, work: runtime.work, observations: [...runtime.observations], diagnostics: [...runtime.diagnostics], groupCounter: runtime.groupCounter, persisted, events });
  const patch = (id, nodes, group) => runtime.patch({ documentId: id, expectedVersion: runtime.getEntry(id).document.version, patch: { nodes }, group });
  const populate = () => {
    runtime.setSelection({ ids: ['consumer'], nodes: { documentId: 'consumer', nodeIds: ['instance'] } });
    runtime.markWork({ documentId: 'definition', nodeIds: ['part'], note: 'Definition' });
    runtime.markWork({ documentId: 'consumer', nodeIds: ['instance'], note: 'Consumer', add: true });
    for (const id of ['definition', 'consumer']) runtime.setObservations({ documentId: id, version: runtime.getEntry(id).render, nodes: [{ id: 'root', rect: { x: 0, y: 0, width: 300, height: 200 } }] });
    check(runtime.selection.selectedNodes.nodeIds.length === 1 && runtime.work.length === 2 && runtime.observations.size === 2, 'Retention state is populated');
  };
  const refuse = async (name, action, expected) => {
    populate(); trace = []; refuseConsumer = true;
    baseline = new Map([...runtime.documents].map(([id, entry]) => [id, entry.html]));
    const before = snapshot(), entries = runtime.documents, identities = [...entries];
    pendingProbe = () => snapshot() === before && runtime.documents === entries && identities.every(([id, entry]) => runtime.documents.get(id) === entry);
    partialState = false;
    let message;
    const error = await code(async () => { try { return await action(); } catch (error) { message = error.message; throw error; } });
    check(error === expected && message.includes('projected preview exceeds the 4 MiB limit'), `${name}: exact projection refusal`);
    check(JSON.stringify(trace) === JSON.stringify([{ id: 'definition', result: 'pass', changed: true }, { id: 'consumer', result: 'oversized' }]), `${name}: changed first frame succeeded before second refused`);
    check(!partialState, `${name}: earlier projection exposed partial accepted state during later preparation`);
    check(snapshot() === before, `${name}: late refusal changed whole-candidate state`);
    check(runtime.documents === entries && identities.every(([id, entry]) => runtime.documents.get(id) === entry), `${name}: accepted entry identities retained`);
    results.push({ name, error, firstPassed: true, populatedStateRetained: true });
    refuseConsumer = false; pendingProbe = undefined;
  };
  try {
    check(runtime.usedBy('definition').includes('consumer'), 'The second frame is a real component dependent');
    await patch('definition', { text: { content: 'Grouped definition' } }, 'paired');
    await patch('consumer', { root: { style: { 'margin-left': '3px' } } }, 'paired');
    await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { css: 'main{padding:11px}' }, group: 'later' });
    check(runtime.undoStack.length === 2 && runtime.undoStack[0].items.length === 2, 'History has a two-item group plus a later group');
    await refuse('late dependent patch refusal', () => patch('definition', { text: { content: 'Refused definition' } }, 'refused'), 'FILE_TOO_LARGE');
    await refuse('late project preparation refusal', () => runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { css: 'main{padding:19px}' } }), 'FILE_TOO_LARGE');
    await refuse('late multi-step grouped undo refusal', () => runtime.undo({ steps: 2 }), 'CANNOT_UNDO');
    await runtime.undo({ steps: 2 });
    check(runtime.getEntry('definition').document.nodes.text.content === 'Initial' && !Object.hasOwn(runtime.getEntry('consumer').document.nodes.root.style, 'margin-left') && runtime.settings.css === '', 'Successful two-step Undo restores both groups');
    check(runtime.undoStack.length === 0 && runtime.redoStack.length === 2, 'Whole two-step Undo moved stack authority');
    await refuse('late multi-step grouped redo refusal', () => runtime.redo({ steps: 2 }), 'CANNOT_UNDO');
    await runtime.redo({ steps: 2 });
    check(runtime.getEntry('definition').document.nodes.text.content === 'Grouped definition' && runtime.getEntry('consumer').document.nodes.root.style['margin-left'] === '3px' && runtime.settings.css === 'main{padding:11px}', 'Successful two-step Redo restores authored content');
    check(runtime.undoStack.length === 2 && runtime.redoStack.length === 0 && [...runtime.documents.keys()].join(',') === 'definition,consumer', 'Whole Redo restored stack and frame order');
    results.push({ name: 'multi-frame replay liveness', groups: 2, groupedItems: 2, restored: true });
  } finally { stop(); await runtime.close(); }
  return results;
}

export const expectedLatePreviewCandidates = [
  { name: 'late initial multi-frame refusal', error: 'FILE_TOO_LARGE', firstPassed: true },
  ...['late dependent patch refusal', 'late project preparation refusal'].map(name => ({ name, error: 'FILE_TOO_LARGE', firstPassed: true, populatedStateRetained: true })),
  ...['late multi-step grouped undo refusal', 'late multi-step grouped redo refusal'].map(name => ({ name, error: 'CANNOT_UNDO', firstPassed: true, populatedStateRetained: true })),
  { name: 'multi-frame replay liveness', groups: 2, groupedItems: 2, restored: true },
];

export const expectedPreviewCandidates = [
  { name: 'resource-free projection boundary', exact: 4194304, oversized: 'FILE_TOO_LARGE' },
  { name: 'UTF-8 projection boundary', oversized: 'FILE_TOO_LARGE' },
  { name: 'initial writer refusal', error: 'FILE_TOO_LARGE', persisted: 0 },
  ...['live writer refusal', 'project candidate refusal', 'create candidate refusal'].map(name => ({ name, error: 'FILE_TOO_LARGE', retained: true })),
  ...['undo candidate refusal', 'redo candidate refusal'].map(name => ({ name, error: 'CANNOT_UNDO', retained: true })),
  { name: 'non-text projection refusal', error: 'INVALID_DOCUMENT', retained: true },
  { name: 'projection input isolation', error: 'INVALID_DOCUMENT', retained: true },
  { name: 'awaited projection in writer queue', retainedWhilePending: true, stale: 'REVISION_CONFLICT' },
  { name: 'asset patch gate unchanged', error: 'ASSETS_UNAVAILABLE', retained: true },
  ...expectedLatePreviewCandidates,
];
