// The landing page is a repository artifact, not part of the package: one static folder, published to GitHub Pages by CI when its
// fingerprint changes. This test keeps it publishable — self-contained, local links only, and in step with the workflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { landingFiles, landingHash, copyLanding } from '../../scripts/landing-hash.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const landing = path.join(root, 'landing');
const read = name => readFile(path.join(landing, name), 'utf8');

test('the fingerprint covers exactly what is published, and is stable', async () => {
  const files = await landingFiles();
  assert.deepEqual(files, ['favicon.svg', 'index.html', 'landing.css'], 'the page and its two assets');
  assert.equal(files.includes('README.md'), false, 'the author note is not part of the site');
  const first = await landingHash();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(await landingHash(), first, 'the same folder fingerprints the same way');

  // A copy is the published set, byte for byte, keeping relative paths.
  const target = await mkdtemp(path.join(os.tmpdir(), 'divlet-landing-'));
  try {
    assert.deepEqual(await copyLanding(target), files);
    for (const name of files) assert.equal(await readFile(path.join(target, name), 'utf8'), await read(name), `${name} is copied unchanged`);
  } finally { await rm(target, { recursive: true, force: true }); }
});

test('the page is self-contained: nothing is fetched from anywhere', async () => {
  const html = await read('index.html');
  const external = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map(match => match[1])
    .filter(target => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target));
  assert.deepEqual(external, [], 'no absolute or remote references');
  // `./` is the page itself; everything else must be a file that ships beside it.
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map(match => match[1])
    .filter(target => !target.startsWith('#') && target !== './' && target !== '.');
  for (const target of refs) {
    const file = path.join(landing, target.split(/[?#]/)[0]);
    assert.ok((await readdir(landing)).includes(path.basename(file)), `a published file backs ${target}`);
  }
  assert.equal(/<script/i.test(html), false, 'no scripts');
  assert.equal(/<link[^>]+rel="stylesheet"[^>]+https?:/i.test(html), false, 'no remote stylesheet');

  const css = await read('landing.css');
  assert.equal(/@import|url\(\s*["']?(?:https?:|\/\/)/i.test(css), false, 'no remote font, image or stylesheet');
});

test('the page says what it is in the terms a crawler and a reader need', async () => {
  const html = await read('index.html');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, 'one first-level heading');
  assert.match(html, /<title>[^<]{8,}<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{40,}">/);
  assert.match(html, /<meta name="viewport"/);
  // Sections the navigation promises must exist.
  for (const [, id] of html.matchAll(/href="#([a-z]+)"/g)) assert.match(html, new RegExp(`id="${id}"`), `#${id} exists`);
});

test('installation examples distinguish the npm package from its commands and unpublished status', async () => {
  const html = await read('index.html');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const wrapper = JSON.parse(await readFile(path.join(root, 'packages/divlet-pi/package.json'), 'utf8'));
  assert.ok(html.includes(`npx -y ${pkg.name} ./my-project`), 'the CLI uses the product package');
  assert.ok(html.includes(`npx -y --package=${pkg.name} divlet-mcp --cwd ./my-project`), 'MCP selects the package explicitly');
  assert.ok(pkg.bin['divlet-mcp'], 'the package ships that server binary');
  assert.ok(html.includes(`pi install npm:${wrapper.name}`), 'Pi installs its host package');
  assert.match(html, /not yet published/, 'planned npm commands are not presented as available');
});

test('the workflow publishes this folder, by the same fingerprint, only when it changed', async () => {
  const workflow = YAML.parse(await readFile(path.join(root, '.github/workflows/landing.yml'), 'utf8'));
  const steps = workflow.jobs.publish.steps;
  const script = 'node scripts/landing-hash.mjs';
  assert.ok(steps.some(step => String(step.run).includes(`${script}`)), 'it fingerprints the folder with the shared script');
  assert.ok(steps.some(step => String(step.run).includes(`${script} --copy`)), 'and copies through the same module, so the published set cannot drift');
  assert.ok(steps.some(step => String(step.run).includes('.landing-hash')), 'the published branch records what it came from');
  assert.equal(workflow.permissions.contents, 'write', 'pushing the branch needs write access');
  assert.match(String(workflow.on.push.paths), /landing/);
  assert.ok(workflow.on.workflow_dispatch !== undefined, 'and it can be run by hand');

  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.files.includes('landing'), false, 'the landing page is not shipped inside the npm package');
});
