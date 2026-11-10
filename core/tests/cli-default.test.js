import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const demo of [false, true]) test(`real CLI creates a Divlet project with ${demo ? 'a starter frame' : 'zero frames via --no-demo'}`, async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-cli-default-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../adapters/cli/index.js', import.meta.url)), '--no-watch', ...(demo ? [] : ['--no-demo'])], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve)); let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGINT'); await exited; await fs.rm(cwd, { recursive: true, force: true }); });
  const url = await new Promise((resolve, reject) => {
    let stdout = ''; const timer = setTimeout(() => reject(new Error('CLI did not announce its native board')), 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited before board announcement: ${code}`)); });
    child.stdout.on('data', data => { stdout += data; const match = /^divlet (http:\/\/\S+)/m.exec(stdout); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const state = await (await fetch(new URL('api/project', url))).json();
  assert.equal(state.project.format, 'divlet'); assert.equal(state.documents.length, demo ? 1 : 0); assert.equal(state.project.version, 1);
  const source = JSON.parse(await fs.readFile(path.join(cwd, 'project.divlet'), 'utf8'));
  assert.equal(source.schemaVersion, 2); assert.equal(Object.hasOwn(source, 'children'), false); assert.equal(source.frames.length, demo ? 1 : 0); assert.equal(stderr, '');
});
