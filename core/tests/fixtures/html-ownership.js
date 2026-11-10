import { canonicalBundleFixture } from './canonical-bundles.js';
export function htmlOwnershipFixture() {
  const source = canonicalBundleFixture(), page = source.children[0];
  page.layout = 'vertical'; page.fill = '#fff';
  for (const key of ['tag', 'className', 'style', 'attrs']) delete page.divlet[key];
  page.divlet.html.className = 'w-full min-h-[120px] p-[10px] flex flex-col gap-[8px]';
  return source;
}
