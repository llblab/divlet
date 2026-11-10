import test from 'node:test';
import assert from 'node:assert/strict';
import { convertHtml, decodePage, summarizeHtml } from '../lib/convert.js';

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
