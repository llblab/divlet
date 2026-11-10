// A static HTML page → a one-frame Divlet project. The page is made acceptable to the core codec first (scripts, event
// handlers, comments, external stylesheet links and frames are dropped and counted), then decoded like any hand-edited page.
import { parse } from 'parse5';
import { decodeHtml } from '../../../core/lib/codec.ts';
import { validateDocument } from '../../../core/lib/model.ts';
import { validateSettings, writeProject } from '../../../core/lib/project.ts';

const DROP = new Set(['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'base', 'template']);
const VOID = new Set(['area', 'br', 'col', 'hr', 'img', 'input', 'source', 'track', 'wbr']);
// Obsolete tags the codec does not know, with their modern equivalents.
const RENAME = { tt: 'code', dir: 'ul', menu: 'ul', acronym: 'abbr', strike: 's' };
const slug = text => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;

const esc = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const escText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** The page with everything the codec cannot hold removed; `dropped` counts what went. */
function sanitize(html) {  const dropped = { scripts: 0, comments: 0, links: 0, handlers: 0, frames: 0 };
  const document = parse(html);
  const root = document.childNodes.find(node => node.nodeName === 'html');
  const head = root?.childNodes.find(node => node.nodeName === 'head');
  const body = root?.childNodes.find(node => node.nodeName === 'body');
  const css = [];
  let title = '';
  const keepAttrs = node => (node.attrs || []).filter(item => {
    // Node ids stay: they are how the codec carries an element's identity through HTML, and a page produced by
    // divlet itself must keep them when it is dropped back into a folder.
    if (/^data-divlet-id$/i.test(item.name)) return true;
    if (/^on/i.test(item.name) || /^(srcdoc|is)$/i.test(item.name) || /^data-divlet-/i.test(item.name) || !/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(item.name)) { if (/^on/i.test(item.name)) dropped.handlers++; return false; }
    return true;
  });
  const serializeNode = node => {
    if (node.nodeName === '#text') return escText(node.value);
    if (node.nodeName === '#comment') { dropped.comments++; return ''; }
    if (!node.tagName) return '';
    const tag = RENAME[node.tagName] ?? node.tagName;
    if (node.tagName === 'style') { css.push(node.childNodes.map(child => child.value ?? '').join('')); return ''; }
    if (DROP.has(tag)) { if (tag === 'script') dropped.scripts++; else if (tag === 'link') dropped.links++; else dropped.frames++; return ''; }
    const attrs = keepAttrs(node).map(item => ` ${item.name}="${esc(item.value)}"`).join('');
    if (VOID.has(tag)) return `<${tag}${attrs}>`;
    const kids = (node.content?.childNodes ?? node.childNodes ?? []).map(serializeNode).join('');
    return `<${tag}${attrs}>${kids}</${tag}>`;
  };
  for (const node of head?.childNodes ?? []) {
    if (node.tagName === 'title') title = node.childNodes.map(child => child.value ?? '').join('').trim();
    else if (node.tagName === 'style') css.push(node.childNodes.map(child => child.value ?? '').join(''));
    else if (node.tagName === 'link') dropped.links++;
    else if (node.tagName === 'script') dropped.scripts++;
  }
  let inner = (body?.childNodes ?? []).map(serializeNode).join('');
  // Attributes on <body> (a class, a background) belong to the root element in Divlet.
  const bodyAttrs = keepAttrs(body ?? {});
  if (bodyAttrs.length) inner = `<div${bodyAttrs.map(item => ` ${item.name}="${esc(item.value)}"`).join('')}>${inner}</div>`;
  const page = `<!doctype html><html><head><meta charset="utf-8">${css.length ? `<style>${css.join('\n').replace(/<\/style/gi, '<\\/style')}</style>` : ''}</head><body>${inner}</body></html>`;
  return { page, title, dropped };
}

/** One sanitized page as a validated frame; `source`/`format` record which file it came from. */
function frameOf({ page, title, dropped }, { fallbackId, name, source, format }) {
  const decoded = decodeHtml(page, { fallbackId });
  const metadata = source ? { import: { source, format, dropped } } : {};
  return validateDocument({ schemaVersion: 1, id: decoded.id, name: title || name || fallbackId, version: 1, rootId: decoded.rootId, artboard: decoded.artboard, tokens: decoded.tokens ?? {}, css: decoded.css ?? '', metadata, nodes: decoded.nodes });
}

/**
 * One page → one validated frame plus the counts of what was dropped. This is the same sanitizer and codec path the
 * whole-project conversion uses, so a page dropped into a project folder and the same page opened by path are decoded alike.
 * `import: { source, format }` records provenance on the frame instead of on project settings.
 */
export function decodePage(text, { fallbackId = 'page', source, format } = {}) {
  const sanitized = sanitize(text);
  return { document: frameOf(sanitized, { fallbackId, source, format }), dropped: sanitized.dropped };
}

/** Convert the page text into the text of a Divlet project and statistics. */
export function convertHtml(text, { name = 'page', provenance } = {}) {
  const sanitized = sanitize(text);
  const { dropped } = sanitized;
  const id = slug(name) || 'page';
  const frame = frameOf(sanitized, { fallbackId: /^[A-Za-z]/.test(id) ? id : `f-${id}`, name });
  const settings = validateSettings({ name, metadata: provenance ? { import: { ...provenance, dropped } } : {} });
  return { text: writeProject(settings, [frame]), stats: { frames: 1, nodes: Object.keys(frame.nodes).length, utilities: 0, arbitrary: 0, dropped } };
}

/** A launcher card without converting. */
export function summarizeHtml(text) {
  const { title } = sanitize(text);
  return { name: title || undefined, frames: 1, frameNames: title ? [title] : [] };
}

