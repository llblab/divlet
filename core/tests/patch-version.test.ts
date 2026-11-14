import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPatchVersion, assertExpectedVersion } from '../lib/acceptance.ts';
import { DivletError } from '../lib/validation.ts';
import { patchVersionCases, capturePatchVersion } from './fixtures/patch-version.js';

const api = { assertPatchVersion, assertExpectedVersion };
for (const { name, run, expected } of patchVersionCases) test(name, () => assert.deepEqual(capturePatchVersion(api, run), expected));

if (false) {
  // @ts-expect-error Required patch scopes cannot silently select arbitrary error/admission policies.
  assertPatchVersion(1, { version: 1 }, 'other');
  // @ts-expect-error The accepted target must expose a numeric version.
  assertPatchVersion(1, { version: '1' });
}
test('required patch refusal retains shared domain error identity and leaves optional lifecycle behavior distinct', () => {
  assert.throws(() => assertPatchVersion(undefined, { version: 1 }), error => error instanceof DivletError && error.code === 'REVISION_CONFLICT');
  assert.doesNotThrow(() => assertExpectedVersion(undefined, { version: 1 }));
});
