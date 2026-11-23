// The GitHub Release text of one version, taken from its CHANGELOG.md section: `node scripts/release-notes.mjs notes|title <tag>`.
// The release flow runs this after validation and before anything is published, so a missing or still-unreleased section stops it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The title and notes of `version` in a changelog. Its heading is `## <version> — <title>`. A tag is the release, so the heading
 * must already name the release: an `Unreleased` section is refused rather than published under that word. Each changelog item is
 * hard-wrapped for the file; the notes join a wrapped item back into one paragraph, as the earlier GitHub Releases were written.
 */
export function releaseNotes(changelog, version) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Use a stable version such as 0.3.1.');
  const headings = [...changelog.matchAll(/^## (\S+) — (.+)$/gm)];
  const at = headings.findIndex(match => match[1] === version);
  assert.ok(at >= 0, `CHANGELOG.md has no "## ${version} — <title>" section.`);
  const title = headings[at][2].trim();
  assert.ok(!/unreleased/i.test(title), `CHANGELOG.md still calls ${version} "${title}": name the release before tagging it.`);
  const start = headings[at].index + headings[at][0].length;
  const end = headings[at + 1]?.index ?? changelog.length;
  const body = changelog.slice(start, end).trim();
  assert.ok(body, `The ${version} section of CHANGELOG.md is empty.`);
  const items = body.split(/\n(?=- )/).map(item => item.split('\n').map(line => line.trim()).join(' '));
  return { title: `${version}: ${title}`, notes: `${items.join('\n')}\n` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [kind, tag] = process.argv.slice(2);
  assert.ok(kind === 'notes' || kind === 'title', 'Usage: release-notes.mjs notes|title vX.Y.Z');
  assert.match(tag ?? '', TAG, 'Use a stable release tag such as v0.3.1.');
  const { title, notes } = releaseNotes(await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), tag.slice(1));
  process.stdout.write(kind === 'title' ? `${title}\n` : notes);
}
