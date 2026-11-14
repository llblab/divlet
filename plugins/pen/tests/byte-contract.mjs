// Maintainer regression for the actual public export graph, not an installed-package or browser-portability claim.
import assert from 'node:assert/strict';
import { importerFor } from '@divlet/core/plugins';
import { checkPublicSourceBytes } from './fixtures/source-bytes.js';

const entry = import.meta.resolve('@divlet/core/plugins');
if (process.argv.includes('--compiled')) assert.ok(entry.endsWith('/dist/core/lib/plugins.js'), 'compiled probe must not resolve the source facade');
const result = await checkPublicSourceBytes(importerFor);
console.log(JSON.stringify({ status: 'passed', mode: entry.endsWith('.ts') ? 'source' : 'compiled', ...result }));
