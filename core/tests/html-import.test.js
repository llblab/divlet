import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertHtml, decodePage, summarizeHtml } from '../lib/html-import.ts';
import { importSource, importAgain, resolveOpenFile, sourceFor, isImportable, pageSourceExtensions } from '../lib/import.ts';
import { importerFor, importerList, importExtensions, registerImporter } from '../lib/plugins.ts';
import { styleEngine, setStyleEngines } from '../lib/engine.ts';
import { listProjects, resolveProject } from '../lib/projects.ts';
import { decodeHtml } from '../lib/codec.ts';

const page = `<!doctype html><html><head><meta charset="utf-8"><title>My Page</title><link rel="stylesheet" href="x.css"><style>.x{color:red}</style></head>
<body class="p-4" onload="boot()"><!-- note --><main id="root" class="x" onclick="go()"><h1>Hello</h1><p>World <a href="#a">link</a></p><script>alert(1)</script></main></body></html>`;

test('a static page becomes a one-frame project; what the codec cannot hold is dropped and counted', () => {
  const { text, stats } = convertHtml(page, { name: 'page', provenance: { source: 'page.html', format: 'html', sha256: 'abc' } });
  const project = JSON.parse(text);
  assert.equal(project.frames.length, 1);
  assert.equal(project.frames[0].name, 'My Page');
  assert.equal(project.frames[0].css, '.x{color:red}');
  assert.deepEqual(stats.dropped, { scripts: 1, comments: 1, links: 1, handlers: 2, frames: 0 });
  assert.equal(project.metadata.import.source, 'page.html');
  const serialized = JSON.stringify(project);
  assert.ok(!serialized.includes('alert(1)') && !serialized.includes('onclick'));
  const nodes = Object.values(project.frames[0].nodes);
  assert.ok(nodes.some(node => node.type === 'text' && node.content === 'Hello'));
  assert.ok(nodes.some(node => node.className?.includes('p-4')), 'body classes land on the root wrapper');
});

test('several top-level elements and a bare fragment are accepted', () => {
  const { text } = convertHtml('<h1>A</h1><p>B</p>', { name: 'frag' });
  assert.equal(JSON.parse(text).frames.length, 1);
  assert.deepEqual(summarizeHtml(page), { name: 'My Page', frames: 1, frameNames: ['My Page'] });
});

test('a dropped page decodes exactly like a page opened by path, with its provenance on the frame', () => {
  const { document, dropped } = decodePage(page, { fallbackId: 'page', source: 'page.html', format: 'html' });
  assert.deepEqual(dropped, { scripts: 1, comments: 1, links: 1, handlers: 2, frames: 0 });
  assert.equal(document.name, 'My Page');
  assert.equal(document.css, '.x{color:red}');
  assert.deepEqual(document.metadata.import, { source: 'page.html', format: 'html', dropped });
  assert.ok(!JSON.stringify(document).includes('alert(1)'));
});

async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-html-admission-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('HTML admission is native, not registered as a foreign importer, and does not need a style engine', async t => {
  const engine = styleEngine();
  t.after(() => setStyleEngines([engine]));
  setStyleEngines([]);
  assert.ok(!importerList().some(importer => importer.id === 'html'));
  assert.ok(!importExtensions({ all: true }).has('.html'));
  for (const name of ['page.html', 'page.HTM']) {
    assert.equal(await importerFor(name, async () => Buffer.from(page)), null);
    const provider = await sourceFor(name, async () => { throw new Error('Native selection must not sniff a foreign format'); });
    assert.equal(provider.id, 'html');
    const { text } = provider.convert(Buffer.from(page), { name: 'native', provenance: {} });
    const project = JSON.parse(text);
    assert.equal(project.frames[0].css, '.x{color:red}');
    assert.ok(!JSON.stringify(project).includes('onclick'));
    assert.equal(isImportable(name), false);
    assert.equal(isImportable(name, { all: true }), true);
  }
  assert.ok(pageSourceExtensions().has('.html') && pageSourceExtensions().has('.htm'));
  assert.throws(() => decodeHtml(page), 'external admission must not weaken strict native HTML decoding');
});

test('native HTML takes precedence without losing foreign page-provider capabilities', async () => {
  const other = {
    id: 'html-admission-test', label: 'Test page provider', extensions: ['.admission-test'], claims: async file => /\.html?$/i.test(file),
    convert: () => ({ text: '{}' }),
    page: () => ({ document: decodeHtml('<main>Other format</main>') }),
  };
  registerImporter(other);
  assert.equal(await sourceFor('example.admission-test', async () => new Uint8Array()), other);
  assert.ok(pageSourceExtensions().has('.admission-test'));
  assert.equal((await sourceFor('example.html', async () => new Uint8Array())).id, 'html');
});

test('native HTML explicit opening and re-import preserve sources, existing projects and listing policy', async t => {
  for (const extension of ['html', 'HTM']) {
    const directory = await workspace(t);
    const source = path.join(directory, `page.${extension}`);
    const file = path.join(directory, 'page.divlet');
    await fs.writeFile(source, page);
    assert.deepEqual(await listProjects(directory), []);
    assert.equal((await resolveProject(source)).kind, 'project');
    const result = await resolveOpenFile(source);
    assert.equal(result.file, file);
    assert.equal(result.created, true);
    const project = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(project.metadata.import.format, 'html');
    assert.equal(project.metadata.import.bytes, Buffer.byteLength(page));
    project.name = 'Authored project';
    const authored = JSON.stringify(project);
    await fs.writeFile(file, authored);
    assert.equal((await importSource(source)).created, false);
    assert.equal(await fs.readFile(file, 'utf8'), authored);
    assert.equal((await importAgain(file, project.metadata)).file, path.join(directory, 'page-2.divlet'));
    assert.equal(await fs.readFile(file, 'utf8'), authored);
    assert.equal(await fs.readFile(source, 'utf8'), page);
    assert.ok((await listProjects(directory)).every(entry => entry.file.endsWith('.divlet')));
  }
});

test('unsafe or unsupported native HTML does not publish a replacement project', async t => {
  const directory = await workspace(t);
  const target = path.join(directory, 'target.html');
  const link = path.join(directory, 'link.html');
  await fs.writeFile(target, '<main>Safe target</main>');
  await fs.symlink(target, link);
  await assert.rejects(importSource(link));
  await assert.rejects(fs.stat(path.join(directory, 'link.divlet')), { code: 'ENOENT' });
  const unsupported = path.join(directory, 'unsupported.html');
  const bytes = '<main><marquee>Unsupported</marquee></main>';
  await fs.writeFile(unsupported, bytes);
  const result = await resolveOpenFile(unsupported);
  assert.equal(result.file, unsupported);
  assert.equal(result.created, false);
  await assert.rejects(fs.stat(path.join(directory, 'unsupported.divlet')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(unsupported, 'utf8'), bytes);
});
