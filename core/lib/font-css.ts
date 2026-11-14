// Owns non-shadowing font-face registration against accepted public styles; not bytes, glyph decoding or writes.
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { cssString, decodeCss } from './css-literals.ts';
import { CUSTOM_CSS_LAYER } from './codec.ts';
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

type Interval = readonly [number, number];
interface Coverage { style: 'normal' | 'italic' | 'oblique'; weight: Interval; stretch: Interval }
const WIDTHS: Record<string, number> = { 'ultra-condensed': 50, 'extra-condensed': 62.5, condensed: 75, 'semi-condensed': 87.5, normal: 100, 'semi-expanded': 112.5, expanded: 125, 'extra-expanded': 150, 'ultra-expanded': 200 };
const DESCRIPTORS = new Set('font-family src font-weight font-style font-stretch font-display unicode-range font-feature-settings font-variation-settings font-language-override ascent-override descent-override line-gap-override size-adjust'.split(' '));
function interval(value: string, unit: string, minimum: number): Interval {
  const parts = value.trim().split(/\s+/), numbers = parts.map(part => {
    const token = valueParser.unit(part);
    if (!token || token.unit !== unit || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token.number)) fail('Font matching descriptors must be literal numbers or supported keywords.');
    return Number(token.number);
  });
  if (numbers.length < 1 || numbers.length > 2 || numbers.some(number => !Number.isFinite(number) || number < minimum || number > 1000) || (unit === '%' && numbers.some(number => number === 0))) fail('The font descriptor range is outside the supported matching profile.');
  const min = numbers[0]!, max = numbers[1] ?? min;
  if (min > max) fail('Font descriptor ranges must be ordered.');
  return [min, max];
}
function coverage(style: string, weight: string, stretch: string): Coverage {
  style = style.trim().toLowerCase(); weight = weight.trim().toLowerCase(); stretch = stretch.trim().toLowerCase();
  // Oblique angles are not used to prove separation: any oblique face conservatively overlaps either style.
  if (!['normal', 'italic', 'oblique'].includes(style)) fail('Companion faces require normal/italic or the default oblique style; edit angle/dynamic rules explicitly.');
  const weightRange: Interval = weight === 'normal' ? [400, 400] : weight === 'bold' ? [700, 700] : interval(weight, '', 1);
  const width = Object.hasOwn(WIDTHS, stretch) ? WIDTHS[stretch]! : null;
  return { style: style as Coverage['style'], weight: weightRange, stretch: width === null ? interval(stretch, '%', 0) : [width, width] };
}
function matchingCoverage(style: string, weight: string, stretch: string): Coverage {
  // Uploaded metadata carries explicit, validated oblique angles. Retain them in emitted CSS, but never use them to prove disjointness.
  return coverage(style.startsWith('oblique ') ? 'oblique' : style, weight, stretch);
}
const intersects = (a: Interval, b: Interval): boolean => a[0] <= b[1] && b[0] <= a[1];
function overlap(a: Coverage, b: Coverage): boolean {
  return (a.style === b.style || a.style === 'oblique' || b.style === 'oblique') && intersects(a.weight, b.weight) && intersects(a.stretch, b.stretch);
}

export interface FontStyleSources {
  readonly files: ReadonlyMap<string, string | Uint8Array>;
  readonly mediaTypes: ReadonlyMap<string, string>;
  /** Core-produced stylesheet and frame HTML names, never declared resource names. */
  readonly generated: ReadonlySet<string>;
  readonly authored: readonly string[];
}
/** Closed source-owned styles only: mutable legacy inputs and imports need a separate registration policy. */
export function fontFaceRules(face: FontFaceMetadata, reference: string, { files, mediaTypes, generated, authored }: FontStyleSources): string {
  const key = familyKey(face.family), sheets = new Map(authored.map(css => [css, false]));
  const sheet = (css: string, projection = false): void => { sheets.set(css, (sheets.get(css) ?? true) && projection); };
  const incoming = face.styles.map(style => matchingCoverage(style, face.weight, face.stretch));
  const mime = (name: string): string => mediaTypes.get(name)?.split(';')[0] ?? (name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : '');
  const text = (contents: string | Uint8Array): string => typeof contents === 'string' ? contents : new TextDecoder('utf-8', { fatal: true }).decode(contents);
  for (const [name, contents] of files) {
    if (mime(name) === 'text/css') {
      if (!mediaTypes.has(name) && !generated.has(name)) fail('Font upload cannot inspect mutable legacy stylesheets safely. Import their bytes explicitly or edit font CSS directly.');
      sheet(text(contents), generated.has(name) && !mediaTypes.has(name));
    }
    if (mime(name) !== 'text/html') continue;
    const walk = (node: DefaultTreeAdapterMap['node']): void => {
      if ('tagName' in node) {
        if (node.tagName === 'style') sheet(node.childNodes.map(child => 'value' in child ? child.value : '').join(''), generated.has(name) && !mediaTypes.has(name));
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
  for (const [css, isProjection] of sheets) {
    let root;
    try { root = postcss.parse(css, { map: false }); } catch { return fail('Existing CSS could not be inspected before font upload.'); }
    root.walkAtRules(rule => {
      const name = decodeCss(rule.name).toLowerCase();
      if (name === 'import') fail('Font upload cannot inspect stylesheet imports yet. Keep the project unchanged and edit its CSS explicitly.');
      if (name !== 'font-face') return;
      const families: string[] = [];
      rule.walkDecls(decl => { if (decodeCss(decl.prop).toLowerCase() === 'font-family') families.push(literalFamily(decl.value)); });
      if (!families.some(family => familyKey(family) === key)) return;
      const parent = rule.parent;
      const coreLayer = isProjection && parent?.type === 'atrule' && decodeCss(parent.name).toLowerCase() === 'layer' && parent.params === CUSTOM_CSS_LAYER && parent.parent?.type === 'root';
      if (families.length !== 1 || families[0] !== face.family || parent?.type !== 'root' && !coreLayer) fail('Companion faces require one exact family identity and unconditional authored rules; edit aliases or conditional/layered faces explicitly.');
      const descriptors = new Map<string, string>();
      for (const node of rule.nodes ?? []) {
        if (node.type === 'comment') continue;
        if (node.type !== 'decl') fail('Nested font-face descriptors cannot be merged safely.');
        const property = decodeCss(node.prop).toLowerCase();
        if (!DESCRIPTORS.has(property) || node.important || descriptors.has(property)) fail('Unknown, duplicate or important font descriptors require explicit CSS editing.');
        valueParser(node.value).walk(part => {
          if (part.type === 'function' && (part.unclosed || property !== 'src' || !['url', 'local', 'format', 'tech'].includes(decodeCss(part.value).toLowerCase()))) fail('Dynamic or unknown font descriptor functions require explicit CSS editing.');
        });
        descriptors.set(property, node.value);
      }
      const existing = coverage(descriptors.get('font-style') ?? 'normal', descriptors.get('font-weight') ?? 'normal', descriptors.get('font-stretch') ?? 'normal');
      if (incoming.some(candidate => overlap(existing, candidate))) fail('This family already has overlapping face coverage. Choose it from Family or edit its face rules explicitly; upload never replaces a covered face.');
    });
  }
  return face.styles.map(style => `@font-face{font-family:"${cssString(face.family)}";src:url("${cssString(reference)}");font-weight:${face.weight};font-style:${style};font-stretch:${face.stretch};font-display:swap}`).join('\n');
}
