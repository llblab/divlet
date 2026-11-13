// End to end: an MCP host starts `divlet-mcp --connect <static site>` over stdio with the official SDK client; the tools run in
// the static Pages build inside a managed Chromium. The site is plain files; no MCP server is deployed for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { pagesEntries } from '../../scripts/pages-build.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const files = new Map(await pagesEntries());
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const name = url.pathname.startsWith('/divlet/') ? decodeURIComponent(url.pathname.slice('/divlet/'.length)) || 'index.html' : null;
  if (req.method !== 'GET' || !name || !files.has(name)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(name)] ?? 'application/octet-stream' });
  res.end(files.get(name));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const site = `http://127.0.0.1:${server.address().port}/divlet/`;
test.after(() => server.close());

const env = { ...process.env };
const args = ['scripts/source.mjs', 'mcp/index.js', '--connect', site, '--headless', ...(process.env.PI_DIVLET_CHROMIUM_EXECUTABLE ? ['--browser', process.env.PI_DIVLET_CHROMIUM_EXECUTABLE] : [])];

for (const [era, options] of [['legacy initialize', {}], ['2026-07-28', { versionNegotiation: { mode: { pin: '2026-07-28' } } }]]) {
  test(`an MCP host connects to the static site by URL (${era})`, async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args, cwd: root, env, stderr: 'pipe' });
    const client = new Client({ name: 'agent-host', version: '1.0.0' }, options);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.filter(tool => !tool.name.endsWith('_divlet')).map(tool => tool.name), ['divlet_read', 'divlet_patch', 'divlet_edit', 'divlet_frame_manage', 'divlet_undo', 'divlet_mark']);
      assert.equal(tools.length, 12, 'the browser adapter forwards explicit compatibility aliases');
      assert.ok(tools.every(tool => tool.description.startsWith(`[Website tool from ${new URL(site).origin};`)));
      const project = await client.callTool({ name: 'read_divlet', arguments: {} });
      assert.equal(project.isError, false);
      assert.deepEqual(project.structuredContent.frames.map(frame => frame.id), ['index']);
      const version = project.structuredContent.frames[0].version;
      const patched = await client.callTool({ name: 'patch_divlet', arguments: { frameId: 'index', expectedVersion: version, patch: { name: `Patched over ${era}` } } });
      assert.equal(patched.isError, false, patched.content[0].text);
      assert.equal(patched.structuredContent.version, version + 1);
      const refused = await client.callTool({ name: 'divlet_patch', arguments: { frameId: 'index', expectedVersion: version, patch: { name: 'stale' } } });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /^REVISION_CONFLICT/);
    } finally { await client.close(); }
  });
}
