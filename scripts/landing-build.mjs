// Regenerate through the normal project owner; check freshness in a private relocated copy, never by overwriting the cache.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createSession } from '../core/lib/contract.ts';
import { openRuntime } from '../core/runtime.ts';
import { OutputStore, safeDirectory } from '../core/lib/output.ts';
import { readResourceBytes } from '../core/lib/static.js';
import { landingSource } from './landing-hash.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => a.size === b.size && [...a].every(([name, bytes]) => b.get(name)?.equals(bytes));

async function inputs(source) {
  const budget = { bytes: 0 }, files = new Map();
  files.set('landing.divlet', await readResourceBytes(source, budget));
  const raw = JSON.parse(files.get('landing.divlet').toString('utf8'));
  if (raw.outputDir != null || raw.frames?.length !== 1 || raw.frames[0]?.id !== 'index') throw new Error('Landing must have one index frame and the default output directory.');
  // Literal SVG nodes and a data-URL favicon keep this project's input closure inside its source.
  if (!raw.frames[0].head?.icon?.startsWith('data:image/svg+xml;base64,')) throw new Error('Landing favicon must be embedded in its project.');
  return files;
}

async function cache(source) {
  const store = new OutputStore(source), manifest = await store.manifest();
  if (!Object.hasOwn(manifest.files, 'index.html')) throw new Error('Landing cache is missing: run npm run landing:build.');
  const files = new Map();
  for (const name of Object.keys(manifest.files).sort()) {
    const bytes = await store.read(name);
    if (!bytes || hash(bytes) !== manifest.files[name]) throw new Error(`Owned landing output was changed: ${name}. Preserve or resolve hand edits before regeneration.`);
    files.set(name, bytes);
  }
  const raw = await store.read('.divlet-build.json');
  if (!raw || !isDeepStrictEqual(await store.manifest(), manifest)) throw new Error('Landing cache changed during inspection.');
  files.set('.divlet-build.json', raw);
  return files;
}

async function generate(source) {
  const session = createSession({ openBoard: ({ file }) => openRuntime({ file, watch: false, createDemo: false }) });
  try {
    // createSession attaches when another board already owns this source; close() never closes that owner's board.
    const opened = await session.open({ path: source, createDemo: false });
    if (opened.kind !== 'project' || opened.info.diagnostics.length) throw new Error(`Landing did not build cleanly: ${JSON.stringify(opened.info?.diagnostics ?? opened.kind)}`);
  } finally { await session.close(); }
}

export async function checkLanding(source = landingSource) {
  source = path.resolve(source);
  const before = await inputs(source), actual = await cache(source);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-landing-check-'));
  try {
    for (const [name, bytes] of before) {
      const file = path.join(directory, name);
      await safeDirectory(path.dirname(file), { create: true });
      await fs.writeFile(file, bytes, { flag: 'wx' });
    }
    const relocated = path.join(directory, 'landing.divlet'), store = new OutputStore(relocated);
    // Reuse portable provenance, not a force overwrite: a cloned tracked cache must regenerate as an owned build.
    for (const [name, bytes] of actual) {
      const file = store.file(name);
      await safeDirectory(path.dirname(file), { create: true });
      await fs.writeFile(file, bytes, { flag: 'wx' });
    }
    await generate(relocated);
    const expected = await cache(relocated);
    if (!equal(before, await inputs(source))) throw new Error('Landing inputs changed during validation. Retry after editing finishes.');
    if (!equal(actual, await cache(source))) throw new Error('Landing cache changed during validation. Retry after the owner finishes.');
    if (!equal(actual, expected)) {
      const changed = [...new Set([...actual.keys(), ...expected.keys()])].filter(name => !actual.get(name)?.equals(expected.get(name)));
      throw new Error(`Landing cache is stale (${changed.join(', ')}). Run npm run landing:build and commit the owned output.`);
    }
    return [...actual.keys()].sort();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

export async function buildLanding(source = landingSource) {
  source = path.resolve(source);
  await inputs(source);
  await generate(source);
  return checkLanding(source);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const check = process.argv.includes('--check');
  const unknown = process.argv.slice(2).filter(arg => arg !== '--check');
  if (unknown.length) throw new Error(`Unknown landing build argument: ${unknown.join(', ')}`);
  const files = await (check ? checkLanding() : buildLanding());
  console.log(`${check ? 'Verified' : 'Built and verified'} examples/landing/landing.divlet → examples/landing/.divlet/landing (${files.length} owned files).`);
}
