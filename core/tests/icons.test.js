// Merge touching shapes of the same paint so crossings never accumulate alpha. Deliberately different paints may stay
// separate (the mark's outlined bracket and filled D); alpha still belongs to the whole icon, never one part.
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

test('each distinct icon paint is one element, and alpha never sits on a part', async () => {
  const icons = await readIcons();
  assert.ok(icons.length > 50, `the set is read from the source (${icons.length} icons)`);
  // Distinct paints stay separate: the gear shares one transform, auto uses stroke/fill, wrap has different dash patterns,
  // and the divlet mark pairs a stroked bracket with a separate filled D. Their painted regions do not overlap.
  const twoElements = new Set(['gear', 'auto', 'wrap', 'divlet']);
  for (const { name, markup } of icons) {
    const paths = (markup.match(/<path /g) ?? []).length;
    const shapes = (markup.match(/<(?:circle|rect|line|ellipse|polygon|polyline) /g) ?? []).length;
    assert.ok(paths <= (name === 'divlet' ? 2 : 1), `${name}: one path per distinct paint (${paths})`);
    assert.equal(/opacity/.test(markup), false, `${name}: no per-element alpha`);
    assert.ok(paths + shapes <= (twoElements.has(name) ? 2 : 1), `${name}: ${paths} path(s) + ${shapes} shape(s) must be merged by paint`);
  }
  // The agent glyph is the one that showed the artefact: a plus with a round-capped dot inside the same path.
  const agent = icons.find(icon => icon.name === 'agent');
  assert.equal(agent.markup, '<path d="M10 3v4M10 13v4M3 10h4M13 10h4M10 10h.01"/>');
});

test('the divlet mark keeps an open bracket and a filled D with matching diagonals across every product surface', async () => {
  const mark = (await readIcons()).find(icon => icon.name === 'divlet').markup;
  const paths = markup => [...markup.matchAll(/<path\b([^>]+)>/g)].map(([, attrs]) => Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value])));
  const wanted = [
    { d: 'M8 4.5 2.5 10 8 15.5', fill: 'none' },
    { d: 'M10.5 4.5H12L17.5 10 12 15.5h-1.5Z', fill: 'currentColor', stroke: 'none' },
  ];
  assert.deepEqual(paths(mark), wanted, 'two non-overlapping paints: outlined bracket, solid D/play wedge');
  // Both bracket arms and D diagonals have a 1:1 rise/run, meeting on the same horizontal centre.
  const [bracket, wedge] = paths(mark).map(part => part.d.match(/-?\d+(?:\.\d+)?/g).map(Number));
  assert.equal(Math.abs((bracket[1] - bracket[3]) / (bracket[0] - bracket[2])), Math.abs((wedge[4] - wedge[1]) / (wedge[3] - wedge[2])));
  for (const file of ['web/index.html', 'core/lib/hub.ts', 'landing/index.html', 'landing/favicon.svg']) {
    const source = await readFile(path.join(root, file), 'utf8');
    const svg = source.match(/<svg\b[^>]*>[\s\S]*?<\/svg>/)?.[0];
    assert.ok(svg, `${file}: literal mark exists`);
    assert.deepEqual(paths(svg), wanted, `${file}: same mark geometry and paints`);
    const encoded = source.match(/href="data:image\/svg\+xml,([^"]+)"/)?.[1];
    if (file === 'web/index.html' || file === 'core/lib/hub.ts') {
      assert.ok(encoded, `${file}: embedded favicon exists`);
      assert.deepEqual(paths(decodeURIComponent(encoded)), wanted, `${file}: favicon matches the mark`);
    }
  }
});

test('the stroke style applies to the whole icon, never to its parts', async () => {
  const css = await readFile(path.join(root, 'web/board.css'), 'utf8');
  assert.match(css, /\.icon \{[^}]*fill: none;[^}]*stroke: currentColor;/, 'one stroke style for the icon element');
  const partRules = css.split('\n').filter(line => /\.icon\s+[^{]*\{[^}]*opacity/.test(line) || /\.icon\s*:is\([^)]*\)[^{]*\{[^}]*opacity/.test(line));
  assert.deepEqual(partRules, [], 'no rule gives an icon part its own opacity');
  assert.equal(/\.icon[^{]*\{[^}]*(fill-opacity|stroke-opacity)/.test(css), false, 'and none uses a partial paint channel');
});
