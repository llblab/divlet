import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureFontCSS } from '../lib/capture.ts';
import { openRuntime } from '../lib/runtime.js';
import { decodeHtml } from '../lib/codec.ts';
import { validateSettings, writeProject } from '../lib/project.ts';
import { fontDataUrl } from './fixtures/font.js';

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
