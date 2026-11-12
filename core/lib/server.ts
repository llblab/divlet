import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runOnRuntime } from './contract.ts';
import type { BoardRuntime } from './contract.ts';
import type { HistoryNavigation } from './history.ts';
import { fileURLToPath } from 'node:url';
import { previewBridge } from './bridge.js';
import { clientPluginFile } from './engine.ts';
import { FONT_LIMITS } from './font.ts';
/**
 * What the HTTP layer needs from a board. Every method is the runtime's own; naming them here keeps this file checkable while
 * the runtime itself is still JavaScript, and states exactly how much of the board the transport depends on.
 */
export interface BoardApi extends BoardRuntime {
  clients: number;
  projectDir: string;
  projectPath: string;
  diagnostics: { has(path: string): boolean };
  readonly publicFiles: ReadonlyMap<string, string | Buffer> | null;
  readonly publicMediaTypes?: ReadonlyMap<string, string>;
  info(): any;
  read(query: Record<string, unknown>): any;
  render(documentId: string): { documentId: string; version: number; render: number; html: string };
  readHistory(query: Record<string, unknown>): any;
  navigateHistory(query: HistoryNavigation): Promise<unknown>;
  setSelection(body: unknown): any;
  setObservations(body: unknown): any;
  exportDocument(documentId: string, options: { nodeId?: string; nodeIds?: string[]; expectedVersion?: number; expectedProjectVersion?: number }): Promise<any>;
  browse(target: string): Promise<any>;
  importStatus(): Promise<any>;
  importAgain(): Promise<any>;
  openProject(body: Record<string, unknown>): Promise<any>;
  saveAs(body: Record<string, unknown>): Promise<any>;
  suggestClasses(body: Record<string, unknown>): Promise<any>;
  explainClasses(body: Record<string, unknown>): Promise<any>;
  patchProject(body: Record<string, unknown>): Promise<any>;
  listAssets(query: Record<string, unknown>): Promise<any>;
  saveAsset(body: Record<string, unknown>): Promise<any>;
  saveFont(body: Record<string, unknown>): Promise<any>;
  patch(body: Record<string, unknown>): Promise<any>;
  edit(body: Record<string, unknown>): Promise<any>;
  undo(body: Record<string, unknown>): Promise<any>;
  redo(body: Record<string, unknown>): Promise<any>;
  createArtboard(body: Record<string, unknown>): Promise<any>;
  removeDocument(body: Record<string, unknown>): Promise<any>;
  ask(body: Record<string, unknown>): any;
  stopAgent(): any;
  applyAgentSetting(body: unknown): any;
  renderSite(route: string): { version: number; html: string };
  getEntry(documentId: string): { render: unknown; html: string };
  documentDir(documentId: string): string;
  on(event: string, listener: (payload: any) => void): unknown;
  off(event: string, listener: (payload: any) => void): unknown;
}

/** A started board: its token URL and how to stop serving clients. */
export interface BoardServer {
  url: string;
  close(): Promise<void>;
}

const WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url));
const MIME: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

/*
 * `siteBridge` is serialized with `Function#toString` and runs inside the site page, so it may not reference anything from this
 * module: the browser globals it uses are declared locally and the function reads as plain browser code.
 */
declare const parent: any;
declare const location: any;
declare const addEventListener: any;
declare const EventSource: any;

function siteBridge(initialVersion: number, eventsUrl: string, boardUrl: string): void {
  let events: any;
  function receive(state: any): void {
    if (!state || !Object.hasOwn(state, 'site') || (state.site !== null && !Number.isInteger(state.site?.version))) return;
    if (!state.site) {
      events?.close();
      location.replace(boardUrl);
    } else if (state.site.version !== initialVersion) {
      events?.close();
      location.reload();
    }
  }
  if (typeof parent !== 'undefined' && parent !== globalThis) {
    addEventListener('message', (event: any) => {
      if (event.source === parent && event.data?.type === 'divlet:site-state') receive(event.data);
    });
    addEventListener('keydown', (event: any) => {
      if (event.key === 'Escape') parent.postMessage({ type: 'divlet:escape' }, '*');
    });
    parent.postMessage({ type: 'divlet:site-ready' }, '*');
  } else {
    events = new EventSource(eventsUrl);
    events.addEventListener('state', (event: any) => {
      try { receive(JSON.parse(event.data)); } catch {}
    });
    addEventListener('pagehide', () => events.close(), { once: true });
  }
}

/** Read-only public pages never receive an editor channel or capability; only Escape returns to the owning canvas. */
function browseBridge(): void {
  if (typeof parent === 'undefined' || parent === globalThis) return;
  addEventListener('keydown', (event: any) => {
    if (event.key === 'Escape') parent.postMessage({ type: 'divlet:escape' }, '*');
  });
}

function sitePath(pathname: string): string {
  const parts = pathname.split('/').map(segment => {
    const decoded = decodeURIComponent(segment);
    if (/[\\/\0]/.test(decoded) || decoded === '.' || decoded === '..') throw Object.assign(new Error('Invalid site route path.'), { code: 'UNSAFE_PATH' });
    return encodeURIComponent(decoded);
  });
  return '/' + parts.join('/');
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function readRaw(req: IncomingMessage, limit: number, message = `Upload exceeds ${Math.round(limit / 1048576)} MiB`): Promise<Buffer> {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const piece = chunk as Buffer;
    bytes += piece.length;
    if (bytes > limit) throw Object.assign(new Error(message), { code: 'BODY_TOO_LARGE' });
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<any> {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('Expected application/json'), { code: 'CONTENT_TYPE' });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const piece = chunk as Buffer;
    bytes += piece.length;
    if (bytes > 256 * 1024) throw Object.assign(new Error('Request exceeds 256 KiB'), { code: 'BODY_TOO_LARGE' });
    chunks.push(piece);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}




export async function startServer(runtime: BoardApi, { port = 0 }: { port?: number } = {}): Promise<BoardServer> {
  const token = randomBytes(24).toString('hex');
  const prefix = `/${token}/`;
  const streams = new Set<ServerResponse>();
  let origin = '';
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const bound = (server.address() as { port: number }).port;
      const allowedHosts = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);
      if (!allowedHosts.has(req.headers.host as string)) return json(res, 403, { error: 'HOST_NOT_ALLOWED' });
      const url = new URL(req.url ?? '/', origin);
      if (!url.pathname.startsWith(prefix)) return json(res, 404, { error: 'NOT_FOUND' });
      const route = decodeURIComponent(url.pathname.slice(prefix.length));
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'ORIGIN_NOT_ALLOWED' });
      if (req.method === 'GET' && route === 'api/project') return json(res, 200, runtime.info());
      if (req.method === 'GET' && route.startsWith('api/documents/')) return json(res, 200, runtime.read({ view: 'document', documentId: route.slice('api/documents/'.length) }));
      if (req.method === 'GET' && route.startsWith('api/render/')) return json(res, 200, runtime.render(route.slice('api/render/'.length)));
      if (req.method === 'POST' && route === 'api/tool') {
        // The shared capability contract, for a client that attached to this board instead of opening its own writer.
        const body = await readBody(req);
        return json(res, 200, { result: await runOnRuntime(body?.name, body?.args ?? {}, runtime) });
      }
      if (req.method === 'POST' && route === 'api/selection') return json(res, 200, runtime.setSelection(await readBody(req)));
      if (req.method === 'POST' && route === 'api/observations') return json(res, 200, runtime.setObservations(await readBody(req)));
      if (req.method === 'GET' && route === 'api/history') {
        const number = (name: string) => (url.searchParams.has(name) ? Number(url.searchParams.get(name)) : undefined);
        return json(res, 200, runtime.readHistory({ since: number('since'), limit: number('limit'), documentId: url.searchParams.get('documentId') || undefined, actor: url.searchParams.get('actor') || undefined }));
      }
      if (req.method === 'POST' && route === 'api/history/navigate') {
        const body = await readBody(req);
        return json(res, 200, await runtime.navigateHistory({ pointId: body?.pointId, expectedPoint: body?.expectedPoint, actor: 'user' }));
      }
      if (req.method === 'GET' && route.startsWith('api/export/')) {
        const nodeId = url.searchParams.get('node') || undefined;
        const result = await runtime.exportDocument(route.slice('api/export/'.length), { nodeId, ...(url.searchParams.has('nodes') ? { nodeIds: url.searchParams.getAll('nodes') } : {}), ...(url.searchParams.has('version') ? { expectedVersion: Number(url.searchParams.get('version')) } : {}), ...(url.searchParams.has('projectVersion') ? { expectedProjectVersion: Number(url.searchParams.get('projectVersion')) } : {}) });
        if (url.searchParams.get('download') !== '1') return json(res, 200, result);
        const originalName = result.fileName || 'artboard.html', fileName = originalName.replace(/[^A-Za-z0-9_.-]/g, '-');
        const disposition = `attachment; filename="${fileName}"` + (!/[^\x20-\x7e]/.test(originalName) ? '' : `; filename*=UTF-8''${encodeURIComponent(originalName).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())}`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': disposition, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" });
        return res.end(result.html);
      }
      if (req.method === 'GET' && route === 'api/components') return json(res, 200, runtime.read({ view: 'components' }));
      if (req.method === 'GET' && route === 'api/fs') return json(res, 200, await runtime.browse(url.searchParams.get('path') || '~'));
      if (req.method === 'GET' && route === 'api/import-status') return json(res, 200, { status: await runtime.importStatus() });
      if (req.method === 'POST' && route === 'api/reimport') return json(res, 200, await runtime.importAgain());
      if (req.method === 'POST' && route === 'api/open-project') {
        const body = await readBody(req);
        return json(res, 200, await runtime.openProject({ path: body.path, create: body.create === true }));
      }
      if (req.method === 'POST' && route === 'api/save-project') {
        const body = await readBody(req);
        return json(res, 200, await runtime.saveAs({ path: body.path, expectedVersion: body.expectedVersion, expectedFormat: body.expectedFormat }));
      }
      if (req.method === 'GET' && route === 'api/classes') {
        const documentId = url.searchParams.get('documentId') || '';
        if (url.searchParams.has('q')) return json(res, 200, await runtime.suggestClasses({ documentId, query: url.searchParams.get('q'), limit: url.searchParams.get('limit') }));
        return json(res, 200, await runtime.explainClasses({ documentId, names: url.searchParams.get('names') || '' }));
      }
      if (req.method === 'POST' && route === 'api/project') {
        const body = await readBody(req);
        return json(res, 200, await runtime.patchProject({ expectedVersion: body.expectedVersion, patch: body.patch, actor: 'user', label: typeof body.label === 'string' ? body.label.slice(0, 200) : undefined }));
      }
      if (req.method === 'GET' && route === 'api/assets') return json(res, 200, await runtime.listAssets({ documentId: url.searchParams.get('documentId') || undefined }));
      if (req.method === 'POST' && route === 'api/fonts') {
        if (req.headers['content-type'] !== 'application/octet-stream') throw Object.assign(new Error('Expected binary font bytes'), { code: 'CONTENT_TYPE' });
        const data = await readRaw(req, FONT_LIMITS.bytes);
        return json(res, 200, await runtime.saveFont({ name: url.searchParams.get('name'), expectedVersion: Number(url.searchParams.get('expectedVersion')), data }));
      }
      if (req.method === 'POST' && route === 'api/assets') {
        if (!String(req.headers['content-type'] || '').startsWith('image/')) throw Object.assign(new Error('Expected an image upload'), { code: 'CONTENT_TYPE' });
        const data = await readRaw(req, 12 * 1024 * 1024);
        return json(res, 200, await runtime.saveAsset({ name: url.searchParams.get('name'), documentId: url.searchParams.get('documentId') || undefined, group: url.searchParams.get('group') || undefined, mediaType: req.headers['content-type'], data }));
      }
      if (req.method === 'POST' && route.startsWith('api/')) {
        const body = await readBody(req);
        const meta = { actor: 'user', group: typeof body.group === 'string' ? body.group.slice(0, 64) : undefined, label: typeof body.label === 'string' ? body.label.slice(0, 200) : undefined };
        if (route === 'api/patch') return json(res, 200, await runtime.patch({ documentId: body.documentId, expectedVersion: body.expectedVersion, expectedRender: body.expectedRender, patch: body.patch, ...meta }));
        if (route === 'api/edit') return json(res, 200, await runtime.edit({ documentId: body.documentId, expectedVersion: body.expectedVersion, expectedRender: body.expectedRender, op: body.op, ...meta }));
        if (route === 'api/undo') return json(res, 200, await runtime.undo({ documentId: body.documentId }));
        if (route === 'api/redo') return json(res, 200, await runtime.redo({ documentId: body.documentId }));
        if (route === 'api/artboards') return json(res, 200, await runtime.createArtboard({ name: body.name, width: body.width, height: body.height, x: body.x, y: body.y, from: body.from, expectedVersion: body.expectedVersion, ...meta }));
        if (route === 'api/ask') return json(res, 200, runtime.ask({ text: body.text, ids: body.ids, nodes: body.nodes }));
        if (route === 'api/agent/stop') return json(res, 200, runtime.stopAgent());
        if (route === 'api/agent/settings') return json(res, 200, runtime.applyAgentSetting(body));
        if (route === 'api/artboards/delete') return json(res, 200, await runtime.removeDocument({ documentId: body.documentId, expectedVersion: body.expectedVersion, ...meta }));
      }
      if (req.method === 'GET' && route === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        streams.add(res);
        runtime.clients = streams.size;
        res.write(`event: state\ndata: ${JSON.stringify(runtime.info())}\n\n`);
        req.on('close', () => { streams.delete(res); runtime.clients = streams.size; });
        return;
      }
      if (req.method === 'GET' && route === 'site') {
        res.writeHead(308, { Location: prefix + 'site/' + url.search, 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname.startsWith(prefix + 'site/')) {
        const requestedPath = sitePath(url.pathname.slice((prefix + 'site/').length));
        const canonicalPath = requestedPath.endsWith('/') ? requestedPath : requestedPath + '/';
        const rendered = runtime.renderSite(canonicalPath);
        if (canonicalPath !== requestedPath) {
          res.writeHead(308, { Location: prefix + 'site' + canonicalPath + url.search, 'Cache-Control': 'no-store' });
          return res.end();
        }
        const nonce = randomBytes(18).toString('base64');
        const bridge = `;(${siteBridge.toString()})(${JSON.stringify(rendered.version)},${JSON.stringify(prefix + 'events')},${JSON.stringify(prefix)});`;
        const html = rendered.html.replace(/<\/body>/i, `<script nonce="${nonce}">${bridge}</script></body>`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'; font-src 'self' data: https:; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'`, 'X-Content-Type-Options': 'nosniff' });
        return res.end(html);
      }
      if (req.method === 'GET' && route.startsWith('preview/')) {
        const id = route.slice('preview/'.length);
        const entry = runtime.getEntry(id);
        const nonce = randomBytes(18).toString('base64');
        const directory = path.relative(runtime.projectDir, runtime.documentDir(id));
        const base = prefix + 'files/' + (!directory || directory === '.' ? '' : directory.split(path.sep).map(encodeURIComponent).join('/') + '/');
        const bridgeToken = /^[a-f0-9-]{36}$/i.test(url.searchParams.get('bridge') || '') ? url.searchParams.get('bridge') : '';
        const bridge = `;(${previewBridge.toString()})(${JSON.stringify(id)},${entry.render},${JSON.stringify(bridgeToken)},${runtime.diagnostics.has(runtime.projectPath)},false);`;
        const html = runtime.render(id).html.replace(/<head([^>]*)>/i, `<head$1><base href="${base}">`).replace(/<\/body>/i, `<script nonce="${nonce}">${bridge}</script></body>`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'; font-src 'self' data: https:; script-src 'nonce-${nonce}'; connect-src 'none'; base-uri 'self'; form-action 'none'`, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        return res.end(html);
      }
      if (req.method === 'GET' && route.startsWith('build/')) {
        const name = route.slice('build/'.length);
        const contents = runtime.publicFiles?.get(name);
        if (contents === undefined) return json(res, 404, { error: 'NOT_FOUND' });
        const mediaType = runtime.publicMediaTypes?.get(name);
        if (mediaType !== undefined) {
          res.writeHead(200, { 'Content-Type': mediaType, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: https:" });
          return res.end(contents);
        }
        const extension = path.extname(name).toLowerCase();
        if (extension === '.html' || extension === '.htm') {
          const nonce = randomBytes(18).toString('base64');
          const source = contents.toString(), helper = `<script nonce="${nonce}">;(${browseBridge.toString()})();</script>`;
          // Anchor at the document boundary, not a body-like string in authored CSS, comments or scripts.
          const closing = /<\/body>(\s*<\/html>\s*)$/i;
          const html = closing.test(source) ? source.replace(closing, `${helper}</body>$1`) : source + helper;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data: https:; script-src 'nonce-${nonce}'; connect-src 'none'; base-uri 'none'; form-action 'none'` });
          return res.end(html);
        }
        res.writeHead(200, { 'Content-Type': MIME[extension] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:" });
        return res.end(contents);
      }
      if (req.method === 'GET' && route.startsWith('files/')) {
        const relative = route.slice('files/'.length);
        if (relative.includes('\0') || relative.includes('\\')) return json(res, 403, { error: 'UNSAFE_PATH' });
        const requested = path.resolve(runtime.projectDir, relative);
        const real = await fs.realpath(requested);
        const rel = path.relative(runtime.projectDir, real);
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return json(res, 403, { error: 'UNSAFE_PATH' });
        const stat = await fs.stat(real);
        if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return json(res, 404, { error: 'NOT_FOUND' });
        res.writeHead(200, { 'Content-Type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:" });
        return res.end(await fs.readFile(real));
      }
      if (req.method === 'GET' && /^((?:lib\/)?[A-Za-z0-9_-]+\.(?:js|css|html|svg)|)$/.test(route)) {
        const file = route || 'index.html';
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(await fs.readFile(path.join(WEB_ROOT, file)));
      }
      const plugin = req.method === 'GET' && /^plugins\/([a-z0-9-]+)\/([A-Za-z0-9_-]+\.js)$/.exec(route);
      const pluginFile = plugin ? clientPluginFile(plugin[1] as string, plugin[2] as string) : null;
      if (pluginFile) {
        res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(await fs.readFile(pluginFile));
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (res.headersSent) return res.end();
      const cause = error as NodeJS.ErrnoException & { details?: unknown };
      const code = cause.code || (error instanceof SyntaxError ? 'INVALID_JSON' : 'INTERNAL_ERROR');
      const status = ['NOT_FOUND', 'ENOENT'].includes(code) ? 404 : ['STALE_PREVIEW', 'REVISION_CONFLICT', 'RENDER_CONFLICT', 'EXTERNAL_PENDING', 'CANNOT_UNDO', 'HISTORY_CONFLICT', 'HISTORY_POINT_UNAVAILABLE', 'NO_AGENT', 'NOT_BUSY', 'NO_HOST'].includes(code) ? 409 : code === 'BODY_TOO_LARGE' ? 413 : 400;
      return json(res, status, { error: code, message: cause.message, details: cause.details });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const listener = (state: unknown) => {
    const message = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const stream of streams) stream.write(message);
  };
  runtime.on('state', listener);
  const changeListener = (change: unknown) => {
    const message = `event: change\ndata: ${JSON.stringify(change)}\n\n`;
    for (const stream of streams) stream.write(message);
  };
  runtime.on('change', changeListener);
  const heartbeat = setInterval(() => { for (const stream of streams) stream.write(': heartbeat\n\n'); }, 20000);
  heartbeat.unref();
  return {
    url: origin + prefix,
    close: async () => {
      clearInterval(heartbeat);
      runtime.off('state', listener);
      runtime.off('change', changeListener);
      for (const stream of streams) stream.end();
      streams.clear();
      runtime.clients = 0;
      const closing = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closing;
    },
  };
}
