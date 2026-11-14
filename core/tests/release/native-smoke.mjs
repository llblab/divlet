// Local tarball acceptance only: no publishing, adapter installation or active-session refresh.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const work = await mkdtemp(path.join(os.tmpdir(), 'divlet-native-public-'));
const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', PI_DIVLET_STATE_DIR: path.join(work, 'boards') };
const command = (file, args, cwd) => execFileSync(file, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
try {
  command('npm', ['run', 'build'], root);
  const archives = [];
  for (const directory of [path.join(root, 'web'), root]) {
    const [packed] = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], directory));
    archives.push(path.join(work, packed.filename));
  }
  const target = path.join(work, 'native');
  await mkdir(target);
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: 'native-consumer', private: true, type: 'module' }));
  command('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', ...archives], target);
  const installed = path.join(target, 'node_modules/@divlet/core');
  const packages = [];
  for (const name of await readdir(path.join(target, 'node_modules'), { recursive: true })) if (name.endsWith('package.json')) {
    const pkg = JSON.parse(await readFile(path.join(target, 'node_modules', name), 'utf8'));
    if (pkg.name) packages.push({ name: pkg.name, version: pkg.version });
  }
  for (const pkg of packages) assert.doesNotMatch(pkg.name, /^(?:@tailwindcss\/|tailwindcss$|lucide-static$|svg-pathdata$)/, 'optional provider dependencies are physically absent');
  await assert.rejects(readFile(path.join(installed, 'core/native.ts')), { code: 'ENOENT' }, 'no checkout product source ships');
  await copyFile(new URL('./native-probe.mjs', import.meta.url), path.join(target, 'probe.mjs'));
  const probe = name => JSON.parse(command(process.execPath, ['probe.mjs', name], target).trim().split('\n').pop());
  const bundledPayload = probe('bundled-payload');
  for (const id of ['pen', 'tailwind']) {
    await readFile(path.join(installed, 'dist/plugins', id, 'index.js'));
    await rm(path.join(installed, 'dist/plugins', id), { recursive: true });
    await assert.rejects(readFile(path.join(installed, 'dist/plugins', id, 'index.js')), { code: 'ENOENT' });
  }
  const absentPayload = probe('absent-payload');
  const parser = path.join(target, 'node_modules/parse5'), removed = path.join(work, 'removed-parser');
  await rename(parser, removed);
  try {
    const missing = spawnSync(process.execPath, ['probe.mjs', 'missing-parser'], { cwd: target, env, encoding: 'utf8', timeout: 20000 });
    assert.ifError(missing.error); assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/); assert.match(missing.stderr, /parse5/);
  } finally { await rename(removed, parser); }
  const defaults = path.join(work, 'defaults');
  await mkdir(defaults);
  await writeFile(path.join(defaults, 'package.json'), JSON.stringify({ name: 'default-consumer', private: true, type: 'module' }));
  command('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--include=optional', ...archives], defaults);
  await writeFile(path.join(work, 'outside-consumer.mjs'), "throw new Error('outside module executed');");
  const defaultControl = command(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createRequire, registerHooks } from 'node:module';
    import { realpathSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    import path from 'node:path';
    const root = realpathSync(process.cwd());
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (result.url.startsWith('file:')) {
        const relative = path.relative(root, realpathSync(fileURLToPath(result.url)));
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
          throw Object.assign(new Error('Module resolved outside the installed consumer'), { code: 'INSTALLED_DEPENDENCY_ESCAPE' });
        }
      } else assert.ok(result.url.startsWith('node:'));
      return result;
    } });
    await assert.rejects(import('../outside-consumer.mjs'), { code: 'INSTALLED_DEPENDENCY_ESCAPE' });
    const require = createRequire(import.meta.url);
    const model = require('@divlet/core/model');
    const engine = require('@divlet/core/engine');
    assert.equal(engine.styleEngine().id, 'tailwind');
    const frame = model.createDemoDocument();
    const changed = model.applyDocumentPatch(frame, { nodes: { [frame.rootId]: { styles: { padding: '16px' } } } });
    assert.match(changed.nodes[frame.rootId].className, /p-4/);
    assert.match(await engine.compileClasses({}, ['p-4'], process.cwd()), /\\.p-4/);
    const plugins = await import('@divlet/core/plugins');
    assert.ok(plugins.importerList().some(item => item.id === 'pen'));
    console.log(JSON.stringify({ status: 'passed', mode: 'installed-bundled-defaults', syncRequire: true, ancestorEscapeRefused: true }));
  `], defaults);
  console.log(JSON.stringify({ status: 'passed', bundledPayload, absentPayload, missingParserRefused: true, defaults: JSON.parse(defaultControl.trim().split('\n').pop()), installedNativePackages: packages }));
} finally { await rm(work, { recursive: true, force: true }); }
