import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteSvgResource } from '../lib/svg-resource.ts';
import { rewriteCss } from '../lib/resource-carriers.ts';
import { svgResourceCases } from './fixtures/svg-resources.js';
import { captureSvgResource, svgProjectionCases, svgBudgetCases } from './fixtures/svg-projection.js';

const api = { rewriteSvgResource, rewriteCss };
for (const { name, text, accepted } of svgResourceCases) test(`shared SVG/XML: ${name}`, async () => {
  const result = await captureSvgResource(api, text);
  assert.equal(result.accepted, accepted);
  if (!accepted) assert.equal(result.error, 'INVALID_ASSET');
});
for (const row of [...svgProjectionCases, ...svgBudgetCases]) test(`SVG projection: ${row.name}`, async () => {
  if ('text' in row && row.text) {
    const result = await captureSvgResource(api, row.text);
    assert.deepEqual(result, { accepted: false, error: 'INVALID_ASSET' });
  } else if ('run' in row && row.run) assert.deepEqual(await row.run(api), row.expected);
  else assert.fail('Missing authored SVG witness.');
});
