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
  return results;
}

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
];
