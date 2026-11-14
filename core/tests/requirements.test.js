import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRequirements } from '../lib/requirements.ts';
import { validateRequirements as publicValidator, readProject, patchSettings, validateSettings } from '../lib/project.ts';
import { DivletError, ID } from '../lib/validation.ts';
import { ID as modelID } from '../lib/model.ts';
import { requirementCases, captureRequirements } from './fixtures/requirements.js';

for (const { name, input, expected, error } of requirementCases) test(`requirements: ${name}`, () => {
  const before = structuredClone(input);
  assert.deepEqual(captureRequirements({ validateRequirements, DivletError }, input), error ? { ok: false, code: error, domainError: true } : { ok: true, value: expected });
  assert.deepEqual(input, before, 'acceptance and refusal never rewrite input');
});

test('project requirement admission shares the identifier grammar and returns independent data', () => {
  assert.equal(publicValidator, validateRequirements);
  assert.equal(modelID, ID);
  const input = Object.freeze({ styleEngine: Object.freeze({ id: 'future', version: 'Exact-Version' }) });
  const result = validateRequirements(input);
  result.styleEngine.id = 'another';
  assert.equal(input.styleEngine.id, 'future');
  assert.deepEqual(validateRequirements(Object.create(null)), {});
});

test('requirement records reject non-JSON fields without invoking accessors', () => {
  const accessor = Object.defineProperty({}, 'styleEngine', { enumerable: true, get() { assert.fail('A requirement must not invoke source code'); } });
  const nestedAccessor = { styleEngine: Object.defineProperty({ version: 'v1' }, 'id', { enumerable: true, get() { assert.fail('A descriptor must not invoke source code'); } }) };
  const hidden = Object.defineProperty({}, 'styleEngine', { value: { id: 'future', version: 'v1' } });
  for (const input of [new Date(), Object.create({ styleEngine: { id: 'future', version: 'v1' } }), accessor, nestedAccessor, hidden, { [Symbol('renderer')]: true }]) assert.throws(() => validateRequirements(input), { code: 'INVALID_PROJECT' });
});

test('the structural decoder loads from only its two portable files without model or provider bootstrap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'divlet-requirements-'));
  try {
    for (const file of ['requirements.ts', 'validation.ts']) await copyFile(new URL(`../lib/${file}`, import.meta.url), path.join(root, file));
    const module = pathToFileURL(path.join(root, 'requirements.ts')).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { validateRequirements } = await import(${JSON.stringify(module)});
      assert.deepEqual(validateRequirements({}), {});
      assert.deepEqual(validateRequirements({ styleEngine: { id: 'not-installed', version: 'EXACT' } }), { styleEngine: { id: 'not-installed', version: 'EXACT' } });
    `], { stdio: 'pipe', timeout: 10000 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('opt-in requirements do not activate partially supported project settings or readers', () => {
  assert.throws(() => readProject({ schemaVersion: 1, requires: validateRequirements({}), frames: [] }), { code: 'INVALID_PROJECT' });
  assert.throws(() => patchSettings(validateSettings({}), { requires: {} }), { code: 'INVALID_PATCH' });
});
