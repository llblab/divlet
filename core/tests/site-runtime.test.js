import test from 'node:test';
import { legacyProject } from './fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntime } from '@divlet/core/runtime';
import { decodeHtml } from '../lib/codec.ts';

async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-site-runtime-'));
  await legacyProject(path.join(cwd, 'project.divlet'));
  const runtime = await openRuntime({ cwd, watch: false, createDemo: false });
  t.after(async () => { await runtime.close(); await fs.rm(cwd, { recursive: true, force: true }); });
  const divletDir = runtime.projectDir;
  const write = async (relative, source) => {
    const file = path.join(divletDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source);
    return file;
  };
  const template = decodeHtml('<main id="layout" class="p-4"><h1 id="page-title">Placeholder title</h1><nav id="navigation"></nav><article id="content"><p>Placeholder content</p></article><footer id="footer">Shared footer</footer></main>', { fallbackId: 'layout' });
  template.metadata = { intent: 'Canonical reusable site template' };
  await runtime.create({ document: template });
  const config = { schemaVersion: 1, title: 'Runtime manual', templateId: 'layout', contentDir: 'content', slots: { content: 'content', title: 'page-title', navigation: 'navigation' } };
  await write('site.json', JSON.stringify(config));
  await write('content/index.md', '# Welcome\n\nHome body.');
  await write('content/guide/start.md', '# Getting started\n\nGuide body.');
  await runtime.scan();
  assert.ok(runtime.siteInfo(), JSON.stringify(runtime.info().diagnostics));
  return { cwd, divletDir, runtime, write, config, template };
}

function textWithin(document, id = document.rootId) {
  const node = document.nodes[id];
  return node.type === 'text' ? node.content : node.children.map(child => textWithin(document, child)).join('');
}

async function componentFixture(t) {
  const setup = await fixture(t);
  const { runtime } = setup;
  await runtime.create({ document: {
    schemaVersion: 1, id: 'components', name: 'Components', version: 1,
    artboard: { x: 1000, y: 0, width: 400, height: 300 }, rootId: 'root',
    nodes: {
      root: { id: 'root', type: 'element', tag: 'main', children: ['brand', 'wrapper', 'unused'] },
      brand: { id: 'brand', type: 'element', tag: 'footer', reusable: true, children: ['brand-text'] },
      'brand-text': { id: 'brand-text', type: 'text', content: 'Initial component brand' },
      wrapper: { id: 'wrapper', type: 'element', tag: 'section', reusable: true, children: ['nested'] },
      nested: { id: 'nested', type: 'ref', ref: 'brand' },
      unused: { id: 'unused', type: 'element', tag: 'aside', reusable: true, children: [] },
    },
  } });
  await runtime.edit({ documentId: 'layout', expectedVersion: 1, op: { type: 'insert', parentId: 'footer', spec: { ref: 'components/wrapper' } } });
  return setup;
}

test('site snapshots follow transitive components and shared theme without changing template source', async t => {
  const { runtime } = await componentFixture(t);
  const template = runtime.read({ view: 'frame', documentId: 'layout' });
  const changes = [
    { apply: () => runtime.patch({ documentId: 'components', expectedVersion: 1, patch: { nodes: { 'brand-text': { content: 'Updated nested brand' } } } }), expected: /Updated nested brand/ },
    { apply: () => runtime.patch({ documentId: 'components', expectedVersion: 2, patch: { nodes: { wrapper: { className: 'p-7' } } } }), expected: /class="p-7"/ },
    { apply: () => runtime.patchProject({ expectedVersion: 1, patch: { css: 'footer{color:rgb(1,2,3)}' } }), expected: /footer\{color:rgb\(1,2,3\)\}/ },
    { apply: () => runtime.patchProject({ expectedVersion: 2, patch: { tokens: { '--color-site': '#123456' } } }), expected: /--color-site:#123456/ },
  ];
  for (const change of changes) {
    const version = runtime.siteInfo().version;
    await change.apply();
    assert.equal(runtime.siteInfo().version, version + 1);
    assert.deepEqual(runtime.read({ view: 'frame', documentId: 'layout' }), template);
    for (const route of ['/', '/guide/start/']) assert.match(runtime.renderSite(route).html, change.expected);
    await runtime.scan();
    assert.equal(runtime.siteInfo().version, version + 1, 'unchanged scans reuse the new snapshot');
  }
});

test('unrelated component and project-name edits do not invalidate site snapshots', async t => {
  const { runtime } = await componentFixture(t);
  const accepted = runtime.site;
  await runtime.patch({ documentId: 'components', expectedVersion: 1, patch: { nodes: { unused: { className: 'p-9' } } } });
  await runtime.patchProject({ expectedVersion: 1, patch: { name: 'Renamed project' } });
  await runtime.scan();
  assert.equal(runtime.site, accepted);
});

test('invalid component edits preserve the entire accepted routed snapshot', async t => {
  const { runtime } = await componentFixture(t);
  const accepted = runtime.site;
  const renders = ['/', '/guide/start/'].map(route => runtime.renderSite(route));
  await assert.rejects(runtime.patch({ documentId: 'components', expectedVersion: 1, patch: { nodes: { brand: { reusable: null } } } }), { code: 'INVALID_REF' });
  await runtime.scan();
  assert.equal(runtime.site, accepted);
  assert.deepEqual(['/', '/guide/start/'].map(route => runtime.renderSite(route)), renders);
});

test('real runtime uses canonical route redirects and returns 404 for missing paths', async t => {
  const { runtime } = await fixture(t);
  const response = await fetch(runtime.url + 'site/guide/start?mode=preview', { redirect: 'manual' });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), new URL(runtime.url).pathname + 'site/guide/start/?mode=preview');
  assert.equal((await fetch(runtime.url + 'site/guide/start/')).status, 200);
  assert.equal((await fetch(runtime.url + 'site/missing', { redirect: 'manual' })).status, 404);
});

test('Markdown changes advance site state without changing or duplicating the template', async t => {
  const { runtime, divletDir, write } = await fixture(t);
  const templateBefore = runtime.read({ view: 'document', documentId: 'layout' });
  const siteBefore = runtime.read({ view: 'site' });
  const pageBefore = runtime.read({ view: 'site', route: '/guide/start/' });
  const revisionBefore = runtime.revision;
  await runtime.scan();
  assert.equal(runtime.siteInfo().version, siteBefore.version);
  assert.equal(runtime.revision, revisionBefore);

  const source = '# Updated chapter\n\nNew Markdown body.';
  await write('content/guide/start.md', source);
  await runtime.scan();
  const siteAfter = runtime.info().site;
  const pageAfter = runtime.read({ view: 'site', route: '/guide/start/' });
  assert.ok(siteAfter.version > siteBefore.version);
  assert.ok(runtime.revision > revisionBefore);
  assert.equal(pageAfter.document.id, pageBefore.document.id);
  assert.match(textWithin(pageAfter.document, 'content'), /New Markdown body/);
  assert.match(textWithin(runtime.read({ view: 'site', route: '/' }).document, 'navigation'), /Updated chapter/);
  assert.deepEqual(runtime.read({ view: 'document', documentId: 'layout' }), templateBefore);
  assert.deepEqual(runtime.info().documents.map(document => document.id), ['layout']);
  assert.equal(await fs.readFile(path.join(divletDir, 'content/guide/start.md'), 'utf8'), source);
  const persistedDocuments = (await fs.readdir(divletDir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile() && /\.(?:divlet|html|meta\.json)$/.test(entry.name)).map(entry => path.relative(divletDir, path.join(entry.parentPath, entry.name))).sort();
  assert.deepEqual(persistedDocuments, ['guide/start/index.html', 'guide/start/index.meta.json', 'index.html', 'index.meta.json', 'layout.html', 'layout.meta.json'].map(file => path.join('.divlet', 'project', file)).concat('project.divlet'));
  assert.ok(siteAfter.url.startsWith(runtime.url + 'site/'));
  assert.deepEqual(siteAfter.routes.map(route => route.path).sort(), ['/', '/guide/start/']);
});

test('template tool patches rebuild every route immediately and composed documents are read-only', async t => {
  const { runtime, template } = await fixture(t);
  const previousSiteVersion = runtime.siteInfo().version;
  const footerTextId = template.nodes.footer.children[0];
  const result = await runtime.patch({ documentId: 'layout', expectedVersion: template.version, patch: { nodes: { [footerTextId]: { content: 'New shared footer' } } } });
  assert.equal(result.version, template.version + 1);
  assert.ok(runtime.siteInfo().version > previousSiteVersion);
  for (const route of ['/', '/guide/start/']) {
    const page = runtime.read({ view: 'site', route });
    assert.equal(textWithin(page.document, 'footer'), 'New shared footer');
    assert.match(runtime.renderSite(route).html, /New shared footer/);
    assert.equal(runtime.renderSite(route).version, runtime.siteInfo().version);
    await assert.rejects(runtime.patch({ documentId: page.document.id, expectedVersion: page.document.version, patch: { name: 'A detached copy' } }), { code: 'NOT_FOUND' });
  }
  assert.equal(textWithin(runtime.read({ view: 'document', documentId: 'layout' }), 'content'), 'Placeholder content');
});

test('invalid content or config retains the complete accepted site until recovery', async t => {
  const { runtime, divletDir, write, config } = await fixture(t);
  const accepted = runtime.read({ view: 'site' });
  const acceptedRenders = ['/', '/guide/start/'].map(route => runtime.renderSite(route));
  await write('content/index.md', '# A valid pending update');
  await write('content/guide/start.md', '# Broken page\n\n<script>alert(1)</script>');
  await runtime.scan();
  assert.deepEqual(runtime.read({ view: 'site' }), accepted);
  assert.deepEqual(['/', '/guide/start/'].map(route => runtime.renderSite(route)), acceptedRenders);
  assert.ok(runtime.info().diagnostics.some(item => item.path === path.join(divletDir, 'site.json')));

  await write('content/guide/start.md', '# Recovered page\n\nA clean body.');
  await runtime.scan();
  assert.ok(runtime.siteInfo().version > accepted.version);
  assert.match(textWithin(runtime.read({ view: 'site', route: '/' }).document, 'content'), /A valid pending update/);
  assert.ok(!runtime.info().diagnostics.some(item => item.path === path.join(divletDir, 'site.json')));
  const recovered = runtime.read({ view: 'site' });
  await write('site.json', JSON.stringify({ ...config, slots: { content: 'missing-node' } }));
  await runtime.scan();
  assert.deepEqual(runtime.read({ view: 'site' }), recovered);
  assert.ok(runtime.info().diagnostics.some(item => item.path === path.join(divletDir, 'site.json')));
  await write('site.json', JSON.stringify(config));
  await runtime.scan();
  assert.deepEqual(runtime.read({ view: 'site' }), recovered);
  assert.equal(runtime.info().diagnostics.length, 0);
});

test('deleting routes removes their navigation and deleting config disables the site', async t => {
  const { runtime, divletDir, write, config } = await fixture(t);
  const firstVersion = runtime.siteInfo().version;
  await fs.rm(path.join(divletDir, 'content/guide/start.md'));
  await runtime.scan();
  const afterDeletion = runtime.siteInfo();
  assert.ok(afterDeletion.version > firstVersion);
  assert.deepEqual(afterDeletion.routes.map(route => route.path), ['/']);
  assert.throws(() => runtime.renderSite('/guide/start/'), { code: 'NOT_FOUND' });
  assert.doesNotMatch(textWithin(runtime.read({ view: 'site', route: '/' }).document, 'navigation'), /Getting started/);
  await fs.rm(path.join(divletDir, 'site.json'));
  await runtime.scan();
  assert.equal(runtime.read({ view: 'site' }), null);
  assert.equal(runtime.info().site, null);
  assert.throws(() => runtime.renderSite('/'), { code: 'NOT_FOUND' });
  assert.equal(runtime.info().documents.length, 1);
  await write('site.json', JSON.stringify(config));
  await runtime.scan();
  assert.ok(runtime.siteInfo().version > afterDeletion.version);
  assert.equal(runtime.read({ view: 'site', route: '/' }).document.version, runtime.siteInfo().version);
  assert.equal(decodeHtml(runtime.renderSite('/').html).version, runtime.siteInfo().version);
});

test('unaccepted template edits cannot leak into composed pages', async t => {
  const { runtime, write } = await fixture(t);
  const entry = runtime.info().documents.find(document => document.id === 'layout');
  const acceptedTemplate = runtime.read({ view: 'document', documentId: 'layout' });
  const project = JSON.parse(await fs.readFile(runtime.projectPath, 'utf8'));
  const template = project.frames.find(frame => frame.id === 'layout');
  template.nodes[template.nodes.footer.children[0]].content = 'Unaccepted project footer';
  template.nodes.footer.children.push('missing-node');
  const acceptedHtml = await fs.readFile(entry.htmlPath, 'utf8');
  const editedHtml = acceptedHtml.replace('Shared footer', 'Unaccepted HTML footer');
  await fs.writeFile(runtime.projectPath, JSON.stringify(project));
  await fs.writeFile(entry.htmlPath, editedHtml);
  await write('content/index.md', '# Accepted content update');
  await runtime.scan();
  assert.deepEqual(runtime.read({ view: 'document', documentId: 'layout' }), acceptedTemplate);
  assert.ok(runtime.info().diagnostics.some(item => item.path === runtime.projectPath));
  const page = runtime.read({ view: 'site', route: '/' }).document;
  assert.equal(textWithin(page, 'footer'), 'Shared footer');
  assert.match(textWithin(page, 'content'), /Accepted content update/);
  assert.doesNotMatch(runtime.renderSite('/').html, /Unaccepted (?:project|HTML) footer/);
  await assert.rejects(runtime.patch({ documentId: 'layout', expectedVersion: acceptedTemplate.version, patch: { name: 'Overwrite pending edit' } }), { code: 'EXTERNAL_PENDING' });
  assert.equal(await fs.readFile(entry.htmlPath, 'utf8'), editedHtml);
});
