// Required patch guards are distinct from optional lifecycle guards; messages/details remain compatibility behavior.
const invalid = [
  ['omitted', undefined, 'undefined'], ['null', null, 'null'], ['boolean', false, 'false'], ['zero', 0, '0'],
  ['negative', -1, '-1'], ['stale', 1, '1'], ['fraction', 2.5, '2.5'], ['numeric string', '2', '2'],
  ['NaN', NaN, 'NaN'], ['infinity', Infinity, 'Infinity'], ['array', [], ''], ['object', {}, '[object Object]'],
];
export const patchVersionCases = ['frame', 'project'].flatMap(what => [
  ...invalid.map(([name, value, text]) => ({
    name: `${what} patch refuses ${name}`, expected: { ok: false, code: 'REVISION_CONFLICT', message: `Expected ${what} version 2; received ${text}. ${what === 'frame' ? 'Read the frame again and rebuild the change.' : 'Read the project again.'}`, details: { actualVersion: 2 } },
    run: api => api.assertPatchVersion(value, Object.freeze({ version: 2 }), what === 'frame' ? undefined : what),
  })),
  { name: `${what} patch accepts its exact integer read point`, expected: { ok: true }, run: api => api.assertPatchVersion(2, Object.freeze({ version: 2 }), what === 'frame' ? undefined : what) },
]);
patchVersionCases.push({ name: 'optional lifecycle omission remains accepted', expected: { ok: true }, run: api => api.assertExpectedVersion(undefined, Object.freeze({ version: 2 })) });
export function capturePatchVersion(api, run) {
  try { run(api); return { ok: true }; }
  catch (error) { return { ok: false, code: error.code, message: error.message, details: error.details }; }
}
