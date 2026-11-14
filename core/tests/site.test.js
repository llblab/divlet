import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSite } from '../lib/site.ts';
import { decodeHtml, encodeHtml } from '../lib/codec.ts';
import { DivletError, validateDocument } from '../lib/model.ts';
import { cssAnnotationCases } from './fixtures/css-annotations.js';

const siteBase = 'http://127.0.0.1:4242/token/site/';
const assetBase = 'http://127.0.0.1:4242/token/files/';

async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-site-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const divletDir = path.join(cwd, 'divlet');
  await fs.mkdir(path.join(divletDir, 'content', 'guide'), { recursive: true });
  await fs.mkdir(path.join(divletDir, 'templates'), { recursive: true });
  const document = decodeHtml('<main id="layout"><header><img id="logo" src="./logo.svg" alt="Logo"><h1 id="page-title"><span id="old-title">Old title</span></h1></header><nav id="navigation"><a id="old-link" href="/">Old navigation</a></nav><article id="content"><p id="old-content">Placeholder</p></article><footer id="footer">Shared footer</footer></main>', { fallbackId: 'layout' });
  document.metadata = { intent: 'Reusable documentation shell' };
  document.nodes.content.metadata = { intent: 'Markdown body insertion point' };
  document.css = 'article{max-width:70ch}img{max-width:100%}';
  const documents = new Map([['layout', { document, modelPath: path.join(divletDir, 'templates', 'layout.json'), htmlPath: path.join(divletDir, 'templates', 'layout.html') }]]);
  const config = { schemaVersion: 1, title: 'The manual', templateId: 'layout', contentDir: 'content', slots: { content: 'content', title: 'page-title', navigation: 'navigation' } };
  const write = async (relative, text) => {
    const file = path.join(divletDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
  };
  const readFile = async file => {
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new DivletError('UNSAFE_PATH', 'Symbolic links are not supported');
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new DivletError('INVALID_FILE', 'Invalid source file');
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const prepare = async input => {
    const document = validateDocument(input);
    return { document, html: encodeHtml(document) };
  };
  const build = previous => buildSite({ projectDir: divletDir, documents, readFile, prepare, previous, siteBase, assetBase });
  const saveConfig = () => write('site.json', JSON.stringify(config));
  await write('templates/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  return { cwd, divletDir, documents, document, config, write, build, saveConfig };
}

function textWithin(document, id = document.rootId) {
  const node = document.nodes[id];
  return node.type === 'text' ? node.content : node.children.map(child => textWithin(document, child)).join('');
}

function links(document) {
  return Object.values(document.nodes).filter(node => node.tag === 'a').map(node => node.attrs.href);
}

test('site is opt-in and removing its configuration disables the projection', async t => {
  const { build, saveConfig, write, divletDir } = await fixture(t);
  assert.equal(await build(), null);
  await saveConfig();
  await write('content/index.md', '# Home\n\nA working site.');
  const accepted = await build();
  assert.ok(accepted);
  await fs.rm(path.join(divletDir, 'site.json'));
  assert.equal(await build(accepted), null);
});

test('site CSS rewriting leaves source-map-looking comments and quoted values inert', async t => {
  const { build, saveConfig, write, document } = await fixture(t);
  await saveConfig(); await write('content/index.md', '# Native CSS');
  for (const { name, literal, comment } of cssAnnotationCases) {
    document.css = `article{content:${literal}}${comment}`;
    const before = structuredClone(document);
    const site = await build();
    assert.equal(site.pages.get('/').document.css, before.css, name);
    assert.deepEqual(document, before, 'rewriting a derived page must not author the template');
  }
});

test('one template composes a Markdown tree without mutating canonical sources', async t => {
  const { build, saveConfig, write, document, config, divletDir } = await fixture(t);
  config.viewport = { width: 390, height: 844 };
  await saveConfig();
  const sources = new Map([
    ['content/index.md', '---\ntitle: Welcome\ndescription: Read the manual\norder: -1\n---\n# Start here\n\n**One** shared template.'],
    ['content/guide/index.md', '# The guide\n\nChoose a chapter.'],
    ['content/guide/start.md', '---\ntitle: First steps\norder: 2\n---\n# Getting started\n\n- Read\n- Build'],
    ['content/draft.md', '---\ndraft: true\n---\n# Not public'],
  ]);
  for (const [file, source] of sources) await write(file, source);
  const before = structuredClone(document);
  const site = await build();
  assert.equal(site.version, 1);
  assert.equal(typeof site.fingerprint, 'string');
  assert.deepEqual(site.routes.map(route => route.path).sort(), ['/', '/guide/', '/guide/start/']);
  const home = site.routes.find(route => route.path === '/');
  assert.equal(home.title, 'Welcome');
  assert.equal(home.description, 'Read the manual');
  assert.equal(home.sourcePath, path.join(divletDir, 'content', 'index.md'));
  assert.equal(home.sourceRelative, 'index.md');
  const page = site.pages.get('/');
  assert.equal(page.document.id, home.documentId);
  assert.equal(page.document.artboard.width, 390);
  assert.equal(page.document.artboard.height, 844);
  assert.equal(textWithin(page.document, 'page-title'), 'Welcome');
  assert.match(textWithin(page.document, 'content'), /One shared template/);
  assert.match(textWithin(page.document, 'navigation'), /First steps/);
  assert.equal(textWithin(page.document, 'footer'), 'Shared footer');
  assert.equal(page.document.nodes['old-content'], undefined);
  assert.equal(page.document.nodes['old-title'], undefined);
  assert.equal(page.document.nodes['old-link'], undefined);
  assert.equal(page.document.nodes.content.metadata.intent, before.nodes.content.metadata.intent);
  assert.equal(page.document.metadata.intent, before.metadata.intent);
  assert.equal(page.document.metadata.divletSite.route, '/');
  for (const entry of site.pages.values()) assert.deepEqual(decodeHtml(entry.html), entry.document);
  assert.deepEqual(document, before);
  for (const [file, source] of sources) assert.equal(await fs.readFile(path.join(divletDir, file), 'utf8'), source);
  const guide = site.tree.find(entry => entry.name === 'guide');
  assert.equal(guide.path, '/guide/');
  assert.equal(guide.title, 'The guide');
  assert.ok(guide.children.some(entry => entry.path === '/guide/start/' && entry.title === 'First steps'));
  assert.ok(!JSON.stringify(site.tree).includes('draft.md'));
});

test('unchanged sources reuse a snapshot; Markdown and template edits each advance site version', async t => {
  const { build, saveConfig, write, documents } = await fixture(t);
  await saveConfig();
  await write('content/index.md', '# Original\n\nFirst body.');
  const first = await build();
  assert.equal(await build(first), first);
  const templateVersion = documents.get('layout').document.version;
  await write('content/index.md', '# Updated\n\nSecond body.');
  const second = await build(first);
  assert.equal(second.version, first.version + 1);
  assert.equal(second.pages.get('/').document.id, first.pages.get('/').document.id);
  assert.match(textWithin(second.pages.get('/').document, 'content'), /Second body/);
  assert.equal(documents.get('layout').document.version, templateVersion);
  assert.match(textWithin(first.pages.get('/').document, 'content'), /First body/);
  documents.get('layout').document.css += '\nfooter{color:red}';
  documents.get('layout').document.version++;
  const third = await build(second);
  assert.equal(third.version, second.version + 1);
  assert.match(third.pages.get('/').document.css, /footer\{color:red\}/);
});

test('nested Markdown links and images resolve from their own sources; template assets retain template origin', async t => {
  const { build, saveConfig, write } = await fixture(t);
  await saveConfig();
  await write('content/index.md', '# Home');
  await write('content/guide/index.md', '# Guide');
  await write('content/guide/start.md', '# Start\n\n[Home](../index.md#overview) · [Guide](index.md?from=start#chapters) · [Root route](/guide/) · [External](https://example.com/reference)\n\n![Sketch](./images/sketch.svg)');
  await write('content/guide/images/sketch.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const site = await build();
  const page = site.pages.get('/guide/start/').document;
  const hrefs = links(page);
  assert.ok(hrefs.includes(siteBase + '#overview'));
  assert.ok(hrefs.includes(siteBase + 'guide/?from=start#chapters'));
  assert.ok(hrefs.includes(siteBase + 'guide/'));
  assert.ok(hrefs.includes('https://example.com/reference'));
  const images = Object.values(page.nodes).filter(node => node.tag === 'img').map(node => node.attrs.src);
  assert.ok(images.includes(assetBase + 'templates/logo.svg'));
  assert.ok(images.includes(assetBase + 'content/guide/images/sketch.svg'));
});

test('route deletion produces a new complete snapshot and removes its navigation entry', async t => {
  const { build, saveConfig, write, divletDir } = await fixture(t);
  await saveConfig();
  await write('content/index.md', '# Home');
  await write('content/chapter.md', '# A chapter');
  const first = await build();
  await fs.rm(path.join(divletDir, 'content', 'chapter.md'));
  const second = await build(first);
  assert.deepEqual(second.routes.map(route => route.path), ['/']);
  assert.equal(second.pages.has('/chapter/'), false);
  assert.ok(!textWithin(second.pages.get('/').document, 'navigation').includes('A chapter'));
  assert.equal(first.pages.has('/chapter/'), true);
});

test('two files cannot claim the same normalized route', async t => {
  const { build, saveConfig, write } = await fixture(t);
  await saveConfig();
  await write('content/index.md', '# Home');
  await write('content/guide.md', '# Guide file');
  await write('content/guide/index.md', '# Guide index');
  await assert.rejects(build(), DivletError);
});

test('slots must reference distinct non-overlapping existing element nodes', async t => {
  const { build, saveConfig, write, config } = await fixture(t);
  await write('content/index.md', '# Home');
  for (const slots of [
    { content: 'missing' },
    { content: 'content', title: 'content' },
    { content: 'layout', title: 'page-title' },
  ]) {
    config.slots = slots;
    await saveConfig();
    await assert.rejects(build(), DivletError, JSON.stringify(slots));
  }
});

test('raw Markdown HTML and executable links are rejected before publication', async t => {
  const { build, saveConfig, write } = await fixture(t);
  await saveConfig();
  await write('content/index.md', '# Accepted');
  const first = await build();
  for (const source of ['# Raw HTML\n\n<script>alert(1)</script>', '# Unsafe\n\n[Click](javascript:alert%281%29)']) {
    await write('content/index.md', source);
    await assert.rejects(build(first), DivletError);
    assert.match(textWithin(first.pages.get('/').document, 'content'), /Accepted/);
  }
});

test('content directory and Markdown sources cannot escape through paths or symbolic links', async t => {
  const { build, saveConfig, write, config, cwd, divletDir } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'outside.md'), '# Outside');
  config.contentDir = '../';
  await saveConfig();
  await assert.rejects(build(), DivletError);
  config.contentDir = 'content';
  await saveConfig();
  await write('content/index.md', '# Safe');
  await fs.symlink(path.join(cwd, 'outside.md'), path.join(divletDir, 'content', 'linked.md'));
  await assert.rejects(build(), DivletError);
});

test('unused slot placeholders do not introduce links into the generated page', async t => {
  const { build, saveConfig, write, document } = await fixture(t);
  await saveConfig();
  await write('content/index.md', '# Actual content');
  document.nodes['old-link'].attrs.href = './unpublished-placeholder.md';
  const site = await build();
  assert.match(textWithin(site.pages.get('/').document, 'content'), /Actual content/);
  assert.equal(site.pages.get('/').document.nodes['old-link'], undefined);
});

test('template CSS, inline URLs and srcset retain their own asset base', async t => {
  const { build, saveConfig, write, document } = await fixture(t);
  await saveConfig();
  await write('content/index.md', '# Home');
  document.css += '\nheader{background-image:url("./logo.svg")}';
  document.nodes.logo.style['background-image'] = "url('./logo.svg')";
  document.nodes.logo.attrs.srcset = './logo.svg 1x, https://example.com/logo.svg 2x';
  const page = (await build()).pages.get('/').document;
  assert.ok(page.css.includes(assetBase + 'templates/logo.svg'));
  assert.ok(page.nodes.logo.style['background-image'].includes(assetBase + 'templates/logo.svg'));
  assert.equal(page.nodes.logo.attrs.srcset, assetBase + 'templates/logo.svg 1x, https://example.com/logo.svg 2x');
});

test('route path segments are canonically encoded and heading anchors are deterministic', async t => {
  const { build, saveConfig, write } = await fixture(t);
  await saveConfig();
  await write('content/space page.md', '# Repeated title\n\n## Repeated title');
  const site = await build();
  assert.equal(site.routes[0].path, '/space%20page/');
  const headings = Object.values(site.pages.get('/space%20page/').document.nodes).filter(node => /^h[1-6]$/.test(node.tag ?? '') && node.id !== 'page-title');
  assert.deepEqual(headings.map(node => node.attrs.id), ['repeated-title', 'repeated-title-2']);
});
