// Server graph acceptance is not completion of a browser action's selection effect.
import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { openRuntime } from '@divlet/core/runtime';
import { decodeHtml } from '../../core/lib/codec.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'divlet-selection-completion-'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const checks = [], evidence = [];
try {
  for (const phase of ['accepted-only', 'selection-complete']) {
    let runtime, page, release;
    try {
      await legacyProject(path.join(root, phase, 'project.divlet'));
      runtime = await openRuntime({ file: path.join(root, phase, 'project.divlet'), watch: false, createDemo: false });
      await runtime.create({ document: decodeHtml('<main id="root" class="p-8"><div id="hero"><button id="cta" type="button">Original</button></div></main>', { fallbackId: 'screen' }) });
      page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); const errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(runtime.url); await page.waitForSelector('#loading', { state: 'hidden' });
      await page.evaluate(async () => {
        window.selectionTest = await import('./lib/store.js'); await window.selectionTest.freshModel('screen');
        window.selectionTest.selectNodes('screen', ['cta']);
        window.deleteObservation = null;
        window.addEventListener('keydown', event => {
          if (event.key !== 'Delete') return;
          const { store, descriptor } = window.selectionTest, doc = descriptor('screen');
          window.deleteObservation = { stateVersion: store.state.stateVersion, revision: store.state.revision, frameVersion: doc.version, render: doc.render, nodeIds: store.node?.nodeIds || [], focus: { tag: document.activeElement?.tagName, id: document.activeElement?.id }, selectionPending: window.selectionTest.isSelectionPending() };
        }, true);
      });
      await page.waitForFunction(() => document.querySelector('.artboard')?.dataset.status === 'live');
      await page.waitForFunction(() => !window.selectionTest.isSelectionPending());
      await page.locator('#viewport').focus();
      // Actual right-click through the confined preview path, not a direct duplicate API call.
      const frame = page.frames().find(frame => frame.url().includes('/preview/screen'));
      const inner = await frame.evaluate(() => { const r = document.querySelector('[data-divlet-id="cta"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      const outer = await page.locator('iframe[data-document-id="screen"]').evaluate(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, scale: r.width / node.offsetWidth }; });
      await page.mouse.click(outer.x + inner.x * outer.scale, outer.y + inner.y * outer.scale, { button: 'right' });
      const duplicate = page.getByRole('menuitem', { name: /^Duplicate/ }); await duplicate.waitFor();
      let entered, reply; const entry = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
      await page.route('**/api/edit', async route => {
        const body = route.request().postDataJSON();
        const observed = { type: body.op.type, ids: body.op.ids, expectedVersion: body.expectedVersion }; requests.push(observed);
        const response = await route.fetch(); observed.status = response.status();
        if (body.op.type === 'duplicate') { reply = await response.json(); entered(); await gate; }
        await route.fulfill({ response });
      });
      await duplicate.click(); await entry;
      assert.ok(runtime.read({ view: 'document', documentId: 'screen' }).nodes['cta-copy']);
      await page.waitForFunction(version => window.selectionTest.descriptor('screen')?.version === version, reply.version);
      await page.evaluate(() => window.selectionTest.freshModel('screen'));
      assert.deepEqual(await page.evaluate(() => window.selectionTest.store.node.nodeIds), ['cta']);
      assert.equal(await page.evaluate(() => !!window.selectionTest.cachedModel('screen')?.nodes['cta-copy']), true);
      assert.equal(await page.locator('#viewport').evaluate(node => document.activeElement === node), true, 'context menu restores canvas focus');
      const before = runtime.info();
      const removed = page.waitForResponse(response => response.url() === runtime.url + 'api/edit' && response.request().postDataJSON().op.type === 'remove');
      if (phase === 'accepted-only') {
        // The old controls precondition is already true, but Delete still targets the selected original.
        await page.keyboard.press('Delete'); release();
      } else {
        release();
        await page.waitForFunction(() => window.selectionTest.store.node?.documentId === 'screen' && window.selectionTest.store.node.nodeIds[0] === 'cta-copy');
        await page.waitForFunction(() => !window.selectionTest.isSelectionPending());
        assert.deepEqual(runtime.info().selection.selectedNodes.nodeIds, ['cta-copy']);
        await page.keyboard.press('Delete');
      }
      assert.equal((await removed).status(), 200);
      const model = runtime.read({ view: 'document', documentId: 'screen' }), target = phase === 'accepted-only' ? 'cta' : 'cta-copy';
      assert.equal(model.nodes[target], undefined); assert.ok(model.nodes[phase === 'accepted-only' ? 'cta-copy' : 'cta']);
      assert.deepEqual(requests.map(request => [request.type, request.ids, request.status]), [['duplicate', ['cta'], 200], ['remove', [target], 200]], 'no retry/rebase or implicit future target');
      const observation = await page.evaluate(() => window.deleteObservation);
      assert.deepEqual(observation.nodeIds, [target]); assert.deepEqual(observation.focus, { tag: 'MAIN', id: 'viewport' });
      assert.ok(observation.stateVersion >= before.stateVersion); assert.equal(observation.frameVersion, reply.version);
      assert.deepEqual(errors, []);
      evidence.push({ phase, beforeDelete: observation, requests });
      checks.push(phase === 'accepted-only' ? 'runtime and browser graph acceptance can precede duplicate selection; early Delete legitimately removes the original' : 'after duplicate selection completion, the same focused Delete removes only the copy and preserves the original');
    } finally { release?.(); await page?.close(); await runtime?.close(); }
  }
  console.log(JSON.stringify({ status: 'passed', checks, evidence }, null, 2));
} finally { await browser.close(); await fs.rm(root, { recursive: true, force: true }); }
