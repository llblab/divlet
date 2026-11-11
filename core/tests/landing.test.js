// The source is a native project; Pages receives only its prepared public artifact, never a second authored HTML tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import YAML from 'yaml';
import { readProject, writeProject } from '../lib/project.ts';
import { encodeHtml, decodeHtml } from '../lib/codec.ts';
import { landingSource, landingDirectory, landingFiles, landingHash, copyLanding } from '../../scripts/landing-hash.mjs';
import { checkLanding, buildLanding } from '../../scripts/landing-build.mjs';
import { OutputStore } from '../lib/output.ts';
import { openRuntime } from '../lib/runtime.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = name => fs.readFile(path.join(landingDirectory, name), 'utf8');
const elements = node => [...(node.tagName ? [node] : []), ...(node.childNodes ?? []).flatMap(elements)];
const attr = (node, name) => node.attrs.find(item => item.name === name)?.value;
const fixture = async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-landing-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.copyFile(landingSource, path.join(directory, 'landing.divlet'));
  const store = new OutputStore(landingSource), manifest = await store.manifest();
  for (const name of ['.divlet-build.json', ...Object.keys(manifest.files)]) {
    const file = path.join(directory, '.divlet/landing', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, await store.read(name), { flag: 'wx' });
  }
  return { directory, source: path.join(directory, 'landing.divlet'), output: path.join(directory, '.divlet/landing') };
};

test('the native landing reopens and reproduces its relocated owned cache without source or cache edits', async () => {
  const source = await fs.readFile(landingSource, 'utf8');
  const project = readProject(JSON.parse(source));
  assert.deepEqual(project.frames.map(frame => frame.id), ['index']);
  assert.equal(writeProject(project.settings, project.frames), source);
  assert.deepEqual(decodeHtml(encodeHtml(project.frames[0])), project.frames[0]);
  assert.match(project.frames[0].head.description, /local browser layout board/);
  assert.match(project.frames[0].head.icon, /^data:image\/svg\+xml;base64,/);
  const before = await landingHash();
  await checkLanding();
  assert.equal(await fs.readFile(landingSource, 'utf8'), source);
  assert.equal(await landingHash(), before);
});

test('fingerprint and copy share the exact public bytes, including the Pages marker but not sidecars', async t => {
  const files = await landingFiles(), hash = await landingHash();
  assert.deepEqual(files.filter(name => !name.startsWith('_assets/')), ['.nojekyll', 'index.html']);
  assert.deepEqual(files, ['.nojekyll', 'index.html'], 'the self-contained source needs no separately materialized favicon');
  assert.match(hash, /^[a-f0-9]{64}$/); assert.equal(await landingHash(), hash);
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-pages-copy-'));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  assert.deepEqual(await copyLanding(target), files);
  for (const name of files) assert.deepEqual(await fs.readFile(path.join(target, name)), name === '.nojekyll' ? Buffer.alloc(0) : await fs.readFile(path.join(landingDirectory, name)));
  await assert.rejects(() => copyLanding(target), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(path.join(target, 'index.html')), await fs.readFile(path.join(landingDirectory, 'index.html')));
});

test('the public set still includes separately owned portable resources and verifies their bytes', async t => {
  const { source, output } = await fixture(t);
  const project = JSON.parse(await fs.readFile(source, 'utf8'));
  const prefix = 'data:image/svg+xml;base64,';
  await fs.writeFile(path.join(path.dirname(source), 'icon.svg'), Buffer.from(project.frames[0].head.icon.slice(prefix.length), 'base64'));
  project.frames[0].head.icon = 'icon.svg';
  await fs.writeFile(source, JSON.stringify(project, null, 2) + '\n');
  const runtime = await openRuntime({ file: source, watch: false, createDemo: false });
  t.after(() => runtime.close());
  const files = await landingFiles(output), resource = files.find(name => /^_assets\/.+-icon\.svg$/.test(name));
  assert.ok(resource, 'embedded examples must not remove public-set support for ordinary file resources');
  const before = await landingHash(output);
  assert.match(before, /^[a-f0-9]{64}$/);
  await fs.appendFile(path.join(output, resource), '<!-- hand edit -->');
  await assert.rejects(() => landingHash(output), /hand-edited/);
});

test('private and unowned output is never published; hand-edited owned output is refused', async t => {
  const { output } = await fixture(t), before = await landingHash(output);
  await fs.mkdir(path.join(output, '_assets'), { recursive: true });
  for (const name of ['secret.txt', 'index.meta.json.backup', '_assets/not-owned.svg', '.divlet-write.lock']) {
    await fs.writeFile(path.join(output, name), 'private');
  }
  await fs.mkdir(path.join(output, '.trash')); await fs.writeFile(path.join(output, '.trash/old.html'), 'private');
  assert.equal(await landingHash(output), before);
  assert.ok(!(await landingFiles(output)).some(name => /private|meta\.json|secret|not-owned|trash|lock/.test(name)));
  await fs.appendFile(path.join(output, 'index.html'), '<!-- hand edit -->');
  await assert.rejects(() => landingHash(output), /hand-edited/);
});

test('the generated page keeps crawler metadata, real section links and a self-contained resource graph', async () => {
  const html = await read('index.html'), nodes = elements(parse(html));
  assert.match(html, /^<!doctype html>/i);
  assert.equal(attr(nodes.find(node => node.tagName === 'html'), 'lang'), 'en');
  assert.equal(nodes.filter(node => node.tagName === 'h1').length, 1);
  assert.ok(nodes.find(node => node.tagName === 'title').childNodes[0].value.length > 8);
  assert.ok(nodes.some(node => node.tagName === 'meta' && attr(node, 'name') === 'description' && attr(node, 'content').length > 40));
  assert.ok(nodes.some(node => node.tagName === 'meta' && attr(node, 'name') === 'viewport'));
  assert.ok(nodes.some(node => node.tagName === 'link' && attr(node, 'rel') === 'icon'));
  assert.equal(nodes.some(node => node.tagName === 'script' || node.tagName === 'base'), false);
  const files = new Set(await landingFiles());
  for (const node of nodes) for (const item of node.attrs) {
    if (!['src', 'href'].includes(item.name)) continue;
    if (item.value.startsWith('data:')) {
      assert.equal(node.tagName, 'link'); assert.equal(attr(node, 'rel'), 'icon');
      assert.match(item.value, /^data:image\/svg\+xml;base64,/);
      continue;
    }
    assert.ok(!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(item.value), `no external request: ${item.value}`);
    if (item.value.startsWith('#')) assert.equal(nodes.filter(target => attr(target, 'id') === item.value.slice(1)).length, 1, `unique target for ${item.value}`);
    else assert.ok(files.has(item.value.split(/[?#]/)[0]), `published file backs ${item.value}`);
  }
  assert.equal(/@import|url\(\s*["']?(?:https?:|\/\/)/i.test(html), false);
  assert.equal(/two-way sync|One click in History reverts/.test(html), false, 'no claims of unimplemented reverse editing or row navigation');
});

test('installation examples distinguish packages, commands and unpublished status', async () => {
  const html = await read('index.html');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const wrapper = JSON.parse(await fs.readFile(path.join(root, 'packages/pi/package.json'), 'utf8'));
  assert.ok(html.includes('npx -y @divlet/cli ./my-project'));
  assert.ok(html.includes('npx -y @divlet/mcp --cwd ./my-project'));
  assert.ok(html.includes(`pi install npm:${wrapper.name}`));
  assert.match(html, /not yet published/);
});

test('freshness refuses source/embedded-resource drift and metadata-only rebuilds do not change the public fingerprint', async t => {
  const { source, output } = await fixture(t), original = await landingHash(output);
  const project = JSON.parse(await fs.readFile(source, 'utf8'));
  project.frames[0].metadata.reviewNote = 'Not public content';
  await fs.writeFile(source, JSON.stringify(project, null, 2) + '\n');
  await assert.rejects(() => checkLanding(source), /cache is stale/);
  await buildLanding(source);
  assert.equal(await landingHash(output), original, 'sidecar/ownership changes cannot trigger deployment commits');
  const prefix = 'data:image/svg+xml;base64,';
  const icon = Buffer.from(project.frames[0].head.icon.slice(prefix.length), 'base64').toString('utf8');
  project.frames[0].head.icon = prefix + Buffer.from(icon.replace('#5b5bf0', '#3737f0')).toString('base64');
  await fs.writeFile(source, JSON.stringify(project, null, 2) + '\n');
  await assert.rejects(() => checkLanding(source), /cache is stale/);
  await buildLanding(source);
  assert.notEqual(await landingHash(output), original, 'published resource bytes participate in the fingerprint');
});

test('CI verifies then copies the prepared public set without compiling a different page in the publication step', async () => {
  const workflow = YAML.parse(await fs.readFile(path.join(root, '.github/workflows/landing.yml'), 'utf8'));
  const steps = workflow.jobs.publish.steps, publish = steps.find(step => step.name === 'Publish');
  assert.ok(steps.some(step => step.run === 'npm run landing:check'));
  assert.equal(steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'], 22);
  const contracts = steps.find(step => step.name === 'Test landing and resource contracts').run;
  assert.match(contracts, /npm run typecheck/);
  for (const file of ['core/tests/landing.test.js', 'web/tests/icons.test.js', 'core/tests/data-urls.test.js']) assert.ok(contracts.includes(file));
  assert.ok(steps.some(step => String(step.run).includes('node scripts/landing-hash.mjs')));
  assert.match(publish.run, /node scripts\/landing-hash\.mjs --copy/);
  assert.match(publish.run, /test "\$copied_hash"/);
  assert.equal(/landing:build|sed |index\.html/.test(publish.run), false);
  assert.equal(workflow.permissions.contents, 'write');
  assert.ok(workflow.on.push.paths.includes('examples/landing/**'), 'nested source, favicon and prepared cache trigger CI');
  assert.equal(workflow.on.push.paths.some(value => /examples\/(?:assets|\.divlet)/.test(value)), false, 'retired landing locations do not drive publication');
  assert.equal(landingSource, path.join(root, 'examples/landing/landing.divlet'));
  assert.equal(landingDirectory, path.join(path.dirname(landingSource), '.divlet/landing'));
  assert.ok(workflow.on.workflow_dispatch !== undefined);
  assert.match(publish.if, /outputs.hash !=/);
  const ignores = await fs.readFile(path.join(root, 'examples/.npmignore'), 'utf8');
  assert.match(ignores, /^\.divlet\/$/m, 'npm keeps source and authored assets, not the tracked repository cache');
});
