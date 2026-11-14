// Node-side async polling: page.evaluate awaits the predicate, unlike Playwright's Promise-truthy page poller.
import { setTimeout as delay } from 'node:timers/promises';

export async function waitForPage(page, predicate, arg, { timeout = 30_000, interval = 25, message = `Waiting for browser condition: ${predicate}` } = {}) {
  let stopped = false, timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      stopped = true;
      const error = new Error(`${message} (timed out after ${timeout}ms)`);
      error.name = 'TimeoutError';
      reject(error);
    }, timeout);
  });
  const poll = async () => {
    while (!stopped) {
      const value = await page.evaluate(predicate, arg);
      if (stopped) return;
      if (value) return value;
      await delay(interval);
    }
  };
  // Expiry stops new polls; an in-flight read-only evaluation is retired when the caller closes its page/context.
  try { return await Promise.race([poll(), expired]); }
  finally { stopped = true; clearTimeout(timer); }
}
