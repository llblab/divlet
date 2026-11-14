// Internal subprocess probe: observe the actual hash recipe, never reconstruct a second renderer identity algorithm.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const createHash = crypto.createHash, readFileSync = fs.readFileSync;
const recipes = [], manifests = new Map();
let capturing = false, renderer;
try {
  crypto.createHash = (...args) => {
    const hash = createHash(...args), update = hash.update.bind(hash);
    hash.update = (data, ...rest) => {
      if (capturing && typeof data === 'string' && data.startsWith('["divlet-tailwind-')) recipes.push(JSON.parse(data));
      return update(data, ...rest);
    };
    return hash;
  };
  fs.readFileSync = (file, ...args) => {
    const result = readFileSync(file, ...args);
    if (capturing && typeof file === 'string' && path.basename(file) === 'package.json') {
      const value = JSON.parse(String(result));
      manifests.set(file, { file, name: value.name, version: value.version });
    }
    return result;
  };
  syncBuiltinESMExports();
  const { createRenderer } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
  capturing = true;
  renderer = createRenderer();
} finally {
  capturing = false;
  crypto.createHash = createHash;
  fs.readFileSync = readFileSync;
  syncBuiltinESMExports();
}
assert.equal(recipes.length, 1, 'observe exactly the versioned identity payload');
const recipe = recipes[0];
assert.equal(recipe.length, 4);
assert.equal(renderer.version, `${recipe[0]}-${createHash('sha256').update(JSON.stringify(recipe)).digest('hex')}`);
const css = await renderer.compileClasses({ '--color-renderer-probe': '#123456' }, ['p-4', 'hover:bg-renderer-probe']);
assert.match(css, /\.p-4/);
assert.match(css, /hover\\:bg-renderer-probe/);
let requirementCheck = null;
if (process.argv[3]) {
  const entry = path.resolve(process.argv[2]);
  const extension = path.extname(entry);
  const { setStyleEngines, resolveStyleEngine } = await import(pathToFileURL(path.resolve(path.dirname(entry), `../../../core/lib/engine${extension}`)).href);
  setStyleEngines([renderer]);
  const requirement = { id: renderer.id, version: process.argv[3] };
  if (requirement.version === renderer.version) {
    assert.equal(resolveStyleEngine(requirement), renderer);
    requirementCheck = 'matched';
  } else {
    assert.throws(() => resolveStyleEngine(requirement), { code: 'STYLE_ENGINE_VERSION_MISMATCH' });
    requirementCheck = 'STYLE_ENGINE_VERSION_MISMATCH';
  }
}
console.log(JSON.stringify({ version: renderer.version, inputs: { policy: recipe[0], roots: recipe[1], packages: recipe[2].map(value => JSON.parse(value)), stylesheets: recipe[3] }, manifests: [...manifests.values()].sort((a, b) => a.file.localeCompare(b.file)), cssHash: createHash('sha256').update(css).digest('hex'), requirementCheck }));
