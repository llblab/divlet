// Read the existing publication owner's exact bytes; this neither renders nor publishes another landing.
import { createPublicPageSnapshot } from '../core/lib/public-snapshot.ts';
import { landingEntries, landingDirectory } from './landing-hash.mjs';

export async function landingDemoSnapshot({ directory = landingDirectory, name = 'divlet demo', artboard = { x: 80, y: 100, width: 1280, height: 900 } } = {}) {
  const entries = await landingEntries(directory);
  const page = entries.find(([file]) => file === 'index.html');
  if (!page) throw new Error('The verified landing public set has no index.html.');
  const html = new TextDecoder('utf-8', { fatal: true }).decode(page[1]);
  return createPublicPageSnapshot({ html, href: 'index.html', name, artboard });
}
