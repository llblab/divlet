import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHtml, encodeHtml, htmlToSpecs } from '../lib/codec.ts';
import { decodePage } from '../lib/html-import.ts';
import { validateDocument, DivletError } from '../lib/model.ts';
import { prepareFrameWith } from '../lib/prepare.ts';
import { captureFontCSS } from '../lib/capture.ts';
import { fontFaceRules } from '../lib/font-css.ts';
import { readFont } from '../lib/font.ts';
import { fontBytes } from './fixtures/font.js';
import { cssAnnotationCases } from './fixtures/css-annotations.js';

const compiler = { compile: () => '', unknown: () => ({}) };
for (const { name, comment, literal, html } of cssAnnotationCases) {
  test(`codec CSS annotations stay inert: ${name}`, () => {
    const decoded = decodeHtml(html);
    assert.equal(decoded.nodes[decoded.rootId].style.content, literal);
    assert.equal(htmlToSpecs(html)[0].style.content, literal, 'paste must not silently drop a valid declaration');
    const admitted = decodePage(html).document;
    assert.equal(admitted.nodes[admitted.rootId].style.content, literal);
    const frame = validateDocument({ ...decoded, tokens: { '--note': literal }, css: `.note{content:${literal}}${comment}` });
    assert.deepEqual(decodeHtml(encodeHtml(frame)), frame, 'tokens, quoted values and authored comments roundtrip exactly');
    // Inertness is not new comment admission inside strict declaration-only carriers.
    for (const source of [`<main style='color:red;${comment}'></main>`, `<style data-divlet-tokens>:root{--note:red;${comment}}</style><main></main>`]) {
      assert.throws(() => decodeHtml(source), error => error instanceof DivletError && error.code === 'INVALID_HTML');
    }
  });

  test(`native CSS analysis does not interpret map metadata: ${name}`, async () => {
    const frame = validateDocument({ ...decodeHtml('<main></main>'), css: `.note{content:${literal}}${comment}` });
    const before = structuredClone(frame);
    const prepared = await prepareFrameWith(frame, { compiler });
    assert.equal(prepared.document.css, frame.css);
    assert.deepEqual(frame, before);
    const css = `@font-face{font-family:${literal};src:local(Fallback)}`;
    const captured = await captureFontCSS(`<style>${css}</style>`, {});
    assert.equal(captured, css, 'both font extraction and final capture parsing preserve the literal');
    const added = fontFaceRules(readFont(fontBytes()), 'asset:fonts/new.ttf', {
      files: new Map(), mediaTypes: new Map(), generated: new Set(), authored: [css + comment],
    });
    assert.match(added, /@font-face/);
    assert.match(added, /asset:fonts\/new.ttf/);
    // Parser-side inertness never relaxes the existing CSS grammar/directive refusals.
    await assert.rejects(prepareFrameWith({ ...frame, css: '@import "other.css"' }, { compiler }), { code: 'UNSUPPORTED_CSS' });
  });
}
