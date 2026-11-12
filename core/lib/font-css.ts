// Owns non-shadowing font-face registration against accepted public styles; not bytes, glyph decoding or writes.
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { cssString, decodeCss } from './css-literals.ts';
import { DivletError } from './validation.ts';
import type { FontFaceMetadata } from './font.ts';

function fail(message: string): never { throw new DivletError('FONT_CONFLICT', message); }
// Comparison only: fold case expansions/sigma conservatively; authored names and bytes remain exact.
const familyKey = (value: string): string => {
  if (/\p{Unassigned}/u.test(value)) fail('The host cannot compare this font family’s Unicode identity safely. Edit its CSS explicitly.');
  return value.normalize('NFC').toLowerCase().toUpperCase().normalize('NFC');
};
function literalFamily(value: string): string {
  const nodes = valueParser(value).nodes.filter(node => node.type !== 'space' && node.type !== 'comment');
  if (nodes.length === 1 && nodes[0]!.type === 'string') return decodeCss(nodes[0]!.value);
  // A general value tokenizer splits hex-escape terminators from identifiers. Do not guess their family identity.
  if (value.includes('\\')) fail('Unquoted escaped font families require explicit CSS editing before upload.');
  if (nodes.length && nodes.every(node => node.type === 'word')) return nodes.map(node => decodeCss(node.value)).join(' ');
  return fail('An existing font family cannot be inspected unambiguously. Edit its CSS before uploading.');
}

export interface FontStyleSources {
  readonly files: ReadonlyMap<string, string | Uint8Array>;
  readonly mediaTypes: ReadonlyMap<string, string>;
  readonly generated: ReadonlySet<string>;
  readonly authored: readonly string[];
}
/** Closed source-owned styles only: mutable legacy inputs and imports need a separate registration policy. */
export function fontFaceRules(face: FontFaceMetadata, reference: string, { files, mediaTypes, generated, authored }: FontStyleSources): string {
  const key = familyKey(face.family), sheets: string[] = [...authored];
  const mime = (name: string): string => mediaTypes.get(name)?.split(';')[0] ?? (name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : '');
  const text = (contents: string | Uint8Array): string => typeof contents === 'string' ? contents : new TextDecoder('utf-8', { fatal: true }).decode(contents);
  for (const [name, contents] of files) {
    if (mime(name) === 'text/css') {
      if (!mediaTypes.has(name) && !generated.has(name)) fail('Font upload cannot inspect mutable legacy stylesheets safely. Import their bytes explicitly or edit font CSS directly.');
      sheets.push(text(contents));
    }
    if (mime(name) !== 'text/html') continue;
    const walk = (node: DefaultTreeAdapterMap['node']): void => {
      if ('tagName' in node) {
        if (node.tagName === 'style') sheets.push(node.childNodes.map(child => 'value' in child ? child.value : '').join(''));
        if (node.tagName === 'link') {
          const attrs = Object.fromEntries(node.attrs.map(attr => [attr.name, attr.value]));
          if (attrs.rel?.toLowerCase().split(/\s+/).includes('stylesheet')) {
            let resolved: URL;
            try { resolved = new URL(attrs.href ?? '', `https://divlet.invalid/${name}`); } catch { return fail('A stylesheet URL cannot be inspected before font upload.'); }
            let path: string;
            try { path = decodeURIComponent(resolved.pathname.slice(1)); } catch { return fail('A stylesheet URL cannot be inspected before font upload.'); }
            if (resolved.origin !== 'https://divlet.invalid' || !files.has(path) || mime(path) !== 'text/css') fail('Font upload requires inspectable local stylesheets; external or indirect stylesheets are not supported yet.');
          }
        }
      }
      if ('childNodes' in node) node.childNodes.forEach(walk);
    };
    walk(parse(text(contents)));
  }
  for (const css of new Set(sheets)) {
    let root;
    try { root = postcss.parse(css); } catch { return fail('Existing CSS could not be inspected before font upload.'); }
    root.walkAtRules(rule => {
      const name = decodeCss(rule.name).toLowerCase();
      if (name === 'import') fail('Font upload cannot inspect stylesheet imports yet. Keep the project unchanged and edit its CSS explicitly.');
      if (name !== 'font-face') return;
      rule.walkDecls(decl => {
        if (decodeCss(decl.prop).toLowerCase() === 'font-family' && familyKey(literalFamily(decl.value)) === key) fail('This font family is already declared. Choose it from Family or edit its face rules explicitly; upload never shadows an existing family.');
      });
    });
  }
  return face.styles.map(style => `@font-face{font-family:"${cssString(face.family)}";src:url("${cssString(reference)}");font-weight:${face.weight};font-style:${style};font-stretch:${face.stretch};font-display:swap}`).join('\n');
}
