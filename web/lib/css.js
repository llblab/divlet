// Custom CSS for people: a formatter (one declaration per line, nested blocks indented) and a
// highlighter. Both are small hand-written scanners — the server still validates with postcss.

/* ---- scanning helpers ----------------------------------------------------------- */

/** End index of a string literal or comment starting at i (exclusive), or -1 if i starts neither. */
function skipQuoted(text, i) {
  const ch = text[i];
  if (ch === '"' || ch === "'") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') j++;
      else if (text[j] === ch) return j + 1;
    }
    return text.length;
  }
  if (ch === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end < 0 ? text.length : end + 2;
  }
  return -1;
}

/* ---- formatter ------------------------------------------------------------------- */

/** Parse into [{ comment }, { prelude, children }, { text }] — braces and semicolons at depth 0 only. */
function parse(text, start, stop) {
  const nodes = [];
  let i = start;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] === '}') { if (stop) return { nodes, end: i + 1 }; throw new Error('Unbalanced }'); }
    if (text[i] === '/' && text[i + 1] === '*') { const end = skipQuoted(text, i); nodes.push({ comment: text.slice(i, end) }); i = end; continue; }
    let depth = 0;
    let j = i;
    let found = '';
    for (; j < text.length; j++) {
      const quoted = skipQuoted(text, j);
      if (quoted > 0) { j = quoted - 1; continue; }
      const ch = text[j];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      else if (!depth && (ch === '{' || ch === ';' || ch === '}')) { found = ch; break; }
    }
    const head = text.slice(i, j).trim();
    if (found === '{') {
      const inner = parse(text, j + 1, true);
      nodes.push({ prelude: head, children: inner.nodes });
      i = inner.end;
    } else {
      if (head) nodes.push({ text: head });
      i = found === ';' ? j + 1 : j;
      if (found === '' ) break;
    }
  }
  if (stop) throw new Error('Unbalanced {');
  return { nodes, end: i };
}

/** Collapse whitespace and add the spaces people expect, leaving strings and url() alone. */
function tidyValue(value) {
  const parts = [];
  let i = 0;
  let plain = '';
  const flush = () => { if (plain) { parts.push(plain.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/\s*!\s*important/gi, ' !important')); plain = ''; } };
  while (i < value.length) {
    const quoted = skipQuoted(value, i);
    if (quoted > 0) { flush(); parts.push(value.slice(i, quoted)); i = quoted; continue; }
    const url = /^url\(/i.exec(value.slice(i, i + 4)) ? value.indexOf(')', i) : -1;
    if (url > 0) { flush(); parts.push(value.slice(i, url + 1)); i = url + 1; continue; }
    plain += value[i++];
  }
  flush();
  return parts.join('').trim();
}

function tidyPrelude(prelude) {
  const at = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude);
  if (at) {
    const params = tidyValue(at[2]).replace(/\s*:\s*/g, ': ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
    return `@${at[1]}${params ? ` ${params}` : ''}`;
  }
  return prelude;
}

function printNodes(nodes, depth, out) {
  const pad = '  '.repeat(depth);
  nodes.forEach((node, index) => {
    if (node.comment !== undefined) { out.push(...node.comment.split('\n').map((line, n) => (n ? line : pad + line.trimStart()))); return; }
    if (node.text !== undefined) {
      const colon = node.text.indexOf(':');
      const declaration = colon > 0 && !node.text.startsWith('@');
      out.push(`${pad}${declaration ? `${node.text.slice(0, colon).trim()}: ${tidyValue(node.text.slice(colon + 1))}` : tidyPrelude(node.text)};`);
      return;
    }
    if (index > 0 && depth === 0) out.push('');
    // A selector list breaks after each top-level comma.
    const selector = /^@/.test(node.prelude) ? tidyPrelude(node.prelude) : splitSelectors(node.prelude).join(`,\n${pad}`);
    if (!node.children.length) { out.push(`${pad}${selector} {}`); return; }
    out.push(`${pad}${selector} {`);
    printNodes(node.children, depth + 1, out);
    out.push(`${pad}}`);
  });
}

function splitSelectors(prelude) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < prelude.length; i++) {
    const quoted = skipQuoted(prelude, i);
    if (quoted > 0) { i = quoted - 1; continue; }
    const ch = prelude[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && !depth) { parts.push(prelude.slice(from, i)); from = i + 1; }
  }
  parts.push(prelude.slice(from));
  return parts.map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Pretty-printed CSS, or the input unchanged if it cannot be parsed (the server will say why). */
export function formatCss(text) {
  if (!text || !text.trim()) return text || '';
  try {
    const out = [];
    printNodes(parse(text, 0, false).nodes, 0, out);
    return `${out.join('\n')}\n`;
  } catch { return text; }
}

/* ---- highlighter ----------------------------------------------------------------- */

const esc = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (kind, value) => (value ? `<span class="syn-${kind}">${esc(value)}</span>` : '');
// Blocks whose contents are declarations rather than nested rules.
const DECLARATION_AT = /^@(font-face|page|property|counter-style|starting-style|view-transition|position-try)\b/i;

function selectorHtml(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i);
    let match;
    if ((match = /^\.(?:\\.|[\w-])+/.exec(rest))) out += span('class', match[0]);
    else if ((match = /^#(?:\\.|[\w-])+/.exec(rest))) out += span('id', match[0]);
    else if ((match = /^::?[\w-]+/.exec(rest))) out += span('pseudo', match[0]);
    else if ((match = /^\[[^\]]*\]/.exec(rest))) out += span('attr', match[0]);
    else if ((match = /^[a-zA-Z][\w-]*/.exec(rest))) out += span('tag', match[0]);
    else if ((match = /^[\s\S]/.exec(rest))) out += /[>+~*,()]/.test(match[0]) ? span('punct', match[0]) : esc(match[0]);
    i += match[0].length;
  }
  return out;
}

function valueHtml(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    const quoted = skipQuoted(text, i);
    if (quoted > 0) { out += span(text[i] === '/' ? 'comment' : 'string', text.slice(i, quoted)); i = quoted; continue; }
    const rest = text.slice(i);
    let match;
    if ((match = /^!\s*important/i.exec(rest))) out += span('important', match[0]);
    else if ((match = /^#[0-9a-fA-F]{3,8}\b/.exec(rest))) out += span('color', match[0]);
    else if ((match = /^--[\w-]+/.exec(rest))) out += span('var', match[0]);
    else if ((match = /^[a-zA-Z_-][\w-]*(?=\()/.exec(rest))) out += span('func', match[0]);
    else if ((match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[a-zA-Z%]+)?/.exec(rest))) out += span('number', match[0]);
    else if ((match = /^[\w-]+/.exec(rest))) out += esc(match[0]);
    else { match = [rest[0]]; out += /[(),/]/.test(match[0]) ? span('punct', match[0]) : esc(match[0]); }
    i += match[0].length;
  }
  return out;
}

/** HTML for `text` with the same characters, in <span class="syn-…"> pieces. */
export function highlightCss(text) {
  let out = '';
  // Each open block remembers whether its contents are declarations.
  const blocks = [];
  let prelude = '';
  let prop = null; // inside a declaration: the property name was read
  let buffer = '';
  const inDeclarations = () => blocks.at(-1) === 'decls';
  const flushPrelude = () => { out += prelude.startsWith('@') || /^\s*@/.test(prelude) ? atHtml(prelude) : selectorHtml(prelude); prelude = ''; };
  const atHtml = value => { const match = /^(\s*)(@[\w-]+)([\s\S]*)$/.exec(value); return match ? `${esc(match[1])}${span('atrule', match[2])}${valueHtml(match[3])}` : esc(value); };
  const flushValue = () => { out += valueHtml(buffer); buffer = ''; };
  for (let i = 0; i < text.length;) {
    const quoted = skipQuoted(text, i);
    if (quoted > 0) {
      const piece = text.slice(i, quoted);
      if (text[i] === '/') {
        if (inDeclarations() && prop === null) { out += esc(prelude); prelude = ''; } else if (prelude) flushPrelude();
        out += span('comment', inDeclarations() && prop !== null ? '' : piece);
        if (inDeclarations() && prop !== null) buffer += piece;
      }
      else if (inDeclarations() && prop !== null) buffer += piece;
      else prelude += piece;
      i = quoted;
      continue;
    }
    const ch = text[i];
    if (inDeclarations()) {
      if (prop === null) {
        if (ch === ':') { out += span('prop', prelude) + span('punct', ':'); prelude = ''; prop = ''; }
        else if (ch === '}') { out += esc(prelude); prelude = ''; out += span('punct', '}'); blocks.pop(); }
        else if (ch === ';') { out += esc(prelude) + span('punct', ';'); prelude = ''; }
        else if (ch === '{') { flushPrelude(); out += span('punct', '{'); blocks.push('rules'); }
        else prelude += ch;
      } else if (ch === ';' || ch === '}') {
        flushValue();
        prop = null;
        out += span('punct', ch);
        if (ch === '}') blocks.pop();
      } else if (ch === '(' ) {
        // url(...) and other parens may hold ; and } — copy to the matching paren.
        let depth = 0; let j = i;
        for (; j < text.length; j++) { const q = skipQuoted(text, j); if (q > 0) { j = q - 1; continue; } if (text[j] === '(') depth++; else if (text[j] === ')' && !--depth) break; }
        buffer += text.slice(i, j + 1);
        i = j + 1;
        continue;
      } else buffer += ch;
    } else if (ch === '{') {
      const at = /^\s*@/.test(prelude);
      const declarations = at ? DECLARATION_AT.test(prelude.trim()) : true;
      flushPrelude();
      out += span('punct', '{');
      blocks.push(declarations ? 'decls' : 'rules');
    } else if (ch === '}') {
      flushPrelude();
      out += span('punct', '}');
      blocks.pop();
    } else if (ch === ';') { flushPrelude(); out += span('punct', ';'); }
    else prelude += ch;
    i++;
  }
  if (prop !== null && buffer) flushValue();
  if (prelude) { if (inDeclarations() && prop === null) out += span('prop', prelude); else flushPrelude(); }
  return out;
}
