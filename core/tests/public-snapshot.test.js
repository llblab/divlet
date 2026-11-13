import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicPageSnapshot } from '../lib/public-snapshot.ts';
import { validateDocument } from '../lib/model.ts';
import { encodeHtml, renderFile } from '../lib/codec.ts';
import { createSnapshotReadSession } from '@divlet/web/session';

const geometry = { x: 80, y: 100, width: 1280, height: 900 };
function source() {
  return validateDocument({ schemaVersion: 1, id: 'source-frame', name: 'Public page', version: 19, artboard: { x: -40, y: 20, width: 700, height: 500 }, rootId: 'root', metadata: { path: '/home/private/project.divlet', token: 'private-session-token' }, nodes: {
    root: { id: 'root', type: 'element', tag: 'main', children: ['label'], metadata: { note: 'private-editor-note' }, attrs: { id: 'public-heading' } },
    label: { id: 'label', type: 'text', content: 'Intentionally public content', metadata: { source: '/private/source.txt' } },
  } });
}
const input = html => ({ html, name: 'Public demo', href: 'index.html', artboard: geometry });

test('public snapshot reconstructs an allowlisted presentation without runtime/source metadata', async () => {
  const html = renderFile(source(), { compiledCss: '.public { color:red }' });
  const before = html, snapshot = createPublicPageSnapshot(input(html));
  assert.equal(html, before, 'the prepared page remains untouched and is the rendering authority');
  assert.deepEqual(Object.keys(snapshot.state).sort(), ['clientPlugins', 'diagnostics', 'documents', 'project', 'projectId', 'revision', 'selection', 'stateVersion', 'work']);
  assert.deepEqual(Object.keys(snapshot.state.project).sort(), ['capabilities', 'format', 'name', 'version']);
  assert.deepEqual(snapshot.state.project.capabilities, { properties: false, settings: false, frames: false, saveAs: false });
  assert.deepEqual(Object.keys(snapshot.state.documents[0]).sort(), ['artboard', 'id', 'name', 'render', 'version', 'viewUrl']);
  assert.match(snapshot.state.projectId, /^public-[a-f0-9]{16}$/);
  const frame = snapshot.frames.get('index');
  assert.deepEqual(validateDocument(frame), frame);
  assert.equal(frame.id, 'index'); assert.equal(frame.version, 1, 'presentation version is not the hidden source-file version');
  assert.deepEqual(frame.artboard, geometry, 'presentation geometry is explicit, never inferred as authored geometry');
  assert.equal(snapshot.state.documents[0].version, frame.version);
  assert.deepEqual(frame.metadata, {});
  for (const node of Object.values(frame.nodes)) assert.deepEqual(node.metadata, {});
  assert.ok(frame.css.includes('.public'), 'inspection CSS derives from prepared visible bytes, including compiled styles');
  assert.ok(Object.values(frame.nodes).some(node => node.type === 'text' && node.content.includes('Intentionally public content')), 'visible content remains the curator’s responsibility, not a secret-scanning claim');
  const serialized = JSON.stringify({ state: snapshot.state, frames: [...snapshot.frames.values()] });
  for (const secret of ['/home/private', '/private/source', 'private-session-token', 'private-editor-note', 'source-frame']) assert.equal(serialized.includes(secret), false, secret);
  const reader = createSnapshotReadSession(snapshot);
  assert.equal((await reader.readState()).projectId, snapshot.state.projectId);
  assert.equal((await reader.readFrame('index')).rootId, frame.rootId);
});

test('prepared page identity follows public bytes and href, not viewport or filesystem location', () => {
  const html = renderFile(source());
  const first = createPublicPageSnapshot(input(html));
  const resized = createPublicPageSnapshot({ ...input(html), artboard: { ...geometry, width: 390 } });
  assert.equal(first.state.projectId, resized.state.projectId);
  assert.notEqual(first.state.projectId, createPublicPageSnapshot({ ...input(html), href: 'other.html' }).state.projectId);
  assert.notEqual(first.state.projectId, createPublicPageSnapshot(input(html.replace('Public page', 'Other public page'))).state.projectId);
});

test('editor metadata scripts are refused rather than copied as public snapshot authority', () => {
  assert.throws(() => createPublicPageSnapshot(input(encodeHtml(source()))), { code: 'INVALID_PUBLIC_SNAPSHOT' });
});

test('script-looking public text/CSS is not confused with script elements', () => {
  const frame = source(); frame.nodes.label.content = '<script>shown as text</script>'; frame.css = 'main::before{content:"<script>"}';
  const snapshot = createPublicPageSnapshot(input(renderFile(frame)));
  assert.ok(Object.values(snapshot.frames.get('index').nodes).some(node => node.type === 'text' && node.content.includes('<script>shown as text</script>')));
});

test('runtime envelopes, invalid geometry and non-HTML values do not acquire snapshot authority', () => {
  const html = renderFile(source());
  assert.throws(() => createPublicPageSnapshot({ ...input(html), cwd: '/private', agent: { connected: true } }), /Unsupported public snapshot field/);
  assert.throws(() => createPublicPageSnapshot({ projectId: 'native', documents: [], project: { file: '/private/project.divlet' } }));
  assert.throws(() => createPublicPageSnapshot({ ...input(html), html: {} }), { code: 'INVALID_PUBLIC_SNAPSHOT' });
  assert.throws(() => createPublicPageSnapshot({ ...input(html), artboard: { ...geometry, width: Infinity } }));
});

test('the browsing descriptor accepts only a public sibling HTML filename', () => {
  const html = renderFile(source());
  for (const href of ['../index.html', '/home/private/index.html', 'https://example.test/index.html', '//127.0.0.1/token/index.html', 'index.html?token=private', 'index.html#fragment', 'index.meta.json', '.divlet/index.html', 'folder/index.html', 'a\\index.html']) {
    assert.throws(() => createPublicPageSnapshot({ ...input(html), href }), { code: 'INVALID_PUBLIC_SNAPSHOT' }, href);
  }
});

