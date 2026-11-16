import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../lib/browser-runtime.ts';
import { projectClosedPreview } from '../lib/closed-preview.ts';
import { browserResourceCases } from './fixtures/browser-resources.js';

for (const { name, run, expected } of browserResourceCases) test(name, async () => {
  assert.deepEqual(await run({ BrowserRuntime, projectClosedPreview }), expected);
});
