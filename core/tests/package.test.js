import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { marked } from 'marked';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('the standalone CLI advertises the package and project naming contract', () => {
  const result = spawnSync(process.execPath, ['adapters/cli/index.js', '--help'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^divlet \[path\]/);
  assert.match(result.stdout, /<(?:path|folder)>\/project\.divlet/);
  assert.match(result.stdout, /\.divlet\/<filename stem>\/.*outputDir/);
  assert.match(result.stdout, /divlet\.config\.json/);
  assert.match(result.stdout, /pi install npm:divlet-pi/);
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
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const [packed] = JSON.parse(result.stdout);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const files = new Set(packed.files.map(file => file.path));
  assert.equal(pkg.name, 'divlet');
  assert.deepEqual(pkg.bin, { 'divlet': './dist/adapters/cli/index.js', 'divlet-mcp': './dist/adapters/mcp/index.js' });
  assert.ok(files.has('skills/divlet/SKILL.md'));
  for (const source of ['examples/studio/project.divlet', 'examples/site/handbook/project.divlet']) {
    assert.ok(files.has(source));
    const project = JSON.parse(await readFile(path.join(root, source), 'utf8'));
    for (const frame of project.frames) for (const suffix of ['html', 'meta.json']) {
      const sibling = `${path.posix.dirname(source)}/${frame.id}.${suffix}`;
      assert.ok(!files.has(sibling), `Generated fixture sibling must not ship: ${sibling}`);
    }
  }
  for (const source of [
    'examples/pen/field-notes.pen',
    'examples/pen/assets/field.svg',
    'examples/pen/README.md',
    'examples/site/handbook/site.json',
    'examples/site/handbook/assets/divlet-mark.svg',
    'examples/site/handbook/content/index.md',
    'examples/site/handbook/content/guide/index.md',
    'examples/site/handbook/content/guide/start.md',
    'examples/site/handbook/content/guide/assets/shared-layout.svg',
  ]) assert.ok(files.has(source), `Missing authored fixture input: ${source}`);
  const native = JSON.parse(await readFile(path.join(root, 'examples/pen/field-notes.pen'), 'utf8'));
  assert.equal(native.version, '2.21'); assert.equal(Object.hasOwn(native, 'frames'), false); assert.equal(Object.hasOwn(native, 'fileToken'), false);
  assert.equal(native.children[0].reusable, true); assert.equal(native.children[1].children.filter(node => node.type === 'ref').length, 2);
  assert.equal(packed.name, pkg.name);
  assert.equal(packed.version, pkg.version);
  assert.deepEqual(lock.packages[''].bin, Object.fromEntries(Object.entries(pkg.bin).map(([name, file]) => [name, file.replace(/^\.\//, '')])), 'the lockfile exposes the same built commands as the manifest');
  for (const metadata of [lock, lock.packages['']]) {
    assert.equal(metadata.name, pkg.name);
    assert.equal(metadata.version, pkg.version);
  }
  for (const entry of [...pkg.pi.extensions, ...Object.values(pkg.bin), ...Object.values(pkg.exports)]) {
    assert.ok(files.has(entry.replace(/^\.\//, '')), `Missing public entrypoint: ${entry}`);
  }
  // A typed product ships its types: every export resolves to a declaration beside the JavaScript it describes.
  for (const [condition, target] of Object.entries(pkg.exports)) {
    const declaration = target.replace(/\.js$/, '.d.ts').replace(/^\.\//, '');
    assert.ok(files.has(declaration), `Missing type declaration for export "${condition}": ${declaration}`);
  }
  for (const entry of Object.values(pkg.bin)) {
    const file = packed.files.find(file => file.path === entry.replace(/^\.\//, ''));
    assert.ok(file.mode & 0o111, `CLI is not executable: ${entry}`);
  }
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
