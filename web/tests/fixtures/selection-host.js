// Fixed test compositions: real store/util modules, a snapshot reader and an optional held publisher. No HTTP fallback.
import { createSnapshotReadSession } from '../read-session.js';
const data = await (await fetch(new URL('../public-snapshot.json', import.meta.url))).json();
export const state = structuredClone(data.state);
export const frame = data.frames[0][1];
state.documents.push({ ...structuredClone(state.documents[0]), id: 'second', name: 'Second' });
state.selection.selectedNodes = { documentId: 'index', nodeIds: [frame.rootId] };
const frames = new Map(data.frames);
frames.set('second', { ...structuredClone(frame), id: 'second' });
export const readSession = createSnapshotReadSession({ state, frames });
export const publications = [], rawRequests = [];
export const shareSelection = import.meta.url.includes('/shared/') ? selection => new Promise((resolve, reject) => publications.push({ selection: structuredClone(selection), resolve, reject })) : undefined;
export const base = new URL('../', import.meta.url);
export const apiUrl = path => new URL(path, base).href;
export const request = async (...args) => { rawRequests.push(args); throw new Error('Unexpected raw HTTP in selection witness'); };
export const post = request;
// Writes and previews are semantic ports; this witness accepts none of them.
const refuse = name => async (...args) => { rawRequests.push([name, ...args]); throw new Error(`Unexpected ${name} in selection witness`); };
export const writer = Object.freeze({ patch: refuse('patch'), edit: refuse('edit'), undo: refuse('undo'), redo: refuse('redo'), createArtboard: refuse('createArtboard'), deleteArtboard: refuse('deleteArtboard') });
export const previews = Object.freeze({ frameUrl: () => 'about:blank', readRender: refuse('readRender') });
export const components = undefined;
export const native = false;
export const hostLabel = 'witness';
