import test from 'node:test';
import { legacyProject } from './fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { openRuntime } from '../lib/runtime.js';
import { createDemoDocument } from '../lib/model.ts';
import { encodeHtml } from '../lib/codec.ts';

const digest = text => createHash('sha256').update(text).digest('hex');

async function fixture(t, options = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-test-'));
  await legacyProject(path.join(cwd, 'project.divlet'), { demo: options.createDemo === true });
  const runtime = await openRuntime({ cwd, watch: false, createDemo: false, ...options });
  t.after(async () => { await runtime.close(); await fs.rm(cwd, { recursive: true, force: true }); });
  return { cwd, runtime, project: path.join(cwd, 'project.divlet') };
}

function document(id = 'example') {
  return {
    schemaVersion: 1, id, name: 'Example', version: 1,
    artboard: { x: 50, y: 60, width: 500, height: 400 }, tokens: { '--accent': '#a78bfa' }, css: '', metadata: { intent: 'Test fixture' }, rootId: 'root',
    nodes: {
      root: { id: 'root', type: 'element', tag: 'main', className: 'flex p-4 text-white bg-violet-950', attrs: {}, style: {}, metadata: {}, children: ['label'] },
      label: { id: 'label', type: 'text', content: 'Original', metadata: { intent: 'Stable text' } },
    },
  };
}

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('patches persist the project file, the generated page and its meta.json with real compiled Tailwind', async t => {
  const { runtime, project } = await fixture(t);
  await runtime.create({ document: document() });
  const entry = runtime.info().documents[0];
  assert.equal(entry.modelPath, project);
  assert.equal(path.basename(entry.htmlPath), 'example.html');
  const html = await fs.readFile(entry.htmlPath, 'utf8');
  assert.match(html, /display:\s*flex/);
  assert.match(html, /data-divlet-id="root"/);
  assert.doesNotMatch(html, /divlet-metadata|divlet:text|data-divlet-compiled/);
  const result = await runtime.patch({ documentId: 'example', expectedVersion: 1, patch: { nodes: { label: { content: 'Updated' } } } });
  assert.equal(result.version, 2);
  assert.equal(result.saved, true);
  assert.deepEqual(result.changedNodeIds, ['label']);
  const page = await fs.readFile(entry.htmlPath, 'utf8');
  assert.match(page, />Updated</);
  const stored = await readJson(project);
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.frames[0].nodes.label.content, 'Updated');
  assert.equal(stored.frames[0].schemaVersion, undefined);
  const meta = await readJson(entry.metaPath);
  assert.equal(meta.frame, 'example');
  assert.equal(meta.version, 2);
  assert.equal(meta.project, path.relative(path.dirname(entry.metaPath), project).split(path.sep).join('/'));
  assert.equal(meta.hashes.html, digest(page));
  assert.equal(runtime.info().documents[0].savedVersion, 2);
});

test('invalid patches and stale versions leave the previous accepted files untouched', async t => {
  const { runtime, project } = await fixture(t);
  await runtime.create({ document: document() });
  const entry = runtime.info().documents[0];
  const before = [await fs.readFile(project, 'utf8'), await fs.readFile(entry.htmlPath, 'utf8')];
  await assert.rejects(runtime.patch({ documentId: 'example', expectedVersion: 1, patch: { nodes: { label: null } } }));
  assert.equal(runtime.read({ view: 'document', documentId: 'example' }).version, 1);
  assert.deepEqual([await fs.readFile(project, 'utf8'), await fs.readFile(entry.htmlPath, 'utf8')], before);
  await runtime.patch({ documentId: 'example', expectedVersion: 1, patch: { name: 'New name' } });
  await assert.rejects(runtime.patch({ documentId: 'example', expectedVersion: 1, patch: { name: 'Outdated' } }), { code: 'REVISION_CONFLICT' });
});

test('external edits of project.divlet are accepted as logged, undoable file changes without echo revisions', async t => {
  const { runtime, project } = await fixture(t);
  await runtime.create({ document: document() });
  const stored = await readJson(project);
  stored.frames[0].nodes.label.content = 'From the file';
  stored.tokens = { '--brand': '#ff0066' };
  await fs.writeFile(project, JSON.stringify(stored, null, 2));
  await runtime.scan();
  const frame = runtime.read({ view: 'document', documentId: 'example' });
  assert.equal(frame.nodes.label.content, 'From the file');
  assert.equal(frame.version, 2);
  assert.equal(runtime.info().project.tokens['--brand'], '#ff0066');
  assert.equal(runtime.info().project.version, 2);
  assert.match(await fs.readFile(runtime.info().documents[0].htmlPath, 'utf8'), /--brand:#ff0066/);
  const changes = runtime.readHistory().changes.slice(-2);
  assert.deepEqual(changes.map(change => [change.actor, change.kind]), [['file', 'external'], ['file', 'external']]);
  const revision = runtime.revision;
  await runtime.scan();
  assert.equal(runtime.revision, revision);
  assert.equal((await readJson(project)).frames[0].version, 2);
  await runtime.undo();
  assert.equal(runtime.read({ view: 'document', documentId: 'example' }).nodes.label.content, 'Original');
  assert.deepEqual(runtime.info().project.tokens, {});
});

test('non-finite project metadata cannot replace accepted source, output or state', async t => {
  const { runtime, project } = await fixture(t);
  await runtime.create({ document: document() });
  const before = await fs.readFile(project, 'utf8');
  const preview = runtime.render('example');
  const accepted = structuredClone(runtime.info().project);
  const entry = runtime.info().documents[0];
  const output = await fs.readFile(entry.htmlPath, 'utf8');
  await assert.rejects(runtime.patchProject({ expectedVersion: accepted.version, patch: { metadata: { value: Infinity } } }), { code: 'INVALID_DOCUMENT' });
  assert.equal(await fs.readFile(project, 'utf8'), before);
  const invalid = JSON.stringify({ ...JSON.parse(before), metadata: { value: '__format_overflow_witness__' } }).replace('"__format_overflow_witness__"', '1e400');
  await fs.writeFile(project, invalid);
  await runtime.scan();
  assert.equal(runtime.info().diagnostics[0].code, 'INVALID_DOCUMENT');
  assert.deepEqual(runtime.info().project.metadata, accepted.metadata);
  assert.equal(runtime.info().project.version, accepted.version);
  assert.deepEqual(runtime.render('example'), preview);
  assert.equal(await fs.readFile(entry.htmlPath, 'utf8'), output);
  await assert.rejects(runtime.patchProject({ expectedVersion: accepted.version, patch: { name: 'Would overwrite' } }), { code: 'EXTERNAL_PENDING' });
  assert.equal(await fs.readFile(project, 'utf8'), invalid);
  await fs.writeFile(project, before);
  await runtime.scan();
  assert.equal(runtime.info().diagnostics.length, 0);
});

test('an invalid project.divlet keeps the last good state, blocks writes and recovers when fixed', async t => {
  const { runtime, project } = await fixture(t);
  await runtime.create({ document: document() });
  await runtime.create({ document: document('other') });
  const good = runtime.render('example');
  const text = await fs.readFile(project, 'utf8');
  await fs.writeFile(project, text.replace('"Original"', '"Broken'));
  await runtime.scan();
  assert.deepEqual(runtime.render('example'), good);
  const diagnostic = runtime.info().diagnostics[0];
  assert.equal(diagnostic.code, 'INVALID_JSON');
  assert.ok(diagnostic.line > 1);
  const broken = await fs.readFile(project, 'utf8');
  await assert.rejects(runtime.patch({ documentId: 'other', expectedVersion: 1, patch: { name: 'Overwrite' } }), { code: 'EXTERNAL_PENDING' });
  assert.equal(await fs.readFile(project, 'utf8'), broken);
  await fs.writeFile(project, text.replace('"Original"', '"Recovered"'));
  await runtime.scan();
  assert.equal(runtime.info().diagnostics.length, 0);
  assert.equal(runtime.read({ view: 'document', documentId: 'example' }).nodes.label.content, 'Recovered');
  // A structurally invalid frame is reported with its frame ID.
  const invalid = await readJson(project);
  invalid.frames[1].nodes.root.children.push('ghost');
  await fs.writeFile(project, JSON.stringify(invalid));
  await runtime.scan();
  assert.match(runtime.info().diagnostics[0].message, /Frame other: Unknown child node: ghost/);
});

test('hand edits of generated pages are flagged, never imported, and kept in .trash when the frame changes', async t => {
  const { cwd, runtime } = await fixture(t);
  await runtime.create({ document: document() });
  const entry = runtime.info().documents[0];
  const generated = await fs.readFile(entry.htmlPath, 'utf8');
  await fs.writeFile(entry.htmlPath, generated.replace('>Original<', '>Hand edit<'));
  await runtime.scan();
  assert.equal(runtime.info().diagnostics[0].code, 'GENERATED_FILE_EDITED');
  assert.equal(runtime.read({ view: 'document', documentId: 'example' }).nodes.label.content, 'Original');
  await runtime.patch({ documentId: 'example', expectedVersion: 1, patch: { name: 'Changed' } });
  assert.equal(runtime.info().diagnostics.length, 0);
  assert.doesNotMatch(await fs.readFile(entry.htmlPath, 'utf8'), /Hand edit/);
  const trash = await fs.readdir(path.join(runtime.outputDir, '.trash'));
  const kept = trash.find(name => name.endsWith('-example.html'));
  assert.ok(kept);
  assert.match(await fs.readFile(path.join(runtime.outputDir, '.trash', kept), 'utf8'), /Hand edit/);
  // Deleted generated files come back.
  await fs.rm(entry.htmlPath);
  await fs.rm(entry.metaPath);
  await runtime.scan();
  assert.match(await fs.readFile(entry.htmlPath, 'utf8'), />Original</);
  assert.equal((await readJson(entry.metaPath)).frame, 'example');
});

test('independent frame versions permit concurrent authors without global conflicts', async t => {
  const { runtime } = await fixture(t);
  await runtime.create({ document: document('one') });
  await runtime.create({ document: document('two') });
  await Promise.all([
    runtime.patch({ documentId: 'one', expectedVersion: 1, patch: { name: 'First' } }),
    runtime.patch({ documentId: 'two', expectedVersion: 1, patch: { name: 'Second' } }),
  ]);
  assert.deepEqual(runtime.info().documents.map(doc => [doc.id, doc.version]), [['one', 2], ['two', 2]]);
});

test('HTML files dropped into the source directory become frames, JSON stays untouched, and unsafe build directives cannot execute', async t => {
  const { cwd, runtime, project } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'imported.html'), '<!doctype html><html><head><title>Import</title></head><body><main class="p-4"><h1>Hello</h1></main></body></html>');
  await runtime.scan();
  assert.equal(runtime.info().documents[0].id, 'imported');
  assert.equal((await readJson(project)).frames[0].id, 'imported');
  assert.match(await fs.readFile(runtime.getEntry('imported').htmlPath, 'utf8'), /data-divlet-id=/);
  assert.ok((await fs.readdir(path.join(runtime.outputDir, '.trash'))).some(name => name.endsWith('-imported-imported.html')));
  assert.equal(runtime.readHistory().changes.at(-1).actor, 'file');
  const json = JSON.stringify(document('data'));
  await fs.writeFile(path.join(cwd, 'data.json'), json);
  await runtime.scan();
  assert.deepEqual(runtime.info().documents.map(doc => doc.id), ['imported']);
  assert.equal(await fs.readFile(path.join(cwd, 'data.json'), 'utf8'), json);
  const version = runtime.info().documents[0].version;
  await assert.rejects(runtime.patch({ documentId: 'imported', expectedVersion: version, patch: { css: '@plugin "some-plugin";' } }));
});

test('explicit legacy demo remains valid and idempotent open preserves existing content', async t => {
  const { cwd, runtime } = await fixture(t, { createDemo: true });
  assert.equal(runtime.info().documents.length, 1);
  assert.ok(createDemoDocument().nodes);
  const id = runtime.info().documents[0].id;
  await runtime.close();
  const reopened = await openRuntime({ cwd, watch: false });
  t.after(() => reopened.close());
  assert.equal(reopened.info().documents.length, 1);
  assert.equal(reopened.info().documents[0].id, id);
  assert.equal(reopened.readHistory().changes.length, 0);
});

test('HTML pages in a folder without project.divlet are imported on open', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-import-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const first = { ...document('first'), artboard: { x: 0, y: 0, width: 400, height: 300 } };
  await fs.writeFile(path.join(cwd, 'first.html'), encodeHtml(first));
  await fs.writeFile(path.join(cwd, 'second.html'), encodeHtml(document('second')));
  const runtime = await openRuntime({ cwd, watch: false });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.info().documents.map(doc => doc.id), ['first', 'second']);
  const stored = await readJson(path.join(cwd, 'project.divlet'));
  assert.deepEqual(stored.frames.map(frame => frame.id), ['first', 'second']);
  assert.equal((await fs.readdir(path.join(runtime.outputDir, '.trash'))).filter(name => name.includes('-imported-')).length, 2);
  assert.match(await fs.readFile(runtime.getEntry('first').htmlPath, 'utf8'), /data-divlet-id="root"/);
  assert.match(runtime.readHistory().changes.at(-1).summary, /imported 2 frames into project\.divlet/);
});

test('a symbolic link in place of project.divlet is refused and the accepted state is kept', async t => {
  const { cwd, runtime, project } = await fixture(t);
  await runtime.create({ document: document() });
  await fs.writeFile(path.join(cwd, 'outside.divlet'), await fs.readFile(project, 'utf8'));
  await fs.rm(project);
  await fs.symlink(path.join(cwd, 'outside.divlet'), project);
  await runtime.scan();
  assert.equal(runtime.info().documents[0].version, 1);
  assert.equal(runtime.info().diagnostics[0].code, 'UNSAFE_PATH');
});

test('unsupported browser-repaired models cannot replace the accepted render', async t => {
  const { runtime } = await fixture(t);
  await runtime.create({ document: document() });
  const previous = runtime.render('example');
  await assert.rejects(runtime.patch({ documentId: 'example', expectedVersion: 1, patch: { nodes: {
    root: { tag: 'p', children: ['wrapper'] },
    wrapper: { id: 'wrapper', type: 'element', tag: 'span', children: ['nested'] },
    nested: { id: 'nested', type: 'element', tag: 'div', children: ['label'] },
  } } }));
  assert.deepEqual(runtime.render('example'), previous);
});

test('outdated generated pages are regenerated in place, not sent to .trash', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-stale-'));
  try {
    let runtime = await openRuntime({ file: path.join(dir, 'project.divlet'), watch: false });
    const htmlPath = runtime.info().documents[0].htmlPath;
    const outputDir = runtime.outputDir;
    await runtime.close();
    // An older divlet wrote a different page, and its meta.json recorded exactly that page.
    const metaPath = htmlPath.replace(/\.html$/, '.meta.json');
    const older = '<!doctype html><title>older output</title>\n';
    await fs.writeFile(htmlPath, older);
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    meta.hashes.html = createHash('sha256').update(older).digest('hex');
    await fs.writeFile(metaPath, JSON.stringify(meta));
    runtime = await openRuntime({ file: path.join(dir, 'project.divlet'), watch: false });
    assert.notEqual(await fs.readFile(htmlPath, 'utf8'), older, 'the page was regenerated');
    assert.deepEqual(await fs.readdir(path.join(outputDir, '.trash')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), [], 'nothing was kept aside');
    assert.deepEqual(runtime.info().diagnostics.filter(d => d.code !== 'PEN_READ_ONLY'), []);
    await runtime.close();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a page another divlet wrote is brought up to date quietly; a hand edit is still reported', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-other-'));
  try {
    const runtime = await openRuntime({ file: path.join(dir, 'project.divlet'), watch: false });
    const { htmlPath, metaPath } = runtime.info().documents[0];
    // Another instance (older code) rewrites the page and records it in the meta, as divlet always does.
    const other = '<!doctype html><title>written by another divlet</title>\n';
    await fs.writeFile(htmlPath, other);
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    meta.hashes.html = createHash('sha256').update(other).digest('hex');
    await fs.writeFile(metaPath, JSON.stringify(meta));
    await runtime.scan();
    assert.deepEqual(runtime.info().diagnostics.filter(d => d.code !== 'PEN_READ_ONLY'), [], 'no alarm for a page divlet itself wrote');
    assert.notEqual(await fs.readFile(htmlPath, 'utf8'), other, 'it was regenerated');
    // A person edits the page: the meta still holds the old hash, so it is flagged and never imported.
    await fs.writeFile(htmlPath, `${await fs.readFile(htmlPath, 'utf8')}<!-- by hand -->`);
    await runtime.scan();
    assert.equal(runtime.info().diagnostics.some(item => item.code === 'GENERATED_FILE_EDITED'), true);
    await runtime.close();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a styles patch replaces a project-colour class instead of leaving two backgrounds', async t => {
  const { runtime } = await fixture(t);
  await runtime.create({ document: document(), undoable: false });
  await runtime.patchProject({ expectedVersion: runtime.info().project.version, patch: { tokens: { '--color-brand': '#123524' } } });
  const version = runtime.read({ view: 'frame', documentId: 'example' }).version;
  await runtime.patch({ documentId: 'example', expectedVersion: version, patch: { nodes: { root: { styles: { 'background-color': '#112233', color: '#ffffff' } } } } });
  const className = runtime.read({ view: 'frame', documentId: 'example' }).nodes.root.className;
  assert.ok(!className.includes('bg-violet-950'), `the palette class goes, got: ${className}`);
  assert.match(className, /bg-\[#112233\]/);
  assert.match(className, /text-\[color:#ffffff\]/);
  // A frame's own colour token counts too.
  await runtime.patch({ documentId: 'example', expectedVersion: version + 1, patch: { tokens: { '--color-paper': '#f4efe6' }, nodes: { root: { className: 'text-paper p-2' } } } });
  await runtime.patch({ documentId: 'example', expectedVersion: version + 2, patch: { nodes: { root: { styles: { color: '#000000' } } } } });
  assert.equal(runtime.read({ view: 'frame', documentId: 'example' }).nodes.root.className.trim(), 'p-2 text-[color:#000000]');
});
