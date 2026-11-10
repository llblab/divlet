/*
 * The launcher: one page that lists the projects of a collection (Designs/…), opens one on
 * its own board, and creates new ones. It runs next to the boards, never inside them, and
 * only ever opens exact source files it listed itself.
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, createProject } from './projects.ts';
import type { ProjectEntry } from './projects.ts';
import { importedName, isImportable } from './import.ts';

/** What a started launcher exposes: its token URL, the collection it serves and how to stop it. */
export interface Hub {
  url: string;
  collection: string;
  close(): Promise<void>;
}
/** Options a launcher needs: what to list, what to show as the root and how a board is started. */
export interface HubOptions {
  collection: string;
  root?: string;
  open(file: string): Promise<string>;
  port?: number;
}

const WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url));

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>divlet · projects</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 20 20%27%3E%3Cpath d=%27M8 4.5 2.5 10 8 15.5M10.5 4.5H12L17.5 10 12 15.5h-1.5Z%27 fill=%27none%27 stroke=%27%235b5bf0%27 stroke-width=%271.5%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E">
<script>try { const t = localStorage.getItem('divlet:theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch {}</script>
<link rel="stylesheet" href="./board.css">
<style>
  html, body { overflow: auto; height: auto; min-height: 100%; }
  main { max-width: 880px; margin: 0 auto; padding: 56px 20px 80px; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 22px; }
  h1 { margin: 0; display: inline-flex; align-items: center; gap: 8px; font-size: 22px; font-weight: 650; letter-spacing: -.01em; }
  h1 svg { width: 26px; height: 26px; fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .where { font: 12px var(--mono); color: var(--muted); white-space: normal; overflow-wrap: anywhere; min-width: 0; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
  .bar input { flex: 1 1 180px; min-width: 0; height: 36px; padding: 0 12px; border: 0; border-radius: 10px; background: var(--field); color: var(--ink); outline: 0; }
  .bar input:focus { outline: 1.5px solid var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(250px, 100%), 1fr)); gap: 16px 12px; }
  .open-error { margin-top: 20px; min-width: 0; padding: 16px; border: 1px solid var(--hair); border-radius: 14px; background: var(--field); overflow-wrap: anywhere; }
  .open-error h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
  .open-error p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
  .card { width: 100%; height: 100%; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; align-content: start; min-height: 112px; padding: 14px 15px; border: 1px solid var(--hair); border-radius: 14px; background: var(--panel); color: var(--ink); text-align: left; box-shadow: var(--shadow); transition: transform .12s var(--ease), border-color .12s; }
  .card:hover:not(:disabled) { transform: translateY(-1px); border-color: color-mix(in srgb, var(--accent) 50%, transparent); }
  .card:disabled { opacity: .55; cursor: default; }
  .card b { font-size: 14.5px; font-weight: 600; white-space: normal; overflow-wrap: anywhere; }
  .card .meta { font-size: 11.5px; color: var(--muted); }
  .card .path { font: 11px var(--mono); color: var(--muted); white-space: normal; overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chips span { min-height: 19px; padding: 0 7px; border-radius: 6px; background: var(--field); color: var(--muted); font-size: 11px; line-height: 19px; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
  .error { color: var(--bad); font-size: 11.5px; overflow-wrap: anywhere; }
  .empty { padding: 40px 0; color: var(--muted); }
  .new { background: var(--accent); border-color: transparent; color: var(--on-accent); font-weight: 600; }
  button.go { height: 36px; padding: 0 14px; border: 0; border-radius: 10px; background: var(--accent); color: var(--on-accent); font-weight: 600; }
  button.go:hover { background: var(--accent-ink); }
  button.go[aria-busy="true"] { background: linear-gradient(110deg, var(--accent) 30%, var(--accent-ink) 50%, var(--accent) 70%) 0 0 / 300% 100%; animation: go-busy 1.6s linear infinite; cursor: progress; }
  @keyframes go-busy { to { background-position: -300% 0; } }
  @media (prefers-reduced-motion: reduce) { button.go[aria-busy="true"] { animation: none; } }
  .card { position: relative; overflow: hidden; }
  .card[aria-busy="true"] { opacity: 1; cursor: progress; border-color: var(--accent); }
  .card[aria-busy="true"] .meta { color: var(--accent); font-variant-numeric: tabular-nums; }
  /* Opening progress lives on the card itself: an overlay bar on its bottom edge, so nothing reflows. */
  .opening-track { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: var(--field); pointer-events: none; }
  .opening-track::before { content: ''; display: block; width: 30%; height: 100%; border-radius: inherit; background: var(--accent); animation: opening-progress 1.6s ease-in-out infinite; }
  @keyframes opening-progress { from { transform: translateX(-100%); } to { transform: translateX(334%); } }
  @media (prefers-reduced-motion: reduce) { .opening-track::before { animation: none; margin-left: 35%; } }
  .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); padding: 8px 14px; border: 1px solid var(--hair); border-radius: 12px; background: var(--solid); box-shadow: var(--shadow); }
</style>
</head>
<body>
<main>
  <header><h1><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 4.5 2.5 10 8 15.5"/><path d="M10.5 4.5H12L17.5 10 12 15.5h-1.5Z"/></svg>divlet</h1><span class="where" id="where"></span></header>
  <form class="bar" id="bar" autocomplete="off">
    <input id="q" type="text" placeholder="Search, or name a new project" aria-label="Search projects or name a new one" autofocus>
    <button class="go" id="make" type="submit">New project</button>
  </form>
  <div class="grid" id="grid" role="list"></div>
  <div class="empty" id="empty" hidden>No projects here yet. Name one above and press Enter.</div>
  <section class="open-error" id="open-error" role="alert" aria-labelledby="open-error-title" hidden>
    <h2 id="open-error-title"></h2><p id="open-error-message"></p>
  </section>
</main>
<div class="sr-only" id="opening-status" role="status" aria-live="polite" aria-atomic="true"></div>
<div class="toast" id="toast" role="status" hidden></div>
<script type="module">
  const $ = id => document.getElementById(id);
  let projects = [];
  const say = text => { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(say.t); say.t = setTimeout(() => { t.hidden = true; }, 3500); };
  const showError = (title, message) => {
    $('open-error-title').textContent = title;
    $('open-error-message').textContent = message;
    $('open-error').hidden = false;
  };
  const ago = iso => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
  async function call(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.message || data.error), { details: data.details });
    return data;
  }
  let opening = 0, navigating = false;
  const pending = new Set();
  const started = new Map();
  let clock = 0;
  const elapsed = key => { const s = Math.floor((performance.now() - (started.get(key) ?? performance.now())) / 1000); return s < 1 ? 'Opening…' : 'Opening… ' + s + ' s'; };
  function syncPending() {
    for (const card of $('grid').querySelectorAll('.card')) {
      const busy = pending.has(card.dataset.file);
      card.disabled = card.dataset.invalid === 'true' || navigating;
      card.setAttribute('aria-disabled', String(card.disabled || busy));
      card.setAttribute('aria-busy', String(busy));
      const meta = card.querySelector('.meta'), track = card.querySelector('.opening-track');
      meta.textContent = busy ? elapsed(card.dataset.file) : meta.dataset.rest;
      if (busy && !track) { const bar = document.createElement('span'); bar.className = 'opening-track'; bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', 'Opening ' + card.querySelector('b').textContent); card.append(bar); }
      else if (!busy && track) track.remove();
    }
    $('make').disabled = navigating;
    $('make').setAttribute('aria-disabled', String(pending.has('new') || navigating));
    $('make').setAttribute('aria-busy', String(pending.has('new')));
    // One timer while anything is opening keeps the elapsed time honest without inventing a percentage.
    if (pending.size && !clock) clock = setInterval(syncPending, 500);
    else if (!pending.size && clock) { clearInterval(clock); clock = 0; }
  }
  async function openRequest(key, title, route, body, errorTitle) {
    if (pending.has(key) || navigating) return;
    const mine = ++opening;
    pending.add(key);
    started.set(key, performance.now());
    $('open-error').hidden = true;
    $('toast').hidden = true;
    $('opening-status').textContent = title;
    syncPending();
    try {
      const result = await call(route, body);
      if (mine === opening) { navigating = true; location.href = result.url; }
    } catch (error) {
      if (mine === opening) { $('opening-status').textContent = ''; showError(errorTitle, error.message); }
    } finally {
      if (!navigating || mine !== opening) { pending.delete(key); started.delete(key); }
      syncPending();
    }
  }
  const open = project => openRequest(project.file, 'Opening ' + project.name + '…', 'api/open', { file: project.file }, 'Could not open ' + project.name);
  function draw() {
    const q = $('q').value.trim().toLowerCase();
    const shown = projects.filter(p => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
    $('grid').replaceChildren(...shown.map(project => {
      const card = document.createElement('button');
      card.className = 'card';
      card.type = 'button';
      const item = document.createElement('div');
      item.setAttribute('role', 'listitem');
      card.dataset.file = project.file;
      card.dataset.invalid = String(!!project.error);
      const title = Object.assign(document.createElement('b'), { textContent: project.name });
      const meta = Object.assign(document.createElement('span'), { className: 'meta', textContent: project.error ? '' : project.frames + ' frame' + (project.frames === 1 ? '' : 's') + ' · ' + ago(project.modified) });
      const where = Object.assign(document.createElement('span'), { className: 'path', textContent: project.path });
      meta.dataset.rest = meta.textContent;
      card.append(title, meta);
      if (project.error) card.append(Object.assign(document.createElement('span'), { className: 'error', textContent: project.error }));
      else if (project.frameNames?.length) {
        const chips = Object.assign(document.createElement('span'), { className: 'chips' });
        chips.append(...project.frameNames.filter(Boolean).map(name => Object.assign(document.createElement('span'), { textContent: name })));
        card.append(chips);
      }
      card.append(where);
      card.addEventListener('click', () => open(project));
      item.append(card);
      return item;
    }));
    syncPending();
    $('empty').hidden = projects.length > 0;
    $('make').textContent = q && !shown.some(p => p.name.toLowerCase() === q) ? 'Create “' + $('q').value.trim().slice(0, 24) + '”' : 'New project';
  }
  async function load() {
    const data = await call('api/projects');
    projects = data.projects;
    $('where').textContent = data.root;
    document.title = 'divlet · ' + data.root.split('/').filter(Boolean).at(-1);
    draw();
  }
  $('q').addEventListener('input', draw);
  $('bar').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('q').value.trim();
    if (!name) { say('Type a name for the new project.'); $('q').focus(); return; }
    await openRequest('new', 'Opening new project…', 'api/new', { name }, 'Could not open the new project');
  });
  window.addEventListener('pageshow', () => {
    opening++; navigating = false; pending.clear(); started.clear(); $('opening-status').textContent = ''; syncPending();
    load().catch(error => showError('Could not load projects', error.message));
  });
</script>
</body>
</html>
`;

const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) { const piece = chunk as Buffer; bytes += piece.length; if (bytes > 16 * 1024) throw Object.assign(new Error('Request is too large'), { code: 'BODY_TOO_LARGE' }); chunks.push(piece); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/**
 * `collection` holds project files; `root` is only shown. `open(file)`
 * starts (or reuses) a board for that folder and returns its URL.
 */
export async function startHub({ collection, root = collection, open, port = 0 }: HubOptions): Promise<Hub> {
  const token = randomBytes(24).toString('hex');
  const prefix = `/${token}/`;
  let origin = '';
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Loopback only: the Host header must name this exact listener, never a name that resolves elsewhere.
      const bound = (server.address() as { port: number }).port;
      const host = `127.0.0.1:${bound}`;
      if (req.headers.host !== host && req.headers.host !== `localhost:${bound}`) return json(res, 403, { error: 'HOST_NOT_ALLOWED' });
      const url = new URL(req.url ?? '/', origin);
      if (!url.pathname.startsWith(prefix)) return json(res, 404, { error: 'NOT_FOUND' });
      const route = decodeURIComponent(url.pathname.slice(prefix.length));
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'ORIGIN_NOT_ALLOWED' });
      if (req.method === 'GET' && route === '') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:" });
        return res.end(PAGE);
      }
      if (req.method === 'GET' && route === 'board.css') {
        res.writeHead(200, { 'Content-Type': route.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(await fs.readFile(path.join(WEB_ROOT, route)));
      }
      if (req.method === 'GET' && route === 'api/projects') return json(res, 200, { root, collection, projects: await listProjects(collection, root) });
      if (req.method === 'POST' && route === 'api/open') {
        const body = await readBody(req) as { file?: unknown };
        // A `.pen` that has been imported is listed as its Divlet project; a page that still names the `.pen` reaches the same one.
        const listed: ProjectEntry[] = await listProjects(collection, root);
        const known = listed.find(item => item.file === body.file || typeof body.file === 'string' && isImportable(body.file) && item.file === importedName(body.file));
        if (!known) return json(res, 404, { error: 'NOT_FOUND', message: 'That project is not in this collection.' });
        return json(res, 200, { url: await open(known.file) });
      }
      if (req.method === 'POST' && route === 'api/new') {
        const body = await readBody(req) as { name?: unknown };
        return json(res, 200, { url: await open(await createProject(collection, body.name)) });
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (res.headersSent) return res.end();
      const cause = error as NodeJS.ErrnoException & { details?: unknown };
      return json(res, cause.code === 'INVALID_NAME' ? 400 : 500, { error: cause.code || 'INTERNAL_ERROR', message: cause.message, details: cause.details });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url: origin + prefix,
    collection,
    close: () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
