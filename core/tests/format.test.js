import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readProject, writeProject, expandFrame } from '../lib/project.ts';
import { HTML_TAGS, SVG_TAGS } from '../lib/model.ts';
import { encodeHtml, decodeHtml } from '../lib/codec.ts';
import { styleEngine, setStyleEngines } from '../lib/engine.ts';

const fixtures = new URL('./fixtures/format/', import.meta.url);
const readJson = async name => JSON.parse(await readFile(new URL(name, fixtures), 'utf8'));
const corpus = await readJson('cases.json');
const at = (value, path) => path.reduce((current, key) => current[key], value);

for (const entry of corpus.accepted) {
  test(`format accepts and semantically round-trips ${entry.id}`, async () => {
    const input = await readJson(entry.file);
    const before = structuredClone(input);
    const project = readProject(input);
    assert.deepEqual(input, before, 'admission does not mutate authored input');
    for (const check of entry.checks) assert.deepEqual(at(project, check.path), check.equals, check.path.join('.'));
    const serialized = JSON.parse(writeProject(project.settings, project.frames));
    assert.equal(serialized.schemaVersion, 2);
    assert.ok(serialized.frames.every(frame => !Object.hasOwn(frame, 'schemaVersion')), 'stored frames omit the standalone envelope marker');
    assert.deepEqual(readProject(serialized), project, 'semantic identity is retained, not JSON formatting');
  });
}

for (const entry of corpus.rejected) {
  test(`format rejects ${entry.id} at its owning boundary`, () => {
    const before = structuredClone(entry.input);
    assert.throws(() => readProject(entry.input), { code: entry.errorCode });
    assert.deepEqual(entry.input, before);
  });
}

test('plain CSS remains native without an engine, and its expanded static projection round-trips', async t => {
  const engine = styleEngine();
  setStyleEngines([]);
  t.after(() => setStyleEngines(engine ? [engine] : []));
  const project = readProject(await readJson('web.divlet'));
  const expanded = expandFrame(project.frames[0], null, project.settings).document;
  assert.deepEqual(expanded.tokens, { '--accent': '#c06030' });
  assert.equal(expanded.css, '.card{color:var(--accent)}\nmain{padding:4px}');
  assert.equal(expanded.nodes.root.style.padding, '12px');
  assert.deepEqual(decodeHtml(encodeHtml(expanded)), expanded);
});

test('nested component addresses affect only occurrences, not stored definitions', async () => {
  const project = readProject(await readJson('components.divlet'));
  const lookup = id => project.frames.find(frame => frame.id === id);
  const expanded = expandFrame(project.frames[1], lookup, project.settings);
  const texts = Object.values(expanded.document.nodes).filter(node => node.type === 'text').map(node => node.content);
  assert.deepEqual(texts, ['Buy', 'New']);
  assert.equal(expanded.document.nodes.action.className, 'cta');
  assert.deepEqual(expanded.document.nodes.action.attrs, { type: 'button', 'aria-label': 'Buy now' });
  assert.equal(project.frames[0].nodes.caption.content, 'Default');
  assert.equal(project.frames[0].nodes.badgeText.content, 'Badge');
  assert.equal(project.frames[1].nodes.action.type, 'ref');
});

test('the candidate JSON example and documented tag profiles match executable admission', async () => {
  const specification = await readFile(new URL('../../docs/format.md', import.meta.url), 'utf8');
  const example = JSON.parse(specification.match(/```json\n([\s\S]*?)\n```/)[1]);
  const project = readProject(example);
  assert.deepEqual(readProject(JSON.parse(writeProject(project.settings, project.frames))), project);
  const profiles = [...specification.matchAll(/```text\n([\s\S]*?)\n```/g)].slice(0, 2).map(match => new Set(match[1].trim().split(/\s+/)));
  assert.deepEqual(profiles[0], HTML_TAGS);
  assert.deepEqual(profiles[1], SVG_TAGS);
});
