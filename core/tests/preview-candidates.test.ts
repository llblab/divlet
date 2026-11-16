import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserRuntime } from '../lib/browser-runtime.ts';
import { projectClosedPreview } from '../lib/closed-preview.ts';
import { PREVIEW_HTML_BYTES } from '../lib/browser-preview.ts';
import { previewCandidateCases, expectedPreviewCandidates } from './fixtures/preview-candidates.js';

test('trusted preview projection is bounded and awaited before browser-writer acceptance', async () => {
  assert.deepEqual(await previewCandidateCases({ BrowserRuntime, projectClosedPreview, PREVIEW_HTML_BYTES }), expectedPreviewCandidates);
});
