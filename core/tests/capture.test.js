import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';
import { captureFontCSS } from '../lib/capture.ts';
import { openRuntime } from '@divlet/core/runtime';
import { decodeHtml } from '../lib/codec.ts';
import { validateSettings, writeProject } from '../lib/project.ts';
import { fontBytes, fontDataUrl } from './fixtures/font.js';
import { SOURCE_LIMITS } from '../lib/model.ts';

const html = css => `<html><head><style>${css}</style></head><body><img src="asset:missing.png"></body></html>`;
const assets = { fonts: { 'face.html': fontDataUrl() }, unused: 'data:application/octet-stream;base64,dW51c2Vk' };

test('snapshot font closure preserves descriptors, conditions and exact declared MIME/bytes without unrelated resources', async () => {
  const css = '@media(min-width:1px){@layer typography{@font-face{font-family:"Capture Face";src:url(asset:fonts/face.html);font-weight:100 900;font-style:italic;font-stretch:75% 125%;unicode-range:U+0041}}}body{background:url(asset:missing.png)}';
  const result = await captureFontCSS(html(css), assets);
  assert.ok(result.includes(fontDataUrl()));
  for (const expected of ['@media', '@layer typography', 'font-weight:100 900', 'font-style:italic', 'font-stretch:75% 125%', 'unicode-range:U+0041']) assert.ok(result.includes(expected), expected);
  assert.ok(!result.includes('background')); assert.ok(!result.includes('missing.png')); assert.ok(!result.includes('dW51c2Vk'));
});

test('literal font Data URLs stay literal and local face alternatives remain authored', async () => {
  const literal = fontDataUrl().replace('data:', 'DATA:');
  const result = await captureFontCSS(html(`@font-face{font-family:Local;src:local("Installed Face"),url("${literal}") format("truetype")}`), {});
  assert.ok(result.includes(literal)); assert.ok(result.includes('local("Installed Face")'));
  assert.equal(await captureFontCSS(html('body{background:url(asset:missing.png)}'), {}), '', 'no fonts never triggers unrelated resource closure');
});

test('unproven filesystem/network/import/dynamic font resources refuse rather than authorize reads or paint fallback', async () => {
  for (const css of ['@font-face{font-family:Proof;src:url(/private/font.ttf)}', '@font-face{font-family:Proof;src:url(https://example.invalid/font.ttf)}', '@font-face{font-family:Proof;src:var(--source)}', '@import "other.css"']) {
    await assert.rejects(captureFontCSS(html(css), {}));
  }
  await assert.rejects(captureFontCSS('<link rel="stylesheet" href="unknown.css">', {}), { code: 'CAPTURE_UNAVAILABLE' });
  await assert.rejects(captureFontCSS(html('@font-face{font-family:Proof;src:url(asset:missing.ttf)}'), {}));
  await assert.rejects(captureFontCSS(html('@font-face{font-family:Proof;src:url(asset:fonts/face.html?query)}'), assets));
});

test('public font closure uses exact accepted bytes and HTTP MIME defaults without scanning unrelated resources', async () => {
  const files = new Map([['_assets/legacy.otf', fontBytes(600, { cff: true })], ['assets/font%20.html', fontBytes()], ['private.meta.json', 'not public']]);
  files.set('assets/unused', { get byteLength() { assert.fail('unreferenced bytes must not be inspected'); } });
  const resources = { files, mediaTypes: new Map([['assets/font%20.html', 'font/ttf']]), documentPath: 'proof.html' };
  const result = await captureFontCSS(html('@media(min-width:1px){@font-face{font-family:Legacy;src:local("A"),url("_assets/legacy.otf") format("opentype")}}@font-face{font-family:Native;src:url("assets/font%2520.html")}'), {}, resources);
  assert.ok(result.includes('data:application/octet-stream;base64,' + files.get('_assets/legacy.otf').toString('base64')));
  assert.ok(result.includes(fontDataUrl())); assert.ok(result.includes('@media')); assert.ok(result.includes('local("A")')); assert.ok(result.includes('format("opentype")'));
  for (const value of ['_assets/legacy.otf?rev=1', '_assets/legacy.otf?', '_assets/legacy.otf#face', '_assets/legacy.otf#', '_assets/missing.ttf', 'private.meta.json', 'https://capture.invalid/_assets/legacy.otf', '//capture.invalid/_assets/legacy.otf', '/_assets/legacy.otf', 'file:///private.ttf', 'asset:missing.ttf']) {
    await assert.rejects(captureFontCSS(html(`@font-face{font-family:Proof;src:url("${value}")}`), {}, resources), value);
  }
  for (const value of ['env(--face)', 'attr(data-face url)', 'var(--face)']) await assert.rejects(captureFontCSS(html(`@font-face{font-family:Proof;src:${value}}`), {}, resources));
});

test('public font closure bounds aggregate repeated expansion, not only one resource size', async () => {
  const resources = { files: new Map([['_assets/large.ttf', Buffer.alloc(20 * 1024 * 1024)]]), documentPath: 'proof.html' };
  assert.ok(resources.files.get('_assets/large.ttf').length < SOURCE_LIMITS.bytes);
  const faces = '@font-face{font-family:One;src:url(_assets/large.ttf)}@font-face{font-family:Two;src:url(_assets/large.ttf)}';
  await assert.rejects(captureFontCSS(html(faces), {}, resources), { code: 'CAPTURE_UNAVAILABLE' });
});

test('legacy font previews and captures share accepted bytes across changes, source/cache deletion and graph races', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-capture-legacy-'));
  const frame = decodeHtml('<main>AA</main>', { fallbackId: 'proof' });
  const file = path.join(directory, 'project.divlet'), font = path.join(directory, 'legacy.otf');
  await fs.writeFile(font, fontBytes(600, { cff: true }));
  await fs.writeFile(file, writeProject(validateSettings({ css: '@font-face{font-family:Proof;src:url(legacy.otf)}main{font-family:Proof}' }), [frame]));
  const runtime = await openRuntime({ file, watch: false, createDemo: false });
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const before = { source: await fs.readFile(file, 'utf8'), revision: runtime.revision, projectVersion: runtime.settings.version, version: runtime.getEntry('proof').document.version, history: runtime.readHistory() };
  const render = runtime.getEntry('proof').render;
  const initial = await runtime.captureFonts('proof', render);
  assert.ok(initial.css.includes('data:application/octet-stream;base64,' + fontBytes(600, { cff: true }).toString('base64')));
  const published = [...runtime.publicFiles.keys()].find(key => key.startsWith('_assets/') && key.endsWith('.otf'));
  assert.ok(runtime.render('proof').html.includes(runtime.url + 'build/' + published + '?divlet-resource='));
  assert.ok(!JSON.stringify(runtime.info()).includes(';base64,')); assert.deepEqual(runtime.settings.assets, {});
  await fs.writeFile(font, fontBytes(900, { cff: true }));
  assert.equal((await runtime.captureFonts('proof', render)).css, initial.css, 'no fresh filesystem read can change the accepted render');
  await runtime.refreshSite();
  const changedRender = runtime.getEntry('proof').render;
  assert.ok(changedRender > render);
  await assert.rejects(runtime.captureFonts('proof', render), { code: 'STALE_PREVIEW' });
  const changed = await runtime.captureFonts('proof', changedRender);
  assert.ok(changed.css.includes(fontBytes(900, { cff: true }).toString('base64')));
  assert.deepEqual({ source: await fs.readFile(file, 'utf8'), revision: runtime.revision, projectVersion: runtime.settings.version, version: runtime.getEntry('proof').document.version, history: runtime.readHistory() }, before, 'resource rendering does not absorb bytes or author content/history');
  await fs.rm(font); await fs.rm(path.dirname(runtime.getEntry('proof').htmlPath), { recursive: true, force: true });
  assert.equal((await runtime.captureFonts('proof', changedRender)).css, changed.css, 'accepted snapshot bytes do not depend on original files or disposable output cache');
  const response = await fetch(runtime.url + 'build/' + published);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fontBytes(900, { cff: true }));
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  const accepted = runtime.publicFiles;
  const pending = runtime.captureFonts('proof', changedRender);
  runtime.publicFiles = new Map(accepted); // Publication swaps the byte port even when a frame entry is otherwise unchanged.
  await assert.rejects(pending, { code: 'STALE_PREVIEW' });
  runtime.publicFiles = accepted;
  await runtime.refreshSite();
  await assert.rejects(runtime.captureFonts('proof', runtime.getEntry('proof').render), { code: 'CAPTURE_UNAVAILABLE' }, 'missing files stay live after an explicit refresh, not an old or fallback snapshot');
});

test('automatic resource scanning accepts an external local font change without authoring project content', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-capture-watch-'));
  const projectDir = path.join(directory, 'project'); await fs.mkdir(projectDir);
  const font = path.join(directory, 'external.otf'), file = path.join(projectDir, 'project.divlet');
  const frame = decodeHtml('<main>AA</main>', { fallbackId: 'proof' });
  await fs.writeFile(font, fontBytes(600, { cff: true }));
  await fs.writeFile(file, writeProject(validateSettings({ css: `@font-face{font-family:Proof;src:url("${font}")}main{font-family:Proof}` }), [frame]));
  const runtime = await openRuntime({ file, watch: true, createDemo: false });
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const render = runtime.getEntry('proof').render, source = await fs.readFile(file, 'utf8'), revision = runtime.revision, history = runtime.readHistory();
  await fs.writeFile(font, fontBytes(900, { cff: true }));
  for (let tries = 0; tries < 100 && runtime.getEntry('proof').render === render; tries++) await wait(50);
  assert.ok(runtime.getEntry('proof').render > render, 'the existing automatic scan publishes a changed resource render without an explicit refresh call');
  assert.ok((await runtime.captureFonts('proof', runtime.getEntry('proof').render)).css.includes(fontBytes(900, { cff: true }).toString('base64')));
  assert.equal(await fs.readFile(file, 'utf8'), source); assert.equal(runtime.revision, revision); assert.deepEqual(runtime.readHistory(), history); assert.deepEqual(runtime.settings.assets, {});
});

test('byte-bearing capture preparation is an explicit guarded read, not model/state content or history', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-capture-'));
  const frame = decodeHtml('<main>AA</main>', { fallbackId: 'proof' });
  const file = path.join(directory, 'project.divlet');
  await fs.writeFile(file, writeProject(validateSettings({ assets, css: '@font-face{font-family:Proof;src:url(asset:fonts/face.html)}' }), [frame]));
  const runtime = await openRuntime({ file, watch: false, createDemo: false });
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const before = { source: await fs.readFile(file, 'utf8'), info: runtime.info(), history: runtime.readHistory() }, render = runtime.getEntry('proof').render;
  assert.ok(!JSON.stringify(before.info).includes(';base64,'));
  assert.ok(runtime.info().project.capabilities.captureFonts.maxBytes > 0);
  await assert.rejects(runtime.captureFonts('proof', render - 1), { code: 'STALE_PREVIEW' });
  assert.equal((await runtime.captureFonts('proof', render)).render, render);
  const response = await fetch(runtime.url + `api/capture-fonts/proof?render=${render}`);
  assert.equal(response.status, 200); const result = await response.json(); assert.ok(result.css.includes(fontDataUrl()));
  assert.deepEqual({ source: await fs.readFile(file, 'utf8'), info: runtime.info(), history: runtime.readHistory() }, before);
  await runtime.patchProject({ expectedVersion: runtime.settings.version, patch: { assets: { fonts: { 'face.html': fontDataUrl(900) } } } });
  await assert.rejects(runtime.captureFonts('proof', render), { code: 'STALE_PREVIEW' });
  assert.ok((await runtime.captureFonts('proof', runtime.getEntry('proof').render)).css.includes(fontDataUrl(900)));
});
