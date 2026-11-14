import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForPage } from './fixtures/wait-for-page.js';

const page = { evaluate: async (predicate, arg) => predicate(arg) };
const options = { timeout: 1000, interval: 1, message: 'test condition' };

test('async browser polling awaits false values and rereads live state with the original argument', async () => {
  const state = { reads: 0 }, argument = Object.freeze({ expected: 3 });
  const result = await waitForPage(page, async arg => {
    assert.equal(arg, argument);
    await Promise.resolve();
    return ++state.reads >= arg.expected;
  }, argument, options);
  assert.equal(result, true); assert.equal(state.reads, 3);
});

test('an async false predicate times out rather than succeeding on its Promise', async () => {
  let reads = 0;
  await assert.rejects(waitForPage(page, async () => { reads++; return false; }, undefined, { ...options, timeout: 60 }), /test condition/);
  assert.ok(reads >= 1);
});

test('a rejected evaluation is preserved and never retried', async () => {
  const refusal = new Error('evaluation refused'); let reads = 0;
  await assert.rejects(waitForPage(page, async () => { if (++reads === 1) return false; throw refusal; }, undefined, options), error => error === refusal);
  assert.equal(reads, 2);
});

test('a late false result does not resume polling after expiry', async () => {
  let release, reads = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const late = { evaluate: () => { assert.equal(++reads, 1); return pending; } };
  await assert.rejects(waitForPage(late, () => false, undefined, { ...options, timeout: 60 }), /test condition/);
  release(false); await delay(10);
  assert.equal(reads, 1);
});

test('a non-settling evaluation is bounded without starting overlapping evaluations', async () => {
  let reads = 0;
  const stalled = { evaluate: () => { reads++; return new Promise(() => {}); } };
  await assert.rejects(waitForPage(stalled, () => true, undefined, { ...options, timeout: 60 }), /test condition/);
  assert.equal(reads, 1);
});
