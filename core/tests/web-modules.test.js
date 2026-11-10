// The browser client is served as files, so its module graph is resolved by the browser: every relative import must name a file
// that exists and ships. A browser module can never import TypeScript (the server compiles none of it), and a stray rename in a
// shared name (`project.js` is both a core module and a client module) must not leak into the client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const WEB = path.join(root, 'web');

const walk = async directory => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
};
const exists = async file => { try { return (await stat(file)).isFile(); } catch { return false; } };
const relative = /from\s+['"](\.[^'"]+)['"]/g;

/** Every module the board's own client loads: `web/**` plus each plugin's client directory. */
const clientModules = async () => {
  const modules = (await walk(WEB)).filter(file => file.endsWith('.js'));
  for (const plugin of await readdir(path.join(root, 'plugins'), { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const client = path.join(root, 'plugins', plugin.name, 'web');
    if (await exists(path.join(client, 'panel.js')).catch(() => false)) continue;
    try { modules.push(...(await walk(client)).filter(file => file.endsWith('.js'))); } catch { /* no client side */ }
  }
  return modules;
};

test('every browser module imports a file that exists, and never TypeScript', async () => {
  const modules = await clientModules();
  assert.ok(modules.length > 20, `the client's module graph is read (${modules.length} modules)`);
  const broken = [];
  for (const file of modules) {
    const source = await readFile(file, 'utf8');
    for (const [, specifier] of source.matchAll(relative)) {
      const where = path.relative(root, file);
      if (specifier.endsWith('.ts')) { broken.push(`${where} → ${specifier} (the browser cannot load TypeScript)`); continue; }
      if (await exists(path.resolve(path.dirname(file), specifier))) continue;
      // A plugin's client module resolves `../../lib/<file>` against the served root, i.e. `web/lib/<file>`.
      const served = path.join(WEB, specifier.replace(/^(\.\.\/)+/, ''));
      if (await exists(served)) continue;
      broken.push(`${where} → ${specifier}`);
    }
  }
  assert.deepEqual(broken, [], 'a module the board serves must resolve');
});
