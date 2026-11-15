import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument } from '../lib/model.ts';
import { frameDocument, storedFrame, readProject, writeProject, validateSettings } from '../lib/project.ts';
import { encodeHtml, decodeHtml, renderFile, exportHtml } from '../lib/codec.ts';

const opaque = Object.freeze({ schemaVersion: 3, version: '2.21', requires: Object.freeze({ styleEngine: Object.freeze({ id: 'application-data', version: 'opaque' }) }) });
const frame = () => validateDocument({
  schemaVersion: 1, id: 'frame', name: 'Frame', version: 1,
  artboard: { x: 0, y: 0, width: 320, height: 200 }, rootId: 'root', metadata: opaque,
  nodes: { root: { id: 'root', type: 'element', tag: 'main', className: 'p-4', metadata: opaque, children: ['text'] }, text: { id: 'text', type: 'text', content: 'Frame', metadata: opaque } },
});
const project = frames => ({ schemaVersion: 1, metadata: opaque, frames });

// Modify the frame manifest only, not identically named opaque metadata members or HTML text.
function manifestPatch(html, patch) {
  const marker = '<script id="divlet-metadata" type="application/json">';
  const start = html.indexOf(marker) + marker.length, end = html.indexOf('</script>', start);
  assert.ok(start >= marker.length && end > start);
  return html.slice(0, start) + JSON.stringify({ ...JSON.parse(html.slice(start, end)), ...patch }) + html.slice(end);
}

test('project and standalone frame envelopes are distinct despite sharing schema 1', () => {
  const document = frame(), envelope = project([storedFrame(document)]), before = structuredClone(envelope);
  assert.deepEqual(readProject(envelope).frames[0], document);
  assert.throws(() => readProject(document), { code: 'INVALID_PROJECT' }, 'a bare frame is not an independently openable project');
  assert.throws(() => validateDocument(envelope), { code: 'INVALID_DOCUMENT' }, 'a project is not a standalone frame');
  assert.throws(() => readProject({ ...document, frames: [] }), { code: 'INVALID_PROJECT' }, 'adding frames does not bless a mixed envelope');
  assert.deepEqual(envelope, before);
});

test('stored frames may omit the initial marker; writing never creates a new schema or changes opaque versions', () => {
  const document = frame();
  for (const stored of [storedFrame(document), document]) {
    assert.deepEqual(frameDocument(stored), document);
    const admitted = readProject(project([stored]));
    const output = JSON.parse(writeProject(admitted.settings, admitted.frames));
    assert.equal(output.schemaVersion, 1);
    assert.equal(Object.hasOwn(output.frames[0], 'schemaVersion'), false);
    assert.deepEqual(output.metadata, opaque);
    assert.deepEqual(output.frames[0].metadata, opaque);
    for (const node of Object.values(output.frames[0].nodes)) assert.deepEqual(node.metadata, opaque);
    assert.deepEqual(readProject(output), admitted);
  }
});

test('unsupported or missing standalone/project markers refuse rather than being reinterpreted', () => {
  for (const marker of [undefined, null, 0, 2, 3, '1']) {
    const document = { ...frame(), schemaVersion: marker }, envelope = { ...project([]), schemaVersion: marker };
    assert.throws(() => validateDocument(document), { code: 'INVALID_DOCUMENT' });
    assert.throws(() => readProject(envelope), { code: 'INVALID_PROJECT' });
    assert.throws(() => readProject(project([document])), { code: 'INVALID_DOCUMENT' });
  }
  const missing = frame(); delete missing.schemaVersion;
  assert.throws(() => validateDocument(missing), { code: 'INVALID_DOCUMENT' });
  assert.equal(frameDocument(missing).schemaVersion, 1, 'only the stored-frame adapter supplies the omitted marker');
});

test('unactivated project requirements cannot enter through standalone frames or HTML manifests', () => {
  for (const requires of [{}, { styleEngine: { id: 'uninstalled', version: 'EXACT' } }]) {
    assert.throws(() => readProject({ ...project([]), requires }), { code: 'INVALID_PROJECT' });
    assert.throws(() => validateDocument({ ...frame(), requires }), { code: 'INVALID_DOCUMENT' });
    assert.throws(() => readProject(project([{ ...storedFrame(frame()), requires }])), { code: 'INVALID_DOCUMENT' });
    assert.throws(() => decodeHtml(manifestPatch(encodeHtml(frame()), { requires })), { code: 'INVALID_HTML' });
  }
});

test('HTML manifests retain the standalone frame marker and opaque metadata, not a project envelope', () => {
  const document = frame(), html = encodeHtml(document);
  assert.deepEqual(decodeHtml(html), document);
  for (const schemaVersion of [undefined, null]) assert.deepEqual(decodeHtml(manifestPatch(html, { schemaVersion })), document, 'current HTML reconstruction supplies the omitted/null marker; it is not standalone JSON admission');
  for (const patch of [{ schemaVersion: 2 }, { schemaVersion: 3 }]) assert.throws(() => decodeHtml(manifestPatch(html, patch)), { code: 'INVALID_DOCUMENT' });
  for (const patch of [{ frames: [] }, { assets: {} }, { outputDir: 'output' }]) assert.throws(() => decodeHtml(manifestPatch(html, patch)), { code: 'INVALID_HTML' });
  assert.deepEqual(document.metadata, opaque, 'manifest refusal never rewrites opaque schema/version/requirement data');
});

test('compiled HTML is derived rendering input, not dependency admission or authored frame CSS', () => {
  const document = frame(), compiledCss = '.p-4{padding:16px}';
  const html = encodeHtml(document, { compiledCss });
  assert.ok(html.includes(compiledCss));
  assert.deepEqual(decodeHtml(html), document, 'strict decoding does not promote generated CSS to authored content');
  assert.equal(document.nodes.root.className, 'p-4', 'class names remain literal structural data');
  assert.equal(Object.hasOwn(document, 'requires'), false);
  const clean = exportHtml(document, { compiledCss }), file = renderFile(document, { compiledCss });
  assert.ok(clean.includes(compiledCss)); assert.ok(file.includes(compiledCss));
  assert.equal(clean.includes('id="divlet-metadata"'), false, 'clean static export is not a canonical JSON container');
  const text = writeProject(validateSettings({ metadata: opaque }), [document]);
  assert.equal(JSON.parse(text).css, '', 'generated rendering CSS never entered project settings');
  assert.deepEqual(readProject(JSON.parse(text)).frames[0], document);
});
