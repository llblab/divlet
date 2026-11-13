// A request typed on the board reaches an agent as one compact prompt block, in the same metadata style as the other adapters:
// `[tag|key:value|…]` with its value on that line, lists from the next line in Markdown, then the request after a blank line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { legacyProject } from './fixtures/legacy-project.js';
import { openRuntime } from '../lib/runtime.js';

const openFixture = async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-ask-'));
  await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
  const runtime = await openRuntime({ cwd, watch: false });
  t.after(async () => { await runtime.close(); await fs.rm(cwd, { recursive: true, force: true }); });
  return { cwd, runtime };
};

const askMessage = async (t, request, { ids = [], nodes = null } = {}) => {
  const { runtime } = await openFixture(t);
  return runtime.askMessage(request, runtime.askContext({ ids, nodes }));
};

test('a board request becomes one compact prompt block, then the request', async t => {
  const message = await askMessage(t, 'Make the intro calmer');
  const [block, request, ...rest] = message.split('\n\n');
  assert.equal(rest.length, 0, 'one block, one blank line, the request');
  assert.equal(request, 'Make the intro calmer');
  const lines = block.split('\n');
  assert.match(lines[0], /^\[divlet\|project:[^|]+\|frames:\d+\] about the project as a whole; nothing is selected$/, 'header with key:value metadata, value on the same line');
  assert.deepEqual(lines.slice(1), ['next:', '- divlet_read before changing anything', '- divlet_edit for structure, divlet_patch for classes, text and components', '- Tailwind classes first, custom css only as an exception (the divlet skill explains the workflow)']);
});

test('a selection adds its frames and elements as Markdown lists under the header', async t => {
  const { runtime } = await openFixture(t);
  const id = runtime.info().documents[0].id;
  const rootId = runtime.read({ view: 'document', documentId: id }).rootId;
  const message = runtime.askMessage('Make it rounder', runtime.askContext({ ids: [id], nodes: { documentId: id, nodeIds: [rootId] } }));
  const lines = message.split('\n\n')[0].split('\n');
  assert.match(lines[0], /^\[divlet\|project:[^|]+\|frames:1\|nodes:1\] about “.+?” with 1 selected element$/, 'counts in the header, one summary sentence after it');
  assert.equal(lines[1], 'frames:');
  assert.match(lines[2], /^- [\w-]+ · v\d+ · “.+?”$/, 'a frame list item: id, version, name');
  assert.equal(lines[3], `elements in ${id}:`);
  assert.match(lines[4], /^- \w+#[\w-]+/, 'an element list item: tag#id and its text');
  assert.deepEqual(lines.slice(5, 6), ['next:'], 'the block closes with what to do');
  assert.equal(message.split('\n\n').at(-1), 'Make it rounder', 'the request itself is last and untouched');
});

test('a frame name with a line break stays one list item', async t => {
  const { runtime } = await openFixture(t);
  const id = runtime.info().documents[0].id;
  await runtime.patch({ documentId: id, expectedVersion: runtime.info().documents[0].version, patch: { name: 'Home\npage' } });
  const block = runtime.askMessage('Hi', runtime.askContext({ ids: [id] })).split('\n\n')[0];
  assert.match(block, /^- .*· “Home page”$/m, 'the name is collapsed to one line');
});

test('a multi-line request keeps its own formatting after the block', async t => {
  const message = await askMessage(t, 'Two things:\n- tighter heading\n- calmer background');
  assert.ok(message.endsWith('\n\nTwo things:\n- tighter heading\n- calmer background'));
  assert.equal(message.split('\n\n').length, 2, 'the block never bleeds into the request');
});
