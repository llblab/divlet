// Authored carrier-transform witnesses; no resolver, filesystem, provider or network implementation.
const mapped = value => value.startsWith('asset:') ? `/out/${value.slice(6)}` : value;
export async function captureResourceCarrier(api, run) {
  try { return { value: await run(api) }; } catch (error) { return { error: error.code || error.name }; }
}
export const resourceCarrierCases = [
  { name: 'CSS declaration/import URLs change, selectors and content strings do not', async run(api) {
    const calls = [];
    const css = await api.rewriteCss('.asset\\:one{background:url("asset:one");content:"url(asset:literal)"}@import "asset:theme" screen;', value => { calls.push(value); return mapped(value); });
    return { css, calls: calls.sort() };
  }, expected: { value: { css: '.asset\\:one{background:url("/out/one");content:"url(asset:literal)"}@import "/out/theme" screen;', calls: ['asset:one', 'asset:theme'] } } },
  { name: 'nested CSS URLs and escaped function names', async run(api) {
    return api.rewriteCss(String.raw`.x{background:image-set(url(asset:a) 1x,url("asset:b") 2x);mask:\75rl("asset:c")}`, mapped);
  }, expected: { value: String.raw`.x{background:image-set(url("/out/a") 1x,url("/out/b") 2x);mask:\75rl("/out/c")}` } },
  { name: 'inline declarations retain literal order and fallback values', run: api => api.rewriteCss('padding-left:20px;padding:10px;background:url(asset:x)', mapped, true), expected: { value: 'padding-left:20px;padding:10px;background:url("/out/x")' } },
  { name: 'source-map-looking comments stay inert', async run(api) {
    const text = '/*# sourceMappingURL=unrequested.map */.x{content:"@import \\"asset:literal\\";"}';
    let calls = 0;
    const result = await api.rewriteCss(text, value => { calls++; return value; });
    return { unchanged: result === text, calls };
  }, expected: { value: { unchanged: true, calls: 0 } } },
  { name: 'closed CSS refuses unsupported indirect values', run: api => api.rewriteCss('.x{background:var(--image)}', mapped, false, true), expected: { error: 'COPY_UNSUPPORTED_RESOURCE' } },
  { name: 'closed CSS refuses malformed parsing', run: api => api.rewriteCss('.x{', mapped, false, true), expected: { error: 'COPY_UNSUPPORTED_RESOURCE' } },
  { name: 'closed CSS allows understood nested functions', run: api => api.rewriteCss('.x{background:linear-gradient(red,blue),url(asset:a)}', mapped, false, true), expected: { value: '.x{background:linear-gradient(red,blue),url("/out/a")}' } },
  { name: 'srcset keeps Data URL commas and candidate descriptors', run: api => api.rewriteSrcset('data:image/png;base64,AA== 1x, asset:two 2x', mapped), expected: { value: 'data:image/png;base64,AA== 1x, /out/two 2x' } },
  { name: 'HTML and SVG template shapes use their actual parser content', run: api => api.rewriteHtml('<template><img src="asset:x"></template><svg><template><image href="asset:y"></image></template></svg>', mapped, true), expected: { value: '<template><img src="/out/x"></template><svg><template><image href="/out/y"></image></template></svg>' } },
  { name: 'HTML contexts, SVG href and CSS presentation carriers', async run(api) {
    const contexts = [];
    const html = await api.rewriteHtml('<img src="asset:a"><svg><use href="asset:b" fill="url(asset:c)"></use></svg>', (value, context) => { contexts.push([value, context?.tag ?? null, context?.attribute ?? null]); return mapped(value); }, true);
    return { html, contexts };
  }, expected: { value: { html: '<img src="/out/a"><svg><use href="/out/b" fill="url(&quot;/out/c&quot;)"></use></svg>', contexts: [['asset:a', 'img', 'src'], ['asset:b', 'use', 'href'], ['asset:c', null, null]] } } },
  { name: 'first base chooses host rewrite, all base hrefs are retired', async run(api) {
    const chosen = [];
    const html = await api.rewriteHtml('<base href="one/"><base href="two/"><img src="x">', mapped, false, base => { chosen.push(base); return value => `mapped:${base}${value}`; });
    return { html, chosen };
  }, expected: { value: { html: '<html><head><base><base></head><body><img src="mapped:one/x"></body></html>', chosen: ['one/'] } } },
  { name: 'CSS inspection observes selectors before URL callbacks', async run(api) {
    const calls = [];
    const css = await api.rewriteCss('.keep{background:url(asset:x)}', value => { calls.push('url'); return mapped(value); }, false, false, root => { root.walkRules(rule => { calls.push(rule.selector); }); });
    return { css, calls };
  }, expected: { value: { css: '.keep{background:url("/out/x")}', calls: ['.keep', 'url'] } } },
];
