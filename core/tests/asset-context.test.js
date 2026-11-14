import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as model from '../lib/model.ts';
import { encodeHtml, decodeHtml } from '../lib/codec.ts';
import { expandFrame, validateSettings, readProject } from '../lib/project.ts';
import { prepareFrame } from '../lib/render.ts';
import { buildStatic } from '../lib/static.js';
import { convertHtml, decodePage } from '../lib/html-import.ts';
import { resolveOpenFile } from '../lib/import.ts';
import { initProject } from '../lib/projects.ts';
import { openRuntime } from '@divlet/core/runtime';
import { frameCases, resourceFrame } from './fixtures/frame-portability.js';

for (const { name, run } of frameCases.filter(row => row.name.startsWith('declared resource attribute') || row.name.startsWith('declared head icon'))) test(`native asset carrier codec: ${name}`, () => {
  const document = run(model);
  assert.deepEqual(decodeHtml(encodeHtml(document)), document);
});

function components(tag = 'use', href = 'https://example.invalid/icon.svg') {
  const definition = model.validateDocument({ ...resourceFrame(tag, { href }, tag === 'use'), id: 'symbols' });
  definition.nodes.label.reusable = true;
  const input = resourceFrame('use', {}, tag === 'use');
  input.nodes.label = { id: 'label', type: 'ref', ref: 'symbols/label', descendants: { label: { attrs: { href: 'asset:icons/logo.svg#mark' } } } };
  return { definition, input };
}

test('component href syntax is deferred, but the expanded target owns resource versus navigation context', () => {
  const { definition, input } = components();
  const document = model.validateDocument(input);
  assert.equal(expandFrame(document, () => definition, validateSettings()).document.nodes.label.attrs.href, 'asset:icons/logo.svg#mark');
  const anchor = components('a');
  assert.doesNotThrow(() => model.validateDocument(anchor.input), 'the target is not available to the standalone ref validator');
  assert.throws(() => expandFrame(model.validateDocument(anchor.input), () => anchor.definition, validateSettings()), { code: 'INVALID_DOCUMENT' });
  assert.throws(() => readProject({ schemaVersion: 1, frames: [anchor.definition, anchor.input].map(({ schemaVersion, ...frame }) => frame) }), { code: 'INVALID_DOCUMENT' });
  input.nodes.label.descendants.label.attrs = { action: 'asset:icons/logo.svg' };
  assert.throws(() => model.validateDocument(input), { code: 'INVALID_DOCUMENT' }, 'deferred href authority does not include form destinations');
});

test('component tag changes cannot retain resource hrefs on unproven consumers; explicit deletion/replacement stays possible', () => {
  const { definition, input } = components('use', 'asset:icons/logo.svg#mark');
  input.nodes.label.descendants.label = { tag: 'g' };
  assert.throws(() => expandFrame(model.validateDocument(input), () => definition, validateSettings()), { code: 'INVALID_DOCUMENT' });
  input.nodes.label.descendants.label.attrs = { href: null };
  assert.deepEqual(expandFrame(model.validateDocument(input), () => definition, validateSettings()).document.nodes.label.attrs, {});
  input.nodes.label.descendants.label.attrs.href = 'https://example.invalid/';
  assert.equal(expandFrame(model.validateDocument(input), () => definition, validateSettings()).document.nodes.label.attrs.href, 'https://example.invalid/');
});

test('canonical syntax is checked before a component target exists, without echoing payloads', () => {
  const { input } = components();
  input.nodes.label.descendants.label.attrs.href = 'asset:icons/%2e%2e/PRIVATE_PAYLOAD';
  assert.throws(() => model.validateDocument(input), error => error.code === 'INVALID_ASSET' && !error.message.includes('PRIVATE_PAYLOAD'));
});

test('native frame rendering composes with the declared project resource graph', async () => {
  const input = resourceFrame('img', { src: 'asset:icons/logo.svg#mark' });
  input.head = { icon: 'asset:icons/logo.svg' };
  const prepared = await prepareFrame(input);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect id="mark" width="20" height="20" fill="#123"/></svg>';
  const graph = await buildStatic({ projectDir: '/no-original-assets', frames: new Map([['test', prepared.fileHtml]]), assets: { icons: { 'logo.svg': 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') } } });
  assert.match(graph.files.get('test.html'), /src="assets\/icons\/logo.svg#mark"/);
  assert.match(graph.files.get('test.html'), /rel="icon" href="assets\/icons\/logo.svg"/);
  assert.equal(graph.mediaTypes.get('assets/icons/logo.svg'), 'image/svg+xml');
  assert.deepEqual(readProject({ schemaVersion: 1, frames: [], assets: {} }).settings.assets, {});
});

test('foreign page URL attributes cannot acquire the native namespace through opened or dropped HTML', async t => {
  for (const html of ['<img src="asset:icons/logo.svg">', '<video poster="asset:images/poster.png"></video>', '<svg><use href="asset:icons/logo.svg#mark"></use></svg>', '<link rel="icon" href="asset:icons/logo.svg">']) {
    assert.throws(() => convertHtml(html), { code: 'INVALID_DOCUMENT' });
    assert.throws(() => decodePage(html), { code: 'INVALID_DOCUMENT' });
  }
  assert.doesNotThrow(() => convertHtml('<p title="asset:../opaque">asset:../opaque</p>'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'divlet-foreign-asset-context-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'page.html'), html = '<img src="asset:icons/logo.svg">';
  await writeFile(source, html);
  const result = await resolveOpenFile(source);
  assert.equal(result.file, source);
  assert.equal(result.created, false);
  assert.equal(await readFile(source, 'utf8'), html);
  await assert.rejects(readFile(path.join(directory, 'page.divlet')), { code: 'ENOENT' });
});

test('the accepted writer still refuses missing declarations without filesystem fallback or source/history changes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'divlet-asset-context-'));
  let runtime;
  t.after(async () => { await runtime?.close(); await rm(directory, { recursive: true, force: true }); });
  const file = path.join(directory, 'project.divlet');
  await mkdir(path.join(directory, 'icons'));
  await writeFile(path.join(directory, 'icons/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await initProject(file);
  runtime = await openRuntime({ file, watch: false });
  await runtime.create({ document: resourceFrame('img', { src: 'icons/logo.svg' }) });
  const source = await readFile(file), state = runtime.info(), history = runtime.readHistory();
  await assert.rejects(runtime.patch({ documentId: 'test', expectedVersion: 1, patch: { nodes: { label: { attrs: { src: 'asset:icons/logo.svg' } } } } }), { code: 'INVALID_ASSET' });
  assert.deepEqual(await readFile(file), source);
  assert.deepEqual(runtime.info(), state);
  assert.deepEqual(runtime.readHistory(), history);
});
