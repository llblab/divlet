import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { marked } from 'marked';
import { readProject, writeProject } from '../lib/project.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('the standalone CLI advertises the package and project naming contract', () => {
  const result = spawnSync(process.execPath, ['packages/cli/index.js', '--help'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^divlet \[path\]/);
  assert.match(result.stdout, /<(?:path|folder)>\/project\.divlet/);
  assert.match(result.stdout, /\.divlet\/<filename stem>\/.*outputDir/);
  assert.match(result.stdout, /divlet\.config\.json/);
  assert.match(result.stdout, /pi install npm:@divlet\/pi/);
});

test('example packaging excludes retained private upload stages but keeps authored assets', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'divlet-package-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'examples/project/assets/.divlet-upload-probe'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'divlet-package-probe', version: '0.0.1', files: ['examples'] }));
  await copyFile(path.join(root, 'examples/.npmignore'), path.join(directory, 'examples/.npmignore'));
  await writeFile(path.join(directory, 'examples/project/assets/photo.png'), 'authored');
  await writeFile(path.join(directory, 'examples/project/assets/.divlet-upload-probe/image'), 'private-stage');
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: directory, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map(file => file.path);
  assert.ok(files.includes('examples/project/assets/photo.png'));
  assert.ok(!files.some(file => file.includes('.divlet-upload-')));
});

test('the npm package includes public entrypoints and a complete documentation link graph', async () => {
  // The published package is the build output: compile it first, exactly as `prepack` does.
  const built = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(built.error);
  assert.equal(built.status, 0, built.stderr);
  const snapshot = async () => {
    const files = {};
    const visit = async (directory, prefix) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name), name = `${prefix}/${entry.name}`;
        assert.notEqual(entry.name, 'dist', `generated output re-entered compiler inputs: ${name}`);
        if (entry.isDirectory()) await visit(file, name);
        else files[name] = createHash('sha256').update(await readFile(file)).digest('hex');
      }
    };
    for (const name of ['cli', 'mcp', 'pi']) await visit(path.join(root, 'packages', name, 'dist'), name);
    return files;
  };
  const first = await snapshot();
  const repeated = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(repeated.error); assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(await snapshot(), first, 'successive builds preserve every adapter file name and byte');
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const [packed] = JSON.parse(result.stdout);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const files = new Set(packed.files.map(file => file.path));
  assert.equal(pkg.name, 'divlet');
  assert.equal(pkg.bin, undefined, 'executables belong to the scoped adapter packages');
  assert.equal(pkg.pi, undefined);
  assert.ok(files.has('skills/divlet/SKILL.md'));
  for (const source of ['examples/landing/landing.divlet', 'examples/studio/project.divlet', 'examples/handbook/project.divlet']) {
    assert.ok(files.has(source));
    const bytes = await readFile(path.join(root, source), 'utf8');
    const project = readProject(JSON.parse(bytes));
    assert.equal(writeProject(project.settings, project.frames), bytes, `${source}: every shipped native example validates and is canonical schema 1`);
    for (const frame of project.frames) for (const suffix of ['html', 'meta.json']) {
      const sibling = `${path.posix.dirname(source)}/${frame.id}.${suffix}`;
      assert.ok(!files.has(sibling), `Generated fixture sibling must not ship: ${sibling}`);
    }
  }
  for (const source of [
    'examples/README.md',
    'examples/landing/landing.divlet',
    'examples/handbook/site.json',
    'examples/handbook/content/index.md',
    'examples/handbook/content/guide/index.md',
    'examples/handbook/content/guide/start.md',
    'examples/handbook/content/guide/assets/shared-layout.svg',
  ]) assert.ok(files.has(source), `Missing authored fixture input: ${source}`);
  assert.equal([...files].some(file => file.startsWith('examples/pen/')), false, 'removed authored PEN demos do not ship; importer coverage lives with its plugin');
  assert.equal(packed.name, pkg.name);
  assert.equal(packed.version, pkg.version);
  assert.equal(lock.packages[''].bin, undefined, 'the product lock metadata has no executable ownership');
  for (const metadata of [lock, lock.packages['']]) {
    assert.equal(metadata.name, pkg.name);
    assert.equal(metadata.version, pkg.version);
  }
  for (const entry of Object.values(pkg.exports).map(target => typeof target === 'string' ? target : target.default)) {
    assert.ok(files.has(entry.replace(/^\.\//, '')), `Missing public entrypoint: ${entry}`);
  }
  // A typed product ships its types: every export resolves to a declaration beside the JavaScript it describes.
  for (const [condition, target] of Object.entries(pkg.exports)) {
    if (condition === './skill') continue;
    const declaration = target.default.replace(/\.js$/, '.d.ts').replace(/^\.\//, '');
    assert.ok(files.has(declaration), `Missing type declaration for export "${condition}": ${declaration}`);
  }
  assert.equal([...files].some(file => /^(?:dist\/)?(?:adapters|packages)\//.test(file)), false, 'adapter implementations do not ship in the core tarball');
  for (const file of files) {
    assert.doesNotMatch(file, /^(?:node_modules|tests|artifacts|coverage|\.git|core\/tests|plugins\/[^/]+\/tests)(?:\/|$)/, `Development output must not ship: ${file}`);
    assert.doesNotMatch(file, /(?:^|\/)(?:\.divlet|\.trash|\.cache|\.divlet-upload-[^/]+)(?:\/|$)|(?:^|\/)(?:\.divlet-build\.json|\.divlet-write\.lock|\.divlet-save-[^/]+)$/, `Managed build state must not ship: ${file}`);
    if (!file.endsWith('.md')) continue;
    const source = await readFile(path.join(root, file), 'utf8');
    const targets = [];
    marked.walkTokens(marked.lexer(source), token => {
      if (token.type === 'link' || token.type === 'image') targets.push(token.href);
    });
    for (const href of targets) {
      if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(href.split(/[?#]/)[0])));
      assert.ok(files.has(target), `Packaged documentation link is missing: ${file} → ${href}`);
    }
  }
});
