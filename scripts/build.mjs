// Build the publishable package: compiled JavaScript and declarations in `dist/`, plus the non-code assets that compiled modules
// reach by a relative path (`web`, the skill, plugin client modules), copied so those paths keep meaning the same thing.
// Development and tests run the TypeScript sources directly; only what npm publishes goes through here.
import { execFileSync } from 'node:child_process';
import { chmod, cp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const tsc = path.join(root, 'node_modules/.bin/tsc');

await rm(dist, { recursive: true, force: true });
execFileSync(tsc, ['-p', path.join(root, 'tsconfig.build.json')], { cwd: root, stdio: 'inherit' });

// Assets the compiled code resolves relative to itself.
for (const asset of ['web', 'skills']) await cp(path.join(root, asset), path.join(dist, asset), { recursive: true });
for (const plugin of await readdir(path.join(root, 'plugins'), { withFileTypes: true })) {
  if (!plugin.isDirectory()) continue;
  await cp(path.join(root, 'plugins', plugin.name, 'web'), path.join(dist, 'plugins', plugin.name, 'web'), { recursive: true }).catch(() => {});
}
// A bin file has to be executable in the tarball; tsc does not carry the mode bit.
for (const bin of ['adapters/cli/index.js', 'adapters/mcp/index.js']) await chmod(path.join(dist, bin), 0o755);
// Progress goes to stderr: stdout may be a machine-readable `npm pack --json` stream.
console.error(`dist: ${(await readdir(dist)).length} entries`);
