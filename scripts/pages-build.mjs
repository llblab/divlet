// One owner of the GitHub Pages public set: the real board as a static application that opens the canonical landing project in
// the visitor's browser and exposes its tools through the page's browser MCP provider. Also the owner of that set's fingerprint
// and byte-for-byte copy. The prepared landing page itself (owned by landing-hash.mjs) travels along under page/.
//
//   node scripts/pages-build.mjs              print the fingerprint
//   node scripts/pages-build.mjs --json       list files and fingerprint
//   node scripts/pages-build.mjs --copy DIR   write the public set into an empty or new DIR
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readProject, expandFrame } from '../core/lib/project.ts';
import { compileClasses } from '../core/lib/engine.ts';
import { safeDirectory } from '../core/lib/output.ts';
import { previewBridge } from '../core/lib/bridge.js';
import { previewBridgeScript } from '../core/lib/browser-board.ts';
import { landingEntries, landingSource } from './landing-hash.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = path.join(root, 'web');
const text = value => Buffer.from(value, 'utf8');

/** Compiled CSS per token set, from the same engine the local host uses; the browser host serves it without compiling. */
export async function styleSnapshot(source) {
  const { settings, frames } = readProject(JSON.parse(source));
  const lookup = id => frames.find(frame => frame.id === id);
  const groups = new Map();
  for (const frame of frames) {
    const expanded = expandFrame(frame, lookup, settings);
    const key = JSON.stringify(expanded.document.tokens);
    const group = groups.get(key) ?? { tokens: expanded.document.tokens, candidates: new Set() };
    for (const node of Object.values(expanded.document.nodes)) if (node.type === 'element') for (const name of node.className.split(/\s+/)) if (name) group.candidates.add(name);
    groups.set(key, group);
  }
  const entries = [];
  for (const group of groups.values()) {
    const candidates = [...group.candidates].sort();
    entries.push({ tokens: group.tokens, candidates, css: await compileClasses(group.tokens, candidates, root) });
  }
  return { entries };
}

/** The composition bundle: the browser writer, the board ports and the MCP provider. No Node module may reach it. */
async function hostBundle(version) {
  const entry = `
import { startBrowserBoard } from ${JSON.stringify(path.join(root, 'core/lib/browser-board.ts'))};
const here = new URL('./', import.meta.url);
try {
  await startBrowserBoard({ projectUrl: new URL('project.divlet', here), stylesUrl: new URL('styles.json', here), bridgeUrl: new URL('preview-bridge.js', here), storageKey: location.pathname + '#landing', file: 'landing.divlet', version: ${JSON.stringify(version)} });
  await import(new URL('./board.js', import.meta.url).href);
} catch (error) {
  // Without its composition the board must not start: it would fall back to native routes that a static host does not have.
  const loading = document.getElementById('loading');
  if (loading) loading.replaceChildren(Object.assign(document.createElement('p'), { className: 'host-error', textContent: 'The board could not start in this browser: ' + (error?.message || error) }));
  throw error;
}
`;
  const result = await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'divlet-host.js', loader: 'js' },
    conditions: ['divlet-source'], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', minify: true, metafile: true, legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const inputs = Object.keys(result.metafile.inputs);
  const host = inputs.filter(file => /(?:^|\/)core\/lib\/(?:engine|model-styles|media-type|runtime|server|boards|render|output|static)\.(?:js|ts)$|(?:^|\/)(?:plugins\/tailwind|@tailwindcss|tailwindcss)\//.test(file));
  if (host.length) throw new Error(`The browser host reached Node/provider modules: ${host.join(', ')}`);
  const external = Object.values(result.metafile.outputs).flatMap(output => output.imports.map(item => item.path));
  if (external.length) throw new Error(`The browser host retained imports: ${external.join(', ')}`);
  return result.outputFiles[0].contents;
}

/** The board's own client files, as the local host serves them: native ES modules and the stylesheet. */
async function clientEntries() {
  const entries = [['board.js', await readFile(path.join(web, 'board.js'))], ['board.css', await readFile(path.join(web, 'board.css'))]];
  for (const name of (await readdir(path.join(web, 'lib'))).sort()) if (name.endsWith('.js')) entries.push([`lib/${name}`, await readFile(path.join(web, 'lib', name))]);
  return entries;
}

/** The board shell with the browser host in front of it, an MCP provider hint and a meta CSP (Pages cannot send headers). */
async function shell() {
  let html = await readFile(path.join(web, 'index.html'), 'utf8');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
    // Previews are blob documents that inherit this policy, so it also admits what project pages may load (https images/fonts).
  const csp = `default-src 'self'; script-src 'self' ${inline.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: https:; font-src 'self' data: https:; frame-src blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">\n    <meta name="browser-mcp" content="browser-mcp/1">\n    <meta name="description" content="divlet, a layout board for agents, running in your browser. Agents connect to this page as an MCP provider: npx -y @divlet/mcp --connect <this page>.">`;
  if (!html.includes('<script type="module" src="./board.js"></script>')) throw new Error('web/index.html no longer loads ./board.js as expected.');
  html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n    ${head}`).replace('<script type="module" src="./board.js"></script>', '<script type="module" src="./divlet-host.js"></script>');
  html = html.replace('<title>divlet</title>', '<title>divlet — a layout board for agents</title>');
  return text(html);
}

export async function pagesEntries() {
  const product = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const source = await readFile(landingSource, 'utf8');
  const entries = [
    ['.nojekyll', Buffer.alloc(0)],
    ['index.html', await shell()],
    ['divlet-host.js', Buffer.from(await hostBundle(product.version))],
    ['project.divlet', text(source)],
    ['styles.json', text(JSON.stringify(await styleSnapshot(source)))],
    ['preview-bridge.js', text(previewBridgeScript(previewBridge.toString()))],
    ...await clientEntries(),
    // The prepared landing as a plain page: readable without the board, and the source of truth for search engines.
    ...(await landingEntries()).filter(([name]) => name !== '.nojekyll').map(([name, bytes]) => [`page/${name}`, bytes]),
  ];
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export const pagesHash = entries => {
  const hash = createHash('sha256');
  for (const [name, bytes] of entries) hash.update(name).update('\0').update(bytes).update('\0');
  return hash.digest('hex');
};

export async function copyPages(target, entries) {
  await safeDirectory(path.resolve(target), { create: true });
  for (const [name, bytes] of entries) {
    const destination = path.resolve(target, name);
    if (!destination.startsWith(path.resolve(target) + path.sep)) throw new Error(`Refusing to write outside the target: ${name}`);
    await safeDirectory(path.dirname(destination), { create: true });
    await writeFile(destination, bytes, { flag: 'wx' });
  }
  return entries.map(([name]) => name);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const entries = await pagesEntries(), hash = pagesHash(entries);
  const copy = process.argv.indexOf('--copy');
  if (copy >= 0) {
    const target = process.argv[copy + 1];
    if (!target || target.startsWith('--')) throw new Error('--copy needs a target directory');
    await copyPages(target, entries);
    console.error(`prepared ${entries.length} public file(s) in ${path.resolve(target)}`);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify({ files: entries.map(([name]) => name), bytes: entries.reduce((sum, [, bytes]) => sum + bytes.length, 0), hash }, null, 2));
  else console.log(hash);
}
