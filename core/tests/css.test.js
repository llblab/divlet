import test from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { formatCss, highlightCss } from '../../web/lib/css.js';

const plain = html => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** The meaning of a stylesheet: every declaration with its selector and at-rule context, spacing ignored. */
const normal = css => {
  const out = [];
  postcss.parse(css).walkDecls(decl => {
    const path = [];
    for (let node = decl.parent; node && node.type !== 'root'; node = node.parent) path.unshift(node.type === 'atrule' ? `@${node.name} ${node.params}` : node.selector);
    out.push(`${path.join(' > ').replace(/\s+/g, '')}|${decl.prop}|${decl.value.replace(/\s+/g, '')}${decl.important ? '!' : ''}`);
  });
  return out;
};

const SAMPLE = `/* head */
.studio { --ink:#24271f; min-height:100vh; padding:28px 40px 24px; font-family:Arial,Helvetica,sans-serif; margin-bottom:21px!important }
.studio *, .studio *::before{box-sizing:border-box}
.a::before { content:"a;b{c}"; background:url(data:image/png;base64,AAA=) no-repeat; }
@media(min-width:1100px) { .studio { padding:36px max(40px,calc((100vw - 1080px)/2)); } .t{font-size:88px} }
@font-face{font-family:X;src:url(x.woff2) format("woff2")}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.x{transition:none}}`;

test('formatting is readable and keeps the meaning', () => {
  const out = formatCss(SAMPLE);
  assert.match(out, /\.studio \{\n {2}--ink: #24271f;\n {2}min-height: 100vh;/);
  assert.match(out, /font-family: Arial, Helvetica, sans-serif;/);
  assert.match(out, /margin-bottom: 21px !important;/);
  assert.match(out, /\.studio \*,\n\.studio \*::before \{/);
  assert.match(out, /@media \(min-width: 1100px\) \{\n {2}\.studio \{\n {4}padding: 36px max\(40px, calc\(\(100vw - 1080px\)\/2\)\);/);
  assert.match(out, /content: "a;b\{c\}";/);
  assert.match(out, /url\(data:image\/png;base64,AAA=\)/);
  assert.equal(formatCss(out), out, 'formatting is stable');
  assert.deepEqual(normal(out), normal(SAMPLE));
});

test('broken css is returned as it was', () => {
  const broken = '.a { color: red';
  assert.equal(formatCss(broken), broken);
  assert.equal(formatCss(''), '');
  assert.equal(formatCss('.a{}'), '.a {}\n');
});

test('highlighting keeps every character and marks the parts', () => {
  for (const text of [SAMPLE, formatCss(SAMPLE), '', '.a{', 'color:red', '/* only a comment */', '.a { color: red; /* c */ }\n']) {
    assert.equal(plain(highlightCss(text)), text);
  }
  const html = highlightCss('.hero > a:hover { color: #fff; margin: -4px auto !important; background: var(--x) }');
  for (const kind of ['class', 'tag', 'pseudo', 'prop', 'color', 'number', 'important', 'var', 'punct']) assert.match(html, new RegExp(`syn-${kind}`), kind);
  assert.match(highlightCss('@media (min-width: 1px) { .a { x: y } }'), /syn-atrule">@media/);
  assert.match(highlightCss('a { content: "x;" }'), /syn-string">"x;"/);
});
