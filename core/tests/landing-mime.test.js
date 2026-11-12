import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OutputStore } from '../lib/output.ts';
import { landingEntries, landingHash, copyLanding, publicLandingFile } from '../../scripts/landing-hash.mjs';

async function fixture(t, name = 'assets/fonts/Regular.woff2', mime = 'font/woff2', bytes = Buffer.from([1, 2, 3])) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'divlet-landing-mime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = new OutputStore(path.join(root, 'landing.divlet'));
  await output.write(new Map([['index.html', '<!doctype html><p>curated prepared content</p>'], [name, bytes], ['index.meta.json', 'PRIVATE'], ['notes.txt', 'PRIVATE NOTE']]), { mediaTypes: new Map([[name, mime], ['index.meta.json', 'application/json'], ['notes.txt', 'image/png']]) });
  return { root, output, name, bytes };
}

test('public set retains hierarchical named assets but MIME does not authorize private sidecars or other owned files', async t => {
  const { root, output, name, bytes } = await fixture(t, 'assets/fonts/字 Regular.woff2');
  assert.equal(publicLandingFile(name), true);
  for (const key of ['assets/.private/font.woff2', 'assets/../font.woff2', 'assets/fonts\\font.woff2', 'assets/CON.woff2', 'assets/secret.meta.json', 'index.meta.json', '.divlet-build.json', '.trash/file.woff2']) assert.equal(publicLandingFile(key), false, key);
  const entries = await landingEntries(output.directory);
  assert.deepEqual(entries.map(([key]) => key), ['.nojekyll', name, 'index.html']);
  assert.deepEqual(entries.find(([key]) => key === name)[1], bytes);
  const target = path.join(root, 'public');
  assert.deepEqual(await copyLanding(target, output.directory), entries.map(([key]) => key));
  assert.deepEqual(await readFile(path.join(target, name)), bytes);
  await assert.rejects(stat(path.join(target, 'index.meta.json')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(target, '.divlet-build.json')), { code: 'ENOENT' });
});

test('static publication refuses missing MIME, filename mismatch and unsupported parameters without creating a partial copy', async t => {
  for (const [name, mime, error] of [
    ['assets/fonts/Regular.woff2', 'image/png', /incompatible/],
    ['assets/fonts/Regular.woff2', 'font/woff2;unknown=value', /parameters/],
    ['assets/abstract-font', 'font/woff2', /cannot retain/],
    ['assets/icon.svg', 'image/svg+xml;charset=iso-8859-1', /parameters/],
  ]) {
    const { root, output } = await fixture(t, name, mime);
    await assert.rejects(copyLanding(path.join(root, 'public'), output.directory), error);
    await assert.rejects(stat(path.join(root, 'public')), { code: 'ENOENT' });
  }
  const { output } = await fixture(t);
  await output.write(new Map(), { mediaTypes: new Map() });
  await assert.rejects(landingEntries(output.directory), /no owned MIME provenance/);
});

test('compatible private MIME changes leave the public-byte fingerprint unchanged', async t => {
  const { output } = await fixture(t, 'assets/icon.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  const hash = await landingHash(output.directory);
  await output.write(new Map(), { mediaTypes: new Map([['assets/icon.svg', 'image/svg+xml;charset=utf-8']]) });
  assert.equal(await landingHash(output.directory), hash);
  await output.write(new Map(), { mediaTypes: new Map([['assets/icon.svg', 'image/svg+xml;charset=us-ascii']]) });
  assert.equal(await landingHash(output.directory), hash);
});

test('static text MIME cannot promise a charset its bytes do not retain', async t => {
  const ascii = await fixture(t, 'assets/icon.svg', 'image/svg+xml;charset=us-ascii', Buffer.from('é'));
  await assert.rejects(landingEntries(ascii.output.directory), /not US-ASCII/);
  const utf8 = await fixture(t, 'assets/theme.css', 'text/css', Buffer.from([0xff]));
  await assert.rejects(landingEntries(utf8.output.directory), /not valid UTF-8/);
});
