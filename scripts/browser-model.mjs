// Portable browser bundle profiles for source/installed acceptance; no generated files or host/provider rescue.
import { build } from 'esbuild';

export const bundleBrowserModel = (resolveDir, options) => bundleEntry('@divlet/core/model', resolveDir, options);
export const bundleBrowserCodec = (resolveDir, options) => bundleEntry('@divlet/core/codec', resolveDir, options);
export const bundleBrowserProject = (resolveDir, options) => bundleEntry('@divlet/core/project', resolveDir, options);
// Checkout-only private kernel profile; not an installed/public browser API.
export const bundleBrowserReplay = resolveDir => bundleEntry('./core/lib/history-replay.ts', resolveDir, { source: true });
export const bundleBrowserAcceptance = resolveDir => bundleEntry('./core/lib/acceptance.ts', resolveDir, { source: true });

async function bundleEntry(entry, resolveDir, { source = false } = {}) {
  const result = await build({
    stdin: { contents: `export * from '${entry}';`, resolveDir, sourcefile: 'divlet-browser-entry.js' },
    conditions: source ? ['divlet-source'] : [],
    bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const inputs = Object.keys(result.metafile.inputs);
  const host = inputs.filter(file => /(?:^|\/)core\/(?:model|lib\/(?:engine|model-styles|runtime|server|boards))\.(?:js|ts)$|(?:^|\/)(?:plugins\/tailwind|@tailwindcss|tailwindcss)\//.test(file));
  if (host.length) throw new Error(`Browser kernel reached Node/provider bootstrap: ${host.join(', ')}`);
  const external = Object.values(result.metafile.outputs).flatMap(output => output.imports);
  if (external.length) throw new Error('Browser kernel retained external imports');
  return { code: result.outputFiles[0].text, bytes: result.outputFiles[0].contents.length, inputs };
}
