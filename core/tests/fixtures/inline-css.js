// Syntax witnesses, not admitted node styles. Property/content safety and aggregate capacities belong to callers.
import { cssAnnotationCases } from './css-annotations.js';
const accepted = (name, input, value) => ({ name, input, expected: { ok: true, value } });
const refused = (name, input) => ({ name, input, expected: { ok: false, code: 'INVALID_CSS', name: 'DivletError' } });
export const inlineCssCases = [
  accepted('empty block', '', []),
  accepted('CSS whitespace', ' \r\n\t\f ', []),
  accepted('ordered repeated fallbacks', 'display:-webkit-box;display:flex', [['display', '-webkit-box'], ['display', 'flex']]),
  accepted('longhand then shorthand', 'padding-left:20px;padding:10px', [['padding-left', '20px'], ['padding', '10px']]),
  accepted('shorthand then longhand', 'padding:10px;padding-left:20px', [['padding', '10px'], ['padding-left', '20px']]),
  accepted('priority belongs to each repeated declaration', 'color:red! IMPORTANT;color:blue', [['color', 'red !important'], ['color', 'blue']]),
  accepted('property spelling and custom-property case', 'COLOR:red;color:blue;--Accent:gold;--accent:black', [['COLOR', 'red'], ['color', 'blue'], ['--Accent', 'gold'], ['--accent', 'black']]),
  accepted('quoted punctuation is not block structure', 'content:"one;two:{three}";background:url("https://example.invalid/x?a=1;b=2")', [['content', '"one;two:{three}"'], ['background', 'url("https://example.invalid/x?a=1;b=2")']]),
  accepted('non-ASCII property spelling is left to admission', '\u00a0color:red', [['\u00a0color', 'red']]),
  accepted('ordinary names stay dictionary data', 'constructor:one;prototype:two', [['constructor', 'one'], ['prototype', 'two']]),
  accepted('grammar parsing is not executable-content admission', 'color:expression(evil())', [['color', 'expression(evil())']]),
  ...cssAnnotationCases.map(({ name, literal }) => accepted(`inert annotation: ${name}`, `content:${literal};--note:${literal}`, [['content', literal], ['--note', literal]])),
  ...[
    ['block escape', 'color:red}p{color:blue'], ['nested at-rule', '@media print{color:red}'], ['nested rule', '&:hover{color:red}'],
    ['standalone comment', '/*note*/color:red'], ['trailing comment', 'color:red;/*note*/'], ['missing colon', 'color red'], ['unclosed string', 'content:"broken'],
    ['underscore property hack', '_color:red'], ['star property hack', '*color:red'],
    ['non-text number', 0], ['non-text null', null], ['non-text record', {}], ['non-text array', []],
  ].map(([name, input]) => refused(name, input)),
];
export function captureInlineCss(api, input) {
  try { return { ok: true, value: api.parseInlineDeclarations(input) }; }
  catch (error) { return { ok: false, code: error.code, name: error.name }; }
}
