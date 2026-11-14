import test from 'node:test';
import { legacyProject } from './fixtures/legacy-project.js';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openRuntime } from '@divlet/core/runtime';
import { readProject } from '../lib/project.ts';
import { domReferenceProject } from './fixtures/dom-ids.js';
import { componentScopeProject } from './fixtures/component-scope.js';

async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-components-'));
  await legacyProject(path.join(cwd, 'project.divlet'));
  const runtime = await openRuntime({ cwd, watch: false, createDemo: false });
  t.after(async () => { await runtime.close(); await fs.rm(cwd, { recursive: true, force: true }); });
  await runtime.create({ document: components() });
  await runtime.create({ document: page() });
  return { cwd, runtime };
}

const element = (id, tag, children = [], extra = {}) => ({ id, type: 'element', tag, children, ...extra });
const text = (id, content) => ({ id, type: 'text', content });

function components() {
  return {
    schemaVersion: 1, id: 'components', name: 'Components', version: 1, artboard: { x: 0, y: 0, width: 600, height: 400 }, rootId: 'root',
    nodes: {
      root: element('root', 'main', ['button', 'card']),
      button: element('button', 'button', ['button-label'], { reusable: true, className: 'rounded bg-black px-4 py-2 text-white', attrs: { type: 'button' }, metadata: { name: 'Button/Primary' } }),
      'button-label': text('button-label', 'Continue'),
      card: element('card', 'article', ['card-title', 'card-action'], { reusable: true, className: 'rounded-xl p-6 shadow' }),
      'card-title': element('card-title', 'h3', ['card-title-text']),
      'card-title-text': text('card-title-text', 'Card title'),
      'card-action': { id: 'card-action', type: 'ref', ref: 'button', descendants: { 'button-label': { content: 'Open' } } },
    },
  };
}

function page() {
  return {
    schemaVersion: 1, id: 'landing', name: 'Landing', version: 1, artboard: { x: 700, y: 0, width: 800, height: 600 }, rootId: 'root',
    nodes: {
      root: element('root', 'main', ['cta', 'feature']),
      cta: { id: 'cta', type: 'ref', ref: 'components/button', descendants: { 'button-label': { content: 'Sign up' }, button: { className: 'rounded bg-black px-4 py-2 text-white w-full' } } },
      feature: { id: 'feature', type: 'ref', ref: 'components/card', descendants: { 'card-title': { text: 'Fast' }, 'card-action/button-label': { content: 'Learn more' } } },
    },
  };
}

test('instances render their component with overrides, nested instances included', async t => {
  const { runtime } = await fixture(t);
  const html = runtime.render('landing').html;
  assert.match(html, /<button data-divlet-id="cta" data-divlet-ref="components\/button" type="button" class="[^"]*w-full[^"]*">.*Sign up/);
  assert.match(html, /data-divlet-in="feature"[^>]*>.*Fast/);
  assert.match(html, /Learn more/);
  assert.doesNotMatch(html, /Continue|Card title|>Open</);
  // The component frame itself is untouched by its instances.
  assert.match(runtime.render('components').html, /Continue/);
  const file = await fs.readFile(runtime.getEntry('landing').htmlPath, 'utf8');
  assert.match(file, /data-divlet-id="cta" data-divlet-ref="components\/button"/);
  assert.doesNotMatch(file, /data-divlet-in/);
  const meta = JSON.parse(await fs.readFile(runtime.getEntry('landing').metaPath, 'utf8'));
  assert.deepEqual(meta.uses, ['components/button', 'components/card']);
  assert.deepEqual(meta.instances, { cta: 'components/button', feature: 'components/card' });
  assert.deepEqual(meta.dependencies, { components: 1 });
  const componentsMeta = JSON.parse(await fs.readFile(runtime.getEntry('components').metaPath, 'utf8'));
  assert.deepEqual(componentsMeta.components, ['button', 'card']);
  assert.deepEqual(componentsMeta.usedBy, ['landing']);
  const listed = runtime.read({ view: 'components' }).components;
  assert.deepEqual(listed.map(item => [item.ref, item.name, item.instances]), [['components/button', 'Button/Primary', ['components/card-action', 'landing/cta']], ['components/card', 'card', ['landing/feature']]]);
  assert.deepEqual(listed[0].texts, [{ id: 'button-label', content: 'Continue', parentId: 'button' }]);
});

test('editing a component re-renders the frames that use it without changing their versions', async t => {
  const { runtime } = await fixture(t);
  const before = runtime.getEntry('landing');
  const result = await runtime.patch({ documentId: 'components', expectedVersion: 1, patch: { nodes: { button: { className: 'rounded-full bg-emerald-600 px-4 py-2' } } } });
  assert.deepEqual(result.rerendered, ['landing']);
  const after = runtime.getEntry('landing');
  assert.equal(after.document.version, before.document.version);
  assert.ok(after.render > before.render);
  // The instance kept its own className override; the nested instance in the card took the new look.
  assert.match(after.html, /data-divlet-id="cta"[^>]*class="rounded bg-black px-4 py-2 text-white w-full"/);
  assert.match(after.html, /class="rounded-full bg-emerald-600 px-4 py-2"[^>]*>.*Learn more/);
  assert.match(await fs.readFile(after.htmlPath, 'utf8'), /bg-emerald-600/);
  assert.equal(JSON.parse(await fs.readFile(after.metaPath, 'utf8')).dependencies.components, 2);
  // Unrelated edits leave dependants alone.
  const unrelated = await runtime.patch({ documentId: 'components', expectedVersion: 2, patch: { name: 'Design system' } });
  assert.deepEqual(unrelated.rerendered, ['landing']);
  assert.equal(runtime.getEntry('landing').render, after.render);
});

test('a component that is still used cannot disappear, and broken references are explained', async t => {
  const { runtime } = await fixture(t);
  await assert.rejects(runtime.patch({ documentId: 'components', expectedVersion: 1, patch: { nodes: { button: { reusable: null } } } }), /Frame components: components\/card-action uses button, which is not a component/);
  await assert.rejects(runtime.patch({ documentId: 'components', expectedVersion: 1, patch: { nodes: { 'button-label': null, button: { children: [] } } } }), /overrides button-label, which is not a node of/);
  await assert.rejects(runtime.removeDocument({ documentId: 'components' }), { code: 'COMPONENT_IN_USE' });
  await assert.rejects(runtime.patch({ documentId: 'landing', expectedVersion: 1, patch: { nodes: { cta: { ref: 'components/nope' } } } }), /there is no frame|has no node nope/);
  await assert.rejects(runtime.patch({ documentId: 'landing', expectedVersion: 1, patch: { nodes: { cta: { descendants: { 'button-label': { className: 'x' } } } } } }), /is text; override its content/);
  await assert.rejects(runtime.patch({ documentId: 'components', expectedVersion: 1, patch: { nodes: { 'button-label': null, button: { children: ['loop'] }, loop: { id: 'loop', type: 'ref', ref: 'card' } } } }), /Component cycle: components\/card → components\/button → components\/card|Component cycle/);
  assert.equal(runtime.read({ view: 'document', documentId: 'components' }).version, 1);
});

test('text peer conflicts preserve accepted source/output/history and identical peers remain undoable', async t => {
  const { runtime, cwd } = await fixture(t);
  await runtime.patch({ documentId: 'landing', expectedVersion: 1, patch: { nodes: { cta: { descendants: { button: { text: 'Agreed' }, 'button-label': { content: 'Agreed' } } } } } });
  const before = runtime.read({ view: 'document', documentId: 'landing' });
  const source = await fs.readFile(path.join(cwd, 'project.divlet')), html = await fs.readFile(runtime.getEntry('landing').htmlPath);
  const history = structuredClone(runtime.historyHead()), selection = structuredClone(runtime.info().selection), render = runtime.getEntry('landing').render;
  await assert.rejects(runtime.patch({ documentId: 'landing', expectedVersion: before.version, patch: { nodes: { cta: { descendants: { button: { text: 'Different' } } } } } }), { code: 'INVALID_OVERRIDE' });
  assert.deepEqual(runtime.read({ view: 'document', documentId: 'landing' }), before);
  assert.deepEqual(await fs.readFile(path.join(cwd, 'project.divlet')), source);
  assert.deepEqual(await fs.readFile(runtime.getEntry('landing').htmlPath), html);
  assert.deepEqual(runtime.historyHead(), history); assert.deepEqual(runtime.info().selection, selection);
  assert.equal(runtime.getEntry('landing').render, render);
  await runtime.undo({});
  assert.equal(runtime.read({ view: 'document', documentId: 'landing' }).nodes.cta.descendants.button.text, undefined);
  await runtime.redo({});
  assert.match(runtime.render('landing').html, /Agreed/);
  assert.equal(runtime.read({ view: 'document', documentId: 'landing' }).nodes.cta.descendants['button-label'].content, 'Agreed');
});

test('literal alias conflicts retain accepted state and equal tag/class peers remain undoable', async t => {
  const { runtime, cwd } = await fixture(t);
  await runtime.patch({ documentId: 'landing', expectedVersion: 1, patch: { nodes: { feature: { descendants: {
    'card-action': { tag: 'button', className: 'rounded' }, 'card-action/button': { tag: 'button', className: 'rounded' },
  } } } } });
  const before = runtime.read({ view: 'document', documentId: 'landing' });
  const source = await fs.readFile(path.join(cwd, 'project.divlet')), html = await fs.readFile(runtime.getEntry('landing').htmlPath);
  const history = structuredClone(runtime.historyHead()), selection = structuredClone(runtime.info().selection), render = runtime.getEntry('landing').render;
  for (const [field, value] of [['tag', 'div'], ['className', 'px-8']]) {
    await assert.rejects(runtime.patch({ documentId: 'landing', expectedVersion: before.version, patch: { nodes: { feature: { descendants: { 'card-action': { [field]: value } } } } } }), { code: 'INVALID_OVERRIDE' });
    assert.deepEqual(runtime.read({ view: 'document', documentId: 'landing' }), before);
    assert.deepEqual(await fs.readFile(path.join(cwd, 'project.divlet')), source);
    assert.deepEqual(await fs.readFile(runtime.getEntry('landing').htmlPath), html);
    assert.deepEqual(runtime.historyHead(), history); assert.deepEqual(runtime.info().selection, selection);
    assert.equal(runtime.getEntry('landing').render, render);
  }
  await runtime.undo({});
  assert.equal(runtime.read({ view: 'document', documentId: 'landing' }).nodes.feature.descendants['card-action'], undefined);
  await runtime.redo({});
  assert.equal(runtime.read({ view: 'document', documentId: 'landing' }).nodes.feature.descendants['card-action/button'].className, 'rounded');
});

test('attribute alias conflicts preserve writer state and equal peers remain undoable', async t => {
  const { runtime, cwd } = await fixture(t);
  await runtime.patch({ documentId: 'landing', expectedVersion: 1, patch: { nodes: { feature: { descendants: {
    'card-action': { attrs: { title: 'Agreed', 'data-retain': 'keep' } }, 'card-action/button': { attrs: { title: 'Agreed' } },
  } } } } });
  const before = runtime.read({ view: 'document', documentId: 'landing' });
  const source = await fs.readFile(path.join(cwd, 'project.divlet')), html = await fs.readFile(runtime.getEntry('landing').htmlPath);
  const history = structuredClone(runtime.historyHead()), selection = structuredClone(runtime.info().selection), render = runtime.getEntry('landing').render;
  const candidate = page(); candidate.id = 'refused-attributes';
  candidate.nodes.feature.descendants['card-action'] = { attrs: { title: null } };
  candidate.nodes.feature.descendants['card-action/button'] = { attrs: { title: 'Agreed' } };
  // Whole-frame admission preserves a stored null operation; sparse tool-patch null would remove the override key instead.
  for (const refuse of [
    () => runtime.patch({ documentId: 'landing', expectedVersion: before.version, patch: { nodes: { feature: { descendants: { 'card-action': { attrs: { title: 'Different' } } } } } } }),
    () => runtime.create({ document: candidate }),
  ]) {
    await assert.rejects(refuse(), { code: 'INVALID_OVERRIDE' });
    assert.deepEqual(runtime.read({ view: 'document', documentId: 'landing' }), before);
    assert.deepEqual(await fs.readFile(path.join(cwd, 'project.divlet')), source);
    assert.deepEqual(await fs.readFile(runtime.getEntry('landing').htmlPath), html);
    assert.deepEqual(runtime.historyHead(), history); assert.deepEqual(runtime.info().selection, selection);
    assert.equal(runtime.getEntry('landing').render, render);
    assert.equal(runtime.documents.has('refused-attributes'), false);
  }
  await runtime.undo({});
  assert.equal(runtime.read({ view: 'document', documentId: 'landing' }).nodes.feature.descendants['card-action'], undefined);
  await runtime.redo({});
  assert.equal(runtime.read({ view: 'document', documentId: 'landing' }).nodes.feature.descendants['card-action/button'].attrs.title, 'Agreed');
});

test('metadata alias conflicts retain selected instances and writer history', async t => {
  const { runtime, cwd } = await fixture(t);
  await runtime.patch({ documentId: 'landing', expectedVersion: 1, patch: { nodes: { feature: { descendants: {
    'card-action': { metadata: { shared: { a: 1 } } }, 'card-action/button': { metadata: { shared: { b: 2 } } },
  } } } } });
  runtime.setSelection({ ids: ['landing'], nodes: { documentId: 'landing', nodeIds: ['feature'] } });
  const before = runtime.read({ view: 'document', documentId: 'landing' });
  const source = await fs.readFile(path.join(cwd, 'project.divlet')), html = await fs.readFile(runtime.getEntry('landing').htmlPath);
  const history = structuredClone(runtime.historyHead()), selection = structuredClone(runtime.info().selection), render = runtime.getEntry('landing').render;
  const candidate = page(); candidate.id = 'refused-metadata';
  candidate.nodes.feature.descendants['card-action'] = { metadata: { shared: null } };
  candidate.nodes.feature.descendants['card-action/button'] = { metadata: { shared: { b: 2 } } };
  for (const refuse of [
    () => runtime.patch({ documentId: 'landing', expectedVersion: before.version, patch: { nodes: { feature: { descendants: { 'card-action': { metadata: { shared: 'replacement' } } } } } } }),
    () => runtime.create({ document: candidate }), // Whole-frame admission retains stored null deletions.
  ]) {
    await assert.rejects(refuse(), { code: 'INVALID_OVERRIDE' });
    assert.deepEqual(runtime.read({ view: 'document', documentId: 'landing' }), before);
    assert.deepEqual(await fs.readFile(path.join(cwd, 'project.divlet')), source);
    assert.deepEqual(await fs.readFile(runtime.getEntry('landing').htmlPath), html);
    assert.deepEqual(runtime.historyHead(), history); assert.deepEqual(runtime.info().selection, selection);
    assert.equal(runtime.getEntry('landing').render, render);
    assert.equal(runtime.documents.has('refused-metadata'), false);
  }
  await runtime.undo({});
  assert.equal(runtime.read({ view: 'document', documentId: 'landing' }).nodes.feature.descendants['card-action'], undefined);
  await runtime.redo({});
  assert.deepEqual(runtime.read({ view: 'document', documentId: 'landing' }).nodes.feature.descendants['card-action/button'].metadata.shared, { b: 2 });
});

test('DOM ID conflicts in dependent instances retain accepted source, selection and history', async t => {
  const { runtime, cwd } = await fixture(t);
  const source = domReferenceProject('for', { unique: true });
  for (const document of source.frames) await runtime.create({ document });
  runtime.setSelection({ ids: ['consumer'], nodes: { documentId: 'consumer', nodeIds: ['second'] } });
  const before = runtime.read({ view: 'document', documentId: 'consumer' });
  const definitions = runtime.read({ view: 'document', documentId: 'definitions' });
  const bytes = await fs.readFile(path.join(cwd, 'project.divlet')), html = await fs.readFile(runtime.getEntry('consumer').htmlPath);
  const history = structuredClone(runtime.historyHead()), selection = structuredClone(runtime.info().selection), render = runtime.getEntry('consumer').render;
  // The definition stays locally unique, but its first occurrence would collide with the explicit second-instance ID.
  await assert.rejects(runtime.patch({ documentId: 'definitions', expectedVersion: definitions.version, patch: { nodes: { target: { attrs: { id: 'field-2' } } } } }), { code: 'INVALID_DOCUMENT' });
  assert.deepEqual(runtime.read({ view: 'document', documentId: 'consumer' }), before);
  assert.deepEqual(runtime.read({ view: 'document', documentId: 'definitions' }), definitions);
  assert.deepEqual(await fs.readFile(path.join(cwd, 'project.divlet')), bytes);
  assert.deepEqual(await fs.readFile(runtime.getEntry('consumer').htmlPath), html);
  assert.deepEqual(runtime.historyHead(), history); assert.deepEqual(runtime.info().selection, selection);
  assert.equal(runtime.getEntry('consumer').render, render);
  await runtime.patch({ documentId: 'consumer', expectedVersion: before.version, patch: { nodes: { second: { descendants: { target: { attrs: { id: 'field-3' } }, referrer: { attrs: { for: 'field-3' } } } } } } });
  assert.match(runtime.render('consumer').html, /for="field-3"/);
  await runtime.undo({});
  assert.match(runtime.render('consumer').html, /for="field-2"/);
  await runtime.redo({});
  assert.match(runtime.render('consumer').html, /for="field-3"/);
});

test('source-only styles stay out of consumer output through edits and Undo', async t => {
  const { runtime } = await fixture(t), input = componentScopeProject();
  await runtime.patchProject({ expectedVersion: 1, patch: { tokens: input.tokens, css: input.css } });
  for (const document of input.frames) await runtime.create({ document });
  runtime.setSelection({ ids: ['consumer'], nodes: { documentId: 'consumer', nodeIds: ['instance'] } });
  const before = runtime.read({ view: 'document', documentId: 'consumer' });
  const html = await fs.readFile(runtime.getEntry('consumer').htmlPath), selected = structuredClone(runtime.info().selection.selectedNodes);
  await runtime.patch({ documentId: 'library', expectedVersion: 1, patch: { tokens: { '--accent': '#ff00ff', '--source-only': '99px' }, css: '.scope{background:black!important}' } });
  assert.deepEqual(runtime.read({ view: 'document', documentId: 'consumer' }), before);
  assert.deepEqual(await fs.readFile(runtime.getEntry('consumer').htmlPath), html, 'unused source-frame context does not enter rendered consumer bytes');
  assert.deepEqual(runtime.info().selection.selectedNodes, selected);
  await runtime.undo({});
  assert.deepEqual(await fs.readFile(runtime.getEntry('consumer').htmlPath), html);
  assert.deepEqual(runtime.read({ view: 'document', documentId: 'consumer' }), before);
  assert.deepEqual(runtime.info().selection.selectedNodes, selected);
  await runtime.redo({});
  assert.deepEqual(await fs.readFile(runtime.getEntry('consumer').htmlPath), html);
  assert.deepEqual(runtime.read({ view: 'document', documentId: 'consumer' }), before);
  assert.deepEqual(runtime.info().selection.selectedNodes, selected);
  await runtime.patch({ documentId: 'consumer', expectedVersion: before.version, patch: { tokens: { '--accent': '#dd00ee' } } });
  assert.match(await fs.readFile(runtime.getEntry('consumer').htmlPath, 'utf8'), /--accent:#dd00ee/);
  const library = runtime.read({ view: 'document', documentId: 'library' });
  assert.equal(library.nodes.component.style.color, 'var(--accent)', 'variable expressions are not replaced by measured values');
  assert.equal(runtime.read({ view: 'document', documentId: 'consumer' }).nodes.instance.ref, 'library/component');
  assert.deepEqual(runtime.info().selection.selectedNodes.nodeIds, ['instance']);
});

test('instances cannot break HTML nesting rules once expanded', async t => {
  const { runtime } = await fixture(t);
  await assert.rejects(runtime.patch({ documentId: 'components', expectedVersion: 1, patch: { nodes: { card: { tag: 'button' } } } }), /Buttons cannot be nested/);
});

test('reusable table rows remain valid only when their expanded parent context is valid', () => {
  const source = { ...components(), id: 'rows', nodes: {
    root: element('root', 'table', ['body']), body: element('body', 'tbody', ['row']),
    row: element('row', 'tr', ['cell'], { reusable: true }), cell: element('cell', 'td', ['label']), label: text('label', 'Cell'),
  } };
  const consumer = { ...page(), nodes: {
    root: element('root', 'table', ['body']), body: element('body', 'tbody', ['instance']),
    instance: { id: 'instance', type: 'ref', ref: 'rows/row' },
  } };
  const accepted = readProject({ schemaVersion: 1, frames: [source, consumer] });
  assert.equal(accepted.frames[1].nodes.instance.type, 'ref');
  const misplaced = structuredClone(consumer);
  misplaced.nodes.root = element('root', 'main', ['instance']);
  delete misplaced.nodes.body;
  assert.throws(() => readProject({ schemaVersion: 1, frames: [source, misplaced] }), { code: 'INVALID_DOCUMENT' });
});

test('detach turns an instance into ordinary nodes that keep its ID', async t => {
  const { runtime } = await fixture(t);
  const result = await runtime.edit({ documentId: 'landing', expectedVersion: 1, op: { type: 'detach', id: 'feature' } });
  const frame = runtime.read({ view: 'document', documentId: 'landing' });
  assert.deepEqual(result.ids, ['feature']);
  assert.equal(frame.nodes.feature.type, 'element');
  assert.equal(frame.nodes.feature.tag, 'article');
  assert.equal(frame.nodes.feature.ref, undefined);
  const html = runtime.render('landing').html;
  assert.match(html, /Fast/);
  assert.match(html, /Learn more/);
  assert.doesNotMatch(html, /data-divlet-in="feature"/);
  assert.deepEqual(runtime.getEntry('landing').uses, ['components/button']);
  await runtime.undo();
  assert.equal(runtime.read({ view: 'document', documentId: 'landing' }).nodes.feature.type, 'ref');
});

test('a request about a selected instance names it and its component', async t => {
  const { runtime } = await fixture(t);
  runtime.setAgent({ connected: true });
  const asked = [];
  runtime.on('ask', request => asked.push(request));
  runtime.ask({ text: 'Make it stand out', ids: ['landing'], nodes: { documentId: 'landing', nodeIds: ['cta'] } });
  assert.match(asked[0].message, /instance#cta of components\/button/);
});

test('instances are inserted with divlet_edit like any other spec, and text cannot be set on them directly', async t => {
  const { runtime } = await fixture(t);
  const inserted = await runtime.edit({ documentId: 'landing', expectedVersion: 1, op: { type: 'insert', parentId: 'root', spec: { ref: 'components/button', descendants: { 'button-label': { content: 'Contact' } } } } });
  assert.deepEqual(inserted.ids, ['button']);
  assert.match(runtime.render('landing').html, /Contact/);
  await assert.rejects(runtime.edit({ documentId: 'landing', expectedVersion: 2, op: { type: 'text', id: 'cta', content: 'x' } }), /is an instance of components\/button/);
  await assert.rejects(runtime.edit({ documentId: 'landing', expectedVersion: 2, op: { type: 'insert', parentId: 'cta', spec: 'text' } }), /is an instance/);
});

test('project tokens and CSS are shared by every frame and changes to them are undoable', async t => {
  const { runtime } = await fixture(t);
  const result = await runtime.patchProject({ expectedVersion: 1, patch: { tokens: { '--brand': '#123456' }, css: '.shared { color: var(--brand); }' } });
  assert.equal(result.version, 2);
  for (const id of ['components', 'landing']) {
    assert.match(runtime.render(id).html, /--brand:#123456/);
    assert.match(runtime.render(id).html, /\.shared \{ color: var\(--brand\); \}/);
  }
  assert.equal(runtime.readHistory().changes.at(-1).summary, 'project tokens, css');
  await assert.rejects(runtime.patchProject({ expectedVersion: 2, patch: { nodes: {} } }), /belongs to a frame/);
  await runtime.undo();
  assert.deepEqual(runtime.info().project.tokens, {});
  assert.doesNotMatch(runtime.render('landing').html, /--brand/);
  const stored = readProject(JSON.parse(await fs.readFile(runtime.projectPath, 'utf8')));
  assert.deepEqual(stored.settings.tokens, {});
  assert.deepEqual(stored.frames.map(frame => frame.id), ['components', 'landing']);
});

test('duplicating a frame shares its components instead of copying them', async t => {
  const { runtime } = await fixture(t);
  const copy = await runtime.createArtboard({ from: 'components' });
  const frame = runtime.read({ view: 'document', documentId: copy.documentId });
  assert.equal(frame.nodes.button.reusable, undefined);
  assert.equal(frame.nodes['card-action'].ref, 'components/button');
  assert.equal(runtime.read({ view: 'components' }).components.length, 2);
});

test('renaming a node moves everything that points at it, and protects used components', async t => {
  const { runtime } = await fixture(t);
  const doc = id => runtime.read({ view: 'document', documentId: id });
  // A plain node of the page: parent, text and undo follow.
  let landing = doc('landing');
  const renamed = await runtime.edit({ documentId: 'landing', expectedVersion: landing.version, op: { type: 'rename', id: 'cta', to: 'sign-up' } });
  assert.deepEqual(renamed.ids, ['sign-up']);
  landing = doc('landing');
  assert.equal(landing.nodes.cta, undefined);
  assert.equal(landing.nodes['sign-up'].id, 'sign-up');
  assert.deepEqual(landing.nodes.root.children, ['sign-up', 'feature']);
  assert.equal(landing.nodes['sign-up'].descendants['button-label'].content, 'Sign up', 'its overrides came along');
  assert.match(runtime.read({ view: 'preview', documentId: 'landing' }).html ?? runtime.render('landing').html, /data-divlet-id="sign-up"/);
  await runtime.undo({});
  assert.ok(doc('landing').nodes.cta && !doc('landing').nodes['sign-up'], 'undo restores the old ID');
  // Refusals are explained.
  const version = doc('landing').version;
  await assert.rejects(runtime.edit({ documentId: 'landing', expectedVersion: version, op: { type: 'rename', id: 'cta', to: 'feature' } }), /already has a node #feature/);
  await assert.rejects(runtime.edit({ documentId: 'landing', expectedVersion: version, op: { type: 'rename', id: 'cta', to: '1st' } }), /not a valid ID/);
  await assert.rejects(runtime.edit({ documentId: 'landing', expectedVersion: version, op: { type: 'rename', id: 'cta', to: 'cta' } }), /already that/);
  // A component used by another frame keeps its IDs (instances address it by them)…
  const components = doc('components');
  await assert.rejects(runtime.edit({ documentId: 'components', expectedVersion: components.version, op: { type: 'rename', id: 'button-label', to: 'label' } }), /used in landing/);
  await assert.rejects(runtime.edit({ documentId: 'components', expectedVersion: components.version, op: { type: 'rename', id: 'button', to: 'btn' } }), /used in landing/);
  // …while the rest of that frame can be renamed, and so can the root.
  await runtime.edit({ documentId: 'components', expectedVersion: components.version, op: { type: 'rename', id: 'root', to: 'sheet' } });
  assert.equal(doc('components').rootId, 'sheet');
  assert.deepEqual(doc('components').nodes.sheet.children, ['button', 'card']);
});

test('renaming inside a frame updates its own instances and override addresses', async t => {
  const { runtime } = await fixture(t);
  const doc = id => runtime.read({ view: 'document', documentId: id });
  // Detach the cross-frame dependency first: only this frame is left using the component.
  const landing = doc('landing');
  await runtime.edit({ documentId: 'landing', expectedVersion: landing.version, op: { type: 'detach', id: 'cta' } });
  await runtime.edit({ documentId: 'landing', expectedVersion: doc('landing').version, op: { type: 'detach', id: 'feature' } });
  const components = doc('components');
  // card-action instances the button inside the same frame: renaming the button keeps the ref.
  await runtime.edit({ documentId: 'components', expectedVersion: components.version, op: { type: 'rename', id: 'button', to: 'primary-button' } });
  const after = doc('components');
  assert.equal(after.nodes['card-action'].ref, 'primary-button');
  await runtime.edit({ documentId: 'components', expectedVersion: after.version, op: { type: 'rename', id: 'button-label', to: 'label' } });
  assert.deepEqual(Object.keys(doc('components').nodes['card-action'].descendants), ['label']);
});
