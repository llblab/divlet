import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDocument, applyDocumentPatch } from '../lib/model.ts';
import { encodeHtml, decodeHtml, exportHtml, renderFile } from '../lib/codec.ts';
import { decodePage } from '../lib/html-import.ts';
import { diffDocuments } from '../lib/diff.ts';
import { writeProject, validateSettings, readProject, expandFrame } from '../lib/project.ts';
import { openRuntime } from '../lib/runtime.js';

const base = () => decodeHtml('<main>Hello</main>', { fallbackId: 'home' });
const description = 'A "quoted" & <safe> description';

test('head is strictly opt-in, bounded and URL validated', () => {
  assert.equal(Object.hasOwn(base(), 'head'), false);
  for (const head of [null, [], { title: 'no' }, { description: 2 }, { description: 'a'.repeat(2049) }, { icon: 'javascript:alert(1)' }, { icon: 'data:image/svg+xml,x' }]) {
    assert.throws(() => validateDocument({ ...base(), head }));
  }
  assert.deepEqual(validateDocument({ ...base(), head: {} }).head, {});
});

test('preview, file and clean HTML preserve supported physical head with safe escaping', () => {
  const frame = validateDocument({ ...base(), head: { description, icon: 'art/icon.svg?x=1&y="yes"' } });
  for (const emit of [encodeHtml, renderFile, exportHtml]) {
    const html = emit(frame);
    assert.match(html, /&quot;quoted&quot; &amp; &lt;safe&gt;/);
    assert.deepEqual(decodeHtml(html).head, frame.head);
  }
  const settings = validateSettings({});
  const stored = readProject(JSON.parse(writeProject(settings, [frame]))).frames[0];
  assert.deepEqual(stored.head, frame.head);
  assert.deepEqual(expandFrame(stored, null, settings).document.head, frame.head);
  assert.deepEqual(decodeHtml(encodeHtml({ ...base(), head: {} })).head, {});
  assert.equal(Object.hasOwn(decodeHtml(encodeHtml(base())), 'head'), false);
  assert.throws(() => decodeHtml(encodeHtml(frame).replace('content="A ', 'content="Other ')), /Conflicting/);
  assert.throws(() => decodeHtml('<meta name="description" content="a"><meta name="description" content="b"><main>x</main>'), /Duplicate description/);
  assert.throws(() => decodeHtml('<link rel="icon" href="a"><link rel="icon" href="b"><main>x</main>'), /Duplicate icon/);
  for (const extra of ['sizes="any"', 'type="image/png"', 'media="print"']) assert.throws(() => decodeHtml(`<link rel="icon" href="a" ${extra}><main>x</main>`), /Unsupported head content/, 'strict source decoding must not silently drop unmodelled icon attributes');
});

test('native admission retains only explicit supported metadata and rejects ambiguity', () => {
  const { document, dropped } = decodePage('<title>Name</title><meta name="description" content="About &amp; more"><link rel="icon" type="image/svg+xml" href="icon.svg"><meta name="author" content="Ignored"><main>x</main>');
  assert.equal(document.name, 'Name');
  assert.deepEqual(document.head, { description: 'About & more', icon: 'icon.svg' });
  assert.equal(dropped.links, 0);
  assert.throws(() => decodePage('<link rel="icon" href="javascript:x"><main>x</main>'));
  assert.throws(() => decodePage('<meta name="description" content="a"><meta name="description" content="b"><main>x</main>'));
});

test('head patches merge, null-remove and diff in both history directions', () => {
  const before = base();
  const after = applyDocumentPatch(before, { head: { description, icon: 'icon.svg' } });
  const changed = applyDocumentPatch(after, { head: { description: null } });
  assert.deepEqual(changed.head, { icon: 'icon.svg' });
  const removed = applyDocumentPatch(changed, { head: null });
  assert.equal(Object.hasOwn(removed, 'head'), false);
  assert.deepEqual(applyDocumentPatch(before, diffDocuments(before, after)), after);
  assert.deepEqual(applyDocumentPatch(after, diffDocuments(after, before)), before);
});

test('static icon resources and canonical copy preserve a source-relative icon closure', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-head-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  await fs.mkdir(path.join(source, 'art'), { recursive: true });
  const icon = path.join(source, 'art/icon.svg');
  await fs.writeFile(icon, '<svg xmlns="http://www.w3.org/2000/svg"><image href="pixel.png"/></svg>');
  await fs.writeFile(path.join(source, 'art/pixel.png'), 'pixels');
  const document = validateDocument({ ...base(), head: { description, icon: 'art/icon.svg' } });
  const file = path.join(source, 'project.divlet');
  await fs.writeFile(file, writeProject(validateSettings({}), [document]));
  const runtime = await openRuntime({ file, watch: false, createDemo: false });
  t.after(() => runtime.close());
  const html = await fs.readFile(path.join(runtime.outputDir, 'home.html'), 'utf8');
  assert.match(html, /rel="icon" href="_assets\//);
  assert.ok(runtime.staticSources.has(icon));
  await runtime.patch({ documentId: 'home', expectedVersion: 1, patch: { head: null } });
  assert.equal(Object.hasOwn(runtime.documents.get('home').document, 'head'), false);
  await runtime.undo({ documentId: 'home' });
  assert.deepEqual(runtime.documents.get('home').document.head, document.head);
  await runtime.redo({ documentId: 'home' });
  assert.equal(Object.hasOwn(runtime.documents.get('home').document, 'head'), false);
  await runtime.undo({ documentId: 'home' });
  let copy;
  runtime.host = { open: async target => {
    copy = await openRuntime({ dir: target, watch: false, createDemo: false });
    t.after(() => copy.close());
    return { url: copy.url };
  } };
  const target = path.join(dir, 'copy');
  await runtime.saveAs({ path: target });
  const saved = readProject(JSON.parse(await fs.readFile(path.join(target, 'project.divlet'), 'utf8')));
  assert.equal(saved.frames[0].head.icon, 'art/icon.svg');
  assert.equal(saved.frames[0].head.description, description);
  const savedIcon = await fs.readFile(path.join(target, saved.frames[0].head.icon), 'utf8');
  assert.match(savedIcon, /href="[^"/]*pixel.png"/);
  assert.equal(copy.info().diagnostics.length, 0);
});
