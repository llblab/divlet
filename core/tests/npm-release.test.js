import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { packages, releaseVersion, validatePackages, validateLockfile, validateCandidate, publicationContext, refusePriorPublication, publishCandidate, publicationArguments } from '../../scripts/npm-release.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
const candidate = () => ({ tag: 'v0.0.2', version: '0.0.2', commit: 'a'.repeat(40), packages: packages.map(pkg => ({ name: pkg.name, version: '0.0.2', filename: `${pkg.name.slice(1).replace('/', '-')}-0.0.2.tgz`, integrity })) });
const manifests = () => packages.map((pkg, i) => ({ name: pkg.name, version: '0.0.2', repository: { url: 'git+https://github.com/llblab/divlet.git' }, ...(i ? { dependencies: { [i === 1 ? '@divlet/web' : '@divlet/core']: '0.0.2' } } : {}) }));

test('stable aligned releases require exact internal pins, package ownership and safe frozen filenames', () => {
  assert.equal(releaseVersion('v0.0.2'), '0.0.2');
  for (const tag of ['0.0.2', 'v00.0.2', 'v0.0.2-beta', 'v0.0.2\n', 'v1;echo unsafe']) assert.throws(() => releaseVersion(tag));
  validatePackages(manifests(), '0.0.2');
  for (const change of [p => { p[2].version = '0.0.1'; }, p => { p[1].dependencies['@divlet/web'] = '^0.0.2'; }, p => { p[0].dependencies = { '@divlet/core': '0.0.2' }; }, p => { p[4].repository.url = 'git+https://github.com/other/divlet.git'; }]) {
    const p = manifests(); change(p); assert.throws(() => validatePackages(p, '0.0.2'));
  }
  const lock = { version: '0.0.2', packages: Object.fromEntries(manifests().map((pkg, i) => [packages[i].directory === '.' ? '' : packages[i].directory, pkg])) };
  validateLockfile(lock, manifests(), '0.0.2');
  lock.packages.pi.version = '0.0.1';
  assert.throws(() => validateLockfile(lock, manifests(), '0.0.2'));
  const valid = candidate(); validateCandidate(valid, valid.tag, valid.commit);
  for (const change of [p => { p.commit = 'b'.repeat(40); }, p => { p.packages.reverse(); }, p => { p.packages[0].filename = '../outside.tgz'; }, p => { p.packages.push(p.packages[0]); }, p => { p.packages[0].integrity = 'unverified'; }]) {
    const p = candidate(); change(p); assert.throws(() => validateCandidate(p, valid.tag, valid.commit));
  }
});

test('publisher accepts only the named main workflow, first attempt and OIDC without npm tokens', () => {
  const env = { GITHUB_REPOSITORY: 'llblab/divlet', GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'llblab/divlet/.github/workflows/release.yml@refs/heads/main', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123', GH_TOKEN: 'test-read-token', ACTIONS_ID_TOKEN_REQUEST_URL: 'test', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test' };
  publicationContext(env);
  for (const [key, value] of [['GITHUB_REPOSITORY', 'fork/divlet'], ['GITHUB_REF', 'refs/heads/dev'], ['GITHUB_WORKFLOW_REF', 'other.yml'], ['GITHUB_RUN_ATTEMPT', '2'], ['GH_TOKEN', ''], ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', ''], ['NPM_TOKEN', 'do-not-use'], ['NODE_AUTH_TOKEN', 'do-not-use']]) assert.throws(() => publicationContext({ ...env, [key]: value }));
});

test('prior-publication guard paginates runs and all job attempts; skipped validation is not publication', async () => {
  const calls = [];
  const get = async route => {
    calls.push(route);
    if (route.endsWith('page=1') && route.includes('/workflows/')) return { workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: i, display_title: 'another release' })) };
    if (route.includes('/workflows/')) return { workflow_runs: [{ id: 456, display_title: 'npm v0.0.2' }] };
    return { jobs: [{ name: 'Publish npm', status: 'completed', conclusion: 'failure' }] };
  };
  await assert.rejects(refusePriorPublication('v0.0.2', '123', get), /Publication already started in run 456/);
  assert.ok(calls.some(route => route.endsWith('page=2')));
  assert.ok(calls.some(route => route.includes('filter=all')));
  await refusePriorPublication('v0.0.2', '123', async route => route.includes('/workflows/') ? { workflow_runs: [{ id: 123, display_title: 'npm v0.0.2' }, { id: 124, display_title: 'npm v0.0.2' }] } : { jobs: [{ name: 'Publish npm', status: 'completed', conclusion: 'skipped' }] });
});

test('all-package preflight precedes uploads; checkpoints enclose serial web/core/adapter publication', async () => {
  const p = candidate(), uploaded = [], saves = [], visible = new Map();
  const result = await publishCandidate(p, {
    inspect: async pkg => ({ exact: visible.get(pkg.name) ?? null, latest: { version: '0.0.1' } }),
    save: async state => saves.push(structuredClone(state)),
    publish: async pkg => {
      assert.equal(saves.at(-1).packages[pkg.name].state, 'attempt_started');
      uploaded.push(pkg.name); visible.set(pkg.name, { ...pkg, dist: { integrity: pkg.integrity } });
    },
  });
  assert.deepEqual(uploaded, packages.map(pkg => pkg.name));
  assert.equal(saves.length, 15);
  assert.deepEqual(Object.values(result.packages).map(pkg => pkg.state), Array(5).fill('registry_verified'));
  for (const existing of [true, false]) await assert.rejects(publishCandidate(p, {
    inspect: async pkg => ({ exact: existing && pkg.name === '@divlet/pi' ? { version: '0.0.2' } : null, latest: { version: existing ? '0.0.1' : '0.0.3' } }),
    publish: async () => assert.fail('no upload before all five preflights pass'), save: async () => assert.fail('no attempt before preflight'),
  }));
});

test('uncertain command failure, accepted+404 and mismatching registry bytes stop without another upload', async () => {
  for (const mode of ['command-failure', 'not-visible', 'different-bytes', 'read-failure']) {
    let uploaded = 0, last;
    await assert.rejects(publishCandidate(candidate(), {
      inspect: async pkg => {
        if (uploaded && mode === 'read-failure') throw new Error('registry unavailable');
        return { exact: uploaded && mode === 'different-bytes' ? { name: pkg.name, version: pkg.version, dist: { integrity: 'wrong' } } : null, latest: null };
      },
      publish: async () => { uploaded++; if (mode === 'command-failure') throw new Error('unknown command outcome'); },
      save: async state => { last = structuredClone(state); }, waitMs: 0,
    }));
    assert.equal(uploaded, 1, mode);
    assert.equal(last.packages['@divlet/web'].state, mode === 'command-failure' ? 'attempt_started' : 'npm_accepted');
    assert.deepEqual(Object.keys(last.packages), ['@divlet/web']);
  }
});

test('prepare freezes real tarballs without lifecycle scripts and rejects a tag that is not HEAD', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'divlet-npm-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'scripts'));
  await copyFile(path.join(root, 'scripts/npm-release.mjs'), path.join(directory, 'scripts/npm-release.mjs'));
  for (const [i, pkg] of manifests().entries()) {
    const dir = path.join(directory, packages[i].directory);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, files: ['index.js'], scripts: { prepack: 'node -e "process.exit(33)"' } }));
    await writeFile(path.join(dir, 'index.js'), 'export const fixture = true;\n');
  }
  await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version: '0.0.2', packages: Object.fromEntries(manifests().map((pkg, i) => [packages[i].directory === '.' ? '' : packages[i].directory, pkg])) }));
  const git = args => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  git(['init', '--quiet']); git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']); git(['tag', 'v0.0.2']);
  const out = path.join(directory, 'candidate');
  execFileSync(process.execPath, ['scripts/npm-release.mjs', 'prepare', 'v0.0.2', out], { cwd: directory, env: { ...process.env, GITHUB_SHA: '' }, stdio: 'pipe' });
  const frozen = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
  validateCandidate(frozen, 'v0.0.2', git(['rev-parse', 'HEAD']).toString().trim());
  for (const pkg of frozen.packages) assert.equal(pkg.integrity, `sha512-${createHash('sha512').update(await readFile(path.join(out, pkg.filename))).digest('base64')}`);
  await writeFile(path.join(directory, 'change'), 'next commit'); git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'later']);
  assert.throws(() => execFileSync(process.execPath, ['scripts/npm-release.mjs', 'prepare', 'v0.0.2', out], { cwd: directory, env: { ...process.env, GITHUB_SHA: '' }, stdio: 'pipe' }), /main commit/);
});

test('npm transport sends only one package PUT after a retryable 502', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'divlet-npm-transport-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@divlet/web', version: '0.0.2', license: 'MIT', files: ['index.js'], scripts: { prepublishOnly: 'node -e "process.exit(33)"' } }));
  await writeFile(path.join(directory, 'index.js'), 'export const fixture = true;\n');
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json'], { cwd: directory, encoding: 'utf8' }))[0];
  let puts = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.method === 'PUT') puts++;
      response.writeHead(request.method === 'PUT' ? 502 : 404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'owned test registry refusal' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/`;
  await writeFile(path.join(directory, 'test.npmrc'), `//127.0.0.1:${server.address().port}/:_authToken=owned-test-only-not-a-secret\n`);
  await writeFile(path.join(directory, 'global.npmrc'), '');
  const command = publicationArguments(path.join(directory, packed.filename));
  assert.ok(command.includes('--fetch-retries=0'));
  // Only the endpoint and unavailable local provenance are substituted; retry/hook settings are the actual publisher's.
  const args = command.map(arg => arg.startsWith('--registry=') ? `--registry=${base}` : arg === '--provenance' ? '--provenance=false' : arg);
  const result = await new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd: directory, env: { ...process.env, NPM_CONFIG_USERCONFIG: path.join(directory, 'test.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(directory, 'global.npmrc'), NPM_CONFIG_CACHE: path.join(directory, 'cache'), NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: '1', NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: '1', NODE_AUTH_TOKEN: '', NPM_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stderr }); });
  });
  assert.equal(result.signal, null, result.stderr);
  assert.notEqual(result.code, 0, 'the mock registry never accepts publication');
  assert.match(result.stderr, /E502/);
  assert.equal(puts, 1, 'npm must not replay an uncertain package PUT internally');
});

test('workflow separates validation and registry checks from OIDC and retains frozen candidate/outcome', async () => {
  const workflow = parse(await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8'));
  assert.equal(workflow.name, 'Release');
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow['run-name'], 'npm ${{ inputs.release_tag }}');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.publish.name, 'Publish npm');
  assert.equal(workflow.jobs.publish.environment, 'npm');
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
  assert.equal(workflow.jobs.prepare.permissions?.['id-token'], undefined);
  assert.equal(workflow.jobs.verify.permissions?.['id-token'], undefined);
  assert.equal(workflow.jobs.publish.needs, 'prepare');
  assert.equal(workflow.jobs.verify.needs, 'publish');
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) if (step.uses) assert.match(step.uses, /^actions\/[\w-]+@[a-f0-9]{40}$/);
  assert.ok(workflow.jobs.publish.steps.some(step => step.if === 'always()' && step.with.name.startsWith('npm-outcome-')));
  assert.ok(!workflow.jobs.publish.steps.some(step => /npm ci|npm run build/.test(step.run ?? '')));
  assert.ok(workflow.jobs.verify.steps.some(step => step.run?.includes('install-smoke.mjs --registry --pi')));
});
