// Freeze and publish one aligned five-package release. npm owns OIDC; this script never handles npm credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = 'https://registry.npmjs.org';
export const packages = ['web', 'core', 'cli', 'mcp', 'pi'].map(id => ({ name: `@divlet/${id}`, directory: id === 'core' ? '.' : id }));

export function releaseVersion(tag) {
  assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Use a stable release tag such as v0.0.2.');
  return tag.slice(1);
}

export function validatePackages(manifests, version) {
  assert.equal(manifests.length, packages.length);
  manifests.forEach((pkg, i) => {
    assert.equal(pkg.name, packages[i].name);
    assert.equal(pkg.version, version, `${pkg.name}: align all five versions before release`);
    assert.notEqual(pkg.private, true);
    assert.equal(pkg.repository?.url, 'git+https://github.com/llblab/divlet.git');
    if (i === 1) assert.equal(pkg.dependencies?.['@divlet/web'], version);
    if (i > 1) assert.equal(pkg.dependencies?.['@divlet/core'], version);
  });
  assert.deepEqual(manifests[0].dependencies ?? {}, {}, 'web has no runtime dependencies');
}

export function validateLockfile(lock, manifests, version) {
  assert.equal(lock.version, version);
  manifests.forEach((pkg, i) => {
    const entry = lock.packages[packages[i].directory === '.' ? '' : packages[i].directory];
    assert.equal(entry?.version, version, `${pkg.name}: update workspace lock metadata`);
    if (i) assert.equal(entry.dependencies?.[i === 1 ? '@divlet/web' : '@divlet/core'], version);
  });
}

export function validateCandidate(candidate, tag, commit) {
  const version = releaseVersion(tag);
  assert.equal(candidate.tag, tag);
  assert.equal(candidate.version, version);
  assert.equal(candidate.commit, commit, 'The tag moved or the artifact belongs to another commit.');
  assert.equal(candidate.packages.length, packages.length);
  candidate.packages.forEach((pkg, i) => {
    assert.equal(pkg.name, packages[i].name);
    assert.equal(pkg.version, version);
    assert.equal(pkg.filename, `divlet-${packages[i].name.split('/')[1]}-${version}.tgz`);
    assert.match(pkg.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  });
}

export function publicationContext(env) {
  assert.equal(env.GITHUB_REPOSITORY, 'llblab/divlet');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Dispatch the workflow from main.');
  assert.equal(env.GITHUB_WORKFLOW_REF, 'llblab/divlet/.github/workflows/release.yml@refs/heads/main');
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'Do not rerun publication jobs; review the original attempt and artifacts.');
  assert.match(env.GITHUB_RUN_ID ?? '', /^\d+$/);
  assert.ok(env.GH_TOKEN, 'A read-only GitHub Actions token is required to inspect prior attempts.');
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'OIDC is required.');
  assert.ok(!env.NPM_TOKEN && !env.NODE_AUTH_TOKEN, 'Do not supply long-lived npm tokens.');
}

export async function refusePriorPublication(tag, runId, get) {
  // Runs survive artifact/log expiration. Never infer permission to replay an unknown upload from registry 404s.
  for (let page = 1; ; page++) {
    const runs = (await get(`actions/workflows/release.yml/runs?per_page=100&page=${page}`)).workflow_runs;
    assert.ok(Array.isArray(runs));
    for (const run of runs) {
      if (String(run.id) === runId || run.display_title !== `npm ${tag}`) continue;
      for (let jobPage = 1; ; jobPage++) {
        const jobs = (await get(`actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${jobPage}`)).jobs;
        assert.ok(Array.isArray(jobs));
        assert.ok(!jobs.some(job => job.name === 'Publish npm' && job.status !== 'queued' && job.conclusion !== 'skipped'), `Publication already started in run ${run.id}; inspect it and recover explicitly, never replay blindly.`);
        if (jobs.length < 100) break;
      }
    }
    if (runs.length < 100) break;
  }
}

function newer(version, previous) {
  releaseVersion(`v${previous}`);
  const a = version.split('.').map(BigInt), b = previous.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export async function publishCandidate(candidate, { inspect, publish, save, wait = pause, waitMs = 600000 }) {
  const progress = { tag: candidate.tag, commit: candidate.commit, packages: {} };
  const absent = async pkg => {
    const { exact, latest } = await inspect(pkg);
    assert.equal(exact, null, `${pkg.name}@${pkg.version} already exists; no automatic overwrite, skip or partial-release replay.`);
    if (latest) assert.ok(newer(pkg.version, latest.version), `${pkg.name}: refusing to move latest backwards or repeat a version`);
  };
  const checkpoint = async (pkg, state) => {
    progress.packages[pkg.name] = { version: pkg.version, integrity: pkg.integrity, state, checkedAt: new Date().toISOString() };
    await save(progress);
  };
  for (const pkg of candidate.packages) await absent(pkg);
  for (const pkg of candidate.packages) {
    await absent(pkg);
    await checkpoint(pkg, 'attempt_started');
    await publish(pkg);
    await checkpoint(pkg, 'npm_accepted');
    const deadline = Date.now() + waitMs;
    for (;;) {
      const { exact } = await inspect(pkg);
      if (exact) {
        assert.equal(exact.name, pkg.name);
        assert.equal(exact.version, pkg.version);
        assert.equal(exact.dist?.integrity, pkg.integrity, `${pkg.name}: registry bytes differ from the frozen archive`);
        await checkpoint(pkg, 'registry_verified');
        break;
      }
      assert.ok(Date.now() < deadline, `${pkg.name}: accepted upload not visible; retain checkpoint and stop, never upload again`);
      await wait(Math.min(15000, deadline - Date.now()));
    }
  }
  return progress;
}

export function publicationArguments(archive) {
  return ['publish', archive, '--ignore-scripts', '--fetch-retries=0', '--access=public', '--provenance', '--tag=latest', `--registry=${registry}/`];
}

function tagCommit(tag) {
  releaseVersion(tag);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = git(['rev-parse', `refs/tags/${tag}^{commit}`]);
  assert.equal(commit, git(['rev-parse', 'HEAD']), 'Release tag must name the dispatched main commit so npm provenance names the actual source.');
  if (process.env.GITHUB_SHA) assert.equal(commit, process.env.GITHUB_SHA);
  return commit;
}

async function digest(file) {
  assert.ok((await lstat(file)).isFile(), `Not a regular archive: ${file}`);
  return `sha512-${createHash('sha512').update(await readFile(file)).digest('base64')}`;
}

async function prepare(tag, directory) {
  const version = releaseVersion(tag), commit = tagCommit(tag);
  const manifests = await Promise.all(packages.map(async pkg => JSON.parse(await readFile(path.join(root, pkg.directory, 'package.json'), 'utf8'))));
  validatePackages(manifests, version);
  validateLockfile(JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8')), manifests, version);
  await mkdir(directory, { recursive: true });
  const frozen = [];
  for (const pkg of packages) {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--workspaces=false', '--json', '--pack-destination', directory], { cwd: path.join(root, pkg.directory), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))[0];
    assert.equal(packed.name, pkg.name); assert.equal(packed.version, version);
    assert.equal(await digest(path.join(directory, packed.filename)), packed.integrity);
    frozen.push({ name: pkg.name, version, filename: packed.filename, integrity: packed.integrity });
  }
  const candidate = { tag, version, commit, packages: frozen };
  validateCandidate(candidate, tag, commit);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(candidate, null, 2) + '\n');
}

async function json(url, headers = {}, missing = false) {
  const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache', ...headers }, signal: AbortSignal.timeout(20000) });
  if (missing && response.status === 404) return null;
  assert.ok(response.ok, `Read failed (${response.status}): ${url}`);
  return response.json();
}

async function main() {
  const [command, tag, destination, ...extra] = process.argv.slice(2);
  assert.ok(['prepare', 'publish'].includes(command) && destination && !extra.length, 'Usage: npm-release.mjs prepare|publish vX.Y.Z DIRECTORY');
  const directory = path.resolve(destination);
  if (command === 'prepare') return prepare(tag, directory);
  publicationContext(process.env);
  const commit = tagCommit(tag);
  const candidate = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  validateCandidate(candidate, tag, commit);
  for (const pkg of candidate.packages) assert.equal(await digest(path.join(directory, pkg.filename)), pkg.integrity, 'Frozen archive was modified.');
  await refusePriorPublication(tag, process.env.GITHUB_RUN_ID, route => json(`https://api.github.com/repos/llblab/divlet/${route}`, { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' }));
  const { GH_TOKEN, GITHUB_TOKEN, ...npmEnv } = process.env;
  await publishCandidate(candidate, {
    inspect: async pkg => {
      const base = `${registry}/${encodeURIComponent(pkg.name)}`;
      return { exact: await json(`${base}/${pkg.version}`, {}, true), latest: await json(`${base}/latest`, {}, true) };
    },
    publish: pkg => execFileSync('npm', publicationArguments(path.join(directory, pkg.filename)), { cwd: directory, env: npmEnv, stdio: 'inherit', timeout: 180000 }),
    save: async progress => {
      const file = path.join(directory, 'publication-progress.json');
      await writeFile(`${file}.tmp`, JSON.stringify(progress, null, 2) + '\n');
      await rename(`${file}.tmp`, file);
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
