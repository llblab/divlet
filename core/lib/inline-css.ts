// Owns syntax-only inline CSS decoding to ordered pairs. Excludes property/content admission, capacities, engines and HTML escaping.
import parse from 'postcss/lib/parse';
import type { Root } from 'postcss';
import type { CssDeclaration } from './declarations.ts';
import { DivletError } from './validation.ts';

function invalid(message: string): never { throw new DivletError('INVALID_CSS', message); }

/** Decode a declaration-only block without collapsing fallbacks or consulting source maps; callers enforce their budgets. */
export function parseInlineDeclarations(input: unknown): CssDeclaration[] {
  if (typeof input !== 'string') invalid('Inline CSS must be text.');
  let root: Root;
  try { root = parse(`div{${input}}`, { map: false }) as Root; }
  catch (cause) { const error = cause as { reason?: string; message: string }; invalid(`Invalid inline style: ${error.reason || error.message}`); }
  const rule = root.first;
  if (root.nodes.length !== 1 || rule?.type !== 'rule' || rule.selector !== 'div') invalid('Inline style escapes its declaration block');
  const declarations: CssDeclaration[] = [];
  for (const node of rule.nodes) {
    if (node.type !== 'decl') invalid('Inline style supports declarations only');
    // PostCSS hides star/underscore property hacks in raws.before; do not reinterpret an ignored browser property.
    if (!/^[\t\n\f\r ]*$/.test(node.raws.before ?? '')) invalid('Inline style has an unsupported declaration prefix');
    declarations.push([node.prop, node.value + (node.important ? ' !important' : '')]);
  }
  return declarations;
}
