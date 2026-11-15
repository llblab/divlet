import test from 'node:test';
import assert from 'node:assert/strict';
import { rendererSource } from '../lib/identity.ts';
import { createRenderer } from '../lib/renderer.ts';
import { createRendererFromSource } from '../lib/renderer-profile.ts';
import type { ResolvedStyleEngine } from '../../../core/lib/engine.ts';

const source = rendererSource();
const portable: ResolvedStyleEngine = createRendererFromSource(source);
const node: ResolvedStyleEngine = createRenderer();

test('Node and portable descriptors bind the same policy-2 source and compiler contract', async () => {
  assert.equal(portable.id, node.id); assert.equal(portable.version, node.version);
  assert.match(portable.version, /^divlet-tailwind-2-[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(portable), true);
  assert.deepEqual(Object.keys(portable).sort(), ['compileClasses', 'id', 'kind', 'label', 'version']);
  const tokens = { '--color-brand': '#123456' }, candidates = ['p-[37px]', 'hover:bg-brand'];
  assert.equal(await portable.compileClasses(tokens, candidates, 'untrusted-consumer-base'), await node.compileClasses(tokens, candidates, 'another-consumer-base'));
});

test('descriptor metadata and compilation stay bound when caller-owned source objects change', async () => {
  const mutable = { version: source.version, stylesheets: { ...source.stylesheets } }, renderer = createRendererFromSource(mutable);
  const before = await renderer.compileClasses({}, ['p-[37px]']);
  mutable.version = 'changed-by-caller'; mutable.stylesheets['index.css'] = '@plugin "unrequested";';
  assert.equal(renderer.version, source.version);
  assert.equal(await renderer.compileClasses({}, ['p-[37px]']), before);
});
