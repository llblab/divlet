import test from 'node:test';
import assert from 'node:assert/strict';
import { compileClasses, resolveStyleEngine, setStyleEngines, styleEngine } from '../lib/engine.ts';

// Each file runs in its own process; restore the shipped provider after every registry-shaped test.
function registry(t, providers) {
  const original = styleEngine();
  t.after(() => setStyleEngines(original ? [original] : []));
  setStyleEngines(providers);
}

const requirement = Object.freeze({ id: 'example', version: 'renderer-1' });

test('an explicit native profile never compiles utilities, even when a provider is installed', async t => {
  registry(t, [{ id: 'example', version: 'renderer-1', compileClasses() { assert.fail('Native CSS must not invoke a compiler'); } }]);
  assert.equal(resolveStyleEngine(null), null);
  assert.equal(await compileClasses({}, ['p-4'], undefined, null), '');
  setStyleEngines([]);
  assert.equal(resolveStyleEngine(null), null);
  assert.equal(await compileClasses({}, ['p-4'], undefined, null), '');
});

test('exact resolution ignores registry order and preserves provider receiver, inputs and active selection', async t => {
  const first = { id: 'other', version: 'renderer-1', compileClasses() { assert.fail('Not the required renderer'); } };
  const tokens = Object.freeze({ '--color-brand': 'red' });
  const candidates = Object.freeze(['brand', 'p-4']);
  const selected = {
    id: 'example', version: 'renderer-1',
    async compileClasses(actualTokens, actualCandidates, base) {
      assert.equal(this, selected);
      assert.equal(actualTokens, tokens);
      assert.equal(actualCandidates, candidates);
      assert.equal(base, '/renderer-base');
      return '.brand { color: red; }';
    },
  };
  registry(t, [first, selected]);
  for (const providers of [[first, selected], [selected, first]]) {
    setStyleEngines(providers);
    const active = styleEngine();
    assert.equal(resolveStyleEngine(requirement), selected);
    assert.equal(await compileClasses(tokens, candidates, '/renderer-base', requirement), '.brand { color: red; }');
    assert.equal(styleEngine(), active);
  }
  assert.deepEqual(requirement, { id: 'example', version: 'renderer-1' });
});

test('a required compiler refuses missing, mismatched, unversioned, incapable and ambiguous providers', t => {
  registry(t, []);
  const compileClasses = () => assert.fail('Resolution must refuse before invoking a provider');
  const witnesses = [
    [[], requirement, 'STYLE_ENGINE_UNAVAILABLE'],
    [[{ id: 'other', version: 'renderer-1', compileClasses }], requirement, 'STYLE_ENGINE_UNAVAILABLE'],
    [[{ id: 'example', version: 'renderer-2', compileClasses }], requirement, 'STYLE_ENGINE_VERSION_MISMATCH'],
    [[{ id: 'example', compileClasses }], requirement, 'STYLE_ENGINE_VERSION_MISMATCH'],
    [[{ id: 'example', version: '', compileClasses }], requirement, 'STYLE_ENGINE_VERSION_MISMATCH'],
    [[{ id: 'example', version: 'renderer-1' }], requirement, 'STYLE_ENGINE_CAPABILITY_MISSING'],
    [[{ id: 'Example', version: 'renderer-1', compileClasses }], requirement, 'STYLE_ENGINE_UNAVAILABLE'],
    [[{ id: 'example', version: 'Renderer-1', compileClasses }], requirement, 'STYLE_ENGINE_VERSION_MISMATCH'],
    [[{ id: 'example', version: '1.2.3', compileClasses }], { id: 'example', version: '^1.2.0' }, 'STYLE_ENGINE_VERSION_MISMATCH'],
    [[{ id: 'example', version: 'renderer-1', compileClasses }, { id: 'example', version: 'renderer-1', compileClasses }], requirement, 'STYLE_ENGINE_AMBIGUOUS'],
  ];
  for (const [providers, required, code] of witnesses) {
    setStyleEngines(providers);
    assert.throws(() => resolveStyleEngine(required), { code });
  }
});

test('required compilation cannot use a first-provider or no-engine empty-CSS fallback', t => {
  registry(t, [{ id: 'other', compileClasses() { assert.fail('Unrelated compiler must not run'); } }]);
  assert.throws(() => compileClasses({}, ['p-4'], undefined, requirement), { code: 'STYLE_ENGINE_UNAVAILABLE' });
  setStyleEngines([]);
  assert.throws(() => compileClasses({}, ['p-4'], undefined, requirement), { code: 'STYLE_ENGINE_UNAVAILABLE' });
});

test('exact versions of one provider ID are selected by identity, not by first match', t => {
  const wrong = { id: 'example', version: 'renderer-2', compileClasses() { assert.fail('Wrong version'); } };
  const right = { id: 'example', version: 'renderer-1', async compileClasses() { return 'exact'; } };
  registry(t, [wrong, right]);
  assert.equal(resolveStyleEngine(requirement), right);
});

test('required compiler errors propagate without retrying another provider or changing active selection', async t => {
  const failure = new Error('Compiler failed');
  const selected = { id: 'example', version: 'renderer-1', async compileClasses() { throw failure; } };
  registry(t, [selected, { id: 'other', compileClasses() { assert.fail('No compiler fallback'); } }]);
  await assert.rejects(async () => compileClasses({}, ['p-4'], undefined, requirement), error => error === failure);
  assert.equal(styleEngine(), selected);
});

test('omitted requirements retain draft first-provider and no-engine behavior', async t => {
  const first = { id: 'legacy', async compileClasses() { assert.equal(this, first); return 'legacy CSS'; } };
  registry(t, [first, { id: 'other', async compileClasses() { return 'other CSS'; } }]);
  assert.equal(await compileClasses({}, ['p-4']), 'legacy CSS');
  setStyleEngines([]);
  assert.equal(await compileClasses({}, ['p-4']), '');
});
