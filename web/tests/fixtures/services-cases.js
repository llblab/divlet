// Consumer witnesses use actual activity/project/store code; canvas/sidebar/chat collaborators are inert UI-only doubles.
export async function serviceCases() {
  const checks = [], record = (name, actual, expected) => checks.push({ name, actual, expected });
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  for (const mode of ['absent', 'audit', 'services']) {
    document.body.innerHTML = '<div id="ui"></div><button id="status"></button><i id="status-dot"></i><span id="diag-count"></span><button id="open-history"></button><span id="live-count">0</span><section id="activity"></section><main id="viewport" tabindex="0"></main>';
    const [store, host, activity, project] = await Promise.all(['store', 'host', 'activity', 'project'].map(file => import(new URL(`${mode}/${file}.js`, import.meta.url).href)));
    const toasts = []; store.on('toast', toast => toasts.push(toast));
    store.setConnection('connected');
    // Even a state claiming navigation cannot manufacture an absent host capability.
    store.receiveState({ ...structuredClone(host.state), history: { navigation: true, pointId: 'current' } });
    await activity.loadRecent(); activity.render();
    record(`${mode}: navigation affordance requires both host authority and advertised state`, document.querySelectorAll('[data-history-point]').length, mode === 'services' ? 2 : 0);
    if (mode === 'absent') {
      store.emit('sidebar', { open: true, tab: 'activity' });
      await project.checkImport(); await activity.loadRecent();
      record('absent services perform no startup/sidebar requests or notifications', { semantic: host.serviceCalls.length, raw: host.rawRequests.length, toasts: toasts.length }, { semantic: 0, raw: 0, toasts: 0 });
      record('absent History names the limitation instead of promising edit history', document.querySelector('#activity').textContent.includes('This host does not provide change history.'), true);
    }
    if (mode === 'audit') record('an audit-only service can read without exposing restore controls', host.serviceCalls, [['history']]);
    if (mode === 'services') {
      document.querySelector('[data-history-point="baseline"]').click();
      await tick();
      record('history restore delegates the rendered captured target once', host.serviceCalls.filter(([name]) => name === 'navigate'), [['navigate', { pointId: 'baseline', expectedPoint: 'current' }]]);
      host.sourceControl.error = new Error('source unavailable');
      await project.checkImport();
      record('source status failure remains a silent bootstrap check', toasts.length, 0);
      host.sourceControl.error = null;
      await project.checkImport(); await project.checkImport();
      record('changed source notices are deduplicated and carry the existing import action', { count: toasts.length, label: toasts[0].action.label }, { count: 1, label: 'Import again' });
      await toasts[0].action.run();
      record('import action uses its advertised workflow and offers the copied project', { calls: host.serviceCalls.filter(([name]) => name === 'reimport'), label: toasts[1].action.label }, { calls: [['reimport']], label: 'Open' });
      host.sourceControl.openError = new Error('copy could not be opened');
      await toasts[1].action.run();
      record('Open delegates the captured copied filename and preserves refusal feedback without navigation', { calls: host.serviceCalls.filter(([name]) => name === 'open'), error: toasts.at(-1).message }, { calls: [['open', 'copy.divlet']], error: 'copy could not be opened' });
      record('semantic native services do not fall back to raw route dispatch', host.rawRequests.length, 0);
    }
  }
  return checks;
}
