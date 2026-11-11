// Actual store modules under fixed local/shared host compositions; not a replacement selection implementation.
export async function selectionCases(local, localHost, shared, sharedHost) {
  const checks = [], tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const record = (name, actual, expected) => checks.push({ name, actual, expected });
  const root = localHost.frame.rootId, localToasts = [];
  local.on('toast', toast => localToasts.push(toast.message));
  const next = (host, version, ids = ['index']) => ({ ...structuredClone(host.state), stateVersion: version, selection: { ids, revision: version, selectedNodes: { documentId: 'index', nodeIds: [root] } } });
  local.receiveState(await localHost.readSession.readState());
  record('local initial public selection seeds the view', { ids: [...local.store.selected], node: local.store.node }, { ids: ['index'], node: { documentId: 'index', nodeIds: [root] } });
  local.selectNodes('second', [root]);
  local.receiveState(next(localHost, 2));
  record('later host reads do not override local frame/node selection', { ids: [...local.store.selected], node: local.store.node }, { ids: ['second'], node: { documentId: 'second', nodeIds: [root] } });
  local.selectNodes('index', [root, 'missing-node']);
  await local.loadModel('index');
  record('local model admission prunes missing node selection without publishing', local.store.node.nodeIds, [root]);
  local.selectArtboards([]);
  local.receiveState(next(localHost, 3));
  record('a cleared local selection is not resurrected by a snapshot echo', { ids: [...local.store.selected], node: local.store.node }, { ids: [], node: null });
  local.selectNodes('second', [root]);
  await local.loadModel('second');
  const removed = next(localHost, 4); removed.documents = removed.documents.filter(doc => doc.id !== 'second');
  local.receiveState(removed);
  record('removed frames prune local selection and cached models', { ids: [...local.store.selected], node: local.store.node, cached: local.store.models.has('second') }, { ids: [], node: null, cached: false });
  record('local selection has no pending publication, refusal toast or raw route dispatch', { pending: local.isSelectionPending(), publications: localHost.publications.length, raw: localHost.rawRequests.length, toasts: localToasts }, { pending: false, publications: 0, raw: 0, toasts: [] });

  shared.receiveState(await sharedHost.readSession.readState());
  shared.selectArtboards(['second']);
  shared.receiveState(next(sharedHost, 2));
  record('shared in-flight intent survives an older state selection', { ids: [...shared.store.selected], pending: shared.isSelectionPending(), payload: sharedHost.publications[0].selection }, { ids: ['second'], pending: true, payload: { ids: ['second'], nodes: undefined } });
  shared.receiveState(next(sharedHost, 3, ['second']));
  record('a matching shared state echo is accepted without completing publication', { ids: [...shared.store.selected], pending: shared.isSelectionPending(), version: shared.store.state.stateVersion }, { ids: ['second'], pending: true, version: 3 });
  shared.selectNodes('index', [root]);
  sharedHost.publications[0].resolve(next(sharedHost, 4, ['second']));
  await tick();
  record('out-of-order shared replies cannot complete a newer selection', { version: shared.store.state.stateVersion, ids: [...shared.store.selected], pending: shared.isSelectionPending() }, { version: 3, ids: ['index'], pending: true });
  sharedHost.publications[1].resolve(next(sharedHost, 5));
  await tick();
  record('the latest shared reply retains state acceptance and completes selection', { version: shared.store.state.stateVersion, pending: shared.isSelectionPending(), node: shared.store.node, payload: sharedHost.publications[1].selection }, { version: 5, pending: false, node: { documentId: 'index', nodeIds: [root] }, payload: { ids: ['index'], nodes: { documentId: 'index', nodeIds: [root] } } });
  const toasts = []; shared.on('toast', toast => toasts.push(toast.message));
  shared.selectArtboards(['second']);
  shared.selectNodes('index', [root]);
  sharedHost.publications[2].reject(new Error('older refusal'));
  await tick();
  record('an obsolete refusal retains newer pending authority and existing failure feedback', { pending: shared.isSelectionPending(), node: shared.store.node, toasts: [...toasts] }, { pending: true, node: { documentId: 'index', nodeIds: [root] }, toasts: ['Selection could not be shared: older refusal'] });
  sharedHost.publications[3].reject(new Error('host offline'));
  await tick();
  record('shared refusal releases pending state and preserves failure feedback without raw routes', { pending: shared.isSelectionPending(), toasts, raw: sharedHost.rawRequests.length }, { pending: false, toasts: ['Selection could not be shared: older refusal', 'Selection could not be shared: host offline'], raw: 0 });
  return checks;
}
