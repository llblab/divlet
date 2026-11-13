// The browser client is served as files, so its module graph is resolved by the browser: every relative import must name a file
// that exists and ships. A browser module can never import TypeScript (the server compiles none of it), and a stray rename in a
// shared name (`project.js` is both a core module and a client module) must not leak into the client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const WEB = path.join(root, 'web');

const walk = async directory => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'tests' && entry.name !== 'dist' && entry.name !== 'node_modules') files.push(...await walk(full)); }
    else files.push(full);
  }
  return files;
};
const exists = async file => { try { return (await stat(file)).isFile(); } catch { return false; } };
const relativeImports = source => ts.preProcessFile(source, true, true).importedFiles.map(file => file.fileName).filter(name => name.startsWith('.'));

/** Every production client module: `web/` without its tests, plus each plugin's client directory. */
const clientModules = async () => {
  const modules = (await walk(WEB)).filter(file => file.endsWith('.js'));
  for (const plugin of await readdir(path.join(root, 'plugins'), { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const client = path.join(root, 'plugins', plugin.name, 'web');
    try { modules.push(...(await walk(client)).filter(file => file.endsWith('.js'))); } catch { /* no client side */ }
  }
  return modules;
};

test('module discovery follows runtime imports/re-exports but not JSDoc or quoted import text', () => {
  const source = `
    /** @typedef {import('./contract.ts').Value} Value */
    // import './comment.ts';
    const text = 'from "./quoted.ts"';
    import { one } from './one.js';
    export { two } from './two.js';
    export * from './three.js';
    void import('./later.js');
  `;
  assert.deepEqual(relativeImports(source), ['./one.js', './two.js', './three.js', './later.js']);
});

test('browser test entries keep their local imports and npm suite coverage after relocation', async () => {
  const directory = path.join(WEB, 'tests');
  const entries = (await readdir(directory)).filter(name => name.endsWith('.mjs')).sort();
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const scheduled = [...pkg.scripts['test:browser:all'].matchAll(/\bweb\/tests\/([\w-]+\.mjs)\b/g)].map(match => match[1]).sort();
  assert.deepEqual(scheduled, entries, 'the browser battery includes every owned entry exactly once');
  for (const name of entries) {
    const source = await readFile(path.join(directory, name), 'utf8');
    for (const [, specifier] of source.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/g)) {
      assert.ok(await exists(path.resolve(directory, specifier)), `${name}: local Node import resolves: ${specifier}`);
    }
  }
});

test('every browser module imports a file that exists, and never TypeScript', async () => {
  const modules = await clientModules();
  assert.ok(modules.length > 20, `the client's module graph is read (${modules.length} modules)`);
  const broken = [];
  for (const file of modules) {
    const source = await readFile(file, 'utf8');
    for (const specifier of relativeImports(source)) {
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

test('web runtime and type imports never reach core internals or Node', async () => {
  const files = (await walk(WEB)).filter(file => /\.(?:js|ts)$/.test(file));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\b(?:from\s*|import\s*\()\s*['"]([^'"]+)/g)) {
      assert.doesNotMatch(match[1], /^(?:@divlet\/core(?:\/|$)|node:)|(?:^|\/)core\//, `${path.relative(root, file)} must not depend back on core, even through JSDoc`);
    }
  }
  for (const file of await readdir(path.join(root, 'core/lib'))) {
    if (!/\.(?:js|ts)$/.test(file) || file === 'server.ts') continue;
    const source = await readFile(path.join(root, 'core/lib', file), 'utf8');
    assert.doesNotMatch(source, /from\s*['"]@divlet\/web/, `only the HTTP composition may resolve the web package: ${file}`);
  }
});

test('browser module dependencies are acyclic, including literal lazy imports', async () => {
  const modules = await clientModules(), graph = new Map();
  for (const file of modules) {
    const dependencies = [];
    for (const specifier of relativeImports(await readFile(file, 'utf8'))) {
      const direct = path.resolve(path.dirname(file), specifier);
      const target = await exists(direct) ? direct : path.join(WEB, specifier.replace(/^(\.\.\/)+/, ''));
      if (modules.includes(target)) dependencies.push(target);
    }
    graph.set(file, dependencies);
  }
  const visiting = new Set(), visited = new Set(), cycles = [];
  const visit = (file, chain) => {
    if (visiting.has(file)) { cycles.push([...chain.slice(chain.indexOf(file)), file].map(item => path.relative(root, item))); return; }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file)) visit(dependency, [...chain, file]);
    visiting.delete(file); visited.add(file);
  };
  for (const file of modules) visit(file, []);
  assert.deepEqual(cycles, [], 'client domains must not reach back into their command facade');
});
