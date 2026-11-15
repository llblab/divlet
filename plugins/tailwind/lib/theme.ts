// Domain: Tailwind token interpretation. Owns: provider theme source. Excludes: native token admission and compiler/loading policy.
const THEME_TOKEN = /^--(color|font|text|tracking|leading|breakpoint|container|spacing|radius|shadow|inset-shadow|drop-shadow|blur|perspective|aspect|ease|animate|default)(-[\w-]+)?$/;

/** Theme namespaces belong to the optional representation; other native variables remain ordinary CSS. */
export function themeOf(tokens: Readonly<Record<string, string>> = {}): string {
  const lines = Object.entries(tokens).filter(([name, value]) => THEME_TOKEN.test(name) && !/!important\s*$/i.test(value)).map(([name, value]) => `  ${name}: ${value};`);
  return lines.length ? `@theme {\n${lines.join('\n')}\n}\n` : '';
}
