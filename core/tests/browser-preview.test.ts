import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewDocument, previewBridgeScript } from '../lib/browser-preview.ts';
import * as board from '../lib/browser-board.ts';

const html = '<!doctype html><html><head lang="en"></head><body><main>Prepared</main></body>\n</html>';
const token = '12345678-1234-1234-1234-123456789012';

test('preview envelope preserves its restricted CSP and exact prepared body', () => {
  const result = previewDocument(html, 'closed', 3, token, 'https://example.test/bridge.js');
  const csp = "default-src 'none'; img-src data: https: blob:; media-src data: https:; style-src 'unsafe-inline'; font-src data: https:; script-src https://example.test/bridge.js; connect-src 'none'; base-uri 'none'; form-action 'none'";
  assert.ok(result.includes(`<head lang="en"><meta http-equiv="Content-Security-Policy" content="${csp}">`));
  assert.ok(result.endsWith('<body><main>Prepared</main><script src="https://example.test/bridge.js"></script></body>\n</html>'));
  assert.ok(result.includes('&quot;render&quot;:3,&quot;token&quot;:&quot;' + token + '&quot;'));
});

test('preview envelope escapes arguments, rejects malformed capabilities and confines bridge CSP source', () => {
  const result = previewDocument(html, '<&"', 1, 'not-a-capability', 'https://example.test/a;b,c d\'e"f.js');
  const source = 'https://example.test/a%3Bb%2Cc%20d%27e%22f.js';
  assert.ok(result.includes('script-src ' + source + '; connect-src'));
  assert.ok(result.includes(`<script src="${source}"></script>`));
  assert.ok(result.includes('&quot;id&quot;:&quot;&lt;&amp;\\&quot;&quot;'));
  assert.ok(result.includes('&quot;token&quot;:&quot;&quot;'));
});

test('browser composition retains the same preview exports and static bootstrap bytes', () => {
  assert.equal(board.previewDocument, previewDocument);
  assert.equal(board.previewBridgeScript, previewBridgeScript);
  assert.equal(previewBridgeScript('function bridge(a){return a}'), '(()=>{const m=document.querySelector(\'meta[name="divlet-bridge"]\');if(!m)return;const a=JSON.parse(m.content);(function bridge(a){return a})(a.id,a.render,a.token,false,false);})();\n');
});
