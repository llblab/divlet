// Native HTML admission: external pages become supported web models. Managed-cache reconciliation is a separate contract.
import path from 'node:path';
import { parse, defaultTreeAdapter as tree } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { decodeHtml } from './codec.ts';
import { object, validateDocument, VOID_TAGS, DivletError } from './model.ts';
import { readAssetReference } from './asset-reference.ts';
import type { DocumentModel } from './model.ts';
import { validateSettings, writeProject } from './project.ts';

type HtmlNode = DefaultTreeAdapterMap['node'];
type HtmlElement = DefaultTreeAdapterMap['element'];
export type HtmlDropped = Record<'scripts' | 'comments' | 'links' | 'handlers' | 'frames', number>;
interface SanitizedPage { page: string; title: string; dropped: HtmlDropped }
interface PageOptions { fallbackId?: string; source?: string; format?: string }

export const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['.html', '.htm']);
export const isHtmlSource = (file: string): boolean => HTML_EXTENSIONS.has(path.extname(file).toLowerCase());
const DROP = new Set(['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'base', 'template']);
const RENAME: Readonly<Record<string, string>> = { tt: 'code', dir: 'ul', menu: 'ul', acronym: 'abbr', strike: 's' };
const slug = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const esc = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const escText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const textOf = (node: HtmlElement): string => node.childNodes.map(child => tree.isTextNode(child) ? child.value : '').join('');

/** External HTML may be normalized with reported losses; never use this path to decode an edited managed projection. */
function sanitize(html: string): SanitizedPage {
  const dropped: HtmlDropped = { scripts: 0, comments: 0, links: 0, handlers: 0, frames: 0 };
  const document = parse(html);
  const root = document.childNodes.find((node): node is HtmlElement => tree.isElementNode(node) && node.tagName === 'html');
  const head = root?.childNodes.find((node): node is HtmlElement => tree.isElementNode(node) && node.tagName === 'head');
  const body = root?.childNodes.find((node): node is HtmlElement => tree.isElementNode(node) && node.tagName === 'body');
  const css: string[] = [];
  const supportedHead: string[] = [];
  let title = '';
  const keepAttrs = (node?: HtmlElement) => (node?.attrs ?? []).filter(item => {
    if (/^data-divlet-id$/i.test(item.name)) return true;
    if (/^on/i.test(item.name) || /^(srcdoc|is)$/i.test(item.name) || /^data-divlet-/i.test(item.name) || !/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(item.name)) {
      if (/^on/i.test(item.name)) dropped.handlers++;
      return false;
    }
    return true;
  });
  const serializeNode = (node: HtmlNode): string => {
    if (tree.isTextNode(node)) return escText(node.value);
    if (tree.isCommentNode(node)) { dropped.comments++; return ''; }
    if (!tree.isElementNode(node)) return '';
    const tag = RENAME[node.tagName] ?? node.tagName;
    if (node.tagName === 'style') { css.push(textOf(node)); return ''; }
    if (DROP.has(tag)) {
      if (tag === 'script') dropped.scripts++;
      else if (tag === 'link') dropped.links++;
      else dropped.frames++;
      return '';
    }
    const attrs = keepAttrs(node).map(item => ` ${item.name}="${esc(item.value)}"`).join('');
    if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${node.childNodes.map(serializeNode).join('')}</${tag}>`;
  };
  for (const node of head?.childNodes ?? []) {
    if (!tree.isElementNode(node)) continue;
    if (node.tagName === 'title') title = textOf(node).trim();
    else if (node.tagName === 'style') css.push(textOf(node));
    else if (node.tagName === 'meta' && node.attrs.some(a => a.name === 'name' && a.value.toLowerCase() === 'description')) {
      const content = node.attrs.find(a => a.name === 'content')?.value ?? '';
      supportedHead.push(`<meta name="description" content="${esc(content)}">`);
    }
    else if (node.tagName === 'link' && node.attrs.some(a => a.name === 'rel' && a.value.toLowerCase() === 'icon')) {
      const href = node.attrs.find(a => a.name === 'href')?.value ?? '';
      supportedHead.push(`<link rel="icon" href="${esc(href)}">`);
    }
    else if (node.tagName === 'link') dropped.links++;
    else if (node.tagName === 'script') dropped.scripts++;
  }
  let inner = (body?.childNodes ?? []).map(serializeNode).join('');
  const bodyAttrs = keepAttrs(body);
  if (bodyAttrs.length) inner = `<div${bodyAttrs.map(item => ` ${item.name}="${esc(item.value)}"`).join('')}>${inner}</div>`;
  const page = `<!doctype html><html><head><meta charset="utf-8">${supportedHead.join('')}${css.length ? `<style>${css.join('\n').replace(/<\/style/gi, '<\\/style')}</style>` : ''}</head><body>${inner}</body></html>`;
  return { page, title, dropped };
}

function frameOf({ page, title, dropped }: SanitizedPage, { fallbackId, name, source, format }: PageOptions & { name?: string }): DocumentModel {
  const decoded = decodeHtml(page, { fallbackId });
  // Native resource syntax in strict HTML is not a foreign page's grant to another project's namespace.
  const urls = Object.values(decoded.nodes).flatMap(node => node.type === 'element' ? Object.entries(node.attrs).filter(([name]) => /^(src|poster|href|xlink:href)$/i.test(name)).map(([, value]) => value) : []);
  if (decoded.head?.icon !== undefined) urls.push(decoded.head.icon);
  if (urls.some(value => readAssetReference(value))) throw new DivletError('INVALID_DOCUMENT', 'External page URL attributes cannot supply native project asset declarations. Import the resource bytes explicitly.');
  const metadata = source ? { import: { source, format, dropped } } : {};
  return validateDocument({ schemaVersion: 1, id: decoded.id, name: title || name || fallbackId, ...(decoded.head !== undefined ? { head: decoded.head } : {}), version: 1, rootId: decoded.rootId, artboard: decoded.artboard, tokens: decoded.tokens, css: decoded.css, metadata, nodes: decoded.nodes });
}

/** A dropped page and an explicitly opened page use the same admission profile. */
export function decodePage(text: string, { fallbackId = 'page', source, format = 'html' }: PageOptions = {}): { document: DocumentModel; dropped: HtmlDropped } {
  const sanitized = sanitize(text);
  return { document: frameOf(sanitized, { fallbackId, source, format }), dropped: sanitized.dropped };
}

/** One external page becomes a one-frame native project, without requiring a style engine. */
export function convertHtml(text: string, { name = 'page', provenance }: { name?: string; provenance?: unknown } = {}): { text: string; stats: { frames: number; nodes: number; utilities: number; arbitrary: number; dropped: HtmlDropped } } {
  const sanitized = sanitize(text);
  const { dropped } = sanitized;
  const id = slug(name) || 'page';
  const frame = frameOf(sanitized, { fallbackId: /^[A-Za-z]/.test(id) ? id : `f-${id}`, name });
  const settings = validateSettings({ name, metadata: provenance ? { import: { ...object(provenance, 'HTML import provenance'), dropped } } : {} });
  return { text: writeProject(settings, [frame]), stats: { frames: 1, nodes: Object.keys(frame.nodes).length, utilities: 0, arbitrary: 0, dropped } };
}

export function summarizeHtml(text: string): { name?: string; frames: number; frameNames: string[] } {
  const { title } = sanitize(text);
  return { name: title || undefined, frames: 1, frameNames: title ? [title] : [] };
}
