/*
 * Owns: strict XML parsing and resource-carrier projection for declared SVG files.
 * Excludes: HTML admission, filesystem access, native project activation and publication.
 */
import { DOMParser, XMLSerializer, onWarningStopParsing } from '@xmldom/xmldom';
import type { Element, Node } from '@xmldom/xmldom';
import { SOURCE_LIMITS } from './model.ts';
import { DivletError } from './validation.ts';

const SVG = 'http://www.w3.org/2000/svg', HTML = 'http://www.w3.org/1999/xhtml', XML = 'http://www.w3.org/XML/1998/namespace', XMLNS = 'http://www.w3.org/2000/xmlns/', XLINK = 'http://www.w3.org/1999/xlink';
export const SVG_RESOURCE_ATTRIBUTES: ReadonlySet<string> = new Set('fill stroke filter mask clip-path marker marker-start marker-mid marker-end cursor color-profile'.split(' '));
export interface SvgResourceTransforms {
  url(value: string): Promise<string>;
  css(value: string, inline: boolean): Promise<string>;
}
function fail(message: string): never { throw new DivletError('INVALID_ASSET', message); }
const boundNamespace = (element: Element, prefix: string): string | null => prefix === 'xml' ? XML : element.lookupNamespaceURI(prefix);
function xmlCharacters(value: string): void {
  if (!value.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(value)) fail('Declared SVG contains characters outside XML 1.0.');
}

export async function rewriteSvgResource(text: string, transforms: SvgResourceTransforms): Promise<string> {
  xmlCharacters(text);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) fail('Declared SVG DTD/entity interpretation is not supported.');
  const declaration = /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.0"|'1\.0')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>/.exec(text);
  let document;
  try {
    document = new DOMParser({ onError: onWarningStopParsing, locator: false, normalizeLineEndings: value => value.replace(/\r\n?/g, '\n') }).parseFromString(text, 'application/xml');
  } catch { fail('Declared SVG is not well-formed XML.'); }
  if (document.documentElement?.namespaceURI !== SVG || document.documentElement.localName !== 'svg') fail('Declared SVG requires an SVG-namespaced root.');
  let nodes = 0;
  const visit = async (node: Node, depth: number, inert = false): Promise<void> => {
    if (++nodes > SOURCE_LIMITS.nodes || depth > SOURCE_LIMITS.depth) fail('Declared SVG exceeds the source node/depth profile.');
    xmlCharacters(node.nodeValue || '');
    if (node.nodeType === node.PROCESSING_INSTRUCTION_NODE && (node.nodeName !== 'xml' || !declaration || node !== document.firstChild)) fail('Declared SVG processing instructions require a leading XML 1.0 declaration.');
    if (node.nodeType === node.ELEMENT_NODE) {
      const element = node as Element, svg = element.namespaceURI === SVG, name = element.localName ?? element.tagName;
      if (element.prefix && (!element.namespaceURI || boundNamespace(element, element.prefix) !== element.namespaceURI) || element.prefix === 'xmlns' || element.namespaceURI === XMLNS) fail('Declared SVG has an invalid element namespace.');
      for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes.item(i)!;
        xmlCharacters(attr.value);
        if (attr.namespaceURI === XMLNS) {
          const prefix = attr.prefix === 'xmlns' ? attr.localName : '';
          if (prefix && !attr.value || /[ \t\r\n]/.test(attr.value) || prefix === 'xmlns' || attr.value === XMLNS || (prefix === 'xml') !== (attr.value === XML)) fail('Declared SVG has an invalid namespace declaration.');
        } else if (attr.prefix && (!attr.namespaceURI || boundNamespace(element, attr.prefix) !== attr.namespaceURI)) fail('Declared SVG has an unbound attribute prefix.');
      }
      inert ||= svg && name === 'metadata';
      if ((svg || element.namespaceURI === HTML) && ['script', 'foreignObject', 'iframe', 'object', 'embed'].includes(name)) fail('Active or foreign HTML content is not supported in declared SVG.');
      for (let i = 0; i < element.attributes.length; i++) if ((svg || element.namespaceURI === HTML) && /^on/i.test(element.attributes.item(i)!.name)) fail('Event handlers are not supported in declared SVG.');
      if (!inert) {
        if (element.hasAttributeNS(XML, 'base')) fail('Declared SVG xml:base is not supported.');
        for (let i = 0; i < element.attributes.length; i++) {
          const attr = element.attributes.item(i)!, name = attr.localName ?? attr.name;
          if (!svg) continue;
          if (name === 'href' && (!attr.namespaceURI || attr.namespaceURI === XLINK)) attr.value = await transforms.url(attr.value);
          else if (!attr.namespaceURI && name === 'style') attr.value = await transforms.css(attr.value, true);
          else if (!attr.namespaceURI && SVG_RESOURCE_ATTRIBUTES.has(name)) {
            const declaration = await transforms.css(`x:${attr.value}`, true);
            attr.value = declaration.slice(declaration.indexOf(':') + 1);
          }
        }
        if (svg && name === 'style') element.textContent = await transforms.css(element.textContent || '', false);
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) await visit(child, depth + 1, inert);
  };
  await visit(document, 0);
  // Literal line ends were normalized before parsing; remaining CRs came from character references and must stay references.
  const result = new XMLSerializer().serializeToString(document).replace(/\r/g, '&#13;');
  xmlCharacters(result);
  return result;
}
