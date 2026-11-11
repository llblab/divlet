import test from 'node:test';
import { legacyProject } from './fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openRuntime } from '../lib/runtime.js';
import { createDemoDocument } from '../lib/model.ts';

async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-http-'));
  await legacyProject(path.join(cwd, 'project.divlet'));
  const runtime = await openRuntime({ cwd, watch: false, createDemo: false });
  t.after(async () => { await runtime.close(); await fs.rm(cwd, { recursive: true, force: true }); });
  await runtime.create({ document: createDemoDocument() });
  return { cwd, runtime, url: runtime.url, id: runtime.info().documents[0].id };
}

test('HTTP serves authenticated project/render/preview and exposes the incremental bridge', async t => {
  const { runtime, url, id } = await fixture(t);
  const response = await fetch(url + 'api/project');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).projectId, runtime.projectId);
  const html = await (await fetch(url + `preview/${id}`)).text();
  assert.match(html, /divlet:update/);
  assert.match(html, /data-divlet-id/);
  const base = /<base href="([^"]+)"/.exec(html)?.[1];
  assert.equal(new URL(base, url).href, url + 'files/');
  const render = await (await fetch(url + `api/render/${id}`)).json();
  assert.equal(render.version, 1);
  assert.doesNotMatch(render.html, /function previewBridge/);
  assert.equal((await fetch(new URL('/api/project', url))).status, 404);
  const previewResponse = await fetch(url + `preview/${id}`);
  assert.match(previewResponse.headers.get('content-security-policy'), /script-src 'nonce-/);
  assert.equal(previewResponse.headers.get('referrer-policy'), 'no-referrer');
});

test('frame browsing serves the prepared public page without editor authority or a resource base', async t => {
  const { runtime, url, id } = await fixture(t);
  await runtime.patch({ documentId: id, expectedVersion: 1, patch: { css: '.browse-close::after { content: "</body>"; }' } });
  const source = await fs.readFile(runtime.projectPath);
  const view = runtime.info().documents.find(frame => frame.id === id).viewUrl;
  assert.equal(typeof view, 'string', 'the source owner provides the exact public frame URL');
  const response = await fetch(view);
  assert.equal(response.status, 200);
  const html = await response.text(), policy = response.headers.get('content-security-policy');
  assert.doesNotMatch(html, /<base\b|function previewBridge|divlet:connect|divlet:update|divlet-metadata/);
  assert.match(html, /divlet:escape/);
  assert.ok(html.indexOf('divlet:escape') > html.lastIndexOf('</style>'), 'a literal closing-body string in authored CSS cannot swallow the Escape helper');
  assert.match(policy, /sandbox allow-scripts/);
  assert.match(policy, /script-src 'nonce-/);
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /form-action 'none'/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const manifest = JSON.parse(await fs.readFile(path.join(runtime.outputDir, '.divlet-build.json'), 'utf8'));
  const privateFiles = Object.keys(manifest.files).filter(name => name.endsWith('.meta.json'));
  assert.ok(privateFiles.length > 0, 'the refusal witnesses are actual generated files, not guessed missing names');
  for (const name of privateFiles) assert.ok((await fs.readFile(path.join(runtime.outputDir, name))).length > 0);
  const metadataPath = path.join(runtime.outputDir, privateFiles[0]);
  const metadata = await fs.readFile(metadataPath);
  await fs.unlink(metadataPath);
  await runtime.scanOutputs();
  assert.deepEqual(await fs.readFile(metadataPath), metadata, 'the full private publication plan still repairs missing sidecars');
  for (const name of [...privateFiles, '.divlet-build.json', '.trash/old.html', 'unknown.html']) assert.equal((await fetch(url + 'build/' + name)).status, 404, `${name} is not a public artifact`);
  assert.deepEqual(await fs.readFile(runtime.projectPath), source, 'view URLs and browsing do not become authored content');
});

test('selection and observations validate IDs, origin and document versions', async t => {
  const { runtime, url, id } = await fixture(t);
  const post = (route, payload, extra = {}) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(payload) });
  assert.equal((await post('api/selection', { ids: [id] })).status, 200);
  assert.deepEqual(runtime.read({ view: 'selection' }).selection.ids, [id]);
  assert.equal((await post('api/selection', { ids: [1] })).status, 400, 'malformed selections are refused');
  assert.equal((await post('api/selection', { ids: ['missing'] })).status, 200, 'a frame that is gone is dropped from the selection, not an error');
  assert.deepEqual(runtime.read({ view: 'selection' }).selection.ids, []);
  await post('api/selection', { ids: [id] });
  assert.equal((await post('api/selection', { ids: [id] }, { origin: 'https://example.com' })).status, 403);
  const nodeId = runtime.read({ view: 'document', documentId: id }).rootId;
  const data = { documentId: id, version: 1, nodes: [{ id: nodeId, rect: { x: 0, y: 0, width: 500, height: 300 } }] };
  assert.equal((await post('api/observations', data)).status, 200);
  assert.equal(runtime.read({ view: 'preview', documentId: id }).observation.version, 1);
  assert.equal((await post('api/observations', { ...data, version: 0 })).status, 409);
  assert.equal((await post('api/observations', { ...data, nodes: [{ id: 'missing', rect: {} }] })).status, 400);
});

test('HTTP advertises guarded whole-project history navigation and preserves grouped forward return', async t => {
  const { runtime, url, id } = await fixture(t);
  const post = body => fetch(url + 'api/history/navigate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const initial = runtime.read({ view: 'document', documentId: id });
  const base = runtime.readTimeline().current;
  const patch = async (patch, group) => runtime.patch({ documentId: id, expectedVersion: runtime.getEntry(id).document.version, patch, group });
  await patch({ artboard: { x: 100 } }, 'http-drag');
  await patch({ artboard: { x: 160, y: 240 } }, 'http-drag');
  await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { name: 'Timeline target' } });
  const second = await runtime.createArtboard({ name: 'Second' });
  const targetOrder = [...runtime.documents.keys()], head = runtime.readTimeline().current;
  const info = await (await fetch(url + 'api/project')).json();
  assert.equal(info.history.navigation, true, 'support is advertised by the existing owner, not guessed by the browser');
  const history = await (await fetch(url + 'api/history?limit=1&actor=file')).json();
  assert.deepEqual(history.timeline, runtime.readTimeline(), 'audit filters do not remove whole-project point addresses');
  assert.equal(history.timeline.points.length, 5, 'the fixture create, one grouped drag, settings and frame creation are four edges');
  let writes = 0;
  const persist = runtime.persist;
  runtime.persist = async function (...args) { writes++; return persist.apply(this, args); };
  const revision = runtime.revision, seq = runtime.seq;
  const backward = await post({ pointId: base, expectedPoint: head, actor: 'system', documentId: 'missing', steps: 200 });
  assert.equal(backward.status, 200);
  assert.equal((await backward.json()).pointId, base);
  assert.equal(writes, 1, 'the entire traversal persists once, not an HTTP Undo loop');
  assert.equal(runtime.revision, revision + 1);
  assert.deepEqual([...runtime.documents.keys()], [id]);
  assert.deepEqual(runtime.getEntry(id).document.artboard, initial.artboard);
  assert.notEqual(runtime.settings.name, 'Timeline target');
  assert.ok(runtime.readHistory({ since: seq }).changes.every(change => change.actor === 'user'), 'HTTP cannot impersonate another actor');
  const noOp = await post({ pointId: base, expectedPoint: base });
  assert.equal((await noOp.json()).changed, false);
  assert.equal(writes, 1);
  const forward = await post({ pointId: head, expectedPoint: base });
  assert.equal(forward.status, 200);
  assert.equal(writes, 2);
  assert.deepEqual([...runtime.documents.keys()], targetOrder);
  assert.equal(runtime.settings.name, 'Timeline target');
  assert.equal(runtime.getEntry(id).document.artboard.x, 160);
  assert.ok(runtime.documents.has(second.documentId));
});

test('HTTP history refuses malformed, stale, unavailable and unsafe traversals without an accepted prefix', async t => {
  const { runtime, url, id } = await fixture(t);
  const base = runtime.readTimeline().current;
  await runtime.patch({ documentId: id, expectedVersion: 1, patch: { artboard: { x: 210 } } });
  const head = runtime.readTimeline().current;
  const post = (body, headers = {}) => fetch(url + 'api/history/navigate', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const snapshot = () => ({ revision: runtime.revision, history: runtime.readHistory(), undo: structuredClone(runtime.undoStack), redo: structuredClone(runtime.redoStack), settings: structuredClone(runtime.settings), documents: [...runtime.documents].map(([id, entry]) => [id, structuredClone(entry.document)]), files: new Map(runtime.staticFiles) });
  const before = snapshot(), source = await fs.readFile(runtime.projectPath);
  for (const body of [null, [], {}, { pointId: 1, expectedPoint: head }, { pointId: head }]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'INVALID_QUERY');
  }
  for (const [body, code] of [[{ pointId: base, expectedPoint: base }, 'HISTORY_CONFLICT'], [{ pointId: 'missing', expectedPoint: head }, 'HISTORY_POINT_UNAVAILABLE']]) {
    const response = await post(body);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, code);
  }
  assert.equal((await post({ pointId: base, expectedPoint: head }, { origin: 'null' })).status, 403);
  assert.equal((await fetch(new URL('/api/history/navigate', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  assert.deepEqual(snapshot(), before);
  const html = runtime.getEntry(id).htmlPath, bytes = await fs.readFile(html), protectedFile = path.join(runtime.projectDir, 'protected.txt');
  await fs.writeFile(protectedFile, 'protected bytes');
  await fs.unlink(html);
  await fs.symlink(protectedFile, html);
  try {
    const refused = await post({ pointId: base, expectedPoint: head });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, 'UNSAFE_PATH');
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(await fs.readFile(runtime.projectPath), source);
    assert.equal(await fs.readFile(protectedFile, 'utf8'), 'protected bytes');
  } finally { await fs.unlink(html); await fs.writeFile(html, bytes); }
});

test('queued HTTP history requests recheck the expected point under the owner writer queue', { timeout: 10000 }, async t => {
  const { runtime, url, id } = await fixture(t);
  const base = runtime.readTimeline().current;
  await runtime.patch({ documentId: id, expectedVersion: 1, patch: { artboard: { x: 410 } } });
  const head = runtime.readTimeline().current;
  let release, entered, firstSeen, secondSeen, calls = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const firstAdmission = new Promise(resolve => { firstSeen = resolve; });
  const secondAdmission = new Promise(resolve => { secondSeen = resolve; });
  const gate = runtime.enqueue(() => new Promise(resolve => { release = resolve; entered(); }));
  await ready;
  const navigate = runtime.navigateHistory;
  runtime.navigateHistory = function (query) {
    const result = navigate.call(this, query);
    if (++calls === 1) firstSeen(); else secondSeen();
    return result;
  };
  const post = pointId => fetch(url + 'api/history/navigate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pointId, expectedPoint: head }) });
  try {
    const first = post(base);
    await firstAdmission;
    const second = post(head);
    await secondAdmission;
    release();
    assert.equal((await first).status, 200);
    const refused = await second;
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error, 'HISTORY_CONFLICT');
    assert.equal(runtime.historyHead().pointId, base);
  } finally { release(); await gate; runtime.navigateHistory = navigate; }
});

test('HTTP and SSE expose a point-only history move even when the audit sequence is unchanged', { timeout: 10000 }, async t => {
  const { runtime, url, id } = await fixture(t);
  const x = runtime.getEntry(id).document.artboard.x, base = runtime.readTimeline().current;
  await runtime.patch({ documentId: id, expectedVersion: 1, patch: { artboard: { x: x + 30 } }, group: 'net-equal' });
  await runtime.patch({ documentId: id, expectedVersion: 2, patch: { artboard: { x } }, group: 'net-equal' });
  const head = runtime.readTimeline().current, seq = runtime.seq, revision = runtime.revision;
  const abort = new AbortController();
  t.after(() => abort.abort());
  const events = await fetch(url + 'events', { signal: abort.signal }), reader = events.body.getReader();
  await reader.read();
  const response = await fetch(url + 'api/history/navigate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pointId: base, expectedPoint: head }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pointId, base);
  const decoder = new TextDecoder();
  let buffer = '', state;
  while (state?.history.pointId !== base) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, 'the owner publishes the new point even without an audit change');
    buffer += decoder.decode(chunk.value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const data = packet.split('\n').find(line => line.startsWith('data: '));
      if (packet.startsWith('event: state') && data) state = JSON.parse(data.slice(6));
    }
  }
  assert.equal(state.history.pointId, base);
  assert.equal(state.history.seq, seq);
  assert.equal(state.history.navigation, true);
  assert.equal(runtime.revision, revision + 1, 'runtime revisions remain monotonic even for a net-equal replay');
  assert.equal((await (await fetch(url + 'api/history')).json()).timeline.current, base);
  abort.abort();
});

test('asset route blocks traversal and symlink escapes', async t => {
  const { runtime, url } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'outside.txt'), 'outside secret');
  await fs.writeFile(path.join(runtime.projectDir, 'inside.txt'), 'inside asset');
  await fs.symlink(path.join(outside, 'outside.txt'), path.join(runtime.projectDir, 'escape.txt'));
  const asset = await fetch(url + 'files/inside.txt', { headers: { origin: 'null' } });
  assert.equal(asset.headers.get('access-control-allow-origin'), '*');
  assert.equal(await asset.text(), 'inside asset');
  assert.equal((await fetch(url + 'api/project')).headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(url + 'files/escape.txt')).status, 403);
  assert.notEqual((await fetch(url + 'files/%2e%2e%2foutside.txt')).status, 200);
});

test('SSE initial snapshot and direct tool commit updates arrive without file watcher', async t => {
  const { runtime, url, id } = await fixture(t);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(url + 'events', { signal: abort.signal });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: state/);
  await runtime.patch({ documentId: id, expectedVersion: 1, patch: { name: 'Direct update' } });
  const second = new TextDecoder().decode((await reader.read()).value);
  assert.match(second, /Direct update/);
  abort.abort();
});

test('shutdown terminates a client that leaves a POST body incomplete', async t => {
  const { runtime, url } = await fixture(t);
  const request = http.request(url + 'api/selection', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1000' } });
  request.on('error', () => {});
  request.write('{');
  await new Promise(resolve => setTimeout(resolve, 30));
  let deadline;
  try {
    await Promise.race([
      runtime.close(),
      new Promise((_, reject) => { deadline = setTimeout(() => { request.destroy(); reject(new Error('Shutdown waited for an incomplete request body')); }, 1000); }),
    ]);
    assert.equal(runtime.closed, true);
  } finally {
    clearTimeout(deadline);
    request.destroy();
  }
});
