// Instance inspector text readback/edit/reset through the real writer, including equal effective peers.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import { chromium } from 'playwright';
import { openRuntime } from '@divlet/core/runtime';
import { componentTextProject } from '../../core/tests/fixtures/component-text.js';

const browser = await chromium.launch({ headless: true, executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const checks = [];
try {
  for (const [width, size] of [[1280, 100], [390, 200]]) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-instance-text-'));
    let runtime, context;
    try {
      const source = componentTextProject('button', { button: { text: 'Existing', className: 'kept', metadata: { parent: true } }, label: { metadata: { child: true } } });
      await writeFile(path.join(cwd, 'project.divlet'), JSON.stringify(source));
      runtime = await openRuntime({ cwd, watch: false });
      context = await browser.newContext({ viewport: { width, height: 1000 } }); const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(runtime.url); await page.waitForFunction(() => document.querySelector('.artboard[data-artboard-id="consumer"]')?.dataset.status === 'live');
      await page.evaluate(async size => {
        (await import('./lib/help.js')).setUiSize(size);
        (await import('./lib/store.js')).selectNodes('consumer', ['instance'], { reveal: true });
      }, size);
      const field = page.getByRole('textbox', { name: 'label text', exact: true });
      const shown = value => page.waitForFunction(value => document.querySelector('[data-key="override:label"]')?.value === value, value);
      const doc = () => runtime.read({ view: 'document', documentId: 'consumer' });
      const retained = () => {
        const ref = doc().nodes.instance;
        assert.equal(ref.type, 'ref'); assert.equal(ref.ref, 'definitions/button');
        assert.equal(ref.descendants.button.className, 'kept');
        assert.deepEqual(ref.descendants.button.metadata, { parent: true });
        assert.deepEqual(ref.descendants.label.metadata, { child: true });
        assert.deepEqual(runtime.info().selection.selectedNodes.nodeIds, ['instance']);
      };
      await field.waitFor(); assert.equal(await field.inputValue(), 'Existing', 'the inspector shows the effective parent-text override, not the definition');
      const change = async value => {
        const version = doc().version;
        const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/patch'));
        await field.fill(value); await field.press('Enter'); assert.equal((await response).status(), 200);
        await shown(value); assert.equal(doc().version, version + 1, 'one accepted text edit'); retained();
        assert.equal(doc().nodes.instance.descendants.button.text, undefined);
        assert.equal(doc().nodes.instance.descendants.label.content, value);
      };
      const history = async (key, value) => {
        await page.locator('#viewport').focus(); await page.keyboard.press(key); await shown(value); retained();
      };
      await change('Changed');
      await history('Control+z', 'Existing'); await history('Control+Shift+z', 'Changed');
      await runtime.patch({ documentId: 'consumer', expectedVersion: doc().version, patch: { nodes: { instance: { descendants: { button: { text: 'Equal' }, label: { content: 'Equal' } } } } } });
      await shown('Equal'); await change('Different');
      const version = doc().version;
      const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/patch'));
      await page.getByRole('button', { name: 'Back to the component text', exact: true }).click(); assert.equal((await response).status(), 200);
      await shown('Definition'); assert.equal(doc().version, version + 1, 'one accepted reset'); retained();
      assert.equal(doc().nodes.instance.descendants.label.content, undefined);
      assert.equal(doc().nodes.instance.descendants.button.text, undefined);
      await history('Control+z', 'Different'); await history('Control+Shift+z', 'Definition');
      assert.equal(runtime.read({ view: 'document', documentId: 'definitions' }).nodes.label.content, 'Definition');
      assert.deepEqual(errors, []);
      checks.push(`${width}px/${size}%: parent shortcut/equal-peer readback, one-step edits/reset, metadata/class/instance/selection retention and Undo/Redo`);
    } finally { await context?.close(); await runtime?.close(); await rm(cwd, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser.close(); }
