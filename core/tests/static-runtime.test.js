import test from 'node:test';
import { legacyProject } from './fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { parse } from 'parse5';
import { openRuntime } from '../lib/runtime.js';
import { decodeHtml } from '../lib/codec.ts';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-static-runtime-'));
  const source = path.join(dir, 'source');
  await fs.mkdir(source);
  await legacyProject(path.join(source, 'landing.divlet'));
  const runtime = await openRuntime({ file: path.join(source, 'landing.divlet'), watch: false, createDemo: false });
  t.after(async () => { await runtime.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const write = async (name, contents) => {
    const file = path.join(source, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
    return file;
  };
  return { dir, source, runtime, write };
}

async function manual(t) {
  const setup = await fixture(t);
  const { runtime, write } = setup;
  await write('assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>');
  await write('assets/background.png', Buffer.from([0, 255, 12, 34]));
  await write('fonts/brand.woff2', Buffer.from([11, 22, 33, 44]));
  await write('content/guide/images/photo.png', Buffer.from([77, 88, 99]));
  const template = decodeHtml('<style>@font-face{font-family:Brand;src:url("fonts/brand.woff2")}main{font-family:Brand;background-image:url("assets/background.png")}</style><main id="shell"><header><img id="logo" src="assets/logo.svg"><h1 id="title">Title</h1></header><nav id="navigation"></nav><article id="content">Content</article><footer id="footer"><a href="layout.html#shell">Template</a></footer></main>', { fallbackId: 'layout' });
  await runtime.create({ document: template });
  await write('site.json', JSON.stringify({ schemaVersion: 1, title: 'Static manual', templateId: 'layout', contentDir: 'content', slots: { content: 'content', title: 'title', navigation: 'navigation' } }));
  await write('content/index.md', '# Welcome\n\n[Start](guide/start.md?from=home#details)');
  await write('content/guide/start.md', '# Details\n\n![Local photo](images/photo.png)\n\n[Home](../index.md)');
  await runtime.scan();
  assert.equal(runtime.info().diagnostics.length, 0, JSON.stringify(runtime.info().diagnostics));
  return setup;
}

function attributes(html, name) {
  const values = [];
  function walk(node) {
    for (const attr of node.attrs ?? []) if (attr.name === name) values.push(attr.value);
    for (const child of node.childNodes ?? []) walk(child);
  }
  walk(parse(html));
  return values;
}

async function staticServer(t, directory) {
  const prefix = '/published/subpath/';
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith(prefix)) { res.writeHead(404); return res.end(); }
      const relative = decodeURIComponent(url.pathname.slice(prefix.length));
      if (relative.split('/').includes('..')) { res.writeHead(403); return res.end(); }
      const file = path.join(directory, relative.endsWith('/') || !relative ? relative + 'index.html' : relative);
      const bytes = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
      res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}${prefix}`;
}

test('a copied output directory serves complete Markdown pages, assets and fonts after Divlet stops', async t => {
  const { runtime, dir } = await manual(t);
  await runtime.patchProject({ expectedVersion: 1, patch: { outputDir: './public/manual' } });
  const destination = path.join(dir, 'standalone');
  await fs.cp(runtime.outputDir, destination, { recursive: true });
  const runtimeURL = runtime.url;
  await runtime.close();
  const base = await staticServer(t, destination);
  const home = await (await fetch(base)).text();
  assert.match(home, /Welcome/);
  const chapterLink = attributes(home, 'href').find(value => value.includes('guide/start/index.html?from=home#details'));
  assert.ok(chapterLink);
  const chapterURL = new URL(chapterLink, base);
  const chapter = await (await fetch(chapterURL)).text();
  assert.match(chapter, /Details/);
  assert.ok(attributes(chapter, 'href').includes('../../index.html'));
  assert.ok(attributes(chapter, 'href').includes('../../layout.html#shell'));
  for (const [html, url] of [[home, base], [chapter, chapterURL]]) {
    assert.ok(!html.includes(runtimeURL));
    assert.doesNotMatch(html, /<script\b|\/files\/|\/site\//);
    for (const src of attributes(html, 'src')) assert.equal((await fetch(new URL(src, url))).status, 200, src);
    for (const match of html.matchAll(/url\(["']?([^"')]+)["']?\)/g)) assert.equal((await fetch(new URL(match[1], url))).status, 200, match[1]);
  }
  const image = attributes(chapter, 'src').find(value => value.endsWith('photo.png'));
  assert.deepEqual(Buffer.from(await (await fetch(new URL(image, chapterURL))).arrayBuffer()), Buffer.from([77, 88, 99]));
  const routeMeta = JSON.parse(await fs.readFile(path.join(destination, 'guide/start/index.meta.json'), 'utf8'));
  assert.equal(routeMeta.route, '/guide/start/');
  assert.equal(routeMeta.project, '../../../../landing.divlet');
});

test('resource-only changes and missing-resource recovery rebuild artifacts without changing source versions', async t => {
  const { runtime, write, source } = await fixture(t);
  const doc = decodeHtml('<main><img src="assets/photo.png"><img src="assets/missing.png"></main>', { fallbackId: 'page' });
  await write('assets/photo.png', Buffer.from([1, 2]));
  await runtime.create({ document: doc });
  assert.equal(runtime.info().diagnostics.filter(item => item.code === 'MISSING_ASSET').length, 1);
  const sourceBefore = await fs.readFile(runtime.projectPath, 'utf8');
  const version = runtime.read({ view: 'frame', documentId: 'page' }).version;
  const page = path.join(runtime.outputDir, 'page.html');
  const names = attributes(await fs.readFile(page, 'utf8'), 'src');
  await write('assets/photo.png', Buffer.from([9, 8, 7]));
  await write('assets/missing.png', Buffer.from([6, 5]));
  await runtime.scan();
  assert.equal(runtime.info().diagnostics.length, 0);
  assert.equal(await fs.readFile(runtime.projectPath, 'utf8'), sourceBefore);
  assert.equal(runtime.read({ view: 'frame', documentId: 'page' }).version, version);
  assert.deepEqual(await fs.readFile(path.join(runtime.outputDir, names[0])), Buffer.from([9, 8, 7]));
  assert.deepEqual(await fs.readFile(path.join(runtime.outputDir, names[1])), Buffer.from([6, 5]));
  await fs.unlink(path.join(source, 'assets/photo.png'));
  await runtime.scan();
  assert.ok(runtime.info().diagnostics.some(item => item.code === 'MISSING_ASSET'));
  await assert.rejects(fs.stat(path.join(runtime.outputDir, names[0])), { code: 'ENOENT' });
  await write('assets/photo.png', Buffer.from([4]));
  await runtime.scan();
  assert.deepEqual(await fs.readFile(path.join(runtime.outputDir, names[0])), Buffer.from([4]));
});

test('Markdown edits, invalid content, deletions and config removal reconcile one owned build', async t => {
  const { runtime, write, source } = await manual(t);
  const chapter = path.join(runtime.outputDir, 'guide/start/index.html');
  const oldHTML = await fs.readFile(chapter, 'utf8');
  await write('content/guide/start.md', '# Changed\n\n[Home](../index.md)');
  await runtime.scan();
  assert.match(await fs.readFile(chapter, 'utf8'), /Changed/);
  assert.notEqual(await fs.readFile(chapter, 'utf8'), oldHTML);
  const accepted = await fs.readFile(chapter, 'utf8');
  await write('content/guide/start.md', '<script>not allowed</script>');
  await runtime.scan();
  assert.equal(await fs.readFile(chapter, 'utf8'), accepted);
  assert.ok(runtime.info().diagnostics.some(item => item.code === 'UNSUPPORTED_MARKDOWN_HTML'));
  await write('content/index.md', '# Home without the removed link');
  await fs.unlink(path.join(source, 'content/guide/start.md'));
  await runtime.scan();
  await assert.rejects(fs.stat(chapter), { code: 'ENOENT' });
  assert.doesNotMatch(await fs.readFile(path.join(runtime.outputDir, 'index.html'), 'utf8'), /guide\/start/);
  await fs.unlink(path.join(source, 'site.json'));
  await runtime.scan();
  await assert.rejects(fs.stat(path.join(runtime.outputDir, 'index.html')), { code: 'ENOENT' });
  assert.equal((await fs.stat(path.join(runtime.outputDir, 'layout.html'))).isFile(), true);
});

test('static asset collisions and unsafe source references fail before source or accepted state changes', async t => {
  const { runtime, write, source } = await fixture(t);
  await write('assets/photo.png', Buffer.from([1]));
  const doc = decodeHtml('<main><img src="assets/photo.png"></main>', { fallbackId: 'page' });
  await runtime.create({ document: doc });
  const asset = attributes(await fs.readFile(path.join(runtime.outputDir, 'page.html'), 'utf8'), 'src')[0];
  await fs.mkdir(path.join(source, 'public/_assets'), { recursive: true });
  await fs.writeFile(path.join(source, 'public', asset), 'Foreign resource');
  const original = await fs.readFile(runtime.projectPath, 'utf8');
  const before = runtime.info();
  await assert.rejects(runtime.patchProject({ expectedVersion: 1, patch: { outputDir: 'public' } }), { code: 'OUTPUT_CONFLICT' });
  assert.deepEqual(runtime.info(), before);
  assert.equal(await fs.readFile(runtime.projectPath, 'utf8'), original);
  await assert.rejects(runtime.patch({ documentId: 'page', expectedVersion: 1, patch: { nodes: { [Object.values(doc.nodes).find(node => node.tag === 'img').id]: { attrs: { src: '../.private.txt' } } } } }), { code: 'STATIC_BUILD_FAILED' });
  assert.equal(await fs.readFile(runtime.projectPath, 'utf8'), original);
});

test('an output directory cannot contain authored inputs or turn copied resources into new source assets', async t => {
  const { runtime, write } = await fixture(t);
  await write('assets/photo.png', Buffer.from([1]));
  await runtime.create({ document: decodeHtml('<main><img src="assets/photo.png"></main>', { fallbackId: 'page' }) });
  const before = await fs.readFile(runtime.projectPath, 'utf8');
  await assert.rejects(runtime.patchProject({ expectedVersion: 1, patch: { outputDir: 'assets' } }), { code: 'INVALID_OUTPUT_DIR' });
  assert.equal(await fs.readFile(runtime.projectPath, 'utf8'), before);
  await runtime.patchProject({ expectedVersion: 1, patch: { outputDir: 'public' } });
  assert.deepEqual((await runtime.listAssets()).assets.map(asset => asset.path), ['assets/photo.png']);
  const published = attributes(await fs.readFile(path.join(runtime.outputDir, 'page.html'), 'utf8'), 'src')[0];
  await assert.rejects(runtime.create({ document: decodeHtml(`<main><img src="public/${published}"></main>`, { fallbackId: 'recursive' }) }), { code: 'STATIC_BUILD_FAILED' });
});

test('route/frame and metadata-directory collisions never commit source or publish partial sites', async t => {
  const { runtime, write } = await fixture(t);
  const template = decodeHtml('<main id="body"><article id="content"></article></main>', { fallbackId: 'layout' });
  await runtime.create({ document: template });
  await write('site.json', JSON.stringify({ schemaVersion: 1, title: 'Site', templateId: 'layout', slots: { content: 'content' } }));
  await write('content/index.md', '# Home');
  await runtime.scan();
  const original = await fs.readFile(runtime.projectPath, 'utf8');
  const site = runtime.site;
  await assert.rejects(runtime.create({ document: { ...template, id: 'index' } }), { code: 'STATIC_BUILD_FAILED' });
  assert.equal(runtime.site, site);
  assert.equal(await fs.readFile(runtime.projectPath, 'utf8'), original);
  await write('content/layout.meta.json/index.md', '# Conflicting directory');
  await runtime.scan();
  assert.equal(runtime.site, site);
  assert.ok(runtime.info().diagnostics.some(item => item.code === 'STATIC_BUILD_FAILED'));
  assert.equal((await fs.stat(path.join(runtime.outputDir, 'layout.meta.json'))).isFile(), true);
});

test('a copy with an escaping outputDir opens independently without claiming the original build', async t => {
  const { runtime, dir } = await manual(t);
  await runtime.patchProject({ expectedVersion: 1, patch: { outputDir: '../public' } });
  const originalOutput = runtime.outputDir;
  const before = await fs.readFile(path.join(originalOutput, 'index.html'));
  let copy;
  runtime.host = { open: async target => {
    copy = await openRuntime({ dir: target, watch: false, createDemo: false });
    t.after(() => copy.close());
    return { url: copy.url };
  } };
  const target = path.join(dir, 'copy');
  await runtime.saveAs({ path: target });
  assert.equal(copy.info().project.outputDir, null);
  assert.equal(copy.outputDir, path.join(target, '.divlet/landing'));
  assert.equal(copy.info().diagnostics.length, 0);
  assert.match(await fs.readFile(path.join(copy.outputDir, 'index.html'), 'utf8'), /Welcome/);
  assert.equal(runtime.info().project.outputDir, '../public');
  assert.equal(JSON.parse(await fs.readFile(runtime.projectPath, 'utf8')).outputDir, '../public');
  assert.deepEqual(await fs.readFile(path.join(originalOutput, 'index.html')), before);
});

test('retained site metadata follows output moves even after the final source frame is removed', async t => {
  const { runtime } = await manual(t);
  await runtime.removeDocument({ documentId: 'layout' });
  assert.equal(runtime.documents.size, 0);
  assert.ok(runtime.site);
  await runtime.patchProject({ expectedVersion: 1, patch: { outputDir: 'public' } });
  await runtime.scan();
  const metadata = JSON.parse(await fs.readFile(path.join(runtime.outputDir, 'index.meta.json'), 'utf8'));
  assert.equal(metadata.project, '../landing.divlet');
  assert.equal(path.resolve(runtime.outputDir, metadata.project), runtime.projectPath);
});

test('browser-normalized editor URLs are bundled without publishing the editor capability', async t => {
  const { runtime, write } = await fixture(t);
  await write('assets/photo.png', Buffer.from([8, 9]));
  const original = runtime.url + 'files/assets/photo.png';
  const variants = [original.replace('http:', 'http:\t'), original.replace('http:', 'http:\n'), original.replace('http:', 'HTTP:')];
  for (const [index, url] of variants.entries()) {
    const id = `page${index}`;
    await runtime.create({ document: decodeHtml(`<main><img src="${url}"></main>`, { fallbackId: id }) });
    const html = await fs.readFile(path.join(runtime.outputDir, `${id}.html`), 'utf8');
    assert.ok(!html.includes(new URL(runtime.url).pathname));
    assert.ok(!html.includes(new URL(runtime.url).origin));
    const image = attributes(html, 'src')[0];
    assert.deepEqual(await fs.readFile(path.join(runtime.outputDir, image)), Buffer.from([8, 9]));
  }
  await assert.rejects(runtime.create({ document: decodeHtml(`<main><a href="${runtime.url}api/project">Private API</a></main>`, { fallbackId: 'private' }) }), { code: 'STATIC_BUILD_FAILED' });
});

test('save-a-copy includes explicitly referenced resources outside conventional asset folders', async t => {
  const { runtime, write, dir } = await fixture(t);
  await write('media/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await write('typography/brand.woff2', Buffer.from([1, 2, 3]));
  await runtime.create({ document: decodeHtml('<style>@font-face{font-family:Brand;src:url(typography/brand.woff2)}</style><main><img src="media/logo.svg"></main>', { fallbackId: 'page' }) });
  runtime.host = { open: async () => ({ url: 'http://example.invalid/' }) };
  const destination = path.join(dir, 'copy');
  await runtime.saveAs({ path: destination });
  assert.equal((await fs.stat(path.join(destination, 'media/logo.svg'))).isFile(), true);
  assert.deepEqual(await fs.readFile(path.join(destination, 'typography/brand.woff2')), Buffer.from([1, 2, 3]));
  await assert.rejects(fs.stat(path.join(destination, '_assets')), { code: 'ENOENT' });
});
