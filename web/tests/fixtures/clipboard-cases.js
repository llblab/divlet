// Actual clipboard/store/host consumers; only canvas/artboard UI collaborators and the OS clipboard are inert.
export async function clipboardCases() {
  const checks = [], record = (name, actual, expected) => checks.push({ name, actual: structuredClone(actual), expected: structuredClone(expected) });
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const key = Symbol.for('divlet.board-host/1'), savedHost = Object.getOwnPropertyDescriptor(globalThis, key);
  const savedClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard'), savedFetch = globalThis.fetch;
  const raw = [], writes = [];
  globalThis.fetch = async (...args) => { raw.push(String(args[0])); throw new Error('Unexpected native HTTP fallback'); };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { writes.push(text); } } });
  try {
    for (const mode of ['absent', 'page', 'nodes', 'refused']) {
      document.body.innerHTML = '<main id="viewport" tabindex="0"></main>';
      const calls = [], edits = [], toasts = [];
      const model = { id: 'index', version: 7, rootId: 'root', nodes: {
        root: { id: 'root', type: 'element', tag: 'main', attrs: {}, style: {}, children: ['a', 'b'] },
        a: { id: 'a', type: 'element', tag: 'span', attrs: {}, style: {}, children: ['label'] },
        label: { id: 'label', type: 'text', content: 'Selected & safe' },
        b: { id: 'b', type: 'element', tag: 'img', attrs: { src: 'data:image/png;base64,AQ==' }, style: {}, children: [] },
      } };
      const html = '<span>closed export</span><img src="data:image/png;base64,AQ==">';
      const refusal = Object.assign(new Error('Captured export version changed'), { code: 'REVISION_CONFLICT' });
      let exportNodes = async () => ({ html });
      const service = mode === 'absent' ? undefined : {
        page: async () => { throw new Error('A selected-node copy must not export the page'); },
        ...(mode === 'page' ? {} : { nodes: async (id, options) => { calls.push([id, structuredClone(options)]); if (mode === 'refused') throw refusal; return exportNodes(); } }),
      };
      const unused = async () => { throw new Error('Unexpected host call'); };
      Object.defineProperty(globalThis, key, { configurable: true, value: {
        label: 'clipboard-test',
        readSession: { readState: unused, readFrame: async () => structuredClone(model), subscribe: () => () => {} },
        writer: { patch: unused, edit: async body => { edits.push(structuredClone(body)); return { version: 8 }; }, undo: unused, redo: unused, createArtboard: unused, deleteArtboard: unused },
        previews: { frameUrl: () => '', readRender: unused },
        ...(service ? { exports: service } : {}),
      } });
      const store = await import(new URL(`copy-${mode}/store.js`, import.meta.url).href);
      const clip = await import(new URL(`copy-${mode}/clip.js`, import.meta.url).href);
      store.on('toast', toast => toasts.push(toast.message));
      store.receiveState({ stateVersion: 1, projectId: 'copy', url: '', project: { file: 'copy.divlet', version: 9, resources: [{ path: 'asset:declared' }] }, documents: [{ id: 'index', version: 7, render: 13 }], selection: { ids: ['index'] } });
      store.selectNodes('index', ['b', 'label', 'a']);
      await store.loadModel('index');
      const event = () => {
        const values = [];
        return { prevented: 0, values, preventDefault() { this.prevented++; }, clipboardData: { setData(type, text) { values.push([type, text]); } } };
      };
      let currentEvent = event();
      const initialWrites = writes.length;
      record(`${mode}: copy is handled synchronously and suppresses raw resource HTML`, [clip.copySelection({ event: currentEvent }), currentEvent.prevented, currentEvent.values], [true, 1, []]);
      await tick();
      record(`${mode}: selection export is an optional capability, never page export`, calls, ['nodes', 'refused'].includes(mode) ? [['index', { nodeIds: ['a', 'b'], expectedVersion: 7, expectedProjectVersion: 9 }]] : []);
      record(`${mode}: only a successful selected-node export reaches the clipboard`, writes.slice(initialWrites), mode === 'nodes' ? [html] : []);
      if (mode !== 'nodes') {
        record(`${mode}: missing capability or refusal gives exact feedback`, toasts.at(-1), mode === 'refused' ? refusal.message : 'This host cannot export selected elements with project resources.');
        clip.copySelection({ cut: true });
        await tick(); await store.idle('index');
        record(`${mode}: a refused export cannot cut content`, edits, []);
      } else {
        let release;
        exportNodes = () => new Promise(resolve => { release = resolve; });
        clip.copySelection({ cut: true });
        exportNodes = async () => ({ html: '<span>newer copy</span>' });
        clip.copySelection();
        await tick();
        record('the deferred selected-node export reached its host', typeof release, 'function');
        if (release) release({ html: '<span>obsolete export</span>' });
        await tick(); await store.idle('index');
        record('a superseded late export neither writes nor cuts', { writes: writes.slice(initialWrites), edits }, { writes: [html, '<span>newer copy</span>'], edits: [] });
        clip.copySelection({ cut: true });
        await tick(); await store.idle('index'); await tick();
        record('successful resource Cut keeps captured render/version and one queued removal', edits, [{ documentId: 'index', expectedVersion: 7, expectedRender: 13, op: { type: 'remove', ids: ['a', 'b'] }, label: 'cut 2 elements', group: undefined }]);
        store.selectNodes('index', ['a']);
      }
      // A resource-free cached copy must still fill a DOM copy event before returning, without a host call.
      store.store.state.project.resources = [];
      currentEvent = event();
      const priorCalls = calls.length;
      clip.copySelection({ event: currentEvent });
      record(`${mode}: resource-free copy keeps the synchronous clipboard path`, { types: currentEvent.values.map(([type]) => type), prevented: currentEvent.prevented, hostCalls: calls.length - priorCalls }, { types: ['text/plain', 'text/html'], prevented: 1, hostCalls: 0 });
    }
    record('all alternative hosts avoid native HTTP entirely', raw, []);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedHost) Object.defineProperty(globalThis, key, savedHost); else delete globalThis[key];
    if (savedClipboard) Object.defineProperty(navigator, 'clipboard', savedClipboard); else delete navigator.clipboard;
  }
  return checks;
}
