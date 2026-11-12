import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, truncate, open, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildStatic, normalizeExternalFiles } from '../lib/static.js';
import { fontBytes } from './fixtures/font.js';

const assetBase = 'http://127.0.0.1:123/token/files/';
const siteBase = 'http://127.0.0.1:123/token/site/';
async function fixture(t, entries = {}) {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'divlet-static-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(projectDir, name)), { recursive: true });
    await writeFile(path.join(projectDir, name), content);
  }
  return projectDir;
}
const build = (projectDir, html, extra = {}) => buildStatic({ projectDir, frames: new Map([['home', html]]), assetBase, siteBase, ...extra });
function resourceName(result, suffix) { return [...result.files.keys()].find((key) => key.startsWith('_assets/') && key.endsWith(suffix)); }

test('binary resources with text suffixes retain bytes and canonical HTTP defaults instead of lossy parsing', async t => {
  const font = fontBytes(600, { cff: true }), invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
  const directory = await fixture(t, { 'font.html': font, 'opaque.css': invalidUtf8 });
  const result = await build(directory, '<style>@font-face{font-family:Proof;src:url(font.html)}body{background:url(opaque.css)}</style>', { previews: new Map([['home', '<style>@font-face{font-family:Proof;src:url(font.html)}</style>']]), previewBase: 'http://127.0.0.1:123/token/build/' });
  const fontKey = resourceName(result, '-font.html'), opaqueKey = resourceName(result, '-opaque.css');
  assert.deepEqual(result.files.get(fontKey), font); assert.deepEqual(result.files.get(opaqueKey), invalidUtf8);
  assert.equal(result.mediaTypes.get(fontKey), 'text/html;charset=utf-8');
  assert.equal(result.mediaTypes.get(opaqueKey), 'text/css;charset=utf-8');
  assert.ok(result.previews.get('home').includes('build/' + fontKey + '?divlet-resource='));
  assert.equal(result.sources.get(path.join(directory, 'font.html')), createHash('sha256').update(font).digest('hex'));
  await assert.rejects(build(directory, '<link rel="stylesheet" href="opaque.css">', { closedCss: true }), { code: 'COPY_UNSUPPORTED_RESOURCE' }, 'closed canonical relocation must not bypass text dependency validation by calling unknown bytes opaque');
});

test('external grant normal forms are set-equivalent and idempotent with native filesystem paths', async t => {
  const root = await fixture(t);
  const a = path.join(root, 'a.png'), b = path.join(root, 'b.png');
  const alias = root + path.sep + 'sub' + path.sep + '..' + path.sep + 'a.png';
  const normalized = normalizeExternalFiles(root, [b, alias, a]);
  assert.deepEqual(normalized, [a, b].sort());
  assert.deepEqual(normalizeExternalFiles(root, normalized), normalized);
  assert.deepEqual(normalizeExternalFiles(root, [a, b]), normalized);
  assert.throws(() => normalizeExternalFiles(root, [a + '\u0001']), /exact absolute/);
});

test('portable nested site routes, runtime URLs, frame links and binary resources', async (t) => {
  const bytes = Buffer.from([0, 255, 23, 84]);
  const projectDir = await fixture(t, { 'images/pic.png': bytes, 'old.html': '<p>raw</p>', 'home.html': 'obsolete' });
  const result = await build(projectDir, '<a href="home.html#x">frame</a><a href="old.html">raw</a>', {
    site: new Map([
      ['/', `<a href="${siteBase}guide/start/?q=1#here">Start</a>`],
      ['/guide/start/', `<a href="${siteBase}">Home</a><img src="${assetBase}images/pic.png?v=2#x"><a href="../../">root</a><a href="../../home.html#frame">frame</a>`],
    ]),
  });
  const image = resourceName(result, 'pic.png');
  assert.deepEqual(result.files.get(image), bytes);
  assert.match(result.files.get('index.html'), /href="guide\/start\/index.html\?q=1#here"/);
  const nested = result.files.get('guide/start/index.html');
  assert.match(nested, /href="..\/..\/index.html"/);
  assert.match(nested, /href="..\/..\/home.html#frame"/);
  assert.ok(nested.includes(`src="../../${image}?v=2#x"`));
  assert.match(result.files.get('home.html'), /href="home.html#x"/);
  assert.equal(result.sources.has(path.join(projectDir, 'home.html')), false);
  assert.ok(resourceName(result, 'old.html'));
  assert.equal(result.sources.get(path.join(projectDir, 'images/pic.png')), createHash('sha256').update(bytes).digest('hex'));
  assert.ok(![...result.files.values()].some((value) => String(value).includes('127.0.0.1')));
});

test('srcset, inline and compiled CSS, imports, fonts and cyclic SVG references', async (t) => {
  const projectDir = await fixture(t, {
    'css/a.css': '@import "b.css" screen; @font-face{src:url(../fonts/test.woff2?#iefix)} .a{background:url(../img/a.svg#icon)}',
    'css/b.css': '@import url("a.css");',
    'fonts/test.woff2': Buffer.from([1, 2, 250]),
    'img/a.svg': '<svg xmlns="http://www.w3.org/2000/svg"><image href="b.svg#b"/><style>.x{fill:url(b.svg#b)}</style></svg>',
    'img/b.svg': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="a.svg#icon"/></svg>',
    'img/a.png': 'a', 'img/b.png': 'b',
  });
  const result = await build(projectDir, `<link href="css/a.css"><style>.hover\\:bg:hover{background:url('${assetBase}img/a.png?x#y')}</style><img srcset="img/a.png 1x, img/b.png 2x" style="background:url(img/b.png)">`);
  const a = resourceName(result, '-a.css');
  const b = resourceName(result, '-b.css');
  assert.ok(result.files.get(a).includes(path.posix.basename(b)));
  assert.ok(result.files.get(b).includes(path.posix.basename(a)));
  assert.ok(result.files.get(a).includes(`${path.posix.basename(resourceName(result, 'test.woff2'))}?#iefix`));
  const svgA = resourceName(result, '-a.svg');
  const svgB = resourceName(result, '-b.svg');
  assert.ok(result.files.get(svgA).includes(`${path.posix.basename(svgB)}#b`));
  assert.ok(result.files.get(svgB).includes(`${path.posix.basename(svgA)}#icon`));
  assert.match(result.files.get('home.html'), /\.hover\\:bg:hover/);
  assert.ok(result.files.get('home.html').includes(`${resourceName(result, '-a.png')}?x#y`));
  assert.equal(result.sources.size, 7);
  assert.deepEqual(result.files.get(resourceName(result, 'test.woff2')), Buffer.from([1, 2, 250]));
});

test('missing assets remain deterministic with warnings and null source hashes', async (t) => {
  const projectDir = await fixture(t);
  const result = await build(projectDir, '<img src="missing.png?v=1#x"><img src="missing.png">');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'MISSING_ASSET');
  assert.equal(result.sources.get(path.join(projectDir, 'missing.png')), null);
  assert.equal(result.files.size, 1);
  assert.match(result.files.get('home.html'), /_assets\/[a-f0-9]+-missing.png\?v=1#x/);
});

test('outside files prepare non-published preview URLs without grants', async t => {
  const root = await fixture(t, { 'design/source.pen': '{"version":"2.21","children":[]}', 'shared/bg.png': Buffer.from([0, 255, 17]) });
  const projectDir = path.join(root, 'design');
  const external = path.join(root, 'shared/bg.png');
  const html = '<style>.wall{background:url("../shared/bg.png?rev=1#x")}</style><div class="wall"></div>';
  const preview = '<script type="application/json">PREVIEW-ONLY-MARKER</script>' + html;
  assert.ok((await build(projectDir, html)).sources.has(external));
  const result = await build(projectDir, html, { externalFiles: [external], previews: new Map([['home', preview]]) });
  const image = resourceName(result, 'bg.png');
  assert.deepEqual(result.files.get(image), Buffer.from([0, 255, 17]));
  assert.match(result.previews.get('home'), /PREVIEW-ONLY-MARKER/);
  assert.ok(result.previews.get('home').includes(`${image}?rev=1&divlet-resource=`));
  assert.match(result.previews.get('home'), /divlet-resource=[a-f0-9]+#x/);
  assert.ok(result.files.get('home.html').includes(`${image}?rev=1#x`));
  assert.ok(![...result.files.values()].some(value => String(value).includes('PREVIEW-ONLY-MARKER')));
  assert.ok(!result.files.get('home.html').includes(root));
  assert.equal(result.sources.get(external), createHash('sha256').update(Buffer.from([0, 255, 17])).digest('hex'));
  assert.equal(await readFile(path.join(projectDir, 'source.pen'), 'utf8'), '{"version":"2.21","children":[]}');
  await assert.rejects(build(projectDir, '<p>public</p>', { externalFiles: [external], previews: new Map([['home', html]]) }), /preview references a resource absent/);
  await assert.rejects(build(projectDir, html, { externalFiles: [external], previews: new Map([['unknown', preview]]) }), /no matching frame/);
});

test('outside dependencies are automatic while private, generated and symlink guards remain', async t => {
  const root = await fixture(t, {
    'design/placeholder': '', 'shared/a.css': '.x{background:url(b.png)}', 'shared/b.png': 'public',
    'shared/other.png': 'other', 'shared/source.pen': '{}', 'shared/.secret.png': 'secret',
    'generated/.divlet-build.json': '{}', 'generated/pic.png': 'generated',
  });
  const projectDir = path.join(root, 'design');
  const css = path.join(root, 'shared/a.css');
  const image = path.join(root, 'shared/b.png');
  assert.equal((await build(projectDir, '<link href="../shared/a.css">')).sources.size, 2);
  const result = await build(projectDir, '<link href="../shared/a.css">', { externalFiles: [css, image] });
  assert.equal(result.sources.size, 2);
  assert.ok(result.files.get(resourceName(result, 'a.css')).includes(path.basename(resourceName(result, 'b.png'))));
  assert.equal((await build(projectDir, '<img src="../shared/other.png">')).warnings.length, 0);
  assert.ok((await build(projectDir, '<img src="../shared/b.png">')).sources.has(image));
  await symlink(image, path.join(root, 'shared/link.png'));
  await symlink(path.join(root, 'shared'), path.join(root, 'linked'));
  for (const relative of ['shared/source.pen', 'shared/.secret.png', 'generated/pic.png', 'shared/link.png', 'linked/b.png', 'shared']) {
    const file = path.join(root, relative);
    await assert.rejects(build(projectDir, `<img src="../${relative}">`, { externalFiles: [file] }), /Static bundle:/, relative);
  }
  for (const externalFiles of ['not-an-array', ['../shared/b.png'], Array(401).fill(image)]) assert.throws(() => normalizeExternalFiles(projectDir, externalFiles), /externalFiles/);
  for (const url of ['%2e%2e/shared/b.png', '../shared%2fb.png', `${assetBase}../shared/b.png`]) await assert.rejects(build(projectDir, `<img src="${url}">`, { externalFiles: [image] }), /Static bundle:/);
  await truncate(image, 21 * 1024 * 1024);
  await assert.rejects(build(projectDir, '<img src="../shared/b.png">', { externalFiles: [image] }), /oversized/);
});

test('a resource growing after descriptor stat fails within its bounded read buffer', async t => {
  const root = await fixture(t, { 'design/placeholder': '', 'shared/growing.png': 'tiny' });
  const file = path.join(root, 'shared/growing.png');
  const probe = await open(file, 'r');
  const prototype = Object.getPrototypeOf(probe);
  const read = prototype.read;
  await probe.close();
  let grew = false;
  prototype.read = async function (...args) {
    if (!grew) { grew = true; await writeFile(file, 'the owner replaced this with much larger content'); }
    return read.apply(this, args);
  };
  try { await assert.rejects(build(path.join(root, 'design'), '<img src="../shared/growing.png">', { externalFiles: [file] }), /resource grew/); }
  finally { prototype.read = read; }
  assert.equal(grew, true);
});

test('aggregate byte reservations also bound concurrent external CSS resource reads', async t => {
  const root = await fixture(t, { 'design/placeholder': '', 'shared/big0.png': '', 'shared/big1.png': '', 'shared/big2.png': '', 'shared/big3.png': '' });
  const externalFiles = Array.from({ length: 4 }, (_, index) => path.join(root, `shared/big${index}.png`));
  for (const file of externalFiles) await truncate(file, 17 * 1024 * 1024);
  const css = externalFiles.map((_, index) => `.x${index}{background:url(../shared/big${index}.png)}`).join('');
  await assert.rejects(build(path.join(root, 'design'), `<style>${css}</style>`, { externalFiles }), /resource byte limit/);
});

test('external URL and fragment values are not rewritten', async (t) => {
  const projectDir = await fixture(t);
  const values = ['https://example.org/a?q#x', 'http://example.org/a', '//example.org/x', 'data:image/png;base64,AAAA', 'mailto:a@example.org', 'tel:123', '#symbol'];
  const result = await build(projectDir, values.map((value) => `<a href="${value}">x</a>`).join('') + '<img srcset="data:image/png;base64,AAAA 1x, https://example.org/x 2x">');
  for (const value of values) assert.ok(result.files.get('home.html').includes(`href="${value}"`));
  assert.match(result.files.get('home.html'), /srcset="data:image\/png;base64,AAAA 1x, https:\/\/example.org\/x 2x"/);
  assert.equal(result.sources.size, 0);
});

test('rejects output collisions and malformed routes or frame identities', async (t) => {
  const projectDir = await fixture(t);
  for (const extra of [
    { frames: new Map([['index', '']]), site: new Map([['/', '']]) },
    { site: new Map([['/a/', ''], ['/%61/', '']]) },
    { site: new Map([['/a/../', '']]) },
    { site: new Map([['/a//', '']]) },
    { frames: new Map([['../x', '']]) },
  ]) await assert.rejects(build(projectDir, '', extra), /Static bundle:/);
});

test('rejects unsafe resources, schemes, escapes and symlink directory components', async (t) => {
  const projectDir = await fixture(t, { 'secret.divlet': '{}', 'secret.pen': '{}', '.env': 'secret', 'normal/image.png': 'x', 'cache/item': 'x', 'public/.divlet-build.json': '{}', 'public/photo.png': 'generated' });
  await symlink('normal/image.png', path.join(projectDir, 'link.png'));
  await symlink('normal', path.join(projectDir, 'linked'));
  for (const url of [
    '%2e%2e/escape.png', 'normal%2fimage.png', 'normal%5cimage.png', 'a%00.png',
    'a\\b.png', 'bad%xx.png', 'javascript:alert(1)', 'file:///tmp/x', 'secret.divlet', 'secret.pen', '.env', 'cache/item',
    'link.png', 'linked/image.png', 'page.meta.json', 'public/photo.png', `${assetBase}../normal/image.png`, `${siteBase}unknown/`,
  ]) await assert.rejects(build(projectDir, `<img src="${url}">`), /Static bundle:/, url);
});

test('normalizes browser-equivalent runtime URLs before preserving external URLs', async (t) => {
  const projectDir = await fixture(t, { 'photo.png': 'photo' });
  const own = 'http://LOCALHOST:80/token/files/';
  for (const prefix of ['HTTP://localhost/token/files/', 'http:\t//localhost/token/files/', 'http://local\nhost:80/token/files/']) {
    const result = await build(projectDir, `<img src="${prefix}photo.png"><a href="${prefix.replace('/files/', '/site/')}guide/">go</a>`, {
      assetBase: own, siteBase: 'http://localhost/token/site/', site: new Map([['/guide/', '<p>guide</p>']]),
    });
    assert.ok(resourceName(result, 'photo.png'));
    assert.match(result.files.get('home.html'), /href="guide\/index.html"/);
    assert.ok(!result.files.get('home.html').includes('token'));
    assert.ok(!result.files.get('home.html').includes('localhost'));
  }
  for (const url of ['http:\t//localhost/token/api/state', 'HTTP://LOCALHOST:80/token/board/', 'http://localhost/elsewhere']) {
    await assert.rejects(build(projectDir, `<a href="${url}">x</a>`, { assetBase: own }), /unrecognized runtime URL/);
  }
  const external = 'HTTP://example.org:80/token/files/photo.png';
  assert.ok((await build(projectDir, `<img src="${external}">`, { assetBase: own })).files.get('home.html').includes(external));
});

test('SVG presentation attributes bundle transitive fragment-bearing paint dependencies', async (t) => {
  const attributes = ['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end', 'cursor'];
  const projectDir = await fixture(t, {
    'shape.svg': `<svg><rect ${attributes.map(name => `${name}="url(paint.svg#grad)"`).join(' ')}/></svg>`,
    'paint.svg': '<svg><image href="pixel.png"/></svg>', 'pixel.png': 'pixel',
  });
  const result = await build(projectDir, '<img src="shape.svg">');
  const paint = path.posix.basename(resourceName(result, 'paint.svg'));
  const svg = result.files.get(resourceName(result, 'shape.svg'));
  assert.equal(svg.split(`${paint}#grad`).length - 1, attributes.length);
  assert.ok(result.files.get(resourceName(result, 'paint.svg')).includes(path.posix.basename(resourceName(result, 'pixel.png'))));
});

test('raw HTML local bases use source location and external bases preserve destinations', async (t) => {
  const projectDir = await fixture(t, {
    'pages/local.html': '<base href="../media/" target="_blank"><base href="https://ignored.example/"><img src="photo.png"><link href="css/main.css"><a href="nested.html">next</a><style>.x{background:url(photo.png)}</style>',
    'media/photo.png': 'photo', 'media/css/main.css': '.x{background:url(../photo.png)}',
    'media/nested.html': '<img src="photo.png">',
    'pages/external.html': '<base href="https://example.org/assets/" target="_blank"><img src="photo.png"><link href="css/main.css"><a href="next.html#x">next</a><style>.x{background:url(photo.png)}</style><img srcset="photo.png 1x, other.png 2x">',
    'pages/photo.png': 'not a dependency', 'pages/css/main.css': 'not a dependency',
  });
  const result = await build(projectDir, '<a href="pages/local.html">local</a><a href="pages/external.html">external</a>');
  const local = result.files.get(resourceName(result, 'local.html'));
  assert.match(local, /<base target="_blank">/);
  assert.ok(!local.includes('href="../media/') && !local.includes('ignored.example'));
  for (const suffix of ['photo.png', 'main.css', 'nested.html']) assert.ok(local.includes(path.posix.basename(resourceName(result, suffix))));
  const external = result.files.get(resourceName(result, 'external.html'));
  for (const destination of ['photo.png', 'css/main.css', 'next.html#x', 'other.png']) assert.ok(external.includes(`https://example.org/assets/${destination}`));
  assert.match(external, /<base target="_blank">/);
  assert.equal(result.sources.has(path.join(projectDir, 'pages/photo.png')), false);
  assert.equal(result.sources.has(path.join(projectDir, 'pages/css/main.css')), false);
});

test('HTML base normalization cannot clamp escaping paths back into the source root', async (t) => {
  const projectDir = await fixture(t, {
    'escape.html': '<base href="../../"><img src="photo.png">',
    'reference.html': '<base href="images/"><img src="../../photo.png">',
    'photo.png': 'A coincident local file is not the escaping dependency',
  });
  for (const file of ['escape.html', 'reference.html']) { const result = await build(projectDir, `<a href="${file}">raw</a>`); assert.ok(!result.sources.has(path.join(projectDir, 'photo.png'))); }
});

test('CSS token escapes decode before confinement and rewritten strings serialize safely', async (t) => {
  const projectDir = await fixture(t, { 'a b.png': 'space', 'café.png': 'unicode', 'quote".png': 'quote', 'a b.css': '.x{color:red}' });
  const result = await build(projectDir, String.raw`<style>@import "a\ b.css";.a{background:url(a\ b.png)}.b{background:url("caf\e9.png")}.c{background:url('quote".png')}</style>`);
  for (const suffix of ['a_b.png', 'caf_.png', 'quote_.png', 'a_b.css']) assert.ok(resourceName(result, suffix), suffix);
  for (const url of [String.raw`normal\5c image.png`, String.raw`\6a avascript:alert`, String.raw`java\9 script:alert`, String.raw`\2e env`, String.raw`cache\2f item`]) {
    await assert.rejects(build(projectDir, `<style>.x{background:url("${url}")}</style>`), /Static bundle:/, url);
  }
});

test('limits single-resource size without publishing bytes', async (t) => {
  const projectDir = await fixture(t, { 'large.bin': Buffer.alloc(20 * 1024 * 1024 + 1) });
  await assert.rejects(build(projectDir, '<a href="large.bin">x</a>'), /oversized/);
});
