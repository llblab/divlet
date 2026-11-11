import { createSnapshotReadSession } from '../lib/board-session.ts';
import type { BoardReadEvent, BoardReadSession, BoardSelection, BoardSelectionPublisher } from '../lib/board-session.ts';
import { createHttpReadSession, createHttpSelectionPublisher } from '../../web/lib/http-session.js';
import { createJsonTransport } from '../../web/lib/http.js';

const transport = createJsonTransport(new URL('http://127.0.0.1/token/'));
const native: BoardReadSession = createHttpReadSession({ request: transport.request, events: () => ({ addEventListener() {}, close() {} }) });
const snapshot: BoardReadSession = createSnapshotReadSession({ state: {}, frames: new Map() });
const publish: BoardSelectionPublisher = createHttpSelectionPublisher(transport.post);
const selection: BoardSelection = { ids: ['index'], nodes: { documentId: 'index', nodeIds: ['root'] } };
const event: BoardReadEvent = { type: 'state', value: { projectId: 'demo' } };
void event;
if (false) {
  void publish(selection);
  // @ts-expect-error selection publication does not grant project patches
  void publish({ patch: {} });
  // @ts-expect-error publication inputs are readonly view data
  selection.ids.push('other');
  // @ts-expect-error the read port does not gain a selection writer
  void snapshot.shareSelection(selection);
  void native.readState();
  void snapshot.readFrame('index');
  // @ts-expect-error the read port grants no writes or raw route dispatch
  snapshot.post('api/patch', {});
  // @ts-expect-error frame identity is explicit
  native.readFrame();
  // @ts-expect-error a transport payload is not implicitly an accepted state/model
  native.readState().then(state => state.projectId);
  // @ts-expect-error connections describe host availability, not arbitrary agent/session settings
  const invalid: BoardReadEvent = { type: 'connection', status: 'busy' };
  void invalid;
}
