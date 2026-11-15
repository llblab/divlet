// Test composition only: read the installed dependency's explicit CSS graph before starting a browser.
import { readFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function browserStylesheets() {
  const manifest = findPackageJSON('tailwindcss', import.meta.url);
  if (!manifest) throw new Error('The test needs the installed Tailwind stylesheet graph');
  const root = pathToFileURL(manifest), read = name => readFile(new URL(name, root), 'utf8');
  const [index, theme, preflight, utilities] = await Promise.all([read('index.css'), read('theme.css'), read('preflight.css'), read('utilities.css')]);
  return { 'index.css': index, 'theme.css': theme, 'preflight.css': preflight, 'utilities.css': utilities };
}
