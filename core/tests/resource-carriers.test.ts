import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../lib/resource-carriers.ts';
import { SVG_RESOURCE_ATTRIBUTES } from '../lib/svg-resource-attributes.ts';
import { SVG_RESOURCE_ATTRIBUTES as XML_ATTRIBUTES, rewriteSvgResource } from '../lib/svg-resource.ts';
import { resourceCarrierCases, captureResourceCarrier } from './fixtures/resource-carriers.js';

for (const { name, run, expected } of resourceCarrierCases) test(`resource carriers: ${name}`, async () => {
  assert.deepEqual(await captureResourceCarrier(api, run), expected);
});

test('carrier callback rejection propagates unchanged without retry or host resolution', async () => {
  const cause = new Error('refused'), urls: string[] = [];
  await assert.rejects(api.rewriteHtml('<img src="asset:one"><img src="asset:two">', value => { urls.push(value); throw cause; }, true), error => error === cause);
  assert.deepEqual(urls, ['asset:one']);
});

test('SVG XML and HTML carriers share one attribute vocabulary without a model dependency', async () => {
  assert.equal(XML_ATTRIBUTES, SVG_RESOURCE_ATTRIBUTES);
  assert.ok(SVG_RESOURCE_ATTRIBUTES.has('fill'));
  const result = await rewriteSvgResource('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(asset:paint)"/></svg>', {
    url: async value => value,
    css: (text, inline) => api.rewriteCss(text, value => value === 'asset:paint' ? '#paint' : value, inline),
  });
  assert.ok(result.includes('url(&quot;#paint&quot;)'));
});
