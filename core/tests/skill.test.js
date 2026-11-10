// The divlet skill is the product's entry point: an agent that has only this file must be able to install the tools, open a
// project and work. So the skill's claims are checked against the code it describes — tool names, CLI flags, error codes, docs —
// instead of drifting into plausible prose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
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
  assert.match(source, /npx -y --package=divlet divlet-mcp/, 'npx selects the package before the server binary');
  const config = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(source)[1]);
  assert.deepEqual(config.mcpServers.divlet.args.slice(0, 3), ['-y', `--package=${pkg.name}`, 'divlet-mcp']);
  assert.ok(pkg.bin[config.mcpServers.divlet.args[2]], 'the configured server is a binary the package ships');
  assert.ok(source.includes(`--package=${pkg.name}@${pkg.version}`), 'version pinning names the package, not the binary');
  assert.match(source, /"mcpServers"/, 'and how an MCP host registers it');
  for (const flag of ['--cwd', '--project', '--port', '--no-demo']) assert.ok(source.includes(flag), `it documents ${flag}`);
  const help = await readFile(path.join(root, 'adapters/mcp/index.js'), 'utf8');
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

test('the model it describes is the model the code validates', async () => {
  const model = await readFile(path.join(root, 'core/lib/model.ts'), 'utf8');
  for (const field of ['className', 'attrs', 'style', 'metadata', 'children', 'reusable']) assert.ok(model.includes(field), `nodes carry ${field}`);
  const ops = await readFile(path.join(root, 'core/lib/ops.ts'), 'utf8');
  for (const op of ['insert', 'move', 'duplicate', 'remove', 'text', 'wrap', 'unwrap', 'detach', 'rename']) {
    assert.ok(source.includes(op) && ops.includes(`type: '${op}'`), `the ${op} operation exists and is described`);
  }
  assert.match(source, /REVISION_CONFLICT/, 'and a stale version is called out where it happens');
});
