// Native font-family inspection/editing. CSSOM is a view of authored CSS, not a project validator or font-byte store.
import { el, icon } from './util.js';
import { openMenu } from './menu.js';

const GENERICS = ['system-ui', 'sans-serif', 'serif', 'monospace'];
function familyStyle(value) {
  const style = document.createElement('span').style;
  style.setProperty('font-family', value);
  return style;
}
function parts(value) {
  const result = [];
  let start = 0, quote = '', depth = 0, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) { result.push(value.slice(start, i).trim()); start = i + 1; }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}
const key = value => value.toLowerCase();
const canonical = value => familyStyle(value).getPropertyValue('font-family');

/** List literal face-family declarations from authored project/frame sheets; never fetch URLs or inspect font payloads. */
export function declaredFamilies(sources) {
  const families = new Map();
  const walk = rules => {
    for (const rule of rules) {
      if (rule.type === CSSRule.FONT_FACE_RULE) {
        const family = rule.style.getPropertyValue('font-family');
        if (family && parts(family).length === 1 && (/^["']/.test(family) || !family.includes('('))) families.set(key(family), family);
      } else if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const css of sources) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css || '');
    walk(sheet.cssRules);
  }
  return [...families.values()];
}

/** Native inline edits retain classes, priority and literal fallback stacks; ambiguous shorthand edits refuse. */
export function familyPatch(node, next, families) {
  if (['font', 'all'].some(name => Object.hasOwn(node.style, name))) throw new Error('Edit the inline font/all shorthand before choosing a family; its other settings must be preserved.');
  if (next === null) return { 'font-family': null };
  const current = document.createElement('span').style;
  current.cssText = `font-family:${node.style['font-family'] || ''}`;
  let value = next;
  if (!GENERICS.includes(next)) {
    const authored = current.getPropertyValue('font-family');
    const stack = /^(inherit|initial|unset|revert|revert-layer)$/i.test(authored) ? [] : parts(authored);
    if (stack.some(item => !/^["']/.test(item) && item.includes('('))) throw new Error('The font family uses a dynamic CSS value. Choose a generic family or edit its fallback explicitly.');
    const declared = new Set(families.map(key));
    const fallback = declared.has(key(stack[0] || '')) ? stack.slice(1) : stack;
    value = [next, ...fallback.filter(item => key(item) !== key(next))].join(', ');
  }
  return { 'font-family': value + (current.getPropertyPriority('font-family') ? ' !important' : '') };
}

export function fontFamilyControl(nodes, { css, apply, upload }) {
  const families = declaredFamilies(css);
  const values = nodes.map(node => ['font', 'all'].some(name => Object.hasOwn(node.style, name)) ? 'Font shorthand' : node.style['font-family'] ?? null);
  const mixed = !values.every(value => value === values[0]);
  const value = values[0], primary = value ? parts(canonical(value.replace(/\s*!important\s*$/i, '')))[0] : null;
  const shown = mixed ? 'Mixed' : value === 'Font shorthand' ? 'Inline shorthand' : primary || value || 'Default';
  // A rare family longer than the viewport is scrollable as one whole control, never ellipsized or squashed.
  const scroll = el('div', 'font-family-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'group');
  scroll.setAttribute('aria-label', 'Font family control');
  scroll.addEventListener('keydown', event => {
    if (event.target === scroll && ['ArrowLeft', 'ArrowRight', 'Home', 'End', ' '].includes(event.key)) event.stopPropagation();
  });
  const button = el('button', 'pick font-family');
  button.type = 'button';
  button.dataset.key = 'font-family';
  button.dataset.tip = mixed ? 'Mixed authored font families' : value || 'Default · use stylesheet or inherited family';
  button.setAttribute('aria-label', `Font family: ${shown}`);
  button.setAttribute('aria-haspopup', 'menu');
  button.append(el('span', 'pick-k', 'Family'), el('span', `pick-v${!value || mixed ? ' faint' : ''}`, shown), icon('chevron', 'icon pick-caret'));
  const choose = next => apply(classes => classes, next === null ? 'default font family' : `font family ${next}`, { style: node => familyPatch(node, next, families) });
  button.addEventListener('click', () => openMenu([
    { label: 'Default (stylesheet / inherited)', checked: !mixed && value === null, run: () => choose(null) },
    ...GENERICS.map(family => ({ label: family, checked: !mixed && key(primary || '') === family, run: () => choose(family) })),
    ...(families.length ? ['-', ...families.map(family => ({ label: family, checked: !mixed && key(primary || '') === key(family), hint: 'Declared @font-face family; availability follows its CSS conditions', run: () => choose(family) }))] : []),
  ], { anchor: button, label: 'Font family' }));
  scroll.append(button);
  const control = el('div', 'font-family-control');
  const note = el('small', 'caption font-family-note', 'Edits set inline CSS; stylesheet priority still applies.');
  note.id = 'font-family-cascade-note';
  button.setAttribute('aria-describedby', note.id);
  const row = el('div', 'font-family-row');
  row.append(scroll);
  if (upload) {
    row.classList.add('with-upload');
    const picker = document.createElement('input');
    picker.type = 'file'; picker.accept = '.ttf,.otf,font/ttf,font/otf'; picker.hidden = true;
    const add = el('button', 'tool mini font-upload');
    add.type = 'button'; add.dataset.key = 'font-upload'; add.setAttribute('aria-label', 'Upload font');
    add.dataset.tip = 'Add a TTF/OTF font to project CSS, then choose it in Family. Existing family declarations are never replaced.';
    add.append(icon('upload'));
    add.disabled = upload.pending; add.setAttribute('aria-busy', String(upload.pending));
    add.addEventListener('click', () => picker.click());
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0]; picker.value = '';
      if (!file || upload.pending) return;
      await upload.run(file);
    });
    row.append(add, picker);
  }
  control.append(row, note);
  return control;
}
