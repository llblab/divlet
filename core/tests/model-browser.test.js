import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as model from '../lib/model.ts';
import { encodeHtml, decodeHtml } from '../lib/codec.ts';
import { setStyleEngines, styleEngine } from '../lib/engine.ts';
import { captureFrame, frameCases, sampleFrame, sourceMapCss } from './fixtures/frame-portability.js';

for (const { name, run, error } of frameCases) test(`shared frame semantics: ${name}`, () => {
  const result = captureFrame(model, run);
  assert.equal(result.ok, !error, JSON.stringify(result));
  if (error) { assert.equal(result.code, error); assert.equal(result.domainError, true); }
});

test('CSS admission never interprets source-map payloads', () => {
  assert.equal(model.validateCss(sourceMapCss), sourceMapCss);
  const frame = model.validateDocument({ ...sampleFrame(), css: sourceMapCss });
  assert.deepEqual(decodeHtml(encodeHtml(frame)), frame, 'inert annotations retain the strict native HTML round trip');
  const token = 'red /*# sourceMappingURL=data:application/json;unsupported,anything */';
  assert.equal(model.validateTokens({ '--brand': token })['--brand'], 'red ');
});

test('missing browser lowering matches the existing no-engine Node refusal', () => {
  const saved = styleEngine();
  try {
    setStyleEngines([]);
    assert.throws(() => model.applyDocumentPatch(sampleFrame(), { nodes: { root: { styles: { color: 'red' } } } }), {
      name: 'Error', code: 'NO_STYLE_ENGINE', message: 'No style engine is installed, so applyStyles is unavailable (the project still renders with its own CSS).',
    });
  } finally { setStyleEngines([saved]); }
});

test('cold public source model entry keeps its Node provider without package-source conditions or a build', () => {
  const file = new URL('../model.ts', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const api = await import(${JSON.stringify(file)});
    const base = api.createDemoDocument();
    const next = api.applyDocumentPatch(base, { nodes: { root: { styles: { 'padding-top': '12px' } } } });
    assert.notEqual(next.nodes.root.className, base.nodes.root.className);
  `], { env: { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS || '').replace(/--conditions=divlet-source\b/g, '') }, timeout: 10000, stdio: 'pipe' });
});
