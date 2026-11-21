import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The product version, read from this package's own manifest — the npm version stays the one source, and no second copy of the
 * number lives in code. Source runs from `core/lib/` and a published install from `dist/core/lib/`, so the walk looks a few
 * levels up and accepts only `@divlet/core`'s manifest (a host package's own version is compared with it, never used here).
 */
export function productVersion(): string | null {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 5; up++) {
    const file = path.join(directory, 'package.json');
    if (existsSync(file)) {
      try {
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        if (manifest?.name === '@divlet/core' && typeof manifest.version === 'string') return manifest.version;
      } catch { /* an unreadable manifest is no version, not a failure to start */ }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}
