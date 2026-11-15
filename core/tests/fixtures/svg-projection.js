// Shared strict XML projection witnesses; transforms are caller-owned plans, not file/network resolution.
export const SVG_NS = 'http://www.w3.org/2000/svg';
const wrap = body => `<svg xmlns="${SVG_NS}">${body}</svg>`;
export const identitySvgTransforms = { url: async value => value, css: async value => value };
export async function captureSvgResource(api, text) {
  try { return { accepted: true, xml: await api.rewriteSvgResource(text, identitySvgTransforms) }; }
  catch (error) { return { accepted: false, error: error.code }; }
}
export const svgProjectionCases = [
  { name: 'URL, presentation, inline and stylesheet carriers share callbacks', async run(api) {
    const urls = [], css = [];
    const result = await api.rewriteSvgResource(`<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink"><image href="asset:image" xlink:href="asset:linked"/><rect fill="url(asset:paint)" style="mask:url(asset:mask)"/><style>.x{filter:url(asset:filter)}</style></svg>`, {
      url: async value => { urls.push(value); return value.startsWith('asset:') ? `#${value.slice(6)}` : value; },
      css: async (text, inline) => { css.push(inline); return api.rewriteCss(text, value => { urls.push(value); return value.startsWith('asset:') ? `#${value.slice(6)}` : value; }, inline, true); },
    });
    return { urls, css, mapped: ['href="#image"', 'xlink:href="#linked"', 'url(&quot;#paint&quot;)', 'url(&quot;#mask&quot;)', 'url("#filter")'].every(value => result.includes(value)) };
  }, expected: { urls: ['asset:image', 'asset:linked', 'asset:paint', 'asset:mask', 'asset:filter'], css: [true, true, false], mapped: true } },
  { name: 'foreign inert metadata retains text and never becomes a carrier', async run(api) {
    let calls = 0;
    const text = `<svg xmlns="${SVG_NS}" xmlns:p="urn:example"><metadata><p:note href="asset:inert" style="url(asset:inert)">A&#13;B</p:note></metadata></svg>`;
    const result = await api.rewriteSvgResource(text, { url: async value => { calls++; return value; }, css: async value => { calls++; return value; } });
    return { calls, retained: result.includes('href="asset:inert"') && result.includes('style="url(asset:inert)"'), referencedCR: result.includes('A&#13;B') };
  }, expected: { calls: 0, retained: true, referencedCR: true } },
  { name: 'URL and CSS refusal identities stop later carriers without retry', async run(api) {
    const result = [];
    for (const phase of ['url', 'css']) {
      const cause = new Error('unavailable'), seen = []; let identical = false;
      const fail = async value => { seen.push(value); throw cause; };
      const text = phase === 'url' ? wrap('<image href="first"/><image href="second"/>') : wrap('<rect style="fill:red"/><rect style="fill:blue"/>');
      try { await api.rewriteSvgResource(text, { url: phase === 'url' ? fail : async value => value, css: phase === 'css' ? fail : async value => value }); }
      catch (error) { identical = error === cause; }
      result.push({ identical, seen });
    }
    return result;
  }, expected: [{ identical: true, seen: ['first'] }, { identical: true, seen: ['fill:red'] }] },
  ...[
    ['DTD', '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['entity declaration', '<!DOCTYPE svg [<!ENTITY x "hello">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'],
    ['script', wrap('<script/>')],
    ['foreignObject', wrap('<foreignObject/>')],
    ['event handler', wrap('<rect onload="bad"/>')],
    ['xml base', `<svg xmlns="${SVG_NS}" xml:base="relative/"/>`],
    ['processing instruction', `<?probe x?><svg xmlns="${SVG_NS}"/>`],
    ['wrong root', '<svg xmlns="urn:wrong"/>'],
    ['unpaired surrogate', wrap('<text>\ud800</text>')],
  ].map(([name, text]) => ({ name: `projection refusal: ${name}`, text, refused: true })),
];
export const svgBudgetCases = [
  { name: 'document/root count in depth limit', async run(api) {
    const text = wrap('<g>'.repeat(63) + '</g>'.repeat(63));
    const accepted = (await captureSvgResource(api, text)).accepted;
    const refused = await captureSvgResource(api, wrap('<g>'.repeat(64) + '</g>'.repeat(64)));
    return { accepted, refused: !refused.accepted && refused.error === 'INVALID_ASSET' };
  }, expected: { accepted: true, refused: true } },
  { name: 'document/root count in node limit', async run(api) {
    const accepted = (await captureSvgResource(api, wrap('<g/>'.repeat(9998)))).accepted;
    const refused = await captureSvgResource(api, wrap('<g/>'.repeat(9999)));
    return { accepted, refused: !refused.accepted && refused.error === 'INVALID_ASSET' };
  }, expected: { accepted: true, refused: true } },
];
export const svgPaintSource = `<svg xmlns="${SVG_NS}" width="7" height="9"><defs><linearGradient id="paint"><stop stop-color="#123456"/><stop offset="1" stop-color="#123456"/></linearGradient></defs><rect width="7" height="9" fill="url(asset:paint)"/></svg>`;
