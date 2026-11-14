import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssetTree, AssetFile, Attrs, Override, CssDeclaration, CssDeclarationOperation } from '../lib/model.ts';
import type { StyleEngine, StyleEngineRequirement, ResolvedStyleEngine } from '../lib/engine.ts';
import { validDeclarations } from '../lib/model.ts';

const assets: AssetTree = { brand: { logo: 'data:image/svg+xml;base64,AA==' } };
const decodedAsset: AssetFile = { mediaType: 'image/png', bytes: new Uint8Array([1]) };
// @ts-expect-error Directory leaves are Data URL strings, never arbitrary JSON scalars.
const invalidAssets: AssetTree = { logo: 1 };
// @ts-expect-error Serialized payloads are not decoded byte buffers.
const bufferAssets: AssetTree = { logo: new Uint8Array([1]) };

test('asset types separate hierarchical serialized resources from decoded output bytes', () => {
  assert.equal(typeof (assets.brand as AssetTree).logo, 'string');
  assert.equal(decodedAsset.bytes.byteLength, 1);
});

const removal: Override = { attrs: { title: null, 'aria-label': 'Buy' } };
// @ts-expect-error Only override attributes admit null; persisted element attributes remain strings.
const invalidElementAttrs: Attrs = { title: null };

const declaration: CssDeclaration = ['display', 'flex'];
const operation: CssDeclarationOperation = ['display', null];
const admittedDeclarations: CssDeclaration[] = validDeclarations([['display', 'flex']], 'root');
const admittedOperations: CssDeclarationOperation[] = validDeclarations([['display', null]], 'instance', true);
// @ts-expect-error Nullable override operations cannot be consumed as literal declarations.
const nullableLiterals: CssDeclaration[] = validDeclarations([['display', null]], 'instance', true);
// @ts-expect-error Literal declaration values are strings, not deletion operations.
const invalidDeclaration: CssDeclaration = ['display', null];
// @ts-expect-error A declaration is exactly one property/value pair.
const invalidTuple: CssDeclaration = ['color', 'red', 'blue'];

const requiredEngine: StyleEngineRequirement = { id: 'example', version: 'renderer-1' };
const legacyEngine: StyleEngine = { id: 'legacy' };
// @ts-expect-error Exact renderer requirements cannot omit the version.
const missingRendererVersion: StyleEngineRequirement = { id: 'example' };
// @ts-expect-error A resolved rendering requirement must provide compilation.
const missingCompiler: ResolvedStyleEngine = { id: 'example', version: 'renderer-1' };
// @ts-expect-error Renderer identities are strings, separate from numeric content revisions.
const numericRendererVersion: StyleEngineRequirement = { id: 'example', version: 1 };

test('renderer types distinguish legacy capabilities from exact compiling requirements', () => {
  assert.equal(requiredEngine.version, 'renderer-1');
  assert.equal(legacyEngine.version, undefined);
});

test('ordered CSS types distinguish literal declarations from property operations', () => {
  assert.deepEqual(declaration, ['display', 'flex']);
  assert.deepEqual(operation, ['display', null]);
  assert.deepEqual(admittedDeclarations, [declaration]);
  assert.deepEqual(admittedOperations, [operation]);
});

test('attribute types distinguish nullable override edits from literal element values', () => {
  assert.equal(removal.attrs?.title, null);
  assert.equal(removal.attrs?.['aria-label'], 'Buy');
});
