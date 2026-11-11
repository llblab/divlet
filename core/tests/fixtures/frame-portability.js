// Shared semantic witnesses; each result is bounded even when its input approaches a frame's byte budget.
export function sampleFrame() {
  return { schemaVersion: 1, id: 'test', name: 'A test', version: 1, artboard: { x: 0, y: 0, width: 390, height: 844 }, rootId: 'root', nodes: { root: { id: 'root', type: 'element', tag: 'main', children: ['label'] }, label: { id: 'label', type: 'text', content: 'Hello' } } };
}

export const sourceMapCss = 'a{color:red}/*# sourceMappingURL=data:application/json;base64,bm90LWpzb24= */';
const invalid = (name, change, error = 'INVALID_DOCUMENT') => ({ name, error, run: api => { const frame = sampleFrame(); change(frame); return api.validateDocument(frame); } });
function byteBoundaryFrame(api, extra) {
  const frame = sampleFrame();
  delete frame.nodes.label;
  frame.nodes.root.children = Array.from({ length: 8 }, (_, i) => `t${i}`);
  for (const id of frame.nodes.root.children) frame.nodes[id] = { id, type: 'text', content: '' };
  const canonical = api.validateDocument(frame);
  let remaining = api.LIMITS.bytes - JSON.stringify(canonical).length + extra;
  for (const id of canonical.nodes.root.children) {
    const length = Math.min(api.LIMITS.text, remaining);
    canonical.nodes[id].content = 'a'.repeat(length);
    remaining -= length;
  }
  if (remaining) throw new Error('Byte-boundary fixture exceeds its text slots');
  return canonical;
}

export const frameCases = [
  { name: 'defaults, attribute folding and newline normalization', run: api => { const frame = sampleFrame(); frame.nodes.root.attrs = { TITLE: 'One\r\nTwo' }; frame.nodes.label.content = 'One\rTwo'; return api.validateDocument(frame); } },
  { name: 'native CSS, tokens, inline declaration normalization', run: api => { const frame = sampleFrame(); frame.css = '@media(min-width:1px){main{color:red}}'; frame.tokens = { '--color-brand': 'red !important' }; frame.nodes.root.style = { padding: '12px !important' }; return api.validateDocument(frame); } },
  { name: 'signed fractional geometry and inert metadata', run: api => { const frame = sampleFrame(); frame.artboard.x = -0.5; frame.artboard.width = 390.25; frame.metadata = { schemaVersion: 3, note: 'One\rTwo', score: Number.MAX_VALUE }; return api.validateDocument(frame); } },
  { name: 'atomic patch and source isolation', run: api => {
    const source = api.validateDocument(sampleFrame()), before = JSON.stringify(source);
    const next = api.applyDocumentPatch(source, { nodes: { root: { children: ['group'] }, group: { id: 'group', type: 'element', tag: 'section', children: ['label'] }, label: { content: 'Changed' } } });
    if (JSON.stringify(source) !== before) throw new Error('Patch mutated source');
    return next;
  } },
  { name: 'refused patch leaves source unchanged', run: api => {
    const source = api.validateDocument(sampleFrame()), before = JSON.stringify(source);
    try { api.applyDocumentPatch(source, { nodes: { label: null } }); } catch (error) {
      if (JSON.stringify(source) !== before) throw new Error('Refused patch mutated source');
      return { code: error.code, domainError: error instanceof api.DivletError };
    }
    throw new Error('Invalid patch was accepted');
  } },
  { name: 'merge deletion and array replacement', run: api => {
    const source = api.applyDocumentPatch(sampleFrame(), { nodes: { root: { attrs: { title: 'Old', 'aria-label': 'Greeting' } } } });
    return api.applyDocumentPatch(source, { nodes: { root: { attrs: { title: null } }, label: { content: 'New' } } });
  } },
  { name: 'inspection addresses and ancestors', run: api => api.inspectDocument(sampleFrame(), { ids: ['label'], depth: 0 }) },
  { name: 'bounded query refusal', error: 'INVALID_QUERY', run: api => api.inspectDocument(sampleFrame(), { depth: 9 }) },
  { name: 'starter data needs no compiler', run: api => { const frame = api.createDemoDocument(); return { id: frame.id, nodes: Object.keys(frame.nodes).length, root: frame.rootId }; } },
  { name: 'source-map annotations remain inert CSS comments', run: api => api.validateCss(sourceMapCss) },
  { name: 'inert source-map comment cannot relax single-declaration shape', error: 'INVALID_DOCUMENT', run: api => api.validStyle({ color: 'red /*# sourceMappingURL=data:application/json;base64,bm90LWpzb24= */' }, 'root') },
  { name: 'exact serialized UTF-16 metadata boundary', run: api => Object.keys(api.validateMetadata({ text: 'é'.repeat(65525) }, 'input')) },
  { name: 'next metadata UTF-16 unit refuses', error: 'INVALID_DOCUMENT', run: api => api.validateMetadata({ text: 'é'.repeat(65526) }, 'input') },
  { name: 'exact canonical frame UTF-8 byte budget', run: api => Object.keys(api.validateDocument(byteBoundaryFrame(api, 0)).nodes).length },
  { name: 'next canonical frame UTF-8 byte refuses', error: 'INVALID_DOCUMENT', run: api => api.validateDocument(byteBoundaryFrame(api, 1)) },
  { name: 'UTF-8 overflow below the UTF-16 unit ceiling', error: 'INVALID_DOCUMENT', run: api => {
    const frame = sampleFrame(); frame.nodes.root.children = ['t0', 't1', 't2']; delete frame.nodes.label;
    for (const id of frame.nodes.root.children) frame.nodes[id] = { id, type: 'text', content: '字'.repeat(api.LIMITS.text) };
    return api.validateDocument(frame);
  } },
  invalid('unsupported schema marker', frame => { frame.schemaVersion = 2; }),
  invalid('duplicate tree ownership', frame => { frame.nodes.root.children = ['label', 'label']; }),
  invalid('missing tree target', frame => { frame.nodes.root.children = ['missing']; }),
  invalid('invalid paragraph content', frame => { frame.nodes.root.tag = 'p'; frame.nodes.label = { id: 'label', type: 'element', tag: 'div', children: [] }; }),
  invalid('executable attribute refusal', frame => { frame.nodes.root.attrs = { onclick: 'evil()' }; }),
  invalid('obfuscated executable URL refusal', frame => { frame.nodes.root.attrs = { href: 'java\nscript:evil()' }; }),
  invalid('data-document navigation refusal', frame => { frame.nodes.root.attrs = { href: 'data:text/html,evil' }; }),
  invalid('unrepresentable rendered text', frame => { frame.nodes.label.content = '\ud800'; }),
  invalid('non-finite geometry refusal', frame => { frame.artboard.x = Infinity; }),
  invalid('CSS grammar refusal', frame => { frame.css = 'a{color:red'; }, 'INVALID_CSS'),
  invalid('CSS build directive refusal', frame => { frame.css = '@import "remote.css";'; }, 'UNSUPPORTED_CSS'),
  invalid('escaped CSS declaration refusal', frame => { frame.nodes.root.style = { color: 'red;background:blue' }; }),
];

export function captureFrame(api, run) {
  try { return { ok: true, value: run(api) }; }
  catch (error) { return { ok: false, code: error.code, name: error.name, message: error.message, domainError: error instanceof api.DivletError }; }
}
