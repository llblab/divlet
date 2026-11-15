import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import draft, { createRenderer } from '../index.js';
import { rendererVersion, rendererSource } from '../lib/identity.ts';
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
  const node = await packageAt(root, '@tailwindcss/node', '10.0.0');
  const css = await packageAt(root, 'tailwindcss', '10.0.0', { transitive: '^1.0.0' });
  const parser = await packageAt(root, 'postcss', '10.0.0');
  await packageAt(root, 'transitive', '1.0.0');
  const selected = await packageAt(css, 'transitive', '1.1.0');
  for (const name of ['index.css', 'theme.css', 'preflight.css', 'utilities.css']) await fs.writeFile(path.join(css, name), `/* ${name} */`);
  const anchor = path.join(root, 'provider.js');
  await fs.writeFile(anchor, '');
  return { from: pathToFileURL(anchor), node, css, parser, selected };
}

test('renderer identity is portable and follows installed transitive resolution, not requested ranges', async t => {
  const a = await temporary(t), b = await temporary(t);
  const first = await installation(a), second = await installation(b);
  const version = rendererVersion(first.from);
  assert.match(version, /^divlet-tailwind-2-[a-f0-9]{64}$/);
  assert.ok(version.length <= 128);
  assert.equal(rendererVersion(second.from), version);
  // A shadowed hoisted copy and a changed requested range do not change the selected implementation.
  await packageAt(a, 'transitive', '99.0.0');
  await packageAt(a, 'tailwindcss', '10.0.0', { transitive: '*' });
  await packageAt(a, '@tailwindcss/node', '99.0.0');
  assert.equal(rendererVersion(first.from), version, 'the legacy wrapper is not a versioned compiler input');
  await packageAt(first.css, 'transitive', '1.2.0');
  assert.notEqual(rendererVersion(first.from), version);
});

test('renderer identity includes the compiler and each owned stylesheet, and refuses incomplete installations', async t => {
  const root = await temporary(t);
  const fixture = await installation(root);
  const original = rendererVersion(fixture.from);
  for (const name of ['tailwindcss', 'postcss']) {
    const dependencies = name === 'tailwindcss' ? { transitive: '^1.0.0' } : {};
    await packageAt(root, name, '10.0.1', dependencies);
    assert.notEqual(rendererVersion(fixture.from), original, name);
    await packageAt(root, name, '10.0.0', dependencies);
    assert.equal(rendererVersion(fixture.from), original);
  }
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

test('renderer source captures the exact hashed stylesheet bytes once and does not require the legacy wrapper', async t => {
  const root = await temporary(t), fixture = await installation(root);
  const source = rendererSource(fixture.from);
  assert.equal(source.version, rendererVersion(fixture.from));
  assert.equal(Object.isFrozen(source) && Object.isFrozen(source.stylesheets), true);
  for (const [name, content] of Object.entries(source.stylesheets)) assert.equal(content, await fs.readFile(path.join(fixture.css, name), 'utf8'));
  await fs.rm(fixture.node, { recursive: true });
  assert.equal(rendererVersion(fixture.from), source.version, 'capture never depends on or executes the legacy Node wrapper');
  await fs.appendFile(path.join(fixture.css, 'index.css'), '\n/* changed after capture */');
  const next = rendererSource(fixture.from);
  assert.notEqual(next.version, source.version);
  assert.notEqual(next.stylesheets['index.css'], source.stylesheets['index.css']);
  assert.equal(source.stylesheets['index.css'], '/* index.css */', 'the old selector remains bound to its old CSS snapshot');
});

test('identity diagnostics capture the real recipe and selected manifests without a second hash algorithm', () => {
  const probe = fileURLToPath(new URL('./fixtures/renderer-probe.mjs', import.meta.url));
  const entry = fileURLToPath(new URL('../lib/renderer.ts', import.meta.url));
  const report = JSON.parse(execFileSync(process.execPath, [probe, entry], { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 30000 }));
  assert.equal(report.version, createRenderer().version);
  assert.equal(report.inputs.policy, 'divlet-tailwind-2');
  assert.equal(report.inputs.stylesheets.length, 4);
  for (const [name, version] of report.inputs.roots) assert.ok(report.manifests.some(manifest => manifest.name === name && manifest.version === version));
  for (const manifest of report.manifests) assert.equal(JSON.stringify(report.inputs).includes(manifest.file), false, 'installation paths are diagnostics, not identity');
  assert.match(report.cssHash, /^[a-f0-9]{64}$/);
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
