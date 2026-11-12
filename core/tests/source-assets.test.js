import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readProject, writeProject, validateSettings, patchSettings } from '../lib/project.ts';
import { readAssets } from '../lib/assets.ts';
import { openRuntime } from '../lib/runtime.js';
import { resourceFrame, sampleFrame } from './fixtures/frame-portability.js';
import { fontDataUrl, fontBytes } from './fixtures/font.js';
import { inlineDeclaredAssets } from '../lib/static.js';
import { importSource, importAgain } from '../lib/import.ts';
import { decodeHtml } from '../lib/codec.ts';

const uri = 'asset:fonts/Regular%20Face.bin?v=%2f#face';
const data = (bytes, type = 'image/png') => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
async function fixture(t, settings = {}, frame = sampleFrame()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-source-assets-'));
  const file = path.join(root, 'project.divlet');
  await fs.writeFile(file, writeProject(validateSettings(settings), [frame]));
  const runtime = await openRuntime({ file, watch: false });
  t.after(async () => { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, file, runtime };
}

test('schema-one storage/patches preserve MIME, aliases, empty directories and literal inline URLs without exposing payloads', () => {
  const assets = { fonts: { 'Regular Face.bin': fontDataUrl(), Alias: fontDataUrl(), empty: {} } };
  const settings = validateSettings({ assets });
  const text = writeProject(settings, [resourceFrame('img', { src: 'data:image/png;base64,AQ==' })]);
  assert.equal(JSON.parse(text).schemaVersion, 1);
  assert.deepEqual(readProject(JSON.parse(text)).settings.assets, assets);
  assert.deepEqual(patchSettings(settings, { assets: { fonts: { Alias: null } } }).assets, { fonts: { 'Regular Face.bin': fontDataUrl(), empty: {} } });
  assert.deepEqual(patchSettings(settings, { assets: null }).assets, {});
  assert.throws(() => patchSettings(settings, { assets: JSON.parse('{"__proto__":null}') }), { code: 'INVALID_ASSET' });
  assert.throws(() => patchSettings(settings, { assets: { fonts: { Alias: 'data:font/ttf;base64,not-base64' } } }), { code: 'INVALID_ASSET' });
});

test('accepted native bytes drive exact HTTP MIME, prepared previews and concise project reads independently of extensions', async t => {
  const frame = resourceFrame('img', { src: 'asset:icons/logo.html?theme=%2f#mark' });
  frame.head = { icon: 'asset:icons/logo.html#mark' };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect id="mark" width="20" height="20"/></svg>';
  const { runtime } = await fixture(t, { assets: { icons: { 'logo.html': data(svg, 'image/svg+xml') }, unused: data('PRIVATE') } }, frame);
  const key = 'assets/icons/logo.html', response = await fetch(runtime.url + 'build/' + key);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.ok(!(await response.text()).includes('browseBridge'));
  assert.equal((await fetch(runtime.url + 'build/assets/unused')).status, 404);
  assert.equal(runtime.info().project.resources.length, 2);
  assert.ok(!JSON.stringify(runtime.info()).includes(';base64,'));
  const preview = await (await fetch(runtime.url + 'preview/test')).text();
  assert.ok(preview.includes(runtime.url + 'build/assets/icons/logo.html?theme=%2f&amp;divlet-resource='));
  assert.ok(runtime.render('test').html.includes('src="' + runtime.url + 'build/assets/icons/logo.html?theme=%2f&amp;divlet-resource='));
});

test('byte/MIME edits invalidate renders but not frame content versions; undo/redo restores canonical bytes and owned MIME', async t => {
  const { file, runtime } = await fixture(t, { assets: { picture: data('first') } }, resourceFrame('img', { src: 'asset:picture' }));
  const initial = runtime.getEntry('test').render;
  await runtime.patchProject({ expectedVersion: 1, patch: { assets: { picture: data('second', 'image/gif') } } });
  assert.equal(runtime.read({ view: 'frame', documentId: 'test' }).version, 1);
  assert.ok(runtime.getEntry('test').render > initial);
  assert.equal(runtime.publicMediaTypes.get('assets/picture'), 'image/gif');
  assert.equal((await fetch(runtime.url + 'build/assets/picture')).headers.get('content-type'), 'image/gif');
  await runtime.undo(); assert.equal(runtime.publicMediaTypes.get('assets/picture'), 'image/png');
  assert.equal(Buffer.from(readAssets(JSON.parse(await fs.readFile(file, 'utf8')).assets).files.get('picture').bytes).toString(), 'first');
  await runtime.redo(); assert.equal(Buffer.from(runtime.publicFiles.get('assets/picture')).toString(), 'second');
});

test('missing declarations, invalid XML, unsupported SVG dependencies/use and output collisions refuse the whole candidate', async t => {
  const { file, runtime } = await fixture(t, { assets: { picture: data('first'), glyph: data('<svg xmlns="http://www.w3.org/2000/svg"><rect id="mark" width="10" height="10"/></svg>', 'image/svg+xml') } }, resourceFrame('img', { src: 'asset:picture' }));
  const before = runtime.info(), source = await fs.readFile(file), history = runtime.readHistory();
  for (const assets of [{ picture: null }, { picture: data('<svg><script/></svg>', 'image/svg+xml') }, { picture: data('<svg xmlns="http://www.w3.org/2000/svg"><image href="asset:other"/></svg>', 'image/svg+xml'), other: data('x') }]) await assert.rejects(runtime.patchProject({ expectedVersion: 1, patch: { assets } }), { code: 'INVALID_ASSET' });
  const use = decodeHtml('<main><svg><use href="asset:glyph#mark"></use></svg></main>', { fallbackId: 'external-use' });
  await assert.rejects(runtime.create({ document: use }), { code: 'INVALID_ASSET' });
  assert.deepEqual(await fs.readFile(file), source); assert.deepEqual(runtime.info(), before); assert.deepEqual(runtime.readHistory(), history);
  await fs.writeFile(path.join(runtime.outputDir, 'assets/extra'), 'unowned');
  await assert.rejects(runtime.patchProject({ expectedVersion: 1, patch: { assets: { extra: data('x') }, css: 'main{background:url(asset:extra)}' } }), { code: 'OUTPUT_CONFLICT' });
  assert.deepEqual(await fs.readFile(file), source);
  assert.equal(await fs.readFile(path.join(runtime.outputDir, 'assets/extra'), 'utf8'), 'unowned');
});

test('cache deletion and source relocation rebuild embedded bytes without authored asset folders', async t => {
  const { root, file, runtime } = await fixture(t, { assets: { picture: data('first') } }, resourceFrame('img', { src: 'asset:picture' }));
  await runtime.close(); await fs.rm(runtime.outputDir, { recursive: true });
  const reopened = await openRuntime({ file, watch: false });
  t.after(() => reopened.close());
  assert.equal(Buffer.from(reopened.publicFiles.get('assets/picture')).toString(), 'first');
  const marker = JSON.parse(await fs.readFile(path.join(reopened.outputDir, '.divlet-build.json'), 'utf8'));
  assert.equal(marker.mediaTypes['assets/picture'], 'image/png');
  await assert.rejects(fs.stat(path.join(root, 'assets')), { code: 'ENOENT' });
});

test('foreign page open/reimport/drop cannot supply undeclared CSS, srcset or compiler resource carriers', async t => {
  const { root, runtime } = await fixture(t, { assets: { picture: data('private') } });
  const file = path.join(root, 'foreign.html');
  for (const html of [
    '<main style="background:url(asset:picture)">x</main>',
    '<main><img srcset="asset:picture 1x"></main>',
    '<main class="bg-[url(asset:picture)]">x</main>',
  ]) {
    await fs.writeFile(file, html);
    for (const operation of [() => importSource(file), () => importAgain(path.join(root, 'project.divlet'), { import: { source: 'foreign.html' } }), () => runtime.pageFrame(file, html)]) await assert.rejects(operation(), { code: 'INVALID_ASSET' });
    await assert.rejects(fs.stat(path.join(root, 'foreign.divlet')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(root, 'foreign-2.divlet')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(file, 'utf8'), html);
  }
});

test('foreign HTML fragments cannot borrow declarations through attributes, inline CSS, srcset or current compiler output, while literals and native specs retain meaning', async t => {
  const { runtime, file } = await fixture(t, { assets: { picture: data('private') } });
  const source = await fs.readFile(file), before = runtime.info(), history = runtime.readHistory();
  for (const html of [
    '<img src="asset:picture">',
    '<img srcset="asset:picture 1x">',
    '<div style="background: url(asset:picture)">x</div>',
    '<div class="bg-[url(asset:picture)]">x</div>',
  ]) {
    await assert.rejects(runtime.edit({ documentId: 'test', expectedVersion: 1, op: { type: 'insert', parentId: 'root', html } }), error => ['INVALID_DOCUMENT', 'INVALID_ASSET'].includes(error.code));
    assert.deepEqual(await fs.readFile(file), source); assert.deepEqual(runtime.info(), before); assert.deepEqual(runtime.readHistory(), history);
  }
  const literal = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoAAC0dAQHuP5EBAAAAAElFTkSuQmCC';
  const inserted = await runtime.edit({ documentId: 'test', expectedVersion: 1, op: { type: 'insert', parentId: 'root', html: `<img src="${literal}" title="asset:picture"><span>asset:picture</span>` } });
  assert.equal(runtime.getEntry('test').document.nodes[inserted.ids[0]].attrs.src, literal);
  await runtime.edit({ documentId: 'test', expectedVersion: inserted.version, op: { type: 'insert', parentId: 'root', spec: { tag: 'img', attrs: { src: 'asset:picture' } } } });
  assert.equal(Buffer.from(runtime.publicFiles.get('assets/picture')).toString(), 'private');
});

test('save a copy retains unused embedded bytes and opens an independent writer without copying an unrelated sibling asset directory', async t => {
  const { root, runtime } = await fixture(t, { assets: { picture: data('first'), unused: data('retained') } }, resourceFrame('img', { src: 'asset:picture' }));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-native-copy-'));
  let copy;
  t.after(async () => { await copy?.close(); await fs.rm(target, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'foreign')); await fs.writeFile(path.join(root, 'foreign/private'), 'not copied');
  await fs.symlink(path.join(root, 'foreign'), path.join(root, 'assets'));
  runtime.host = { open: async directory => { copy = await openRuntime({ file: path.join(directory, 'project.divlet'), watch: false }); return { url: copy.url }; } };
  await runtime.saveAs({ path: target, expectedVersion: 1 });
  assert.notEqual(copy.projectId, runtime.projectId);
  assert.deepEqual(copy.settings.assets, runtime.settings.assets);
  await assert.rejects(fs.stat(path.join(target, 'assets')), { code: 'ENOENT' });
  await copy.patchProject({ expectedVersion: 1, patch: { assets: { picture: data('copy') } } });
  assert.equal(Buffer.from(runtime.publicFiles.get('assets/picture')).toString(), 'first');
});

test('the whole source envelope, not just individual leaves, must remain reopenable', () => {
  const frame = sampleFrame(); delete frame.nodes.label;
  frame.nodes.root.children = Array.from({ length: 8 }, (_, i) => `text${i}`);
  for (const id of frame.nodes.root.children) frame.nodes[id] = { id, type: 'text', content: 'x'.repeat(60000) };
  const bytes = Buffer.alloc(12 * 1024 * 1024 - 100000);
  const settings = validateSettings({ assets: { one: data(bytes), two: data(bytes) } });
  assert.throws(() => writeProject(settings, [frame]), { code: 'FILE_TOO_LARGE' });
  assert.throws(() => readAssets({ invalid: 'data:font/ttf;v=#fragment;base64,AQ==' }), { code: 'INVALID_ASSET' });
});

test('standalone frame exports inline project fonts and explicit images but keep literals inline and refuse lossy query/use exports', async t => {
  const { runtime } = await fixture(t, { assets: { fonts: { 'Regular Face.bin': fontDataUrl() } }, css: '@font-face{font-family:Test;src:url(asset:fonts/Regular%20Face.bin)}main{font-family:Test}' });
  const exported = await runtime.exportDocument('test');
  assert.ok(exported.html.includes(fontDataUrl())); assert.ok(!exported.html.includes('asset:') || exported.html.includes('asset:../not-a-reference'));
  const literal = '<img src="data:image/png;base64,AQ==">';
  assert.equal(await inlineDeclaredAssets(literal, {}), literal);
  await assert.rejects(inlineDeclaredAssets(`<img src="${uri}">`, runtime.settings.assets), { code: 'UNSUPPORTED_EXPORT' });
  await assert.rejects(inlineDeclaredAssets('<svg><use href="asset:fonts/Regular%20Face.bin#face"></use></svg>', runtime.settings.assets), { code: 'UNSUPPORTED_EXPORT' });
  assert.deepEqual(Buffer.from(readAssets(runtime.settings.assets).files.get('fonts/Regular Face.bin').bytes), fontBytes());
});
