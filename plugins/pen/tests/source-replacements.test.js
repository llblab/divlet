import test from 'node:test';
import assert from 'node:assert/strict';
import { readProject, writeProject, materializeProject } from '../lib/source.js';
import { sourceFrame } from '../lib/projection.js';

function fixture() {
  return { version: '2.21', foreign: { keep: 'slot' }, children: [
    { id: 'avatar', type: 'frame', reusable: true, layout: 'vertical', width: 24, height: 24, children: [{ id: 'letter', type: 'text', content: 'A' }] },
    { id: 'component', type: 'frame', reusable: true, layout: 'vertical', width: 100, height: 100, children: [{ id: 'slot', type: 'ref', ref: 'avatar' }, { id: 'list', type: 'frame', layout: 'vertical', children: [{ id: 'old', type: 'text', content: 'Old' }] }] },
    { id: 'screen', type: 'frame', width: 200, height: 200, layout: 'vertical', children: [{ id: 'instance', type: 'ref', ref: 'component', descendants: {} }] }
  ] };
}

test('typed frame/text/ref replacements have their own indexed identity without requiring a presentation name', () => {
  for (const replacement of [
    { id: 'new-avatar', type: 'frame', width: 24, height: 24, layout: 'vertical', children: [{ id: 'new-label', type: 'text', content: 'New' }] },
    { id: 'new-avatar', type: 'text', content: 'New' },
    { id: 'new-avatar', type: 'ref', ref: 'avatar' }
  ]) {
    const input = fixture(); input.children[2].children[0].descendants.slot = replacement;
    const before = structuredClone(input), project = readProject(input), view = materializeProject(project, { rootIds: ['screen'] });
    assert.equal(project.nodes.get('new-avatar').type, replacement.type);
    assert.ok([...view.nodes.values()].some(node => node.provenance.sourceId === 'new-avatar' || node.provenance.instanceId === 'new-avatar'));
    assert.equal([...view.nodes.values()].some(node => node.provenance.sourceId === 'letter'), replacement.type === 'ref');
    sourceFrame(project, 'screen'); assert.deepEqual(JSON.parse(writeProject(project)), before); assert.deepEqual(input, before);
  }
});

test('explicit child-list overrides replace a frame list whole and index/validate every serialized descendant', () => {
  const input = fixture(); input.children[2].children[0].descendants.list = { children: [{ id: 'replacement-child', type: 'ref', ref: 'avatar' }] };
  const project = readProject(input), view = materializeProject(project, { rootIds: ['screen'] });
  assert.ok(project.nodes.has('replacement-child')); assert.ok(![...view.nodes.values()].some(node => node.provenance.sourceId === 'old'));
  assert.ok([...view.nodes.values()].some(node => node.provenance.instanceId === 'replacement-child')); sourceFrame(project, 'screen');
  assert.deepEqual(JSON.parse(writeProject(project)), input);
  for (const child of [{ id: 'old', type: 'text', content: 'Duplicate' }, { id: 'replacement-child', type: 'ref', ref: 'missing' }, { id: 'replacement-child', type: 'frame', reusable: true, children: [{ id: 'cycle', type: 'ref', ref: 'replacement-child' }] }]) {
    const bad = structuredClone(input); bad.children[2].children[0].descendants.list.children = [child]; assert.throws(() => readProject(bad));
  }
});

test('structural ambiguity and stale descendant scopes still refuse instead of silently remapping identity', () => {
  const input = fixture(); input.children[2].children[0].descendants.slot = { id: 'partial-id-only' };
  assert.throws(() => materializeProject(input), { code: 'UNSUPPORTED_PEN_OVERRIDE' });
  const next = fixture();
  next.children.push({ id: 'wrapper', type: 'frame', reusable: true, layout: 'vertical', children: [{ id: 'nested', type: 'ref', ref: 'component', descendants: { slot: { id: 'replaced', type: 'frame', layout: 'vertical', children: [] } } }] });
  next.children[2].children[0].ref = 'wrapper'; next.children[2].children[0].descendants['nested/slot/letter'] = { content: 'Retired ref scope' };
  assert.throws(() => materializeProject(next), { code: 'UNSUPPORTED_OVERRIDE_CONFLICT' });
  const invalid = fixture(); invalid.children[2].children[0].descendants = { list: { children: [] }, old: { content: 'Retired target' } };
  assert.throws(() => materializeProject(invalid), { code: 'UNSUPPORTED_OVERRIDE_CONFLICT' });
});
