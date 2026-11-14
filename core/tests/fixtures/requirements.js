// Structural requirement vectors shared by Node and native browser imports; no provider lookup belongs here.
const renderer = (id, version) => ({ styleEngine: { id, version } });
const accepted = (name, input) => ({ name, input, expected: input });
const refused = (name, input) => ({ name, input, error: 'INVALID_PROJECT' });

export const requirementCases = [
  accepted('explicit native CSS profile', {}),
  accepted('unknown renderer is retained', renderer('not-installed.Engine:1', 'Renderer-A')),
  accepted('opaque version is not trimmed or interpreted as a range', renderer('future', ' ^1.2.3 ')),
  accepted('resource-looking identity is data, not loading authority', renderer('node:fs', 'https://invalid.example/renderer.js')),
  accepted('maximum identifier and version lengths', renderer('A' + 'b'.repeat(95), 'v'.repeat(128))),
  refused('missing requirements are not implicit native CSS', undefined),
  refused('null is not an explicit profile', null),
  refused('array is not a profile', []),
  refused('scalar is not a profile', 'native'),
  refused('unknown requirement field', { script: 'renderer.js' }),
  refused('unknown renderer field', { styleEngine: { id: 'future', version: 'v1', module: 'renderer.js' } }),
  refused('null renderer is not an engine-disable conversion', { styleEngine: null }),
  refused('undefined renderer field', { styleEngine: undefined }),
  refused('array renderer descriptor', { styleEngine: [] }),
  refused('missing renderer identity', { styleEngine: {} }),
  refused('missing renderer version', { styleEngine: { id: 'future' } }),
  refused('missing renderer id', { styleEngine: { version: 'v1' } }),
  ...['', '1engine', './renderer', '@scope/renderer', 'a'.repeat(97), 'renderer\n', '雪'].map((id, index) => refused(`unsafe renderer id ${index + 1}`, renderer(id, 'v1'))),
  ...['', 'v'.repeat(129), 'v\n1', 'v\r1', 'v\t1', 'v\0', 'v\u007f', 'v雪', '\ud800', 1, null].map((version, index) => refused(`invalid opaque renderer version ${index + 1}`, renderer('future', version))),
];

export function captureRequirements(api, input) {
  try { return { ok: true, value: api.validateRequirements(input) }; }
  catch (error) { return { ok: false, code: error.code, domainError: error instanceof api.DivletError }; }
}
