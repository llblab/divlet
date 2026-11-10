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
