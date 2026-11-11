// Select checkout sources for workspace packages and every child process; installed packages use compiled defaults.
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=divlet-source'].filter(Boolean).join(' ') },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
