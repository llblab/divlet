import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerBoard, findBoard, listBoards, unregisterBoard } from '../lib/boards.ts';

const withState = async run => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'divlet-boards-'));
  const previous = process.env.PI_DIVLET_STATE_DIR;
  process.env.PI_DIVLET_STATE_DIR = directory;
  try { await run(directory); } finally {
    if (previous === undefined) delete process.env.PI_DIVLET_STATE_DIR; else process.env.PI_DIVLET_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
};

test('a board entry is announced, found, listed and withdrawn by its owner', () => withState(async () => {
  const file = path.join(os.tmpdir(), 'one', 'project.divlet');
  await registerBoard({ file, url: 'http://127.0.0.1:1/token/', projectId: 'one' });
  assert.equal((await findBoard(file))?.url, 'http://127.0.0.1:1/token/');
  assert.deepEqual((await listBoards()).map(board => board.file), [path.resolve(file)]);
  assert.equal(await unregisterBoard({ file, url: 'http://127.0.0.1:1/token/' }), true);
  assert.equal(await findBoard(file), null);
}));

test('an entry owned by another account is ignored and left alone', { skip: typeof process.getuid !== 'function' || process.getuid() === 0 }, () => withState(async directory => {
  const file = path.join(os.tmpdir(), 'two', 'project.divlet');
  await registerBoard({ file, url: 'http://127.0.0.1:2/planted/', projectId: 'two' });
  const real = process.getuid;
  const mine = real.call(process);
  // The planted file is ours in this sandbox; pretending to be a different account makes it foreign, which is the same comparison.
  process.getuid = () => mine + 1;
  try {
    assert.equal(await findBoard(file), null, 'a foreign-owned entry is never attached to');
    assert.deepEqual(await listBoards(), [], 'nor listed');
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.json')).length, 1, 'and it is not deleted, as a stale entry would be');
  } finally { process.getuid = real; }
  assert.equal((await stat(path.join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))))).uid, mine);
  assert.equal((await findBoard(file))?.url, 'http://127.0.0.1:2/planted/', 'the same entry is trusted again for its real owner');
}));
