// Opt-in source/build/installed comparison. Run after building; installation stays with the trusted caller.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const probe = fileURLToPath(new URL('./fixtures/renderer-probe.mjs', import.meta.url));
const entry = core => path.join(core, 'dist/plugins/tailwind/lib/renderer.js');
const inspect = (file, required) => JSON.parse(execFileSync(process.execPath, [probe, file, ...(required ? [required] : [])], { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 30000 }));

function compare(expected, actual) {
  const equal = JSON.stringify(expected.inputs) === JSON.stringify(actual.inputs);
  if (equal) {
    assert.equal(actual.version, expected.version, 'equal selected inputs retain identity after relocation/packaging');
    assert.equal(actual.cssHash, expected.cssHash, 'equal selected inputs retain the exercised compiler output');
  } else assert.notEqual(actual.version, expected.version, 'different selected inputs must not silently share exact compatibility');
  const left = new Map(expected.inputs.packages.map(item => [JSON.stringify(item), item]));
  const right = new Map(actual.inputs.packages.map(item => [JSON.stringify(item), item]));
  return { relationship: equal ? 'same-inputs' : 'selected-inputs-differ', expected: expected.version, actual: actual.version, roots: { expected: expected.inputs.roots, actual: actual.inputs.roots }, packages: { onlyExpected: [...left].filter(([key]) => !right.has(key)).map(([, value]) => value), onlyActual: [...right].filter(([key]) => !left.has(key)).map(([, value]) => value) }, sameStylesheets: JSON.stringify(expected.inputs.stylesheets) === JSON.stringify(actual.inputs.stylesheets), sameProbeCss: expected.cssHash === actual.cssHash, sourceRequirementCheck: actual.requirementCheck };
}

/** Observe the real recipe in isolated subprocesses; paths are diagnostics, never identity inputs. */
export function auditRendererIdentity(installedCore, equivalentCore) {
  const source = inspect(path.join(root, 'plugins/tailwind/lib/renderer.ts'));
  const built = inspect(entry(root), source.version);
  const installed = inspect(entry(path.resolve(installedCore)), source.version);
  const sourceBuild = compare(source, built), sourceInstalled = compare(source, installed);
  const buildInstalled = compare(built, installed);
  const reports = { source, built, installed };
  const result = { sourceBuild, sourceInstalled, buildInstalled };
  if (equivalentCore) {
    const equivalent = inspect(entry(path.resolve(equivalentCore)), source.version);
    assert.deepEqual(equivalent.inputs, source.inputs, 'the caller-selected control installation really has equivalent inputs');
    reports.equivalent = equivalent;
    result.sourceEquivalent = compare(source, equivalent);
  }
  return { status: 'passed', comparisons: result, reports };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], 'Usage: node plugins/tailwind/tests/identity-audit.mjs <installed-core-directory> [equivalent-core-directory]');
  console.log(JSON.stringify(auditRendererIdentity(process.argv[2], process.argv[3]), null, 2));
}
