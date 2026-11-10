// Freeze-preparation witnesses, not compatibility assertions that preserve known reader inconsistencies.
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { readProject, writeProject } from '../lib/project.ts';
import { validateDocument, DivletError } from '../lib/model.ts';

const fixtures = new URL('./fixtures/format/', import.meta.url);
const cases = JSON.parse(await readFile(new URL('reader-boundaries.json', fixtures), 'utf8'));
const baseFrame = validateDocument({ schemaVersion: 1, ...JSON.parse(await readFile(new URL('web.divlet', fixtures), 'utf8')).frames[0] });
readProject({ schemaVersion: 2, frames: [] });
const admit = operation => {
  try { return { accepted: true, value: operation() }; }
  catch (error) {
    if (!(error instanceof DivletError)) throw error;
    return { accepted: false, code: error.code };
  }
};
const summary = result => result.accepted ? { accepted: true } : { accepted: false, code: result.code };
const checks = cases.map(entry => {
  if (!['name', 'metadata'].includes(entry.field) || !['semantic-roundtrip', 'same-field-policy'].includes(entry.invariant)) throw new Error(`Unknown reader witness: ${entry.id}`);
  const value = JSON.parse(entry.valueJson);
  const project = admit(() => readProject({ schemaVersion: 2, frames: [], [entry.field]: structuredClone(value) }));
  const frame = admit(() => validateDocument({ schemaVersion: 1, ...baseFrame, [entry.field]: structuredClone(value) }));
  const sameFieldPolicy = project.accepted === frame.accepted && (!project.accepted || isDeepStrictEqual(project.value.settings[entry.field], frame.value[entry.field]));
  const roundTrip = project.accepted ? admit(() => readProject(JSON.parse(writeProject(project.value.settings, project.value.frames)))) : null;
  const semanticRoundTrip = roundTrip === null ? null : roundTrip.accepted && isDeepStrictEqual(project.value, roundTrip.value);
  const satisfied = entry.invariant === 'semantic-roundtrip' ? !project.accepted || semanticRoundTrip === true : sameFieldPolicy;
  return {
    id: entry.id, category: entry.category, status: satisfied ? 'passed' : 'blocked',
    field: entry.field, inputValueJson: entry.valueJson, project: summary(project), frame: summary(frame),
    sameFieldPolicy, semanticRoundTrip, ...(!satisfied ? { unblocker: entry.unblocker } : {}),
  };
});
const blocked = checks.filter(check => check.status === 'blocked').length;
console.log(JSON.stringify({ status: blocked ? 'blocked' : 'passed', blocked, checks }, null, 2));
process.exitCode = blocked ? 1 : 0;
