import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openRuntime } from '../lib/runtime.js';
import { buildStatic, readConfinedResource } from '../lib/static.js';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-local-resources-')), dir = path.join(root, 'design'), file = path.join(dir, 'scene.pen');
  await fs.mkdir(dir); await fs.mkdir(path.join(root, 'shared'));
  const image = path.join(root, 'shared/photo.svg'); await fs.writeFile(image, '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="green"/></svg>');
  const source = { version: '2.21', children: [{ id: 'screen', type: 'frame', width: 100, height: 100, layout: 'vertical', fill: [{ type: 'image', url: '../shared/photo.svg', mode: 'cover' }] }] }, text = JSON.stringify(source);
  await fs.writeFile(file, text); t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, dir, file, image, source, text };
}


test('outside CSS and SVG dependencies close transitively and absolute filesystem URLs need no approval list', async t => {
  const f = await setup(t); await fs.writeFile(path.join(f.root, 'shared/theme.css'), '.x{background:url(photo.svg)}');
  for (const url of ['../shared/theme.css', path.join(f.root, 'shared/theme.css')]) {
    const result = await buildStatic({ projectDir: f.dir, frames: new Map([['page', `<link rel="stylesheet" href="${url}">`]]) });
    assert.equal(result.sources.size, 2); assert.ok(result.sources.has(f.image)); assert.equal(result.warnings.length, 0);
    assert.ok([...result.files.keys()].some(name => name.endsWith('photo.svg')));
  }
});

test('automatic local access does not expose source/private/generated files or turn reuse into an outside primary-file service', async t => {
  const f = await setup(t); await fs.writeFile(path.join(f.root, 'shared/.secret.svg'), '<svg/>');
  await fs.symlink(f.image, path.join(f.root, 'shared/link.svg'));
  const build = url => buildStatic({ projectDir: f.dir, frames: new Map([['page', `<img src="${url}">`]]) });
  for (const url of ['scene.pen', '../shared/.secret.svg', '../shared/link.svg']) await assert.rejects(build(url), /Static bundle:/);
  await assert.rejects(readConfinedResource(f.dir, f.image), /required snapshot containment/);
});
