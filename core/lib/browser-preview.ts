/*
 * Owns: browser preview HTML byte admission, its CSP envelope and static bridge bootstrap. Excludes: resource projection, model admission,
 * frame/port lifecycle, writer state and host composition. Inputs are trusted prepared HTML and a trusted serialized bridge.
 */
import { DivletError, withinUtf8Budget } from './validation.ts';

export const PREVIEW_HTML_BYTES = 4 * 1024 * 1024;

/** Bound derived HTML independently of resource closure's deliberate no-files bypass. */
export function assertPreviewHtml(html: unknown): asserts html is string {
  if (typeof html !== 'string') throw new TypeError('A preview projection must return HTML text.');
  if (!withinUtf8Budget(html, PREVIEW_HTML_BYTES)) throw new DivletError('FILE_TOO_LARGE', 'The projected preview exceeds the 4 MiB limit.');
}

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The preview page of one frame: the rendered HTML, a meta CSP and the static preview bridge with its arguments in a meta tag.
 * A blob preview inherits the board page's CSP, so the bridge is a same-site script file rather than an inline script.
 */
export function previewDocument(html: string, id: string, render: number, bridge: string, bridgeUrl: string): string {
  const token = /^[a-f0-9-]{36}$/i.test(bridge) ? bridge : '';
  // A path may legally contain CSP separators; encode them so the bridge address cannot add or end a directive.
  const source = bridgeUrl.replace(/[;,\s'"]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  const csp = `default-src 'none'; img-src data: https: blob:; media-src data: https:; style-src 'unsafe-inline'; font-src data: https:; script-src ${source}; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}"><meta name="divlet-bridge" content="${escapeAttribute(JSON.stringify({ id, render, token }))}">`;
  return html.replace(/<head([^>]*)>/i, `<head$1>${meta}`).replace(/<\/body>(\s*<\/html>\s*)?$/i, `<script src="${escapeAttribute(source)}"></script></body>$1`);
}

/** The static bridge file: the trusted serialized preview bridge, started with the arguments its page carries. */
export function previewBridgeScript(bridgeSource: string): string {
  return `(()=>{const m=document.querySelector('meta[name="divlet-bridge"]');if(!m)return;const a=JSON.parse(m.content);(${bridgeSource})(a.id,a.render,a.token,false,false);})();\n`;
}
