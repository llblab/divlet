// The browser a website connection starts: a visible window fills the screen and the board follows its real size.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browserLaunchSettings } from '../lib/browser-mcp.ts';

test('a visible connection window opens maximized and the page follows the window, not an emulated viewport', () => {
  const shown = browserLaunchSettings({ headless: false });
  assert.deepEqual(shown.args, ['--start-maximized']);
  assert.equal(shown.context.viewport, null, 'resizing the window resizes the board');
  const hidden = browserLaunchSettings({ headless: true });
  assert.deepEqual(hidden.args, []);
  assert.deepEqual(hidden.context.viewport, { width: 1440, height: 900 }, 'a hidden browser still gets a desktop-sized page');
  for (const settings of [shown, hidden]) assert.deepEqual({ downloads: settings.context.acceptDownloads, permissions: settings.context.permissions }, { downloads: false, permissions: [] }, 'isolation is the same either way');
});
