// Bottom-stacked conversation, conditional following and reachable history in real Chromium.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { legacyProject } from '../fixtures/legacy-project.js';
import { openRuntime } from '../../lib/runtime.js';

const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(launch);
const errors = [], checks = [];
try {
  for (const [width, size] of [[1280, 100], [390, 100], [390, 200]]) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-chat-'));
    let runtime, context;
    try {
      await legacyProject(path.join(cwd, 'project.divlet'), { demo: true });
      runtime = await openRuntime({ cwd, watch: false });
      runtime.setAgent({ connected: true }); runtime.on('ask', () => {});
      context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width === 390 });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(runtime.url);
      await page.waitForFunction(() => document.querySelectorAll('.artboard').length > 0);
      await page.evaluate(async size => { (await import('./lib/help.js')).setUiSize(size); (await import('./lib/sidebar.js')).show('agent'); }, size);
      const list = page.locator('.chat-list'), input = page.locator('.ask-input');
      // Clearing a focused textarea can nudge Chromium's scroll position by 2px without resizing the log.
      const bottom = () => page.waitForFunction(() => { const n = document.querySelector('.chat-list'); return n.clientHeight > 0 && n.scrollHeight - n.scrollTop - n.clientHeight <= 3 && n.lastElementChild.getBoundingClientRect().bottom <= n.getBoundingClientRect().bottom + 1; });
      const messages = count => page.waitForFunction(count => document.querySelectorAll('.chat-list .bubble').length === count, count);
      const scroll = value => list.evaluate((node, value) => new Promise(resolve => {
        const top = value === 'bottom' ? node.scrollHeight - node.clientHeight : value;
        if (Math.abs(node.scrollTop - top) < 1) return resolve();
        node.addEventListener('scroll', () => requestAnimationFrame(() => resolve()), { once: true });
        node.scrollTop = top;
      }), value);

      await input.fill('First message.'); await input.press('Enter');
      await messages(1);
      await page.waitForFunction(() => document.querySelector('.ask-suggest').hidden);
      const first = await list.evaluate(node => {
        const bubble = node.querySelector('.bubble').getBoundingClientRect(), box = node.getBoundingClientRect(), composer = document.querySelector('.agent-composer').getBoundingClientRect();
        const scale = box.width / node.offsetWidth;
        return { overflow: node.scrollHeight - node.clientHeight, gap: (composer.top - bubble.bottom) / scale, headroom: (bubble.top - box.top) / scale };
      });
      assert.ok(first.overflow <= 1, `one message needs no scroll: ${JSON.stringify(first)}`);
      assert.ok(first.gap >= 0 && first.gap <= 32 && first.headroom > 50, `the first message sits by the composer, not the ceiling: ${JSON.stringify(first)}`);
      runtime.say({ text: 'Example reply.' }); await messages(2); await bottom();
      assert.deepEqual(await list.locator('.bubble').evaluateAll(nodes => nodes.map(n => n.classList.contains('from-user') ? 'user' : 'agent')), ['user', 'agent']);
      const shortStack = await list.evaluate(n => ({ total: n.scrollHeight, height: n.clientHeight }));
      assert.ok(shortStack.total <= shortStack.height + 1, `two short messages need no scrollbar at ${width}px/${size}%: ${JSON.stringify(shortStack)}`);

      for (let i = 0; i < 24; i++) runtime.say({ text: `Reply ${i + 1}: a conversation should grow upward from the composer.\nOlder messages remain reachable above.` });
      await messages(26); await bottom();
      assert.ok(await list.evaluate(n => n.scrollHeight > n.clientHeight && getComputedStyle(n).overflowY === 'auto'), 'only a full stack overflows');
      const composerTop = await page.locator('.agent-composer').evaluate(n => n.getBoundingClientRect().top);
      await scroll(0);
      assert.ok(await list.evaluate(n => n.firstElementChild.getBoundingClientRect().top >= n.getBoundingClientRect().top - 1), 'the oldest message is reachable, not stranded above a flex-end scroll origin');
      runtime.say({ text: 'A new reply must not interrupt reading the oldest message.' }); await messages(27);
      assert.ok(await list.evaluate(n => n.scrollTop <= 1), 'reading the top is not interrupted');
      const middle = await list.evaluate(n => Math.floor((n.scrollHeight - n.clientHeight) / 2));
      await scroll(middle);
      runtime.say({ text: 'Another reply while reading the middle.' }); await messages(28);
      assert.ok(Math.abs(await list.evaluate(n => n.scrollTop) - middle) <= 1, 'reading the middle retains its offset');
      await scroll('bottom');
      runtime.say({ text: 'Following resumes after scrolling back to the bottom.' }); await messages(29); await bottom();
      assert.ok(Math.abs(await page.locator('.agent-composer').evaluate(n => n.getBoundingClientRect().top) - composerTop) <= 1, 'conversation growth never moves the composer');

      if (width === 1280) {
        const edge = await page.locator('.resize-handle[data-panel="sidebar"]').boundingBox();
        const previousWidth = await list.evaluate(n => n.clientWidth);
        await page.mouse.move(edge.x + 4, edge.y + edge.height / 2); await page.mouse.down();
        await page.mouse.move(edge.x - 100, edge.y + edge.height / 2, { steps: 6 }); await page.mouse.up();
        await page.waitForFunction(previousWidth => document.querySelector('.chat-list').clientWidth < previousWidth, previousWidth); await bottom();
      }
      const height = await list.evaluate(n => n.clientHeight);
      await input.fill('A multiline draft\nSecond line\nThird line\nFourth line');
      await page.waitForFunction(height => document.querySelector('.chat-list').clientHeight < height, height); await bottom();
      await input.fill(''); await bottom();
      runtime.setAgent({ busy: true, activity: 'Working on a longer activity description that wraps inside the narrow sidebar' });
      await page.locator('.agent-status:not([hidden])').waitFor(); await bottom();
      runtime.setAgent({ busy: false }); await page.locator('.agent-status').waitFor({ state: 'hidden' }); await bottom();

      await page.evaluate(async () => (await import('./lib/sidebar.js')).close());
      runtime.say({ text: 'A reply delivered while the conversation was folded.' }); await messages(30);
      await page.evaluate(async () => (await import('./lib/sidebar.js')).show('agent')); await bottom();
      await page.evaluate(async () => { const chat = await import('./lib/chat.js'); chat.focus(Number(document.querySelector('.chat-list .bubble').dataset.seq)); });
      await page.waitForFunction(() => { const list = document.querySelector('.chat-list'), box = list.getBoundingClientRect(), first = list.firstElementChild.getBoundingClientRect(); return first.top >= box.top - 1 && first.bottom <= box.bottom + 1; });
      const focusedTop = await list.evaluate(n => n.scrollTop);
      runtime.say({ text: 'An explicitly focused old message must remain in view.' }); await messages(31);
      assert.ok(Math.abs(await list.evaluate(n => n.scrollTop) - focusedTop) <= 1, 'explicit message focus overrides following');
      await scroll(middle);
      await page.evaluate(async () => (await import('./lib/sidebar.js')).close());
      runtime.say({ text: 'A hidden-pane reply must not discard an older reading position.' }); await messages(32);
      await page.evaluate(async () => (await import('./lib/sidebar.js')).show('agent'));
      assert.ok(Math.abs(await list.evaluate(n => n.scrollTop) - middle) <= 1, 'folding and reopening preserves an older reading position');
      await input.fill('Continue at the newest message.'); await input.press('Enter'); await messages(33); await bottom();
      runtime.say({ text: 'Sending a new request explicitly resumes following.' }); await messages(34); await bottom();
      checks.push(`${width}px/${size}%: short stack at bottom, chronological overflow with reachable history, follow/read/resume, fixed composer, multiline/status resize, reopen and explicit focus`);
    } finally { await context?.close(); await runtime?.close(); await rm(cwd, { recursive: true, force: true }); }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await browser.close(); }
