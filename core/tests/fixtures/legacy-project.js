// Explicit backwards-compatibility fixtures, never a production default/format switch.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDemoDocument } from '../../lib/model.ts';
import { validateSettings, writeProject } from '../../lib/project.ts';

export async function legacyProject(file, { demo = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const text = writeProject(validateSettings({ name: path.basename(path.dirname(file)) }), demo ? [createDemoDocument()] : []);
  try { await fs.writeFile(file, text, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return file;
}
