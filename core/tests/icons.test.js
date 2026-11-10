// The icon set is drawn by one stroke, so an icon is one painted element: a crossing or a touching join cannot accumulate alpha
// and darken (the agent glyph used to be a plus whose centre dot was a second element over the four stroke ends).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

const readIcons = async () => {
  const source = await readFile(path.join(root, 'web/lib/util.js'), 'utf8');
  const block = source.slice(source.indexOf('const ICONS = {'), source.indexOf('\n};', source.indexOf('const ICONS = {')));
  return [...block.matchAll(/^  (\w+): '([^']*)',?\s*$/gm)].map(match => ({ name: match[1], markup: match[2] }));
};

test('every icon is one painted element, and alpha never sits on a part', async () => {
  const icons = await readIcons();
  assert.ok(icons.length > 50, `the set is read from the source (${icons.length} icons)`);
  // Three shapes are deliberate and do not overlap: the gear needs one transform for the whole glyph, `auto` is a stroked circle
  // with a filled half-disc inside it, and `wrap` is a dashed outer frame around a solid inner one (different dash patterns).
  const twoElements = new Set(['gear', 'auto', 'wrap']);
  for (const { name, markup } of icons) {
    const paths = (markup.match(/<path /g) ?? []).length;
    const shapes = (markup.match(/<(?:circle|rect|line|ellipse|polygon|polyline) /g) ?? []).length;
    assert.ok(paths <= 1, `${name}: at most one path (${paths})`);
    assert.equal(/opacity/.test(markup), false, `${name}: no per-element alpha`);
    if (paths + shapes > 1) assert.ok(twoElements.has(name), `${name}: ${paths} path(s) + ${shapes} shape(s) must be merged into one element`);
  }
  // The agent glyph is the one that showed the artefact: a plus with a round-capped dot inside the same path.
  const agent = icons.find(icon => icon.name === 'agent');
  assert.equal(agent.markup, '<path d="M10 3v4M10 13v4M3 10h4M13 10h4M10 10h.01"/>');
});

test('the stroke style applies to the whole icon, never to its parts', async () => {
  const css = await readFile(path.join(root, 'web/board.css'), 'utf8');
  assert.match(css, /\.icon \{[^}]*fill: none;[^}]*stroke: currentColor;/, 'one stroke style for the icon element');
  const partRules = css.split('\n').filter(line => /\.icon\s+[^{]*\{[^}]*opacity/.test(line) || /\.icon\s*:is\([^)]*\)[^{]*\{[^}]*opacity/.test(line));
  assert.deepEqual(partRules, [], 'no rule gives an icon part its own opacity');
  assert.equal(/\.icon[^{]*\{[^}]*(fill-opacity|stroke-opacity)/.test(css), false, 'and none uses a partial paint channel');
});
