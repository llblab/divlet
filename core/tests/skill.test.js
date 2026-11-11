// The divlet skill is the product's entry point: an agent that has only this file must be able to install the tools, open a
// project and work. So the skill's claims are checked against the code it describes — tool names, CLI flags, error codes, docs —
// instead of drifting into plausible prose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { parse } from 'parse5';
import { createDemoDocument, validateDocument, applyDocumentPatch } from '../lib/model.ts';
import { operationPatch } from '../lib/ops.ts';
import { exportHtml } from '../lib/codec.ts';
import { buildStatic } from '../lib/static.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { TOOLS } from '../lib/contract.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const skillPath = path.join(root, 'skills/divlet/SKILL.md');
const source = await readFile(skillPath, 'utf8');
const meta = YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(source)?.[1] ?? '');
const exists = async file => { try { return (await stat(file)).isFile(); } catch { return false; } };

test('the front matter routes work here, and stays inside the limits a host enforces', () => {
  assert.equal(meta.name, 'divlet', 'the name matches the folder hosts look for');
  assert.match(meta.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase words and hyphens only');
  assert.ok(meta.description.length <= 1024, `descriptions are at most 1024 characters (${meta.description.length})`);
  assert.ok(meta.description.length >= 120, 'and long enough to route real requests');
  for (const trigger of ['board', 'frames', 'Tailwind', 'components', 'project.divlet', 'divlet-mcp']) {
    assert.match(meta.description, new RegExp(trigger.replace('.', '\\.'), 'i'), `the description names ${trigger}`);
  }
});

test('it is an entry point: install the tools, then open, then work', async () => {
  const sections = [...source.matchAll(/^## (\d+)\. (.+)$/gm)].map(match => ({ n: Number(match[1]), title: match[2] }));
  assert.ok(sections.length >= 8, `the skill is a walkthrough, not a reference dump (${sections.length} steps)`);
  assert.deepEqual(sections.map(section => section.n), sections.map((_, index) => index + 1), 'the steps are numbered in order');
  const first = sections.slice(0, 3).map(section => section.title).join(' | ');
  assert.match(first, /tools/i, 'the first step is how to get the tools');
  assert.match(first, /open a project/i, 'the second is how to open one');
  assert.match(first, /loop/i, 'the third is the working loop');

  // A session that has only this skill must be able to run the server and register it.
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const adapter = JSON.parse(await readFile(path.join(root, 'packages/mcp/package.json'), 'utf8'));
  assert.match(source, /npx -y @divlet\/mcp/, 'npx selects the real adapter package');
  const config = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(source)[1]);
  assert.deepEqual(config.mcpServers.divlet.args.slice(0, 2), ['-y', adapter.name]);
  assert.deepEqual(Object.keys(adapter.bin), ['divlet-mcp']);
  assert.ok(source.includes(`${adapter.name}@${pkg.version}`), 'version pinning names the adapter package');
  assert.match(source, /"mcpServers"/, 'and how an MCP host registers it');
  for (const flag of ['--cwd', '--project', '--port', '--no-demo']) assert.ok(source.includes(flag), `it documents ${flag}`);
  const help = await readFile(path.join(root, 'packages/mcp/index.js'), 'utf8');
  for (const flag of ['--cwd', '--project', '--port', '--no-demo']) assert.ok(help.includes(flag), `the server accepts ${flag}`);
});

test('every tool it names is a tool the contract serves, and it names them all once', () => {
  const named = new Set([...source.matchAll(/`([a-z]+_divlet)`/g)].map(match => match[1]));
  const served = new Set(TOOLS.filter(tool => !tool.hidden).map(tool => tool.name));
  for (const name of named) assert.ok(served.has(name), `the skill names ${name}, which the contract serves`);
  for (const name of served) assert.ok(named.has(name), `the skill mentions ${name}`);
  const count = /seven tools/.test(source) ? 7 : null;
  if (count) assert.equal(served.size, count, 'a stated count matches the contract');
});

test('every error code and document it sends the agent to exists', async () => {
  const codes = [...source.matchAll(/`([A-Z][A-Z_]{3,})`/g)].map(match => match[1]);
  assert.ok(codes.length >= 6, 'the refusal table is real');
  // Every module of the core, so a table entry cannot outlive the code that raised it.
  const coerce = async directory => {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await coerce(full));
      else if (/\.(?:ts|js)$/.test(entry.name)) files.push(full);
    }
    return files;
  };
  const haystack = (await Promise.all((await coerce(path.join(root, 'core/lib'))).map(file => readFile(file, 'utf8')))).join('\n');
  for (const code of codes) {
    // `INVALID_*` and `UNSUPPORTED_*` are families: the skill says so, the code raises specific members.
    const pattern = code.endsWith('_') ? `'${code}` : `'${code}'`;
    assert.ok(haystack.includes(pattern), `the code ${code} is raised by the product`);
  }

  for (const [, doc] of source.matchAll(/`docs\/([a-z-]+\.md)`/g)) {
    assert.ok(await exists(path.join(root, 'docs', doc)), `docs/${doc} exists`);
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.ok(pkg.files.includes('docs'), 'and ships with the package the skill belongs to');
  }
});

test('meaningful navigation is the default and its examples reach real portable targets', async t => {
  const navigation = source.split('### Meaningful navigation')[1]?.split('## 4.')[0];
  assert.ok(navigation, 'navigation belongs in the working loop, not only optional deeper reading');
  for (const rule of ['by default', 'no destination', 'attrs.id', 'Play', 'placeholder', 'instances']) assert.ok(navigation.includes(rule), `the navigation rule covers ${rule}`);
  const examples = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(navigation)[1]);
  const frame = id => validateDocument({ ...createDemoDocument(), id, name: id, rootId: 'root', tokens: {}, css: '', metadata: {}, nodes: { root: { id: 'root', type: 'element', tag: 'main', children: [] } } });
  const insert = (doc, specs) => applyDocumentPatch(doc, operationPatch(doc, { type: 'insert', parentId: 'root', spec: specs }).patch);
  const home = insert(frame('home'), [examples.pageLink, examples.sectionLink, examples.sectionTarget]);
  const pricing = insert(frame('pricing'), [examples.pageTarget]);
  assert.notEqual(examples.sectionTarget.id, examples.sectionTarget.attrs.id, 'a DOM anchor is not the internal node ID');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'divlet-skill-links-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const built = await buildStatic({ projectDir: directory, frames: new Map([[home.id, exportHtml(home)], [pricing.id, exportHtml(pricing)]]) });
  const pages = new Map();
  for (const name of ['home.html', 'pricing.html']) {
    const ids = new Map(), hrefs = [];
    const visit = node => {
      const attrs = Object.fromEntries((node.attrs ?? []).map(attr => [attr.name, attr.value]));
      if (attrs.id) ids.set(attrs.id, (ids.get(attrs.id) ?? 0) + 1);
      if (node.tagName === 'a' && attrs.href !== undefined) hrefs.push(attrs.href);
      for (const child of node.childNodes ?? []) visit(child);
    };
    visit(parse(built.files.get(name)));
    pages.set(name, { ids, hrefs });
  }
  assert.equal(pages.get('home.html').hrefs.length, 2);
  for (const href of pages.get('home.html').hrefs) {
    assert.ok(href && href !== '#', 'examples never teach empty or top-of-page placeholders');
    const target = new URL(href, 'https://example.test/deployed/site/home.html');
    assert.equal(target.origin, 'https://example.test');
    assert.ok(target.pathname.startsWith('/deployed/site/'), 'navigation stays portable beneath a deployment prefix');
    const page = pages.get(path.posix.basename(target.pathname));
    assert.ok(page, `the generated page exists for ${href}`);
    assert.equal(page.ids.get(decodeURIComponent(target.hash.slice(1))), 1, `the DOM fragment exists exactly once for ${href}`);
  }
});

test('the model it describes is the model the code validates', async () => {
  const model = await readFile(path.join(root, 'core/lib/model.ts'), 'utf8');
  for (const field of ['className', 'attrs', 'style', 'metadata', 'children', 'reusable']) assert.ok(model.includes(field), `nodes carry ${field}`);
  const ops = await readFile(path.join(root, 'core/lib/ops.ts'), 'utf8');
  for (const op of ['insert', 'move', 'duplicate', 'remove', 'text', 'wrap', 'unwrap', 'detach', 'rename']) {
    assert.ok(source.includes(op) && ops.includes(`type: '${op}'`), `the ${op} operation exists and is described`);
  }
  assert.match(source, /REVISION_CONFLICT/, 'and a stale version is called out where it happens');
});

test('a copied standalone skill stands on its own, and the install path is the documented one', async t => {
  const { cp } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'divlet-skill-copy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const copy = path.join(directory, 'divlet');
  await cp(path.dirname(skillPath), copy, { recursive: true });
  const copied = await readFile(path.join(copy, 'SKILL.md'), 'utf8');
  assert.equal(copied, source, 'copying the folder copies the whole skill');
  assert.doesNotMatch(copied, /node_modules/, 'it does not assume the package sits beside it');
  for (const [, target] of copied.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    const resolved = path.resolve(copy, target.split('#')[0]);
    assert.ok(resolved === copy || resolved.startsWith(copy + path.sep), `${target} stays inside the skill folder`);
    assert.ok(await exists(resolved), `${target} exists in the copy`);
  }
  for (const [, doc] of copied.matchAll(/`docs\/([a-z-]+\.md)`/g)) assert.ok(await exists(path.join(root, 'docs', doc)), `docs/${doc} is the file its public address names`);
  assert.ok(copied.includes('https://github.com/llblab/divlet/blob/main/docs/'), 'documents are named by their public address');

  const command = 'npx skills add llblab/divlet --skill divlet --global';
  for (const file of ['README.md', 'docs/agents.md']) assert.ok((await readFile(path.join(root, file), 'utf8')).includes(command), `${file} documents the skill installation command`);
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.indexOf(command) < readme.indexOf('Register the server'), 'the skill comes first, the server registration second');
  assert.match(readme, /Skip this step under Pi/, 'Pi users are not sent to install the bundled skill twice');
  assert.equal((await stat(path.join(root, 'skills/divlet/SKILL.md'))).isFile(), true, 'the --skill name is a folder in the repository');
});
