import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, truncate, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildStatic } from '../lib/static.js';
import { assetReference } from '../lib/asset-reference.ts';
import { svgResourceCases } from './fixtures/svg-resources.js';
const data = (bytes, mime = 'application/octet-stream') => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const build = (assets, html, options = {}) => buildStatic({ projectDir: '/missing-original-assets', frames: new Map([['home', html]]), assets, ...options });
async function fixture(t, files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'divlet-declared-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), bytes); }
  return root;
}

test('declared assets share named output across pages without extracting inline URLs or collapsing aliases', async () => {
  const bytes = [1, 2, 255], literal = data(bytes, 'image/png');
  const assets = { fonts: { 'Regular.woff2': data(bytes, 'font/woff2'), 'Alias.woff2': data(bytes, 'font/woff2') }, unused: literal };
  const before = structuredClone(assets);
  const result = await build(assets, `<style>@font-face{font-family:Test;src:url(asset:fonts/Regular.woff2?v=1#face)}</style><img src="${literal}">`, {
    frames: new Map([['home', '<style>@font-face{src:url(asset:fonts/Regular.woff2?v=1#face)}</style>'], ['other', '<style>@font-face{src:url(asset:fonts/Alias.woff2)}</style>']]),
    site: new Map([['/guide/deep/', `<img src="${literal}"><a href="asset:fonts/Regular.woff2">font</a>`]]),
  });
  assert.deepEqual([...result.files.keys()].sort(), ['assets/fonts/Alias.woff2', 'assets/fonts/Regular.woff2', 'guide/deep/index.html', 'home.html', 'other.html']);
  assert.deepEqual(result.files.get('assets/fonts/Regular.woff2'), Buffer.from(bytes));
  assert.deepEqual(result.files.get('assets/fonts/Alias.woff2'), Buffer.from(bytes));
  assert.match(result.files.get('home.html'), /assets\/fonts\/Regular.woff2\?v=1#face/);
  assert.ok(result.files.get('guide/deep/index.html').includes('../../assets/fonts/Regular.woff2'));
  assert.ok(result.files.get('guide/deep/index.html').includes(literal));
  assert.deepEqual([...result.mediaTypes], [['assets/fonts/Regular.woff2', 'font/woff2'], ['assets/fonts/Alias.woff2', 'font/woff2']]);
  assert.equal(result.sources.size, 0, 'no original filesystem resource was read');
  assert.equal(result.assetSources.size, 2);
  assert.deepEqual(assets, before);
});

test('declared CSS/SVG closure follows MIME and each authored dependency base, including cycles', async () => {
  const assets = {
    styles: { 'main.bin': data('@IMPORT "nested/b.css"; @font-face{src:url(../fonts/Regular%20Italic.woff2?#iefix)} .x{background:url(../icons/a.svg#view)}', 'text/css'), nested: { 'b.css': data('@ImPoRt "../main.bin";', 'text/css') } },
    fonts: { 'Regular Italic.woff2': data([0, 1, 250], 'font/woff2') },
    icons: { 'a.svg': data('<svg xmlns="http://www.w3.org/2000/svg"><use href="b.svg#b"/><style>.x{fill:url(b.svg#b)}</style></svg>', 'image/svg+xml'), 'b.svg': data('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="a.svg#view"/></svg>', 'image/svg+xml') },
    'opaque.css': data('not CSS; no interpretation by extension'),
  };
  const result = await build(assets, '<link href="asset:styles/main.bin"><img src="asset:opaque.css">');
  assert.equal(result.files.size, 7);
  assert.ok(result.files.get('assets/styles/main.bin').includes('../../assets/styles/nested/b.css'));
  assert.ok(result.files.get('assets/styles/main.bin').includes('../../assets/fonts/Regular%20Italic.woff2?#iefix'));
  assert.ok(result.files.get('assets/styles/nested/b.css').includes('../../../assets/styles/main.bin'));
  assert.ok(result.files.get('assets/icons/a.svg').includes('../../assets/icons/b.svg#b'));
  assert.ok(result.files.get('assets/icons/b.svg').includes('../../assets/icons/a.svg#view'));
  assert.deepEqual(result.files.get('assets/opaque.css'), Buffer.from('not CSS; no interpretation by extension'));
  assert.deepEqual(result.files.get('assets/fonts/Regular Italic.woff2'), Buffer.from([0, 1, 250]));
  assert.equal(result.sources.size, 0);
  assert.equal(result.mediaTypes.get('assets/styles/main.bin'), 'text/css');
});

test('equal CSS bytes retain distinct declared dependency bases rather than digest-interning their outputs', async () => {
  const css = data('.x{background:url(pic.bin)}', 'text/css');
  const result = await build({ a: { theme: css, 'pic.bin': data([1]) }, b: { theme: css, 'pic.bin': data([2]) } }, '<link href="asset:a/theme"><link href="asset:b/theme">');
  for (const [name, byte] of [['a', 1], ['b', 2]]) {
    assert.ok(result.files.get(`assets/${name}/theme`).includes(`../../assets/${name}/pic.bin`));
    assert.deepEqual(result.files.get(`assets/${name}/pic.bin`), Buffer.from([byte]));
  }
});

test('percent, fragment-like, spaces and Unicode keys retain exact output identity under a hosting prefix', async () => {
  const assets = { '%20space': { 'theme.css': data('.x{background:url(../%20space/a%23b.bin)}', 'text/css') }, ' space': { 'a#b.bin': data([1]) }, '雪': { 'é.bin': data([2]) } };
  const result = await build(assets, `<link href="${assetReference('%20space/theme.css')}"><img src="${assetReference('雪/é.bin', '#mark')}">`);
  assert.ok(result.files.has('assets/%20space/theme.css'));
  assert.ok(result.files.has('assets/ space/a#b.bin'));
  assert.ok(result.files.has('assets/雪/é.bin'));
  const css = result.files.get('assets/%20space/theme.css'), url = /url\("([^"]+)"\)/.exec(css)[1];
  assert.equal(decodeURIComponent(new URL(url, 'https://example.invalid/prefix/assets/%2520space/theme.css').pathname), '/prefix/assets/ space/a#b.bin');
  assert.ok(result.files.get('home.html').includes('assets/%E9%9B%AA/%C3%A9.bin#mark'));
});

test('SVG projection uses XML escaping and preserves inert metadata instead of following its hrefs', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title aria-label="&lt;brand&gt;">&#160;</title><metadata><note xmlns="urn:inert" href="private.json">&lt;literal&gt;</note></metadata><rect width="20" height="20"/></svg>';
  const result = await build({ icon: data(svg, 'image/svg+xml') }, '<img src="asset:icon">');
  const output = result.files.get('assets/icon');
  assert.ok(!output.includes('&nbsp;'), 'HTML-only named entities are never introduced into XML');
  assert.ok(output.includes('aria-label="&lt;brand&gt;"'));
  assert.ok(output.includes('href="private.json"'));
  assert.equal(result.files.size, 2);
});

test('SVG preparation refuses invalid XML character and namespace regions before returning output', async () => {
  for (const { name, text, accepted } of svgResourceCases) {
    const run = () => build({ icon: data(text, 'image/svg+xml') }, '<img src="asset:icon">');
    if (accepted) assert.ok((await run()).files.has('assets/icon'), name);
    else await assert.rejects(run(), { code: 'INVALID_ASSET' }, name);
  }
});

test('missing declarations and directories never fall back to original filesystem files', async t => {
  const root = await fixture(t, { 'fonts/Regular.woff2': 'PRIVATE ORIGINAL', 'missing.png': 'PRIVATE IMAGE' });
  for (const url of ['asset:fonts/Regular.woff2', 'asset:missing.png', 'asset:fonts']) await assert.rejects(build({ fonts: {} }, `<img src="${url}">`, { projectDir: root }), { code: 'INVALID_ASSET' });
  const assets = { styles: { 'a.css': data('.x{background:url(../missing.png)}', 'text/css') } };
  await assert.rejects(build(assets, '<link href="asset:styles/a.css">', { projectDir: root }), { code: 'INVALID_ASSET' });
  assert.equal(await readFile(path.join(root, 'missing.png'), 'utf8'), 'PRIVATE IMAGE');
});

test('canonical mapping retains explicit references, while public pages materialize them', async () => {
  const source = '@font-face{font-family:Brand;src:url("asset:brand-font#face")}';
  const result = await build({ 'brand-font': data([1, 2], 'font/woff2') }, `<style>${source}</style>`, {
    mapResources: async rewrite => ({ url: await rewrite('asset:brand-font#face'), css: await rewrite(source, 'css'), srcset: await rewrite('asset:brand-font 1x', 'srcset') }),
  });
  assert.deepEqual(result.mapped, { url: 'asset:brand-font#face', css: source, srcset: 'asset:brand-font 1x' });
  assert.ok(result.files.get('home.html').includes('assets/brand-font#face'));
});

test('preview closure is locked and cache versions include declared bytes and MIME', async () => {
  const html = '<img src="asset:image">', options = { previews: new Map([['home', html]]) };
  const first = await build({ image: data([1], 'image/png') }, html, options);
  const second = await build({ image: data([2], 'image/png') }, html, options);
  const third = await build({ image: data([1], 'image/jpeg') }, html, options);
  assert.match(first.previews.get('home'), /assets\/image\?divlet-resource=[a-f0-9]+/);
  assert.notEqual(first.previews.get('home'), second.previews.get('home'));
  assert.notEqual(first.previews.get('home'), third.previews.get('home'));
  await assert.rejects(build({ image: data([1]) }, '<p>no resource</p>', options), /preview references a resource absent/);
});

test('combined resource counts and output collisions include both declared and filesystem resources', async t => {
  const root = await fixture(t, { 'legacy.bin': 'legacy' });
  const assets = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`file${i}`, data([])]));
  const html = Array.from({ length: 400 }, (_, i) => `<img src="asset:file${i}">`).join('') + '<img src="legacy.bin">';
  await assert.rejects(build(assets, html, { projectDir: root }), /resource count limit/);
  const key = createHash('sha256').update('legacy.bin').digest('hex').slice(0, 20) + '-legacy.bin';
  await assert.rejects(build({ [key]: data([9]) }, `<img src="legacy.bin"><img src="${assetReference(key)}">`, { projectDir: root }), /output collision/);
  await assert.rejects(build({}, '<p>x</p>', { resourceDirectory: '_assets' }), /require the assets/);
  assert.equal(await readFile(path.join(root, 'legacy.bin'), 'utf8'), 'legacy');
});

test('combined decoded-byte budget includes declared bytes before filesystem allocation', async t => {
  const root = await fixture(t, { 'a.bin': '', 'b.bin': '', 'c.bin': '' });
  for (const name of ['a.bin', 'b.bin', 'c.bin']) await truncate(path.join(root, name), 20 * 1024 * 1024);
  await assert.rejects(build({ font: data(Buffer.alloc(20 * 1024 * 1024), 'font/woff2') }, '<img src="asset:font"><img src="a.bin"><img src="b.bin"><img src="c.bin">', { projectDir: root }), /resource byte limit/);
});

test('unsupported text interpretation is refused rather than losing encoding, carrier or base meaning', async () => {
  for (const [mime, bytes, code] of [
    ['text/css;charset=iso-8859-1', 'a{}', 'INVALID_ASSET'],
    ['text/css', [0xff], 'INVALID_ASSET'],
    ['text/css;charset=us-ascii', 'a{content:"é"}', 'INVALID_ASSET'],
    ['text/css', '@charset "windows-1251";a{}', 'INVALID_ASSET'],
    ['image/svg+xml', '<?xml version="1.0" encoding="UTF-16"?><svg/>', 'INVALID_ASSET'],
    ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" xml:base="../"><image href="image.png"/></svg>', 'INVALID_ASSET'],
    ['image/svg+xml;charset=us-ascii', '<svg xmlns="http://www.w3.org/2000/svg"><text>&#233;</text></svg>', 'INVALID_ASSET'],
    ['image/svg+xml', '<!DOCTYPE svg [<!ENTITY label "test">]><svg xmlns="http://www.w3.org/2000/svg"><text>&label;</text></svg>', 'INVALID_ASSET'],
    ['text/css', '.x{background:var(--resource)}', 'COPY_UNSUPPORTED_RESOURCE'],
    ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><text>&nbsp;</text></svg>', 'INVALID_ASSET'],
    ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>', 'INVALID_ASSET'],
    ['text/css', '@i\\6Dport "other.css";', 'COPY_UNSUPPORTED_RESOURCE'],
    ['text/css', '@\\69mport "other.css";', 'COPY_UNSUPPORTED_RESOURCE'],
    ['image/svg+xml', `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(65)}${'</g>'.repeat(65)}</svg>`, 'INVALID_ASSET'],
    ['image/svg+xml', `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(10001)}</svg>`, 'INVALID_ASSET'],
    ['text/html', '<img src="relative.png">', 'INVALID_ASSET'],
  ]) await assert.rejects(build({ file: data(bytes, mime) }, '<img src="asset:file">'), { code });
});

test('source-map comments stay inert and literal/external URLs are not fetched or extracted', async t => {
  const css = '.x{background:url(data:image/png;base64,AQ==)}/*# sourceMappingURL=data:application/json;base64,NOT-A-MAP */';
  const root = await fixture(t, { 'legacy.css': css });
  const result = await build({ theme: data(css + '.y{background:url(https://example.invalid/private.png)}', 'text/css;charset=utf-8') }, '<link href="asset:theme"><link href="legacy.css">', { projectDir: root });
  assert.ok(result.files.get('assets/theme').includes('data:image/png;base64,AQ=='));
  assert.ok(result.files.get('assets/theme').includes('https://example.invalid/private.png'));
  assert.ok(result.files.get('assets/theme').includes('NOT-A-MAP'));
  assert.equal(result.mediaTypes.get('assets/theme'), 'text/css;charset=utf-8');
  assert.equal(result.sources.size, 1, 'only the explicitly referenced legacy local CSS joined filesystem provenance');
  const bundled = await build({}, `<style>${css}</style><p>public</p>`, { stylesheetFrames: new Set(['home']) });
  assert.ok(bundled.files.get(bundled.stylesheets.get('home')).includes('NOT-A-MAP'));
});
