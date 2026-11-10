// Domain: Renderer identity. Owns: portable installed compiler/dependency and stylesheet identity. Excludes: loading project-selected code.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import path from 'node:path';

type InstalledPackage = { file: string; name: string; version: string; dependencies: string[] };
const ROOTS = ['@tailwindcss/node', 'tailwindcss'];
const STYLESHEETS = ['index.css', 'theme.css', 'preflight.css', 'utilities.css'];
// Bump for changes to compiler options, token interpretation or the provider-owned stylesheet-resolution policy.
const POLICY = 'divlet-tailwind-1';
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function installed(name: string, from: string | URL): InstalledPackage {
  const resolved = findPackageJSON(name, from);
  if (!resolved) throw new Error(`Cannot locate installed renderer dependency ${name}.`);
  const file = realpathSync(resolved);
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid package manifest for ${name}.`);
  const data = value as Record<string, unknown>;
  const dependencies = data.dependencies ?? {};
  if (typeof data.name !== 'string' || !data.name || typeof data.version !== 'string' || !data.version
    || !dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)
    || Object.values(dependencies).some(value => typeof value !== 'string')) throw new Error(`Invalid renderer dependency identity for ${name}.`);
  return { file, name: data.name, version: data.version, dependencies: Object.keys(dependencies).sort() };
}

/** Installed versions, not requested ranges or machine paths. Optional platform binaries share their parent's published semantics. */
export function rendererVersion(from: string | URL = import.meta.url): string {
  try {
    const roots = ROOTS.map(name => installed(name, from));
    const queue = [...roots];
    const visited = new Set<string>();
    const records = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index] as InstalledPackage;
      if (visited.has(current.file)) continue;
      visited.add(current.file);
      const dependencies = current.dependencies.map(name => ({ alias: name, target: installed(name, current.file) }));
      queue.push(...dependencies.map(item => item.target));
      records.add(JSON.stringify([current.name, current.version, dependencies.map(({ alias, target }) => [alias, target.name, target.version])]));
    }
    const stylesheet = roots[1] as InstalledPackage;
    const css = STYLESHEETS.map(name => [name, digest(readFileSync(path.join(path.dirname(stylesheet.file), name)))]);
    return `${POLICY}-${digest(JSON.stringify([POLICY, roots.map(item => [item.name, item.version]), [...records].sort(), css]))}`;
  } catch (cause) {
    throw Object.assign(new Error('Cannot establish the installed Tailwind renderer identity.', { cause }), { code: 'RENDERER_IDENTITY_UNAVAILABLE' });
  }
}
