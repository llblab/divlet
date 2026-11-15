// Admitted-file fixtures and trusted planning ports, not a browser storage/resolver implementation.
const file = (text, mediaType = 'text/css') => ({ mediaType, bytes: new TextEncoder().encode(text) });
export function declaredHarness(api, entries, overrides = {}) {
  const files = new Map(entries), outputs = new Map(), types = new Map(), sources = [], events = [], tasks = [];
  let open = true, claimed = 0, graph;
  const { allocation, output, ...ports } = overrides;
  const host = {
    allocation: {
      assertOpen() { events.push('open'); if (!open) throw Object.assign(new Error('closed'), { code: 'CLOSED' }); },
      claim(bytes) { events.push('claim'); claimed += bytes; },
      reserve(output) { events.push(`reserve:${output}`); },
      ...allocation,
    },
    output: {
      source(source, output, input) { events.push(`source:${source}`); sources.push(source); types.set(output, input.mediaType); outputs.set(output, new Uint8Array(input.bytes)); },
      text(output, text) { events.push(`text:${output}`); outputs.set(output, text); },
      ...output,
    },
    defer(task) { tasks.push(task); },
    async rewrite(value, source, output) {
      let reference = api.readAssetReference(value);
      if (!reference && value && !value.startsWith('#') && !/^data:/i.test(value)) reference = api.readAssetReference(api.resolveAssetDependency(api.readAssetReference(source).path, value));
      if (!reference) return value;
      return graph.url(reference, output);
    },
    ...ports,
  };
  graph = new api.DeclaredResourceGraph(files, host);
  return { graph, outputs, types, sources, events, tasks, close() { open = false; }, get claimed() { return claimed; }, async drain() { for (let index = 0; index < tasks.length; index++) await tasks[index](); } };
}
export const declaredResourceCases = [
  { name: 'projected URLs register once and retain raw output identity independently of per-use suffixes', async run(api) {
    const h = declaredHarness(api, [['字/a%2Fb.svg', file('bytes', 'application/octet-stream')]]);
    const first = await h.graph.url({ path: '字/a%2Fb.svg', suffix: '?v=1#part' }, 'index.html'); h.close();
    const second = await h.graph.url({ path: '字/a%2Fb.svg', suffix: '#other' }, 'assets/字/style.css');
    return { first, second, size: h.graph.size, outputs: [...h.outputs.keys()], opens: h.events.filter(value => value === 'open').length };
  }, expected: { first: 'assets/%E5%AD%97/a%252Fb.svg?v=1#part', second: '../../assets/%E5%AD%97/a%252Fb.svg#other', size: 1, outputs: ['assets/字/a%2Fb.svg'], opens: 1 } },
  { name: 'cyclic CSS closure reserves identity before deferred discovery; aliases and suffixes survive', async run(api) {
    const bytes = file('binary', 'application/octet-stream');
    const h = declaredHarness(api, [['a.css', file(`@import "b.css";.a{background:url("${api.assetReference('字%25.bin')}?q=1#part")}`)], ['b.css', file('@import "a.css";')], ['字%25.bin', bytes], ['alias.bin', { mediaType: bytes.mediaType, bytes: new Uint8Array(bytes.bytes) }]]);
    await h.graph.add('a.css'); await h.graph.add('alias.bin'); await h.drain();
    const a = h.outputs.get('assets/a.css'), b = h.outputs.get('assets/b.css');
    return { size: h.graph.size, tasks: h.tasks.length, sources: h.sources, cyclic: a.includes('../assets/b.css') && b.includes('../assets/a.css'), suffix: a.includes('../assets/%E5%AD%97%2525.bin?q=1#part'), owned: h.outputs.get('assets/alias.bin').buffer !== h.outputs.get('assets/字%25.bin').buffer };
  }, expected: { size: 4, tasks: 2, sources: ['asset:a.css', 'asset:alias.bin', 'asset:%E5%AD%97%2525.bin', 'asset:b.css'], cyclic: true, suffix: true, owned: true } },
  { name: 'SVG text dependency discovery uses strict XML and real CSS carriers', async run(api) {
    const h = declaredHarness(api, [['icon.svg', file('<svg xmlns="http://www.w3.org/2000/svg"><image href="paint.bin"/><rect fill="url(#paint)"/></svg>', 'image/svg+xml')], ['paint.bin', file('bytes', 'application/octet-stream')]]);
    await h.graph.add('icon.svg'); await h.drain();
    return { size: h.graph.size, mapped: h.outputs.get('assets/icon.svg').includes('href="../assets/paint.bin"'), sameDocument: h.outputs.get('assets/icon.svg').includes('url(&quot;#paint&quot;)') };
  }, expected: { size: 2, mapped: true, sameDocument: true } },
  { name: 'existing members remain readable when closed; new missing members check authority first', async run(api) {
    const h = declaredHarness(api, [['one', file('x', 'application/octet-stream')]]);
    await h.graph.add('one'); h.close(); await h.graph.add('one');
    let code; try { await h.graph.add('absent'); } catch (error) { code = error.code; }
    return { size: h.graph.size, code, calls: h.events.filter(value => value === 'open').length };
  }, expected: { size: 1, code: 'CLOSED', calls: 2 } },
  { name: 'missing open member does not claim budget or reserve output', async run(api) {
    const h = declaredHarness(api, []); let code;
    try { await h.graph.add('absent'); } catch (error) { code = error.code; }
    return { code, events: h.events, size: h.graph.size };
  }, expected: { code: 'INVALID_ASSET', events: ['open'], size: 0 } },
  { name: 'host claim refusal precedes text interpretation and preserves identity', async run(api) {
    const cause = new Error('capacity'), events = [];
    const h = declaredHarness(api, [['bad.css', { mediaType: 'text/css', bytes: new Uint8Array([255]) }]], { allocation: { assertOpen() { events.push('open'); }, claim() { events.push('claim'); throw cause; }, reserve() { events.push('reserve'); } } });
    let same = false; try { await h.graph.add('bad.css'); } catch (error) { same = error === cause; }
    return { same, events, size: h.graph.size };
  }, expected: { same: true, events: ['open', 'claim'], size: 0 } },
  { name: 'text interpretation precedes output reservation', async run(api) {
    const h = declaredHarness(api, [['bad.css', { mediaType: 'text/css', bytes: new Uint8Array([255]) }]]); let code;
    try { await h.graph.add('bad.css'); } catch (error) { code = error.code; }
    return { code, events: h.events, size: h.graph.size };
  }, expected: { code: 'INVALID_ASSET', events: ['open', 'claim'], size: 0 } },
  { name: 'closed CSS refusal leaves initial bytes rather than publishing transformed text', async run(api) {
    const h = declaredHarness(api, [['bad.css', file('.a{background:var(--unknown)}')]]); await h.graph.add('bad.css'); let code;
    try { await h.drain(); } catch (error) { code = error.code; }
    return { code, binary: h.outputs.get('assets/bad.css') instanceof Uint8Array };
  }, expected: { code: 'COPY_UNSUPPORTED_RESOURCE', binary: true } },
  { name: 'ASCII text cannot silently acquire Unicode from a host URL rewrite', async run(api) {
    const h = declaredHarness(api, [['ascii.css', file('.a{background:url(asset:x)}', 'text/css;charset=us-ascii')]], { rewrite: async () => 'λ' });
    await h.graph.add('ascii.css'); let code; try { await h.drain(); } catch (error) { code = error.code; }
    return { code, binary: h.outputs.get('assets/ascii.css') instanceof Uint8Array };
  }, expected: { code: 'INVALID_ASSET', binary: true } },
  { name: 'deferred resolver rejection propagates unchanged and never publishes partial text', async run(api) {
    const cause = new Error('unrequested'), seen = [];
    const h = declaredHarness(api, [['one.svg', file('<svg xmlns="http://www.w3.org/2000/svg"><image href="one"/><image href="two"/></svg>', 'image/svg+xml')]], { rewrite: async value => { seen.push(value); throw cause; } });
    await h.graph.add('one.svg'); let same = false; try { await h.drain(); } catch (error) { same = error === cause; }
    return { same, seen, binary: h.outputs.get('assets/one.svg') instanceof Uint8Array };
  }, expected: { same: true, seen: ['one'], binary: true } },
];
