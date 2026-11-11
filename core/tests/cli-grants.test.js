import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixtures/source-project.js';

const cli = fileURLToPath(import.meta.resolve('@divlet/cli'));
const run = promisify(execFile);

test('CLI and browser-hosted projects open outside resources without flags or approvals', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-cli-grants-'));
  let child;
  let closed;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { const [code, signal] = await closed; assert.equal(code, 0); assert.equal(signal, null); }
      finally { clearTimeout(force); }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'design');
  await fs.mkdir(dir); await fs.mkdir(path.join(root, 'shared'));
  const images = ['photo.svg', 'other.svg'].map(name => path.join(root, 'shared', name));
  for (const file of images) await fs.writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const source = fixture();
  const photo = source.children[1].children.find(node => node.id === 'photo');
  photo.fill[0].url = '../shared/photo.svg';
  photo.fill.unshift({ type: 'image', url: '../shared/other.svg', mode: 'cover' });
  const original = JSON.stringify(source);
  for (const name of ['a.pen', 'b.pen']) await fs.writeFile(path.join(dir, name), original);
  child = spawn(process.execPath, [cli, 'a.pen', '--no-watch'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  closed = new Promise(resolve => child.once('close', (...args) => resolve(args)));
  const url = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => reject(new Error('CLI did not announce its board')), 15000);
    const cleanup = () => clearTimeout(timeout);
    child.stdout.on('data', data => {
      output += data;
      const match = /^divlet (http:\/\/[^\s]+)/m.exec(output);
      if (match) { cleanup(); resolve(match[1]); }
    });
    child.stderr.on('data', data => { errors += data; });
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', code => { cleanup(); reject(new Error(`CLI exited ${code}: ${errors}`)); });
  });
  const state = await (await fetch(new URL('api/project', url))).json();
  assert.equal(state.project.file, path.join(dir, 'a.divlet'));
  assert.equal(state.project.capabilities.frames, true);
  assert.equal(state.documents.length, 2);
  const assets = (await fs.readdir(path.join(dir, '.divlet/a/_assets'))).filter(name => name.endsWith('.svg'));
  assert.equal(assets.length, 2);
  for (const asset of assets) assert.equal((await fetch(new URL('build/_assets/' + asset, url))).status, 200);
  const post = async (url, body) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const body = { path: path.join(dir, 'b.pen'), externalFiles: images };
  const direct = await post(new URL('api/open-project', url), body);
  assert.equal(direct.status, 200); assert.ok(direct.body.url);
  const launcher = await post(new URL('api/open-project', url), { path: dir });
  const deferred = await post(new URL('api/open', launcher.body.url), { file: body.path, externalFiles: images });
  assert.equal(deferred.status, 200); assert.ok(deferred.body.url);
  for (const name of ['a.pen', 'b.pen']) assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), original);
});
