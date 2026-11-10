import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoDocument, validateDocument, applyDocumentPatch, DivletError } from '../lib/model.ts';
import { encodeHtml, decodeHtml, renderFile } from '../lib/codec.ts';
import { operationPatch } from '../lib/ops.ts';

test('Generated HTML roundtrips the canonical document exactly, including metadata and text identities', () => {
  const doc = createDemoDocument();
  doc.metadata.reference = '</script><script>not executed</script>';
  doc.nodes['title-text'].metadata.intent = 'Keep & < > " and Unicode: Привет';
  doc.nodes['title-text'].content = '<Hello> & "world"\nПривет';
  const html = encodeHtml(doc, { compiledCss: '.generated { color: red; }' });
  assert.deepEqual(decodeHtml(html), doc);
  assert.match(html, /data-divlet-id="root"/);
  assert.match(html, /<!--divlet:text:title-text-->/);
  assert.ok(!html.includes('</script><script>not executed'));
  assert.equal(decodeHtml(html).css, '');
});

test('Actual edited HTML wins over metadata: content, classes, inline CSS, token and authored CSS', () => {
  const doc = createDemoDocument();
  const html = encodeHtml(doc)
    .replace('Start exploring  ↗', 'Ship an idea')
    .replace(/class="text-lg font-semibold tracking-tight[^"]*"/, 'class="text-2xl font-bold"')
    .replace('--accent:#d7b474;', '--accent:#ff6600;')
    .replace('<style data-divlet-custom></style>', '<style data-divlet-custom>main{letter-spacing:0.1px}</style>')
    .replace('style="white-space:pre-line"', 'style="white-space:pre-line;color:red"');
  const changed = decodeHtml(html);
  assert.equal(changed.nodes['cta-text'].content, 'Ship an idea');
  assert.equal(changed.nodes.brand.className, 'text-2xl font-bold');
  assert.equal(changed.tokens['--accent'], '#ff6600');
  assert.equal(changed.nodes.title.style.color, 'red');
  assert.equal(changed.nodes.cta.metadata.purpose, 'primary-action');
  assert.equal(changed.css, 'main{letter-spacing:0.1px}');
  assert.deepEqual(decodeHtml(encodeHtml(changed)), changed);
});

test('Previous model preserves design metadata when source HTML omits its metadata script', () => {
  const doc = createDemoDocument();
  const html = encodeHtml(doc).replace(/<script id="divlet-metadata" type="application\/json">.*?<\/script>/s, '').replace('Start exploring  ↗', 'Edited without metadata');
  const imported = decodeHtml(html, { previous: doc });
  assert.equal(imported.id, doc.id);
  assert.deepEqual(imported.metadata, doc.metadata);
  assert.deepEqual(imported.nodes.cta.metadata, doc.nodes.cta.metadata);
  assert.equal(imported.nodes['cta-text'].content, 'Edited without metadata');
});

test('Ordinary static fragments import as native DOM nodes, preserving mixed content and SVG', () => {
  const doc = decodeHtml('<main id="page" class="p-8"><p>Hello <strong>world</strong>!</p><svg viewBox="0 0 20 20"><path d="M0 0h20v20z"/></svg><input disabled></main>', { fallbackId: 'landing' });
  assert.equal(doc.id, 'landing');
  assert.equal(doc.rootId, 'page');
  assert.equal(doc.nodes.page.className, 'p-8');
  assert.ok(Object.values(doc.nodes).some(node => node.tag === 'svg' && node.attrs.viewBox === '0 0 20 20'));
  assert.ok(Object.values(doc.nodes).some(node => node.tag === 'input' && node.attrs.disabled === ''));
  assert.deepEqual(decodeHtml(encodeHtml(doc)), doc);
});

test('SVG Gaussian blur definitions preserve tag/attribute case and filter references on round trip', () => {
  const doc = decodeHtml('<svg viewBox="0 0 100 100"><defs><filter id="soften" x="-20%" width="140%"><feGaussianBlur in="SourceGraphic" stdDeviation="2 3" edgeMode="duplicate" result="blurred"/></filter></defs><rect width="100" height="100" filter="url(#soften)"/></svg>');
  const filter = Object.values(doc.nodes).find(node => node.tag === 'filter');
  const blur = Object.values(doc.nodes).find(node => node.tag === 'feGaussianBlur');
  assert.equal(filter.attrs.id, 'soften');
  assert.equal(blur.attrs.stdDeviation, '2 3');
  assert.equal(blur.attrs.edgeMode, 'duplicate');
  assert.equal(blur.attrs.in, 'SourceGraphic');
  assert.deepEqual(decodeHtml(encodeHtml(doc)), doc);
  assert.match(renderFile(doc), /<feGaussianBlur\b[^>]*stdDeviation="2 3"/);
  assert.match(renderFile(doc), /filter="url\(#soften\)"/);
});

test('pasted SVG blur definitions keep DOM IDs needed by local filter references', () => {
  const base = decodeHtml('<main id="host"></main>');
  const op = { type: 'insert', parentId: base.rootId, html: '<svg><defs><filter id="paste-blur"><feGaussianBlur stdDeviation="4"/></filter></defs><circle r="20" filter="url(#paste-blur)"/></svg>' };
  const doc = applyDocumentPatch(base, operationPatch(base, op).patch);
  const filter = Object.values(doc.nodes).find(node => node.tag === 'filter');
  assert.equal(filter.attrs.id, 'paste-blur');
  assert.match(renderFile(doc), /id="paste-blur"/);
  assert.deepEqual(decodeHtml(encodeHtml(doc)), doc);
});

test('Empty text, textarea content, inline escaping and canonical line endings roundtrip', () => {
  let doc = decodeHtml('<section><textarea placeholder="Say &quot;hello&quot;">Text &amp; more</textarea><span></span></section>');
  const textarea = Object.values(doc.nodes).find(node => node.tag === 'textarea');
  doc.nodes[textarea.children[0]].content = '\nA\r\nB';
  const span = Object.values(doc.nodes).find(node => node.tag === 'span');
  span.children = ['empty'];
  doc.nodes.empty = { id: 'empty', type: 'text', content: '', metadata: { note: 'A deliberate empty text node' } };
  doc = validateDocument(doc);
  assert.deepEqual(decodeHtml(encodeHtml(doc)), doc);
});

test('Malformed or repaired HTML and damaged identity markers are rejected', () => {
  const invalid = [
    '<div><span>broken',
    '<div a="one" a="two"></div>',
    '<div></span></div>',
    '<div>before</span>after</div>',
    '<br></br>',
    '<div><p>One<div>Two</div></p></div>',
    '<div data-divlet-id="same"><span data-divlet-id="same"></span></div>',
    '<div><!--divlet:text:label-->Text</div>',
    '<div><!--divlet:text:label--><span></span><!--/divlet:text:label--></div>',
    '<div><!--unsupported comment--></div>'
  ];
  for (const html of invalid) assert.throws(() => decodeHtml(html), DivletError, html);
});

test('Unsupported executable and lossy HTML constructs fail explicitly', () => {
  const invalid = [
    '<div><script>alert(1)</script></div>',
    '<script>alert(1)</script><div></div>',
    '<div onclick="evil()"></div>',
    '<a href="javascript:evil()">link</a>',
    '<iframe src="https://example.test"></iframe>',
    '<link rel="stylesheet" href="theme.css"><main></main>',
    '<html lang="ru"><head></head><body><main></main></body></html>',
    '<body class="bg-red-500"><main></main></body>',
    '<style media="print">main{color:red}</style><main></main>',
    '<main style="color:red;color:blue"></main>',
    '<main style="color:red}body{display:none"></main>'
  ];
  for (const html of invalid) assert.throws(() => decodeHtml(html), DivletError, html);
});

test('Quoted markup in legitimate raw text and attributes does not cause false syntax rejection', () => {
  const doc = decodeHtml('<style>.a{content:"</div>"}</style><main title="</span>">Fine &lt;tag&gt;</main>');
  assert.equal(doc.nodes[doc.rootId].attrs.title, '</span>');
  assert.equal(doc.css, '.a{content:"</div>"}');
  assert.deepEqual(decodeHtml(encodeHtml(doc)), doc);
});

test('randomized structural edits survive the HTML round trip', async () => {
  const { applyDocumentPatch, createDemoDocument } = await import('../lib/model.ts');
  const { operationPatch, PRESET_NAMES } = await import('../lib/ops.ts');
  const { decodeHtml, encodeHtml } = await import('../lib/codec.ts');
  let seed = 7;
  const random = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const words = ['plain', 'a < b & c > d', 'quote " and \' marks', '  leading\n\ttabs  ', 'emoji ✦ 日本語', '<!-- not a comment -->', ''];
  let doc = createDemoDocument();
  for (let step = 0; step < 120; step++) {
    const ids = Object.keys(doc.nodes);
    const elements = ids.filter(id => doc.nodes[id].type === 'element');
    const pick = list => list[random(list.length)];
    let op;
    try {
      switch (random(5)) {
        case 0: op = { type: 'insert', parentId: pick(elements), index: random(4), spec: pick(PRESET_NAMES) }; break;
        case 1: op = { type: 'duplicate', id: pick(ids.filter(id => id !== doc.rootId)) }; break;
        case 2: op = { type: 'move', id: pick(ids.filter(id => id !== doc.rootId)), parentId: pick(elements), index: random(4) }; break;
        case 3: op = { type: 'remove', ids: [pick(ids.filter(id => id !== doc.rootId))] }; break;
        default: op = { type: 'text', id: pick(ids.filter(id => doc.nodes[id].type === 'text')), content: pick(words) };
      }
      doc = applyDocumentPatch(doc, operationPatch(doc, op).patch);
    } catch { continue; }
    const decoded = decodeHtml(encodeHtml(doc), { previous: doc });
    assert.deepEqual({ ...decoded, version: 0 }, { ...doc, version: 0 }, `step ${step}: ${JSON.stringify(op)}`);
  }
});
