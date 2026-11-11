import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeAttribute, validateDocument } from '../lib/model.ts';
import { decodeHtml, encodeHtml, exportHtml } from '../lib/codec.ts';
import { decodePage } from '../lib/html-import.ts';
import { readProject, writeProject, validateSettings } from '../lib/project.ts';
import { openRuntime } from '../lib/runtime.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M0 0h20v20H0z"/></svg>';
const images = [`data:image/svg+xml,${encodeURIComponent(svg)}`, `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`];
const font = 'data:font/woff2;base64,AA==';
const frame = icon => decodePage(`<link rel="icon" href="${icon}"><style>@font-face{font-family:Embedded;src:url("${font}")}</style><main><img src="${icon}" srcset="${icon} 1x" style="background-image:url('${icon}')"><video poster="${icon}"></video></main>`).document;

test('data URLs survive native admission, strict HTML codecs and project storage in resource contexts', () => {
  for (const icon of images) {
    const document = frame(icon);
    assert.equal(document.head.icon, icon);
    for (const emit of [encodeHtml, exportHtml]) assert.deepEqual(decodeHtml(emit(document)).head, document.head);
    assert.deepEqual(decodeHtml(encodeHtml(document)), document);
    const stored = readProject(JSON.parse(writeProject(validateSettings({}), [document])));
    assert.deepEqual(stored.frames[0].head, document.head);
    for (const name of ['src', 'poster', 'SRC']) assert.doesNotThrow(() => safeAttribute(name, icon, 'resource'));
  }
});

test('embedded resource URLs rebuild without source assets or cache and remain ordinary undoable content', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-data-urls-'));
  let runtime;
  t.after(async () => { await runtime?.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const document = frame(images[0]), source = path.join(dir, 'project.divlet');
  const text = writeProject(validateSettings({}), [document]);
  await fs.writeFile(source, text);
  runtime = await openRuntime({ file: source, watch: false, createDemo: false });
  const output = runtime.outputDir, file = path.join(output, `${document.id}.html`);
  const before = await fs.readFile(file, 'utf8');
  for (const url of [images[0], font]) assert.ok(before.includes(url));
  assert.equal(runtime.staticSources.size, 0, 'no external file input or network fetch is needed');
  await runtime.close(); runtime = null;
  await fs.rm(output, { recursive: true });
  assert.deepEqual(await fs.readdir(dir), ['.divlet', 'project.divlet']);
  runtime = await openRuntime({ file: source, watch: false, createDemo: false });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(await fs.readFile(source, 'utf8'), text);
  await runtime.patch({ documentId: document.id, expectedVersion: 1, patch: { head: { icon: images[1] } } });
  assert.equal(runtime.documents.get(document.id).document.head.icon, images[1]);
  await runtime.undo({ documentId: document.id });
  assert.equal(runtime.documents.get(document.id).document.head.icon, images[0]);
});

test('data resources do not admit active navigation, script schemes, handlers or larger strings', () => {
  for (const name of ['href', 'xlink:href', 'action', 'formaction']) for (const url of [images[0], 'data:text/html,<script>alert(1)</script>', '\tDa\nta:text/html,x']) {
    assert.throws(() => safeAttribute(name, url, 'navigation'), /Unsupported URL scheme/);
  }
  for (const name of ['src', 'poster', 'href']) for (const url of ['javascript:alert(1)', 'java\tscript:alert(1)', 'vbscript:x']) {
    assert.throws(() => safeAttribute(name, url, 'resource'), /Unsupported URL scheme/);
  }
  assert.throws(() => safeAttribute('onload', 'x', 'image'), /Unsupported attribute/);
  const document = frame(images[0]);
  assert.throws(() => validateDocument({ ...document, head: { icon: 'data:image/svg+xml,' + 'x'.repeat(8192) } }), /8192/);
  assert.throws(() => safeAttribute('src', 'data:image/png,' + 'x'.repeat(65536), 'image'), /65536/);
});
