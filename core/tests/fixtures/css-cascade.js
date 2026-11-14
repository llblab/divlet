// Migration witnesses, not a second renderer: references describe the approved raw-CSS target explicitly.
import { sampleFrame } from './frame-portability.js';

const red = 'rgb(255, 0, 0)', blue = 'rgb(0, 0, 255)', green = 'rgb(0, 128, 0)';
const root = { tokens: { '--ink': 'blue' }, css: [':root{--ink:red}.sample{color:var(--ink)}'], legacy: blue, native: red, premature: blue };
export const cssCascadeCases = [
  { name: 'later authored root versus unlayered token', ...root, compiled: '' },
  { name: 'inert compiled bytes do not select a cascade policy', ...root, compiled: '/* inert compiled bytes */' },
  { name: 'ordinary authored rule versus layered utility', css: ['.sample{color:red}'], compiled: '@layer utilities{.sample{color:blue}}', legacy: blue, native: red, premature: blue },
  { name: 'important order reverses layer priority', css: ['.sample{color:red!important}'], compiled: '@layer utilities{.sample{color:blue!important}}', legacy: red, native: blue, premature: red },
  { name: 'explicit nested authored layer remains nested', css: ['@layer ink{.sample{color:red!important}}'], compiled: '@layer utilities{.sample{color:blue!important}}', legacy: red, native: red, premature: red },
  { name: 'separate project and consumer conversions retain their order', css: ['.sample{color:red!important}', '.sample{color:green!important}'], compiled: '@layer utilities{.sample{color:blue!important}}', legacy: green, native: blue, premature: green },
  { name: 'converting before the emitter cutover can change same-layer important precedence', css: ['.sample{color:red!important}'], compiled: '@layer components{.sample{color:green!important}}', legacy: green, native: green, premature: red },
];

export function cascadeFrame(row) {
  const frame = sampleFrame();
  frame.tokens = { ...row.tokens }; frame.css = row.css.join('\n'); frame.nodes.root.className = 'sample';
  return frame;
}

export function cascadeDocuments(codec, row) {
  const frame = cascadeFrame(row), options = { compiledCss: row.compiled };
  // Deliberately authored reference HTML, never claimed to be a production native emitter.
  const reference = css => '<!doctype html><html><head><style>:root{' + Object.entries(frame.tokens).map(([name, value]) => `${name}:${value};`).join('') + '}</style><style>' + css + '</style><style>' + row.compiled + '</style></head><body><main class="sample">Hello</main></body></html>';
  return [
    { mode: 'current-preview', html: codec.encodeHtml(frame, options), expected: row.legacy },
    { mode: 'current-file', html: codec.renderFile(frame, options), expected: row.legacy },
    { mode: 'current-export', html: codec.exportHtml(frame, options), expected: row.legacy },
    { mode: 'raw-reference', html: reference(frame.css), expected: row.native },
    { mode: 'whole-conversion-reference', html: reference(codec.layered(frame.css)), expected: row.legacy },
    { mode: 'separate-conversion-reference', html: reference(row.css.map(css => codec.layered(css)).join('\n')), expected: row.legacy },
    { mode: 'premature-conversion-preview', html: codec.encodeHtml({ ...frame, css: codec.layered(frame.css) }, options), expected: row.premature },
  ];
}
