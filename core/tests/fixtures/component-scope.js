// Ordinary class references and inline declarations travel; source-frame CSS/tokens and outside ancestors do not.
export const projectTokens = { '--accent': '#123456', '--shared-gap': '3px', '--Case': '5px', '--case': '6px', '--project-only': '7px' };
export const projectCss = '.scope{background-color:rgb(10,20,30);border-top:solid 3px rgb(1,2,3)}.leaf{padding-right:var(--project-only);word-spacing:1px}';
export const sourceTokens = { '--accent': '#cc0000', '--shared-gap': '13px', '--Case': '15px', '--source-only': '11px' };
export const sourceCss = '.scope{background-color:rgb(200,0,0);border-top-width:var(--source-only)}.leaf{word-spacing:var(--source-only)}';
export const consumerTokens = { '--accent': '#0000cc', '--shared-gap': '17px', '--Case': '19px', '--consumer-only': '23px' };
export const consumerCss = '.scope{background-color:rgb(0,0,200);border-top-width:var(--consumer-only)}.leaf{word-spacing:var(--consumer-only)}';
const rootStyle = { color: 'var(--accent)', width: 'calc(100px + var(--source-only, 1px))', 'font-size': '16px' };
const leafStyle = { 'margin-left': 'var(--shared-gap)', 'padding-top': 'var(--Case)', 'padding-bottom': 'var(--case)' };
const element = (id, tag, children, extra = {}) => ({ id, type: 'element', tag, children, ...extra });
const frame = (id, nodes, tokens = {}, css = '') => ({ schemaVersion: 1, id, name: id, version: 1, artboard: { x: 0, y: 0, width: 300, height: 200 }, rootId: 'root', tokens, css, nodes });
export function componentScopeProject() {
  return structuredClone({ schemaVersion: 1, tokens: projectTokens, css: projectCss, frames: [
    frame('library', {
      root: element('root', 'main', ['component', 'wrapper'], { style: { '--accent': '#ee9900' } }),
      component: element('component', 'article', ['leaf'], { reusable: true, className: 'scope source-only', style: rootStyle, metadata: { retained: 'definition' } }),
      leaf: element('leaf', 'span', ['label'], { className: 'leaf', style: leafStyle }),
      label: { id: 'label', type: 'text', content: 'Scoped component' },
      wrapper: element('wrapper', 'section', ['nested'], { reusable: true }),
      nested: { id: 'nested', type: 'ref', ref: 'component', descendants: { component: { className: 'scope source-only nested-override', style: { 'border-left-style': 'solid', 'border-left-width': 'var(--source-only, 1px)' } } } },
    }, sourceTokens, sourceCss),
    frame('consumer', { root: element('root', 'main', ['instance']), instance: { id: 'instance', type: 'ref', ref: 'library/component' } }, consumerTokens, consumerCss),
    frame('neutral', { root: element('root', 'main', ['instance']), instance: { id: 'instance', type: 'ref', ref: 'library/component' } }),
    frame('nested', { root: element('root', 'main', ['instance']), instance: { id: 'instance', type: 'ref', ref: 'library/wrapper' } }, { '--accent': '#008800', '--shared-gap': '29px', '--Case': '31px', '--consumer-only': '37px' }, consumerCss),
  ] });
}
export const scopeRenderCases = [
  { name: 'library', frame: 'library', expected: { color: 'rgb(238, 153, 0)', background: 'rgb(200, 0, 0)', width: '111px', borderTop: '11px', borderLeft: '0px', marginLeft: '13px', paddingTop: '15px', paddingBottom: '6px', paddingRight: '7px', wordSpacing: '11px' } },
  { name: 'consumer', frame: 'consumer', expected: { color: 'rgb(0, 0, 204)', background: 'rgb(0, 0, 200)', width: '101px', borderTop: '23px', borderLeft: '0px', marginLeft: '17px', paddingTop: '19px', paddingBottom: '6px', paddingRight: '7px', wordSpacing: '23px' } },
  { name: 'neutral', frame: 'neutral', expected: { color: 'rgb(18, 52, 86)', background: 'rgb(10, 20, 30)', width: '101px', borderTop: '3px', borderLeft: '0px', marginLeft: '3px', paddingTop: '5px', paddingBottom: '6px', paddingRight: '7px', wordSpacing: '1px' } },
  { name: 'nested', frame: 'nested', expected: { color: 'rgb(0, 136, 0)', background: 'rgb(0, 0, 200)', width: '101px', borderTop: '37px', borderLeft: '1px', marginLeft: '29px', paddingTop: '31px', paddingBottom: '6px', paddingRight: '7px', wordSpacing: '37px' } },
  { name: 'edited-consumer', frame: 'consumer', accent: '#dd00ee', expected: { color: 'rgb(221, 0, 238)', background: 'rgb(0, 0, 200)', width: '101px', borderTop: '23px', borderLeft: '0px', marginLeft: '17px', paddingTop: '19px', paddingBottom: '6px', paddingRight: '7px', wordSpacing: '23px' } },
];
export function scopeRenderProject(row) {
  const input = componentScopeProject();
  if (row.accent) { input.frames[1].tokens['--accent'] = row.accent; input.frames[1].version++; }
  return input;
}
export function expandScope(api, input, id) {
  const before = JSON.stringify(input);
  try {
    const admitted = api.readProject(input), lookup = new Map(admitted.frames.map(frame => [frame.id, frame]));
    return api.expandFrame(lookup.get(id), key => lookup.get(key), admitted.settings);
  } finally { if (JSON.stringify(input) !== before) throw new Error('Scope admission mutated its plain JSON fixture'); }
}
const summary = (expanded, id) => {
  const key = id === 'library' ? 'component' : id === 'nested' ? 'instance:nested' : 'instance';
  const leaf = id === 'library' ? 'leaf' : id === 'nested' ? 'instance:nested:leaf' : 'instance:leaf';
  const node = expanded.document.nodes[key];
  return { tokens: expanded.document.tokens, css: expanded.document.css, className: node.className, style: node.style, leafStyle: expanded.document.nodes[leaf].style, metadata: node.metadata, part: expanded.parts.get(leaf), uses: expanded.uses };
};
export const componentScopeCases = [
  ...['consumer', 'neutral', 'library', 'nested'].map(id => ({ name: `${id} uses project and its own frame context, not the component source context`, expected: {
    tokens: { ...projectTokens, ...(id === 'consumer' ? consumerTokens : id === 'library' ? sourceTokens : id === 'nested' ? { '--accent': '#008800', '--shared-gap': '29px', '--Case': '31px', '--consumer-only': '37px' } : {}) },
    css: id === 'neutral' ? projectCss : projectCss + '\n' + (id === 'library' ? sourceCss : consumerCss),
    className: id === 'nested' ? 'scope source-only nested-override' : 'scope source-only',
    style: id === 'nested' ? { ...rootStyle, 'border-left-style': 'solid', 'border-left-width': 'var(--source-only, 1px)' } : rootStyle,
    leafStyle, metadata: { retained: 'definition' },
    part: id === 'library' ? undefined : { instance: 'instance', address: id === 'nested' ? 'nested/leaf' : 'leaf' },
    uses: id === 'nested' || id === 'library' ? ['library/component', ...(id === 'nested' ? ['library/wrapper'] : [])] : ['library/component'],
  }, run: api => summary(expandScope(api, componentScopeProject(), id), id) })),
  { name: 'source-only CSS and token edits leave full consumer expansion and provenance unchanged', expected: true, run: api => {
    const source = componentScopeProject(), before = ['consumer', 'neutral', 'nested'].map(id => expandScope(api, source, id));
    source.frames[0].tokens = { '--accent': '#ff00ff', '--source-only': '99px' }; source.frames[0].css = '.scope{background:black!important}'; source.frames[0].version++;
    const after = ['consumer', 'neutral', 'nested'].map(id => expandScope(api, source, id));
    return JSON.stringify(before.map(value => ({ ...value, parts: [...value.parts] }))) === JSON.stringify(after.map(value => ({ ...value, parts: [...value.parts] })));
  } },
];
