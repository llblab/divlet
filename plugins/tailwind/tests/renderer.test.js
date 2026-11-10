import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import draft, { createRenderer } from '../index.js';
import { rendererVersion } from '../lib/identity.ts';
import { compileClasses, resolveStyleEngine, setStyleEngines, styleEngine } from '../../../core/lib/engine.ts';

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-renderer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function packageAt(root, name, version, dependencies = {}) {
  const directory = path.join(root, 'node_modules', name);
  await fs.mkdir(directory, { recursive: true });
  // package.json is deliberately not exported, as with @tailwindcss/node.
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, dependencies, exports: { '.': { style: './index.css', default: './index.js' } } }));
  await fs.writeFile(path.join(directory, 'index.js'), 'throw new Error("Identity discovery must not execute dependency code");');
  return directory;
}

async function installation(root) {
  const node = await packageAt(root, '@tailwindcss/node', '10.0.0', { transitive: '^1.0.0', tailwindcss: '^10.0.0' });
  const css = await packageAt(root, 'tailwindcss', '10.0.0');
  await packageAt(root, 'transitive', '1.0.0');
  const selected = await packageAt(node, 'transitive', '1.1.0');
  for (const name of ['index.css', 'theme.css', 'preflight.css', 'utilities.css']) await fs.writeFile(path.join(css, name), `/* ${name} */`);
  const anchor = path.join(root, 'provider.js');
  await fs.writeFile(anchor, '');
  return { from: pathToFileURL(anchor), node, css, selected };
}

test('renderer identity is portable and follows installed transitive resolution, not requested ranges', async t => {
  const a = await temporary(t), b = await temporary(t);
  const first = await installation(a), second = await installation(b);
  const version = rendererVersion(first.from);
  assert.match(version, /^divlet-tailwind-1-[a-f0-9]{64}$/);
  assert.ok(version.length <= 128);
  assert.equal(rendererVersion(second.from), version);
  // A shadowed hoisted copy and a changed requested range do not change the selected implementation.
  await packageAt(a, 'transitive', '99.0.0');
  await packageAt(a, '@tailwindcss/node', '10.0.0', { transitive: '>=1.0.0', tailwindcss: '*' });
  assert.equal(rendererVersion(first.from), version);
  await packageAt(first.node, 'transitive', '1.2.0');
  assert.notEqual(rendererVersion(first.from), version);
});

test('renderer identity includes the compiler and each owned stylesheet, and refuses incomplete installations', async t => {
  const root = await temporary(t);
  const fixture = await installation(root);
  const original = rendererVersion(fixture.from);
  await packageAt(root, '@tailwindcss/node', '10.0.1', { transitive: '^1.0.0', tailwindcss: '^10.0.0' });
  assert.notEqual(rendererVersion(fixture.from), original);
  await packageAt(root, '@tailwindcss/node', '10.0.0', { transitive: '^1.0.0', tailwindcss: '^10.0.0' });
  assert.equal(rendererVersion(fixture.from), original);
  for (const name of ['index.css', 'theme.css', 'preflight.css', 'utilities.css']) {
    const file = path.join(fixture.css, name);
    const bytes = await fs.readFile(file);
    await fs.appendFile(file, '\n/* changed */');
    assert.notEqual(rendererVersion(fixture.from), original, name);
    await fs.writeFile(file, bytes);
  }
  await fs.rm(fixture.selected, { recursive: true });
  assert.notEqual(rendererVersion(fixture.from), original, 'removing a nested copy selects a different installed version');
  await fs.rm(path.join(root, 'node_modules/transitive'), { recursive: true });
  assert.throws(() => rendererVersion(fixture.from), { code: 'RENDERER_IDENTITY_UNAVAILABLE' });
});

test('versioned compilation is provider-owned while draft compilation retains its ambient stylesheet behavior', async t => {
  const root = await temporary(t);
  const shadow = await packageAt(root, 'tailwindcss', '0.0.0');
  await fs.writeFile(path.join(shadow, 'index.css'), '@theme { --color-shadow-probe: #010203; }\n@tailwind utilities;');
  const renderer = createRenderer();
  const original = styleEngine();
  t.after(() => setStyleEngines([original]));
  setStyleEngines([draft, renderer]);
  const required = Object.freeze({ id: renderer.id, version: renderer.version });
  const candidates = Object.freeze(['p-4', 'hover:bg-red-500', 'bg-shadow-probe', 'bg-[url(assets/local.svg)]']);
  const tokens = Object.freeze({ '--color-brand': '#abcdef' });
  assert.equal(resolveStyleEngine(required), renderer);
  const normal = await draft.compileClasses(tokens, candidates, process.cwd());
  const pinned = await compileClasses(tokens, candidates, root, required);
  assert.equal(pinned, normal);
  assert.ok(pinned.includes('assets/local.svg'));
  assert.ok(!pinned.includes('bg-shadow-probe'));
  const ambient = await compileClasses(tokens, candidates, root);
  assert.ok(ambient.includes('bg-shadow-probe'));
  assert.notEqual(ambient, pinned);
  assert.equal(styleEngine(), draft);
  assert.equal(draft.version, undefined);
  assert.equal(createRenderer().version, renderer.version);
});
