import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHtml, encodeHtml } from '../lib/codec.ts';
import { applyDocumentPatch, validateDocument } from '../lib/model.ts';

const css = `
.shell{width:min(calc(100% - 32px),960px);margin-inline:auto;container-type:inline-size}
.grid{display:grid;grid-template-columns:repeat(1,minmax(0,1fr));gap:16px}
.fluid{width:clamp(120px,50vw,420px);max-width:100%;min-width:0}
@media(min-width:768px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(min-width:1100px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@container(min-width:700px){.card{padding:24px}}
`;

function fixture() {
  const document = decodeHtml(`<style>${css}</style><main id="shell" class="shell"><section id="cards" class="grid grid-cols-1 md:grid-cols-2 min-[1100px]:grid-cols-3"><article class="card">First</article><article class="card">Second</article><article class="card">Third</article></section><div class="fluid">Fluid</div></main>`, { fallbackId: 'responsive' });
  document.metadata = { intent: 'One layout responds to its viewport and container widths', viewportExamples: [390, 768, 1200] };
  document.nodes.cards.metadata = { intent: 'Preserve the responsive rules, not a measured fixed column count' };
  return validateDocument(document);
}

test('responsive CSS, container queries and Tailwind variants survive semantic round trips', () => {
  const document = fixture();
  assert.deepEqual(decodeHtml(encodeHtml(document)), document);
  const resized = applyDocumentPatch(document, { artboard: { width: 390 } });
  assert.equal(resized.artboard.width, 390);
  assert.deepEqual(resized.nodes, document.nodes);
  assert.equal(resized.css, document.css);
  assert.deepEqual(resized.metadata, document.metadata);
  assert.deepEqual(decodeHtml(encodeHtml(resized)), resized);
});

test('edited responsive rules are decoded from actual HTML instead of retained stale metadata', () => {
  const document = fixture();
  const editedHtml = encodeHtml(document)
    .replace('@media(min-width:768px)', '@media(min-width:900px)')
    .replace('width:clamp(120px,50vw,420px)', 'width:clamp(140px,60vw,480px)');
  const changed = decodeHtml(editedHtml);
  assert.match(changed.css, /@media\(min-width:900px\)/);
  assert.match(changed.css, /clamp\(140px,60vw,480px\)/);
  assert.deepEqual(changed.metadata, document.metadata);
  assert.deepEqual(changed.nodes.cards.metadata, document.nodes.cards.metadata);
  assert.deepEqual(decodeHtml(encodeHtml(changed)), changed);
});
