import test from 'node:test';
import assert from 'node:assert/strict';
import * as validation from '../lib/validation.ts';
import * as model from '../lib/model.ts';
import { captureValidation, validationCases } from './fixtures/validation.js';

test('the model preserves the shared validation exports and domain error identity', () => {
  for (const name of ['DivletError', 'fail', 'object', 'string', 'keys', 'json']) assert.equal(model[name], validation[name], name);
  assert.throws(() => model.validateDocument(null), validation.DivletError);
});

for (const { name, run, expected } of validationCases) test(`portable admission: ${name}`, () => {
  for (const api of [validation, model]) assert.deepEqual(captureValidation(api, run), expected);
});
