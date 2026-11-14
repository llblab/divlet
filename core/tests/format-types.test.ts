import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssetTree, AssetFile, Attrs, Override, CssDeclaration, CssDeclarationOperation, DocumentModel } from '../lib/model.ts';
import type { StyleEngine, StyleEngineRequirement, ResolvedStyleEngine } from '../lib/engine.ts';
import { validDeclarations, parseNativeJson, normalizeNativeJson, sameNativeJson } from '../lib/model.ts';
import type { JsonTextLimits, JsonValueLimits } from '../lib/model.ts';
import type { ProjectRequirements } from '../lib/project.ts';
import { validateRequirements } from '../lib/project.ts';

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
const jsonTextLimits: JsonTextLimits = { bytes: 1024, nesting: 16 };
const decodedText: unknown = parseNativeJson('{"schemaVersion":1}', jsonTextLimits);
// @ts-expect-error Text decoding cannot attest a document's schema or fields.
const uncheckedDocument: DocumentModel = decodedText;
// @ts-expect-error JSON container nesting is not the source/DOM depth capacity.
const wrongJsonLimits: JsonTextLimits = { bytes: 1024, depth: 16 };
const jsonValueLimits: JsonValueLimits = { nodes: 1024, nesting: 16 };
const decodedValue: unknown = normalizeNativeJson({ value: -0 }, jsonValueLimits);
const equalNativeValues: boolean = sameNativeJson(decodedValue, { value: 0 });
// @ts-expect-error Object-only value normalization does not attest a document's schema or fields.
const uncheckedValueDocument: DocumentModel = decodedValue;
// @ts-expect-error Object-only expanded-value capacities are not text-byte capacities.
const wrongValueLimits: JsonValueLimits = { bytes: 1024, nesting: 16 };
const nativeRequirements: ProjectRequirements = {};
const declaredRequirements: ProjectRequirements = { styleEngine: requiredEngine };
const decodedRequirements: ProjectRequirements = validateRequirements(declaredRequirements);
const decodedEngine: StyleEngineRequirement | undefined = decodedRequirements.styleEngine;
// @ts-expect-error The native dependency profile is not a plugin-defined bag of fields.
const unknownRequirements: ProjectRequirements = { scripts: [] };
// @ts-expect-error A declared renderer requires an exact string version.
const incompleteRequirements: ProjectRequirements = { styleEngine: { id: 'example' } };
// @ts-expect-error Exact renderer requirements cannot omit the version.
const missingRendererVersion: StyleEngineRequirement = { id: 'example' };
// @ts-expect-error A resolved rendering requirement must provide compilation.
const missingCompiler: ResolvedStyleEngine = { id: 'example', version: 'renderer-1' };
// @ts-expect-error Renderer identities are strings, separate from numeric content revisions.
const numericRendererVersion: StyleEngineRequirement = { id: 'example', version: 1 };

test('renderer types distinguish legacy capabilities from exact compiling requirements', () => {
  assert.equal(requiredEngine.version, 'renderer-1');
  assert.equal(legacyEngine.version, undefined);
  assert.deepEqual(decodedText, { schemaVersion: 1 });
  assert.deepEqual(nativeRequirements, {});
  assert.deepEqual(decodedEngine, requiredEngine);
});

test('native value types distinguish bounded JSON data from admitted documents', () => {
  assert.deepEqual(decodedValue, { value: 0 });
  assert.equal(equalNativeValues, true);
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
