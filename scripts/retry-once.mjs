// Run a command and, if it fails, run it once more: `node scripts/retry-once.mjs <command> [args...]`. For the one browser suite
// known to hang on hosted runners (BACKLOG: BROWSER SUITE TRANSIENTS); a suite that fails twice fails the battery.
import { spawnSync } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) { console.error('Usage: retry-once.mjs <command> [args...]'); process.exit(2); }
const run = () => spawnSync(command, args, { stdio: 'inherit' }).status ?? 1;
let status = run();
if (status !== 0) { console.error(`\n[retry-once] "${[command, ...args].join(' ')}" failed (exit ${status}); running it once more.\n`); status = run(); }
process.exit(status);
