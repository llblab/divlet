// Domain: Renderer identity. Owns: portable installed compiler/dependency and stylesheet identity. Excludes: loading project-selected code.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { STYLESHEETS } from './renderer-source.ts';
import type { RendererSource, RendererStylesheets } from './renderer-source.ts';

type InstalledPackage = { file: string; name: string; version: string; dependencies: string[] };
const ROOTS = ['tailwindcss', 'postcss'];
// Bump for changes to compiler options, token interpretation or the provider-owned stylesheet-resolution policy.
const POLICY = 'divlet-tailwind-2';
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

/** Capture the compiler/parser identity and its exact stylesheet inputs together, without executing dependency code. */
export function rendererSource(from: string | URL = import.meta.url): RendererSource {
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
    const stylesheet = roots[0] as InstalledPackage;
    const css = STYLESHEETS.map(name => ({ name, bytes: readFileSync(path.join(path.dirname(stylesheet.file), name)) }));
    const stylesheets = Object.fromEntries(css.map(({ name, bytes }) => [name, bytes.toString('utf8')])) as RendererStylesheets;
    const hashes = css.map(({ name, bytes }) => [name, digest(bytes)]);
    const version = `${POLICY}-${digest(JSON.stringify([POLICY, roots.map(item => [item.name, item.version]), [...records].sort(), hashes]))}`;
    return Object.freeze({ version, stylesheets: Object.freeze(stylesheets) });
  } catch (cause) {
    throw Object.assign(new Error('Cannot establish the installed Tailwind renderer identity.', { cause }), { code: 'RENDERER_IDENTITY_UNAVAILABLE' });
  }
}

/** Opaque selector only; source capture owns the one hash recipe and preserves installation-path independence. */
export function rendererVersion(from: string | URL = import.meta.url): string { return rendererSource(from).version; }
