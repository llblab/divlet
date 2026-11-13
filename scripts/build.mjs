// Build the five publishable packages. Core owns compiled runtime/plugins/skill; web owns client files and portable host ports.
// No client or adapter implementation is copied into the core tarball.
// Development and tests run the TypeScript sources directly; only what npm publishes goes through here.
import { execFileSync } from 'node:child_process';
import { chmod, cp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const tsc = path.join(root, 'node_modules/.bin/tsc');

await rm(dist, { recursive: true, force: true });
execFileSync(tsc, ['-p', path.join(root, 'tsconfig.build.json')], { cwd: root, stdio: 'inherit' });

// Assets the compiled code resolves relative to itself.
for (const asset of ['skills']) await cp(path.join(root, asset), path.join(dist, asset), {
  recursive: true,
  filter: source => !path.relative(path.join(root, asset), source).split(path.sep).includes('tests'),
});
for (const plugin of await readdir(path.join(root, 'plugins'), { withFileTypes: true })) {
  if (!plugin.isDirectory()) continue;
  await cp(path.join(root, 'plugins', plugin.name, 'web'), path.join(dist, 'plugins', plugin.name, 'web'), { recursive: true }).catch(() => {});
}
// Web owns a small DOM-only port build; core never emits or ships its peer's implementation.
const product = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const web = path.join(root, 'web');
const webPackage = JSON.parse(await readFile(path.join(web, 'package.json'), 'utf8'));
if (webPackage.version !== product.version || product.dependencies?.['@divlet/web'] !== product.version) throw new Error('Core must pin the exact matching @divlet/web version.');
await rm(path.join(web, 'dist'), { recursive: true, force: true });
execFileSync(tsc, ['-p', path.join(web, 'tsconfig.build.json')], { cwd: root, stdio: 'inherit' });
for (const asset of ['board.js', 'board.css', 'index.html', 'lib']) await cp(path.join(web, asset), path.join(web, 'dist', asset), {
  recursive: true,
  filter: source => !source.endsWith('.ts'),
});
await cp(path.join(root, 'LICENSE'), path.join(web, 'dist/LICENSE'));
// Each adapter owns its published output; none of its implementation ships in the core tarball.
for (const name of ['cli', 'mcp', 'pi']) {
  const directory = path.join(root, 'packages', name);
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (pkg.version !== product.version || pkg.dependencies?.['@divlet/core'] !== product.version) throw new Error(`${pkg.name} must share the product version and pin @divlet/core exactly.`);
  await rm(path.join(directory, 'dist'), { recursive: true, force: true });
  await cp(path.join(dist, 'packages', name), path.join(directory, 'dist'), { recursive: true });
  await cp(path.join(root, 'LICENSE'), path.join(directory, 'dist/LICENSE'));
  if (pkg.bin) await chmod(path.join(directory, 'dist/index.js'), 0o755);
}
await rm(path.join(dist, 'packages'), { recursive: true, force: true });
// Progress goes to stderr: stdout may be a machine-readable `npm pack --json` stream.
console.error(`dist: ${(await readdir(dist)).length} entries`);
