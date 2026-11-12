// One owner of the Pages public set, its fingerprint and its byte-for-byte publication copy.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OutputStore, safeDirectory } from '../core/lib/output.ts';
import { validateAssetPath } from '../core/lib/asset-reference.ts';
import { canonicalMediaType } from '../core/lib/media-type.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
export const landingSource = path.join(root, 'examples/landing/landing.divlet');
export const landingDirectory = path.join(root, 'examples/landing/.divlet/landing');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** The landing is one page plus portable assets, never sidecars, ownership data or unowned directory debris. */
export const publicLandingFile = name => {
  if (name === 'index.html' || /^_assets\/[a-z0-9_-][a-z0-9_.-]*\.(?:svg|png|jpe?g|gif|webp|avif|ico|css|woff2?|ttf|otf)$/i.test(name)) return true;
  if (!name.startsWith('assets/') || !/\.(?:svg|png|jpe?g|gif|webp|avif|ico|css|woff2?|ttf|otf)$/i.test(name)) return false;
  try { validateAssetPath(name.slice(7)); return true; } catch { return false; }
};
const staticMediaTypes = { '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };
function checkStaticMime(name, bytes, mediaType) {
  if (mediaType === undefined) return;
  const parsed = canonicalMediaType(mediaType);
  if (!parsed || parsed.essence !== staticMediaTypes[path.extname(name).toLowerCase()]) throw new Error(`Landing resource MIME is incompatible with its static-host filename: ${name}`);
  for (const [parameter, value] of parsed.params) {
    if (parameter !== 'charset' || !['text/html', 'text/css', 'image/svg+xml'].includes(parsed.essence) || !['utf-8', 'us-ascii'].includes(value.toLowerCase())) throw new Error(`Landing resource MIME parameters cannot be retained by static hosting: ${name}`);
    if (value.toLowerCase() === 'us-ascii' && bytes.some(byte => byte > 127)) throw new Error(`Landing resource is not US-ASCII: ${name}`);
  }
  if (['text/html', 'text/css', 'image/svg+xml'].includes(parsed.essence)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error(`Landing resource is not valid UTF-8: ${name}`); }
  }
}

export async function landingEntries(directory = landingDirectory) {
  directory = path.resolve(directory);
  const store = new OutputStore(path.resolve(directory, '../../landing.divlet'));
  if (store.directory !== directory) throw new Error('Expected the managed .divlet/landing directory.');
  const manifest = await store.manifest();
  const allNames = Object.keys(manifest.files);
  if (allNames.some(name => name.startsWith('assets/') && !publicLandingFile(name))) throw new Error('Landing contains a declared resource that static publication cannot retain.');
  const names = allNames.filter(publicLandingFile).sort();
  if (!names.includes('index.html')) throw new Error('Landing cache is missing: run npm run landing:build.');
  // Pages otherwise runs Jekyll, which omits the generated _assets directory. This is publication metadata, not a second page.
  const entries = [['.nojekyll', Buffer.alloc(0)]];
  for (const name of names) {
    const bytes = await store.read(name);
    if (!bytes || digest(bytes) !== manifest.files[name]) throw new Error(`Landing cache changed or was hand-edited: ${name}. Rebuild it through its owner.`);
    if (name.startsWith('assets/')) {
      if (!manifest.mediaTypes?.[name]) throw new Error(`Landing declared resource has no owned MIME provenance: ${name}`);
      checkStaticMime(name, bytes, manifest.mediaTypes[name]);
    } else checkStaticMime(name, bytes, manifest.mediaTypes?.[name]);
    entries.push([name, bytes]);
  }
  if (!isDeepStrictEqual(await store.manifest(), manifest)) throw new Error('Landing cache changed while it was being read. Retry after the owner finishes.');
  return entries;
}

const fingerprint = entries => {
  const hash = createHash('sha256');
  for (const [name, bytes] of entries) hash.update(name).update('\0').update(bytes).update('\0');
  return hash.digest('hex');
};
async function copyEntries(entries, target) {
  await safeDirectory(path.resolve(target), { create: true });
  for (const [name, bytes] of entries) {
    const destination = path.resolve(target, name);
    await safeDirectory(path.dirname(destination), { create: true });
    await writeFile(destination, bytes, { flag: 'wx' });
  }
}

export async function landingFiles(directory = landingDirectory) { return (await landingEntries(directory)).map(([name]) => name); }
export async function landingHash(directory = landingDirectory) { return fingerprint(await landingEntries(directory)); }
export async function copyLanding(target, directory = landingDirectory) {
  const entries = await landingEntries(directory);
  await copyEntries(entries, target);
  return entries.map(([name]) => name);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const entries = await landingEntries(landingDirectory), hash = fingerprint(entries);
  const copy = process.argv.indexOf('--copy');
  if (copy >= 0) {
    const target = process.argv[copy + 1];
    if (!target || target.startsWith('--')) throw new Error('--copy needs a target directory');
    await copyEntries(entries, path.resolve(target));
    console.error(`prepared ${entries.length} public file(s) in ${path.resolve(target)}`);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify({ directory: path.relative(root, landingDirectory), files: entries.map(([name]) => name), hash }, null, 2));
  else console.log(hash);
}
