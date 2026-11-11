// Fixed optional-service compositions. Raw routes remain refusals; only explicit semantic operations can succeed.
export * from './selection-host.js';
const mode = new URL(import.meta.url).pathname.split('/').at(-2);
export const serviceCalls = [], sourceControl = { error: null, openError: null };
export const historyService = mode === 'absent' ? undefined : Object.freeze({
  readRecent: async () => {
    serviceCalls.push(['history']);
    return { changes: [], navigation: true, timeline: { current: 'current', index: 1, boundary: 'opened', points: [{ id: 'baseline', label: 'Baseline', seq: null }, { id: 'current', label: 'Current edit', seq: 1, firstSeq: 1 }] } };
  },
  navigate: mode === 'services' ? async target => { serviceCalls.push(['navigate', target]); return {}; } : undefined,
});
export const sourceUpdates = mode !== 'services' ? undefined : Object.freeze({
  readStatus: async () => { serviceCalls.push(['import-status']); if (sourceControl.error) throw sourceControl.error; return { status: { changed: true, source: 'public-source.pen' } }; },
  reimport: async () => { serviceCalls.push(['reimport']); return { file: 'copy.divlet' }; },
  openProject: async path => { serviceCalls.push(['open', path]); if (sourceControl.openError) throw sourceControl.openError; return { url: './' }; },
});
