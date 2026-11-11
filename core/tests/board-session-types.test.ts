import { createSnapshotReadSession } from '../lib/board-session.ts';
import type { BoardReadEvent, BoardReadSession } from '../lib/board-session.ts';
import { createHttpReadSession } from '../../web/lib/http-session.js';
import { createJsonTransport } from '../../web/lib/http.js';

const transport = createJsonTransport(new URL('http://127.0.0.1/token/'));
const native: BoardReadSession = createHttpReadSession({ request: transport.request, events: () => ({ addEventListener() {}, close() {} }) });
const snapshot: BoardReadSession = createSnapshotReadSession({ state: {}, frames: new Map() });
const event: BoardReadEvent = { type: 'state', value: { projectId: 'demo' } };
void event;
if (false) {
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
