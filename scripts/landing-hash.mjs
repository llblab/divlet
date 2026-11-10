// The landing folder and its fingerprint. One module owns both questions the workflow asks — "what gets published" and "is that
// already live" — so the set of published files cannot drift from the set that was hashed.
//
//   node scripts/landing-hash.mjs                 the hash
//   node scripts/landing-hash.mjs --json          the hash, the file list and the folder
//   node scripts/landing-hash.mjs --copy <dir>    write the published files into <dir> (and print the hash)
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
/** Written for whoever edits the page; it is not part of the site. */
const NOT_PUBLISHED = new Set(['README.md']);

/** The files of the landing folder that are published, as sorted relative paths with forward slashes. */
export async function landingFiles(directory = path.join(root, 'landing')) {
  const walk = async current => {
    const entries = await readdir(current, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) files.push(...await walk(full));
      else files.push(full);
    }
    return files;
  };
  return (await walk(directory))
    .map(file => path.relative(directory, file).split(path.sep).join('/'))
    .filter(name => !NOT_PUBLISHED.has(name))
    .sort();
}

/** `sha256` over `path\0bytes` for every published file, in sorted order: the same on any machine. */
export async function landingHash(directory = path.join(root, 'landing')) {
  const digest = createHash('sha256');
  for (const name of await landingFiles(directory)) {
    digest.update(name).update('\0');
    digest.update(await readFile(path.join(directory, name))).update('\0');
  }
  return digest.digest('hex');
}

/** Copy the published files into `target`, keeping their relative paths. */
export async function copyLanding(target, directory = path.join(root, 'landing')) {
  for (const name of await landingFiles(directory)) {
    const destination = path.join(target, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(directory, name), destination);
  }
  return landingFiles(directory);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const directory = path.join(root, 'landing');
  const hash = await landingHash(directory);
  const copy = process.argv.indexOf('--copy');
  if (copy >= 0) {
    const target = process.argv[copy + 1];
    if (!target) throw new Error('--copy needs a target directory');
    const files = await copyLanding(path.resolve(target), directory);
    console.error(`published ${files.length} file(s) to ${path.resolve(target)}`);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify({ directory: path.relative(root, directory), files: await landingFiles(directory), hash }, null, 2));
  else console.log(hash);
}
