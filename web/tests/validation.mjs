// Real browser ESM executes the shared core admission code; this is not a browser-only validator or an API mock.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { chromium } from 'playwright';

const prefix = '/divlet-kernel/';
const files = new Map([
  [prefix, ['text/html', '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Portable validation</title>']],
  [`${prefix}validation.js`, ['text/javascript', stripTypeScriptTypes(await readFile(new URL('../../core/lib/validation.ts', import.meta.url), 'utf8'))]],
  [`${prefix}cases.js`, ['text/javascript', await readFile(new URL('../../core/tests/fixtures/validation.js', import.meta.url), 'utf8')]],
]);
const requests = [];
const server = http.createServer((request, response) => {
  requests.push(request.url);
  const file = files.get(request.url);
  if (!file) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': file[0], 'Cache-Control': 'no-store' }).end(file[1]);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.PI_DIVLET_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}${prefix}`);
  const result = await page.evaluate(async () => {
    const [api, { validationCases, captureValidation }] = await Promise.all([
      import(new URL('validation.js', location.href).href), import(new URL('cases.js', location.href).href),
    ]);
    return {
      nodeGlobals: ['Buffer', 'process', 'require'].filter(name => name in globalThis),
      cases: validationCases.map(({ name, run, expected }) => ({ name, actual: captureValidation(api, run), expected })),
    };
  });
  assert.deepEqual(result.nodeGlobals, [], 'no Node globals/polyfills supply the kernel');
  assert.ok(result.cases.length > 25, 'the shared acceptance/refusal regions are exercised');
  for (const { name, actual, expected } of result.cases) assert.deepEqual(actual, expected, name);
  assert.deepEqual([...new Set(requests)].sort(), [...files.keys()].sort(), 'only static module/fixture bytes are served; no API, SSE or dependency rescue');
  assert.deepEqual(errors, []);
  console.log(`PASS: ${result.cases.length} shared admission witnesses in native browser ESM without Node globals, providers or a backend API`);
} finally {
  await browser?.close();
  server.close();
  await once(server, 'close');
}
