import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseNotes } from '../../scripts/release-notes.mjs';

const changelog = `# Changelog

Intro.

## 0.3.1 — Unreleased

- **Next.** Not out yet.

## 0.3.0 — Border frame and a steady axis

- **Border is a frame.** One wrapped
  paragraph, joined back into one line
  (\`web/lib/properties.js\`).
- **A unit menu.** A second item.

## 0.2.0 — Inspector polish

- **Older.** Older item.
`;

test('release notes are the version\'s own section, one paragraph per item, titled by its heading', () => {
  const { title, notes } = releaseNotes(changelog, '0.3.0');
  assert.equal(title, '0.3.0: Border frame and a steady axis');
  assert.equal(notes, '- **Border is a frame.** One wrapped paragraph, joined back into one line (`web/lib/properties.js`).\n- **A unit menu.** A second item.\n');
  assert.equal(releaseNotes(changelog, '0.2.0').notes, '- **Older.** Older item.\n', 'the last section ends at the end of the file');
});

test('a release is refused when its section is missing, empty or still unreleased', () => {
  assert.throws(() => releaseNotes(changelog, '0.3.1'), /name the release before tagging/);
  assert.throws(() => releaseNotes(changelog, '0.9.0'), /no "## 0\.9\.0/);
  assert.throws(() => releaseNotes('## 0.1.0 — Empty\n\n## 0.0.9 — Older\n\n- x\n', '0.1.0'), /empty/);
  assert.throws(() => releaseNotes(changelog, 'v0.3.0'), /stable version/);
});

test('the shipped changelog parses for its latest released section', async () => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
  assert.match(releaseNotes(text, '0.3.0').notes, /^- \*\*/);
});
