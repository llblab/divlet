// One browser-model build profile for source acceptance and installed-package acceptance; it writes no generated files.
import { build } from 'esbuild';

export async function bundleBrowserModel(resolveDir, { source = false } = {}) {
  const result = await build({
    stdin: { contents: "export * from 'divlet/model';", resolveDir, sourcefile: 'divlet-browser-entry.js' },
    conditions: source ? ['divlet-source'] : [],
    bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const inputs = Object.keys(result.metafile.inputs);
  const host = inputs.filter(file => /(?:^|\/)core\/lib\/(?:engine|model-styles|runtime|server|boards)\.(?:js|ts)$|(?:^|\/)(?:plugins\/tailwind|@tailwindcss|tailwindcss)\//.test(file));
  if (host.length) throw new Error(`Browser model reached Node/provider bootstrap: ${host.join(', ')}`);
  const external = Object.values(result.metafile.outputs).flatMap(output => output.imports);
  if (external.length) throw new Error('Browser model retained external imports');
  return { code: result.outputFiles[0].text, bytes: result.outputFiles[0].contents.length, inputs };
}
