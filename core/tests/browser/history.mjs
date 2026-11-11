// Whole-project History acceptance: real gestures, grouped lifecycle/settings, refusal and session boundaries.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { legacyProject } from '../fixtures/legacy-project.js';
import { openRuntime } from '../../lib/runtime.js';

const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-history-browser-'));
await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
let runtime = await openRuntime({ cwd, watch: false });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.PI_DIVLET_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE } : {}) });
const checks = [], errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (fn, label) => {
  const until = Date.now() + 10000;
  while (Date.now() < until) { if (await fn()) return; await sleep(40); }
  throw new Error(`Timed out: ${label}`);
};
const doc = id => runtime.getEntry(id).document;
const authored = () => {
  const { version, ...settings } = runtime.settings;
  return { settings: structuredClone(settings), frames: [...runtime.documents.values()].map(entry => {
    const { version, ...frame } = entry.document;
    return structuredClone(frame);
  }) };
};
const patch = (id, value, meta = {}) => runtime.patch({ documentId: id, expectedVersion: doc(id).version, patch: value, actor: 'user', ...meta });
const settings = (value, meta = {}) => runtime.patchProject({ expectedVersion: runtime.settings.version, patch: value, actor: 'user', ...meta });
try {
  const removed = (await runtime.createArtboard({ name: 'Middle', x: 1100, y: 600, width: 320, height: 300 })).documentId;
  const second = (await runtime.createArtboard({ name: 'Second', x: 1100, y: 100, width: 320, height: 300 })).documentId;
  const page = await browser.newPage({ viewport: { width: 1500, height: 960 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  let navigationPosts = 0, undoPosts = 0, writes = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/history/navigate')) navigationPosts++;
    if (/\/api\/(?:undo|redo)$/.test(request.url())) undoPosts++;
  });
  const countPersistence = () => {
    const persist = runtime.persist;
    runtime.persist = function (...args) { writes++; return persist.apply(this, args); };
  };
  countPersistence();
  const row = point => page.locator(`#activity [data-history-point="${point}"]`);
  const current = point => wait(async () => (await row(point).getAttribute('aria-current').catch(() => null)) === 'step', `visible current state ${point}`);
  const openHistory = async () => {
    if (!await page.evaluate(async () => (await import('./lib/sidebar.js')).isOpen('activity'))) await page.locator('#open-history').click();
    await current(runtime.historyHead().pointId);
  };
  const visiblePlacement = async () => {
    const expected = [...runtime.documents.values()].map(entry => ({ id: entry.document.id, ...entry.document.artboard }));
    await wait(async () => {
      const { shown, projected } = await page.evaluate(async frames => {
        const { camera } = await import('./lib/canvas.js');
        return {
          projected: frames.map(frame => ({ id: frame.id, x: camera.x + frame.x * camera.k, y: camera.y + frame.y * camera.k, width: frame.width * camera.k, height: frame.height * camera.k })),
          shown: [...document.querySelectorAll('.artboard')].map(node => {
            const transform = new DOMMatrixReadOnly(getComputedStyle(node).transform);
            return { id: node.dataset.artboardId, x: transform.e, y: transform.f, width: parseFloat(node.style.width), height: parseFloat(node.style.height) };
          }),
        };
      }, expected);
      return shown.length === projected.length && projected.every(frame => {
        const actual = shown.find(node => node.id === frame.id);
        return actual && ['x', 'y', 'width', 'height'].every(key => Math.abs(actual[key] - frame[key]) < .02);
      });
    }, 'canvas wrapper positions and dimensions follow the restored authored frames');
  };
  const go = async point => {
    const beforeWrites = writes, beforePosts = navigationPosts, revision = runtime.revision;
    await row(point).click();
    await current(point);
    assert.equal(runtime.historyHead().pointId, point);
    assert.equal(navigationPosts, beforePosts + 1, 'one point request, never a browser Undo loop');
    assert.equal(writes, beforeWrites + 1, 'the complete path persists once');
    assert.equal(runtime.revision, revision + 1);
    await visiblePlacement();
  };
  await page.goto(runtime.url);
  await page.waitForFunction(() => document.querySelector('.artboard[data-artboard-id="welcome"]')?.dataset.status === 'live');
  await page.evaluate(async () => { const m = await import('./lib/store.js'); m.selectArtboards(['welcome']); (await import('./lib/sidebar.js')).close(); });
  const initial = authored(), initialPoint = runtime.historyHead().pointId, depth = runtime.undoStack.length;
  const label = page.locator('.artboard[data-artboard-id="welcome"] .ab-label');
  const box = await label.boundingBox();
  await page.mouse.move(box.x + 25, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 65, box.y + box.height / 2 + 20, { steps: 4 });
  await wait(() => doc('welcome').artboard.x !== initial.frames[0].artboard.x, 'live movement before pointer release');
  const partialPoint = runtime.historyHead().pointId;
  await page.mouse.move(box.x + 145, box.y + box.height / 2 + 70, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(async () => (await import('./lib/store.js')).idle('welcome'));
  let stable = 0, version = doc('welcome').version;
  await wait(async () => { await sleep(100); const next = doc('welcome').version; stable = next === version ? stable + 1 : 0; version = next; return stable >= 3; }, 'released drag commits settle');
  const dragged = authored(), draggedPoint = runtime.historyHead().pointId;
  assert.notDeepEqual(dragged.frames[0].artboard, initial.frames[0].artboard);
  assert.equal(runtime.undoStack.length, depth + 1, 'one real drag is one group');
  assert.notEqual(partialPoint, draggedPoint);
  assert.ok(!runtime.readTimeline().points.some(point => point.id === partialPoint), 'partial drag frontiers are no longer addresses');
  await openHistory();
  assert.equal(await row(partialPoint).count(), 0);
  await go(initialPoint); assert.deepEqual(authored(), initial);
  await go(draggedPoint); assert.deepEqual(authored(), dragged);
  checks.push('real pointer drag creates one endpoint; chosen rows restore exact authored placement and forward return');

  const group = runtime.newGroup(), groupBase = runtime.historyHead().pointId, beforeGroup = authored(), pointCount = runtime.readTimeline().points.length;
  await patch('welcome', { artboard: { x: doc('welcome').artboard.x + 80 }, nodes: { 'title-text': { content: 'Grouped content' } } }, { group, label: 'Grouped project edit' });
  await patch(second, { artboard: { y: 330 }, nodes: { root: { children: ['message'] }, message: { id: 'message', type: 'text', content: 'Grouped second frame' } } }, { group, label: '' });
  await settings({ name: 'Grouped project', tokens: { '--color-brand': '#123456' }, css: 'main { letter-spacing: .1px; }' }, { group, label: '' });
  const transient = (await runtime.createArtboard({ name: 'Transient', group, label: '' })).documentId;
  await runtime.removeDocument({ documentId: removed, expectedVersion: doc(removed).version, actor: 'user', group, label: '' });
  const groupTarget = runtime.historyHead().pointId, afterGroup = authored();
  assert.equal(runtime.readTimeline().points.length, pointCount + 1, 'mixed frame/settings/lifecycle operations share one endpoint');
  assert.deepEqual(afterGroup.frames.map(frame => frame.id), ['welcome', second, transient]);
  await current(groupTarget);
  await go(groupBase); assert.deepEqual(authored(), beforeGroup);
  await page.waitForSelector(`.artboard[data-artboard-id="${removed}"]`);
  assert.equal(await page.locator(`.artboard[data-artboard-id="${transient}"]`).count(), 0);
  await go(groupTarget); assert.deepEqual(authored(), afterGroup);
  await page.locator('iframe[data-document-id="welcome"]').contentFrame().getByText('Grouped content', { exact: true }).waitFor();
  await page.locator(`iframe[data-document-id="${second}"]`).contentFrame().getByText('Grouped second frame', { exact: true }).waitFor();
  assert.equal(await page.locator(`.artboard[data-artboard-id="${removed}"]`).count(), 0);
  await page.waitForSelector(`.artboard[data-artboard-id="${transient}"]`);
  checks.push('one state restores grouped multi-frame content, settings, tokens/CSS, create/delete and frame order');

  const accepted = () => ({ authored: authored(), documents: structuredClone([...runtime.documents.values()].map(entry => entry.document)), settings: structuredClone(runtime.settings), history: runtime.readHistory(), stacks: structuredClone([runtime.undoStack, runtime.redoStack]), revision: runtime.revision });
  const beforeRefusal = accepted();
  const source = await readFile(runtime.projectPath), htmlPath = runtime.getEntry('welcome').htmlPath, html = await readFile(htmlPath);
  const protectedPath = path.join(cwd, 'protected.txt');
  await writeFile(protectedPath, 'protected bytes'); await unlink(htmlPath); await symlink(protectedPath, htmlPath);
  try {
    const response = page.waitForResponse(response => response.url().endsWith('/api/history/navigate'));
    await row(groupBase).click();
    const refused = await response;
    assert.equal(refused.status(), 400);
    assert.equal((await refused.json()).error, 'UNSAFE_PATH');
    await wait(async () => (await page.locator('#activity .history-feedback').innerText()).length > 0, 'visible refusal after controls');
    await current(groupTarget);
    assert.deepEqual(accepted(), beforeRefusal);
    assert.deepEqual(await readFile(runtime.projectPath), source);
    assert.equal(await readFile(protectedPath, 'utf8'), 'protected bytes');
  } finally { await unlink(htmlPath); await writeFile(htmlPath, html); }
  await go(groupBase); assert.deepEqual(authored(), beforeGroup);
  await go(groupTarget); assert.deepEqual(authored(), afterGroup);
  checks.push('real symlink preflight refusal preserves source/model/points/stacks and visible current row; retry recovers');

  let releasePost, capturedBody;
  const postGate = new Promise(resolve => { releasePost = resolve; });
  const holdPost = async route => { capturedBody = route.request().postDataJSON(); await postGate; await route.continue(); };
  await page.route('**/api/history/navigate', holdPost);
  try {
    const response = page.waitForResponse(response => response.url().endsWith('/api/history/navigate'));
    await row(groupBase).click(); await wait(() => capturedBody !== undefined, 'UI navigation POST reaches the held route');
    assert.equal(capturedBody.expectedPoint, groupTarget);
    await patch('welcome', { metadata: { peerEdit: true } }, { label: 'Peer edit while request is held' });
    const peer = runtime.historyHead().pointId, peerState = authored(), peerSource = await readFile(runtime.projectPath), peerRevision = runtime.revision;
    await current(peer);
    releasePost();
    const refused = await response;
    assert.equal(refused.status(), 409); assert.equal((await refused.json()).error, 'HISTORY_CONFLICT');
    await wait(async () => /changed since/.test(await page.locator('#activity .history-feedback').innerText()), 'stale request has a visible conflict');
    await current(peer);
    assert.deepEqual(authored(), peerState); assert.deepEqual(await readFile(runtime.projectPath), peerSource); assert.equal(runtime.revision, peerRevision);
  } finally { releasePost(); await page.unroute('**/api/history/navigate', holdPost); }
  checks.push('a held UI request keeps its captured expected point; a peer edit is preserved and stale replay refuses');

  await patch('welcome', { artboard: { y: doc('welcome').artboard.y + 10 } });
  await settings({ name: 'Keep selective settings' });
  const oldPoints = runtime.readTimeline().points.map(point => point.id);
  await runtime.undo({ documentId: 'welcome' });
  await current(runtime.historyHead().pointId);
  assert.equal(runtime.readTimeline().boundary, 'nonlinear');
  assert.equal(await page.locator('#activity [data-history-point]').count(), 1);
  assert.match(await page.locator('#activity .history-states .history-boundary').innerText(), /Selective Undo/);
  for (const point of oldPoints) assert.equal(await row(point).count(), 0);
  assert.equal(runtime.settings.name, 'Keep selective settings');
  await runtime.redo({ documentId: 'welcome' });
  await patch('welcome', { metadata: { untracked: true } }, { undoable: false });
  const untracked = runtime.historyHead().pointId;
  await current(untracked);
  assert.equal(runtime.readTimeline().boundary, 'untracked');
  assert.equal(await page.locator('#activity [data-history-point]').count(), 1);
  assert.match(await page.locator('#activity .history-states .history-boundary').innerText(), /untracked source change/);
  checks.push('selective legacy replay and untracked edits cut only advertised navigation, with explicit boundaries and no resurrected endpoints');

  await page.reload(); await openHistory(); await current(untracked);
  assert.ok(!(await readFile(runtime.projectPath, 'utf8')).includes(untracked), 'state addresses never become project data');
  const saved = authored();
  await runtime.close(); runtime = await openRuntime({ cwd, watch: false }); countPersistence();
  await page.goto(runtime.url); await openHistory();
  assert.deepEqual(authored(), saved);
  assert.notEqual(runtime.historyHead().pointId, untracked);
  assert.equal(await row(untracked).count(), 0);
  assert.equal(await page.locator('#activity [data-history-point]').count(), 1);
  checks.push('browser reload keeps owner IDs; owner restart keeps authored state but opens a fresh session baseline');

  await page.evaluate(async () => (await import('./lib/sidebar.js')).close());
  const opened = runtime.historyHead().pointId;
  for (let index = 0; index < 201; index++) await patch('welcome', { artboard: { x: index + 1000 } });
  await openHistory();
  assert.equal(runtime.readTimeline().boundary, 'retained');
  assert.equal(await page.locator('#activity [data-history-point]').count(), 201);
  assert.equal(await row(opened).count(), 0);
  assert.match(await page.locator('#activity .history-states .history-boundary').innerText(), /Only the retained/);
  const retained = runtime.readTimeline();
  await go(retained.points[0].id);
  assert.equal(doc('welcome').artboard.x, 1000);
  await go(retained.current);
  assert.equal(doc('welcome').artboard.x, 1200);
  assert.equal(undoPosts, 0);
  assert.deepEqual(errors, []);
  checks.push('real 200-group retention renders only retained addresses and traverses both window edges with one persist each');
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser.close(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
