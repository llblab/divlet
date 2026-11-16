/*
 * Owns: the first closed-resource browser preview projection, not project admission, writer state, CSP or activation.
 * Canonical assets/references remain input; unsupported reached forms refuse through the shared standalone projector.
 */
import { inlineDeclaredAssets } from './standalone-assets.ts';
import { assertPreviewHtml, PREVIEW_HTML_BYTES } from './browser-preview.ts';

export async function projectClosedPreview(html: string, assets: unknown): Promise<string> {
  const projected = await inlineDeclaredAssets(html, assets, { maxWorkBytes: PREVIEW_HTML_BYTES });
  assertPreviewHtml(projected);
  return projected;
}
