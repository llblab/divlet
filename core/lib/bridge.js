/**
 * Trusted script injected into every artboard preview. It is serialized with
 * Function#toString, so it must stay free of imports and outer-scope references.
 */
export function previewBridge(documentId, initialVersion, bridgeToken, readOnly = false, propertiesOnly = false) {
  const channel = new MessageChannel();
  const port = channel.port1;
  let version = initialVersion;
  let mode = 'board';
  let timer = 0;
  let selectedIds = [];
  let hovered = null;
  let editing = null;
  let pending = null;
  const KEEP = new Set(['data-divlet-inspected', 'data-divlet-hover', 'data-divlet-flash', 'data-divlet-work', 'contenteditable', 'spellcheck']);
  let workIds = [];
  // Elements rendered for a component instance carry data-divlet-in; only the instance itself is selectable.
  const OWN = '[data-divlet-id]:not([data-divlet-in])';
  const send = message => port.postMessage({ ...message, documentId, version });
  const root = () => document.body.querySelector('[data-divlet-id]');
  const byId = id => {
    const element = [...document.querySelectorAll('[data-divlet-id]')].find(node => node.dataset.divletId === id);
    if (element) return element;
    // Text nodes are identified by comment boundaries; their owner element is what we can highlight.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.data === `divlet:text:${id}`) return node.parentElement;
    return null;
  };
  const sheet = document.createElement('style');
  sheet.id = 'divlet-inspector-style';
  sheet.textContent = [
    '[data-divlet-inspected]{outline:2px solid #5b5bf0!important;outline-offset:-1px!important}',
    '[data-divlet-hover]:not([data-divlet-inspected]){outline:1px solid rgba(91,91,240,.65)!important;outline-offset:-1px!important}',
    'html.divlet-inspect [data-divlet-id]{cursor:default!important}',
    '[contenteditable]{outline:2px solid #5b5bf0!important;outline-offset:2px!important;cursor:text!important;min-width:1ch}',
    '[data-divlet-flash]{animation:divlet-flash 1.1s cubic-bezier(.2,.7,.2,1)}',
    // Where the agent says it is working: a breathing outline with a soft sweep.
    '[data-divlet-work]{outline:2px dashed #5b5bf0!important;outline-offset:3px!important;animation:divlet-work 1.5s ease-in-out infinite;background-image:linear-gradient(100deg,transparent 30%,rgba(91,91,240,.13) 50%,transparent 70%)!important;background-size:250% 100%!important;background-repeat:no-repeat!important}',
    '@keyframes divlet-work{0%{background-position:150% 0;outline-color:rgba(91,91,240,.35)}50%{outline-color:rgba(91,91,240,1)}100%{background-position:-150% 0;outline-color:rgba(91,91,240,.35)}}',
    '@keyframes divlet-flash{0%{box-shadow:0 0 0 0 rgba(91,91,240,.55),inset 0 0 0 999px rgba(91,91,240,.16)}100%{box-shadow:0 0 0 14px rgba(91,91,240,0),inset 0 0 0 999px rgba(91,91,240,0)}}',
  ].join('');
  document.head.append(sheet);

  // Height the page's content actually needs, ignoring a root that merely fills the viewport (min-h-screen).
  function contentHeight() {
    const top = root();
    if (!top) return 0;
    const style = getComputedStyle(top);
    let bottom = top.getBoundingClientRect().top + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0);
    for (const child of top.children) {
      const childStyle = getComputedStyle(child);
      if (childStyle.position === 'fixed' || childStyle.display === 'none') continue;
      bottom = Math.max(bottom, child.getBoundingClientRect().bottom + Math.max(0, parseFloat(childStyle.marginBottom) || 0));
    }
    return Math.ceil(bottom + (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderBottomWidth) || 0) + scrollY);
  }

  function report() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      paintBoxes();
      const nodes = [...document.querySelectorAll(OWN)].slice(0, 300).map(element => {
        const rect = element.getBoundingClientRect();
        return { id: element.dataset.divletId, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, overflowX: element.scrollWidth > element.clientWidth + 1, overflowY: element.scrollHeight > element.clientHeight + 1 };
      });
      send({ type: 'divlet:observations', nodes, contentHeight: contentHeight(), scrollHeight: document.documentElement.scrollHeight, rootHeight: document.fonts?.status === 'loading' ? undefined : root()?.getBoundingClientRect().height, viewportWidth: innerWidth, viewportHeight: innerHeight });
    }, 80);
  }

  function describe(element) {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { nodeId: element.dataset.divletId, tag: element.localName, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }

  function choose(element, additive) {
    const id = element.dataset.divletId;
    selectedIds = additive ? (selectedIds.includes(id) ? selectedIds.filter(item => item !== id) : [...selectedIds, id]) : [id];
    applySelection();
    send({ type: 'divlet:node-selection', nodeIds: selectedIds });
    report();
  }

  function applyWork() {
    for (const node of document.querySelectorAll('[data-divlet-work]')) node.removeAttribute('data-divlet-work');
    for (const id of workIds) byId(id)?.setAttribute('data-divlet-work', '');
  }

  // A quiet spacing overlay for the selection: margin (warm) outside the border box, padding (cool) inside it.
  // It lives on the root element in a fixed, clipped, non-interactive layer, so it never touches the page's layout or reconciliation.
  const boxes = document.createElement('div');
  boxes.id = 'divlet-boxes';
  boxes.setAttribute('aria-hidden', 'true');
  boxes.style.cssText = 'position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:2147483645;contain:strict;';
  document.documentElement.appendChild(boxes);
  let boxFrame = 0;
  let spaceFocus = null;
  let spaceDrag = null;
  let handlesOn = true;
  let handleRects = [];
  let handleBox = null;
  let lastHandles = '';
  function paintBoxes() {
    cancelAnimationFrame(boxFrame);
    boxFrame = requestAnimationFrame(drawBoxes);
  }
  function drawBoxes() {
    boxes.replaceChildren();
    handleRects = [];
    handleBox = null;
    if (mode !== 'inspect' || editing) { reportHandles(); return; }
    const single = selectedIds.length === 1;
    const band = (kind, side, x, y, width, height, value) => {
      const lit = !!spaceFocus && spaceFocus.kind === kind && spaceFocus.sides.includes(side);
      if (!(width > 0.5) || !(height > 0.5)) return;
      const node = document.createElement('div');
      const rgb = kind === 'margin' ? '255,153,51' : '47,184,112';
      node.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;background:rgba(${rgb},${lit ? .46 : spaceFocus ? .1 : .17});${lit ? `box-shadow:inset 0 0 0 1px rgba(${rgb},.9);` : ''}display:flex;align-items:center;justify-content:center;overflow:hidden;`;
      if ((single || lit) && Math.min(width, height) >= 11 && Math.max(width, height) >= 24) {
        const label = document.createElement('span');
        label.textContent = String(Math.round(value * 10) / 10);
        label.style.cssText = `font:600 9px/1 ui-monospace,monospace;color:rgb(${rgb});filter:brightness(.62);opacity:.9;`;
        node.append(label);
      }
      boxes.append(node);
    };
    for (const id of selectedIds.slice(0, 8)) {
      const element = byId(id);
      if (!element) continue;
      const r = element.getBoundingClientRect(), cs = getComputedStyle(element);
      const side = (prefix, edge) => Math.max(0, parseFloat(cs.getPropertyValue(`${prefix}-${edge}${prefix === 'border' ? '-width' : ''}`)) || 0);
      const m = { t: side('margin', 'top'), r: side('margin', 'right'), b: side('margin', 'bottom'), l: side('margin', 'left') };
      const b = { t: side('border', 'top'), r: side('border', 'right'), b: side('border', 'bottom'), l: side('border', 'left') };
      const p = { t: side('padding', 'top'), r: side('padding', 'right'), b: side('padding', 'bottom'), l: side('padding', 'left') };
      const ix = r.left + b.l, iy = r.top + b.t, iw = r.width - b.l - b.r, ih = r.height - b.t - b.b;
      // The numbers the page really has, for the inspector (a class it cannot read, such as padding:var(--space-3), still counts).
      if (single) {
        const edges = ['top', 'right', 'bottom', 'left'];
        const contentSize = (axis, padding, border) => {
          const size = parseFloat(cs[axis]);
          return element.getClientRects().length && cs.display !== 'contents' && Number.isFinite(size) ? Math.max(0, size - (cs.boxSizing === 'border-box' ? padding + border : 0)) : null;
        };
        handleBox = { nodeId: id,
          margin: edges.map(edge => parseFloat(cs.getPropertyValue(`margin-${edge}`)) || 0),
          padding: [p.t, p.r, p.b, p.l], border: [b.t, b.r, b.b, b.l],
          position: cs.position, inset: edges.map(edge => cs.getPropertyValue(edge)),
          content: { width: contentSize('width', p.l + p.r, b.l + b.r), height: contentSize('height', p.t + p.b, b.t + b.b) },
          colors: { background: cs.backgroundColor, color: cs.color, radius: cs.borderTopLeftRadius, fontSize: cs.fontSize, borderColor: cs.borderTopColor } };
      }
      band('margin', 't', r.left - m.l, r.top - m.t, r.width + m.l + m.r, m.t, m.t);
      band('margin', 'b', r.left - m.l, r.bottom, r.width + m.l + m.r, m.b, m.b);
      band('margin', 'l', r.left - m.l, r.top, m.l, r.height, m.l);
      band('margin', 'r', r.right, r.top, m.r, r.height, m.r);
      band('padding', 't', ix, iy, iw, p.t, p.t);
      band('padding', 'b', ix, iy + ih - p.b, iw, p.b, p.b);
      band('padding', 'l', ix, iy + p.t, p.l, ih - p.t - p.b, p.l);
      band('padding', 'r', ix + iw - p.r, iy + p.t, p.r, ih - p.t - p.b, p.r);
      // Direct manipulation: a small pill at each edge of the selected element stands for that side's margin (outside) or padding
      // (inside). The pills are only drawn here; the board owns the pointer, so it is told where they are (`divlet:handles`) and
      // drives the drag with `divlet:space-drag` messages.
      // An instance of a component has no style of its own to drag (edit the component); it still has its grip.
      const styleable = !element.hasAttribute('data-divlet-ref');
      if (single && handlesOn && styleable && !spaceDrag && r.width >= 36 && r.height >= 24) {
        const pill = (kind, side, cx, cy) => {
          const horizontal = side === 't' || side === 'b';
          const w = horizontal ? 16 : 6, h = horizontal ? 6 : 16;
          const node = document.createElement('div');
          node.style.cssText = `position:absolute;left:${cx - w / 2}px;top:${cy - h / 2}px;width:${w}px;height:${h}px;border-radius:3px;background:${kind === 'margin' ? 'rgb(255,153,51)' : 'rgb(47,184,112)'};opacity:.6;box-shadow:0 0 0 1px rgba(255,255,255,.8);`;
          boxes.append(node);
          handleRects.push({ id: kind + '-' + side, x: cx - w / 2 - 3, y: cy - h / 2 - 3, w: w + 6, h: h + 6 });
        };
        pill('margin', 't', r.left + r.width / 2, r.top - m.t - 6); pill('margin', 'b', r.left + r.width / 2, r.bottom + m.b + 6);
        pill('margin', 'l', r.left - m.l - 6, r.top + r.height / 2); pill('margin', 'r', r.right + m.r + 6, r.top + r.height / 2);
        pill('padding', 't', ix + iw / 2, iy + p.t + 6); pill('padding', 'b', ix + iw / 2, iy + ih - p.b - 6);
        pill('padding', 'l', ix + p.l + 6, iy + ih / 2); pill('padding', 'r', ix + iw - p.r - 6, iy + ih / 2);
      }
      // A grip at the top-left corner moves the element: drop it before or after another element to reorder (or move it elsewhere).
      if (single && handlesOn && !spaceDrag && element.parentElement?.closest('[data-divlet-id]') && r.width >= 24 && r.height >= 16) {
        const grip = document.createElement('div');
        grip.style.cssText = `position:absolute;left:${r.left - 9}px;top:${r.top - 9}px;width:14px;height:14px;border-radius:4px;background:rgb(91,91,240);opacity:.85;box-shadow:0 0 0 1px rgba(255,255,255,.85);background-image:radial-gradient(circle,#fff 1.2px,transparent 1.4px);background-size:5px 5px;background-position:1px 1px;`;
        boxes.append(grip);
        handleRects.push({ id: 'move', x: r.left - 12, y: r.top - 12, w: 20, h: 20 });
      }
      // A square at the bottom-right corner resizes the element (width and height; see moveSpaceDrag for the modifiers).
      if (single && handlesOn && styleable && !spaceDrag && element.parentElement?.closest('[data-divlet-id]') && r.width >= 24 && r.height >= 16) {
        const corner = document.createElement('div');
        corner.style.cssText = `position:absolute;left:${r.right - 5}px;top:${r.bottom - 5}px;width:10px;height:10px;border-radius:2px;background:#fff;border:2px solid rgb(91,91,240);box-sizing:border-box;`;
        boxes.append(corner);
        handleRects.push({ id: 'size', x: r.right - 9, y: r.bottom - 9, w: 18, h: 18 });
      }
      // The gap of a flex or grid container: one pill in the first gap between its children.
      if (single && handlesOn && styleable && !spaceDrag && /flex|grid/.test(cs.display)) {
        const kids = [...element.children].filter(child => getComputedStyle(child).display !== 'none').slice(0, 2);
        if (kids.length === 2) {
          const a = kids[0].getBoundingClientRect(), c = kids[1].getBoundingClientRect();
          const row = c.left >= a.right - 1 && Math.abs(c.top - a.top) < Math.max(a.height, c.height);
          const column = !row && c.top >= a.bottom - 1;
          if (row || column) {
            // The pill sits where the CSS gap is (right after the first child), not in whatever extra space justify-content adds.
            const g = Math.max(0, parseFloat(row ? cs.columnGap : cs.rowGap) || 0);
            const w = row ? 6 : 16, h = row ? 16 : 6;
            const cx = row ? a.right + g / 2 : (Math.max(a.left, c.left) + Math.min(a.right, c.right)) / 2;
            const cy = row ? (Math.max(a.top, c.top) + Math.min(a.bottom, c.bottom)) / 2 : a.bottom + g / 2;
            const gapBand = document.createElement('div');
            gapBand.style.cssText = `position:absolute;left:${row ? a.right : cx - w / 2 - 4}px;top:${row ? cy - h / 2 - 4 : a.bottom}px;width:${row ? g : w + 8}px;height:${row ? h + 8 : g}px;background:rgba(91,91,240,.2);`;
            boxes.append(gapBand);
            const node = document.createElement('div');
            node.style.cssText = `position:absolute;left:${cx - w / 2}px;top:${cy - h / 2}px;width:${w}px;height:${h}px;border-radius:3px;background:rgb(91,91,240);opacity:.7;box-shadow:0 0 0 1px rgba(255,255,255,.8);`;
            boxes.append(node);
            handleRects.push({ id: row ? 'gap-x' : 'gap-y', x: cx - w / 2 - 3, y: cy - h / 2 - 3, w: w + 6, h: h + 6 });
          }
        }
      }
    }
    if (spaceDrag?.label && spaceDrag.at) {
      const tag = document.createElement('div');
      tag.textContent = spaceDrag.label;
      const near = spaceDrag.kind === 'size' ? spaceDrag.element.getBoundingClientRect() : null;
      const at = near ? { x: near.right + 8, y: near.bottom + 8 } : spaceDrag.at;
      tag.style.cssText = `position:absolute;left:${at.x}px;top:${at.y}px;padding:2px 6px;border-radius:5px;background:#1c1b22;color:#fff;font:600 11px/1.3 ui-monospace,monospace;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.35);`;
      boxes.append(tag);
    }
    if (spaceDrag?.line) {
      const line = document.createElement('div');
      line.style.cssText = `position:absolute;left:${spaceDrag.line.x}px;top:${spaceDrag.line.y}px;width:${spaceDrag.line.w}px;height:${spaceDrag.line.h}px;background:rgb(91,91,240);border-radius:2px;box-shadow:0 0 0 1px rgba(255,255,255,.8);`;
      boxes.append(line);
    }
    reportHandles();
  }

  // The drag itself: the element shows the new value live (a temporary inline style); finishing sends one edit, which the board
  // commits as a declarative style (one undo step). Steps of 4px match the Tailwind scale; Alt gives 1px; Shift changes all four
  // sides of that kind, Ctrl/Cmd the opposite pair. Escape (the board cancels) restores everything.
  const SIDE_NAMES = { t: 'top', r: 'right', b: 'bottom', l: 'left' };
  function reportHandles() {
    const text = JSON.stringify([handleRects, handleBox]);
    if (text === lastHandles) return;
    lastHandles = text;
    send({ type: 'divlet:handles', nodeId: selectedIds[0] || null, rects: handleRects.map(item => ({ ...item })), box: handleBox }); 
  }
  function restoreInline() {
    if (!spaceDrag) return;
    if (spaceDrag.original === null) spaceDrag.element.removeAttribute('style'); else spaceDrag.element.setAttribute('style', spaceDrag.original);
  }
  // While a pill is dragged the element follows the pointer through inline styles (no round trip). The same value is also
  // committed every LIVE_MS so the project, the inspector and anything built from the model move with the drag; the drag's
  // own group keeps all of it one undo step, and the release still commits the exact final value.
  const LIVE_MS = 90;
  /** What a drag would commit right now; the same string makes the release a no-op instead of a "no change" history row. */
  const spacingSignature = d => d.kind === 'size'
    ? `size:${d.only === 'height' ? '-' : d.width}:${d.only === 'width' ? '-' : d.height}`
    : `${d.kind}:${[...d.sides].sort().join('')}:${d.value}`;
  function liveSpacing(d) {
    const now = performance.now();
    if (now - (d.liveAt || 0) < LIVE_MS) return;
    const signature = spacingSignature(d);
    if (d.liveSent === signature) return;
    d.liveAt = now;
    d.liveSent = signature;
    const nodeId = d.element.dataset.divletId;
    if (d.kind === 'size') send({ type: 'divlet:spacing-edit', live: true, nodeId, kind: 'size', sides: [], width: d.only === 'height' ? null : d.width, height: d.only === 'width' ? null : d.height });
    else send({ type: 'divlet:spacing-edit', live: true, nodeId, kind: d.kind, sides: d.sides, value: d.value });
  }

  // A reorder commits while the drag runs, but only when the insertion point changes. The move names the sibling it goes
  // beside (never an index), so repeating the same drop is a no-op on the tree that already moved. Alt copies, so it waits.
  function liveReorder(d) {
    if (!d.moved || !d.target || d.copy) return;
    const signature = `${d.target.dataset.divletId}:${d.after ? 'after' : 'before'}`;
    if (d.liveReorder === signature) return;
    const now = performance.now();
    if (now - (d.liveReorderAt || 0) < LIVE_MS) return;
    d.liveReorder = signature;
    d.liveReorderAt = now;
    send({ type: 'divlet:reorder', live: true, nodeId: d.element.dataset.divletId, targetId: d.target.dataset.divletId, after: d.after, copy: false });
  }

  function beginSpaceDrag(id) {
    const [kind, side] = String(id).split('-');
    const element = selectedIds.length === 1 ? byId(selectedIds[0]) : null;
    if (id === 'size' && element && element.parentElement?.closest('[data-divlet-id]') && mode === 'inspect' && !editing) {
      const box = element.getBoundingClientRect();
      const spot = handleRects.find(item => item.id === 'size');
      spaceDrag = { element, kind: 'size', original: element.getAttribute('style'), startW: box.width, startH: box.height, width: Math.round(box.width), height: Math.round(box.height), only: null, moved: false, at: spot ? { x: spot.x + spot.w + 2, y: spot.y + spot.h + 2 } : null, label: Math.round(box.width) + ' × ' + Math.round(box.height) };
      paintBoxes();
      return;
    }
    if (id === 'move' && element && element.parentElement?.closest('[data-divlet-id]') && mode === 'inspect' && !editing) {
      spaceDrag = { element, kind: 'move', original: element.getAttribute('style'), target: null, after: false, line: null, moved: false };
      element.style.setProperty('opacity', '.4', 'important');
      paintBoxes();
      return;
    }
    if (kind === 'gap' && element && (side === 'x' || side === 'y') && mode === 'inspect' && !editing) {
      const cs = getComputedStyle(element);
      const start = parseFloat(side === 'x' ? cs.columnGap : cs.rowGap) || 0;
      const spot = handleRects.find(item => item.id === id);
      spaceDrag = { element, kind, side, start, value: start, sides: [], moved: false, sign: 1, horizontal: side === 'x', original: element.getAttribute('style'), at: spot ? { x: spot.x + spot.w + 4, y: spot.y - 4 } : null, label: Math.round(start) + 'px' };
      paintBoxes();
      return;
    }
    if (!element || (kind !== 'padding' && kind !== 'margin') || !SIDE_NAMES[side] || mode !== 'inspect' || editing) return;
    const outward = side === 't' || side === 'l' ? -1 : 1;
    const start = parseFloat(getComputedStyle(element).getPropertyValue(kind + '-' + SIDE_NAMES[side])) || 0;
    spaceDrag = { element, kind, side, start, value: start, sides: [side], moved: false, sign: kind === 'padding' ? -outward : outward, horizontal: side === 'l' || side === 'r', original: element.getAttribute('style') };
    paintBoxes();
  }
  function moveSpaceDrag(data) {
    if (!spaceDrag) return;
    const d = spaceDrag;
    if (d.kind === 'size') {
      // Steps of 4px (the Tailwind scale), Alt for 1px; Shift changes only the width, Ctrl/Cmd only the height.
      const snap = value => Math.max(8, data.alt ? Math.round(value) : Math.round(value / 4) * 4);
      d.only = data.shift ? 'width' : data.ctrl ? 'height' : null;
      d.width = d.only === 'height' ? Math.round(d.startW) : snap(d.startW + data.dx);
      d.height = d.only === 'width' ? Math.round(d.startH) : snap(d.startH + data.dy);
      d.moved = true;
      d.label = d.width + ' × ' + d.height;
      restoreInline();
      if (d.only !== 'height') d.element.style.setProperty('width', d.width + 'px', 'important');
      if (d.only !== 'width') d.element.style.setProperty('height', d.height + 'px', 'important');
      drawBoxes();
      if (d.moved) liveSpacing(d);
      return;
    }
    if (d.kind === 'move') {
      // Find the element under the pointer (never the dragged one or something inside it) and which side of it the pointer is on.
      const under = Number.isFinite(data.x) && Number.isFinite(data.y) ? document.elementFromPoint(data.x, data.y)?.closest(OWN) : null;
      // Prefer a sibling of the dragged element (the pointer is usually over something inside it): that is a reorder; otherwise
      // the deepest element under the pointer, which moves the element into that element's container.
      let candidate = under;
      for (let at = under; at; at = at.parentElement?.closest(OWN)) if (at.parentElement === d.element.parentElement) { candidate = at; break; }
      d.target = candidate && candidate !== d.element && !d.element.contains(candidate) ? candidate : null;
      d.line = null;
      if (d.target) {
        const box = d.target.getBoundingClientRect();
        const parentStyle = getComputedStyle(d.target.parentElement);
        const across = /flex/.test(parentStyle.display) && !/column/.test(parentStyle.flexDirection);
        d.copy = !!data.alt;
      d.after = across ? data.x > box.left + box.width / 2 : data.y > box.top + box.height / 2;
        d.line = across ? { x: (d.after ? box.right : box.left) - 1, y: box.top, w: 3, h: box.height } : { x: box.left, y: (d.after ? box.bottom : box.top) - 1, w: box.width, h: 3 };
        d.moved = true;
      }
      d.copy = !!data.alt;
      d.label = d.copy ? 'copy' : null;
      d.at = { x: (Number(data.x) || 0) + 14, y: (Number(data.y) || 0) + 14 };
      drawBoxes();
      liveReorder(d);
      return;
    }
    const raw = d.start + (d.horizontal ? data.dx : data.dy) * d.sign;
    d.value = Math.max(d.kind === 'padding' ? 0 : -2000, data.alt ? Math.round(raw) : Math.round(raw / 4) * 4);
    d.sides = d.kind === 'gap' ? [] : data.shift ? ['t', 'r', 'b', 'l'] : data.ctrl ? (d.horizontal ? ['l', 'r'] : ['t', 'b']) : [d.side];
    d.moved = d.moved || d.value !== d.start;
    restoreInline();
    if (d.kind === 'gap') { d.element.style.setProperty('gap', d.value + 'px', 'important'); d.label = d.value + 'px'; }
    else for (const key of d.sides) d.element.style.setProperty(d.kind + '-' + SIDE_NAMES[key], d.value + 'px', 'important');
    drawBoxes();
    if (d.moved) liveSpacing(d);
  }
  function endSpaceDrag(commit) {
    if (!spaceDrag) return;
    const d = spaceDrag;
    restoreInline();
    spaceDrag = null;
    paintBoxes();
    // The release always states the final value: it may be the one the last live commit failed to deliver, and the board
    // drops a patch that changes nothing (no version bump, no history row), so repeating it costs nothing.
    if (commit && d.kind === 'size' && d.moved) { send({ type: 'divlet:spacing-edit', nodeId: d.element.dataset.divletId, kind: 'size', sides: [], width: d.only === 'height' ? null : d.width, height: d.only === 'width' ? null : d.height }); return; }
    if (commit && d.kind === 'move' && d.target) { send({ type: 'divlet:reorder', nodeId: d.element.dataset.divletId, targetId: d.target.dataset.divletId, after: d.after, copy: !!d.copy }); return; }
    if (commit && d.moved && d.kind !== 'move') send({ type: 'divlet:spacing-edit', nodeId: d.element.dataset.divletId, kind: d.kind, sides: d.sides, value: d.value });
  }
  addEventListener('scroll', paintBoxes, { passive: true, capture: true });
  addEventListener('resize', paintBoxes);

  function applySelection() {
    for (const node of document.querySelectorAll('[data-divlet-inspected]')) node.removeAttribute('data-divlet-inspected');
    for (const id of selectedIds) byId(id)?.setAttribute('data-divlet-inspected', '');
    paintBoxes();
  }

  function setHover(element, announce = false) {
    if (hovered === element) return;
    hovered?.removeAttribute('data-divlet-hover');
    hovered = element;
    hovered?.setAttribute('data-divlet-hover', '');
    if (announce) send({ type: 'divlet:hover-node', node: describe(element) });
  }

  function flash(ids) {
    for (const id of ids.slice(0, 40)) {
      const element = byId(id);
      if (!element || element.hasAttribute('data-divlet-flash')) continue;
      element.setAttribute('data-divlet-flash', '');
      setTimeout(() => element.removeAttribute('data-divlet-flash'), 1200);
    }
  }

  function syncAttributes(current, desired) {
    const valueChanged = current.getAttribute('value') !== desired.getAttribute('value');
    const checkedChanged = current.hasAttribute('checked') !== desired.hasAttribute('checked');
    for (const attr of [...current.attributes]) if (!KEEP.has(attr.name) && !desired.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    for (const attr of [...desired.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    if (valueChanged && 'value' in current) current.value = desired.getAttribute('value') || '';
    if (checkedChanged && 'checked' in current) current.checked = desired.hasAttribute('checked');
  }

  function reconcile(current, desired, ids) {
    if (current.nodeType !== desired.nodeType || (current.nodeType === 1 && (current.localName !== desired.localName || current.namespaceURI !== desired.namespaceURI))) return desired.cloneNode(true);
    if (current.nodeType !== 1) {
      if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
      return current;
    }
    syncAttributes(current, desired);
    let cursor = current.firstChild;
    for (const next of [...desired.childNodes]) {
      const id = next.nodeType === 1 ? next.getAttribute('data-divlet-id') : null;
      let target = id ? ids.get(id) : cursor;
      if (!target || target.nodeType !== next.nodeType || (next.nodeType === 1 && (target.localName !== next.localName || target.namespaceURI !== next.namespaceURI || (target.getAttribute('data-divlet-id') || null) !== id))) target = next.cloneNode(true);
      if (target !== cursor) current.insertBefore(target, cursor);
      const updated = reconcile(target, next, ids);
      if (updated !== target) target.replaceWith(updated);
      target = updated;
      cursor = target.nextSibling;
    }
    while (cursor) {
      const next = cursor.nextSibling;
      current.removeChild(cursor);
      cursor = next;
    }
    return current;
  }

  function update(html, incomingVersion) {
    const next = new DOMParser().parseFromString(html, 'text/html');
    const desired = next.body.querySelector('[data-divlet-id]');
    const current = root();
    if (!desired || !current) throw new Error('Missing render root');
    const desiredIds = [...next.body.querySelectorAll('[data-divlet-id]')].map(node => node.dataset.divletId);
    if (new Set(desiredIds).size !== desiredIds.length || next.body.querySelector('script')) throw new Error('Invalid prepared render tree');
    const ids = new Map([...document.querySelectorAll('[data-divlet-id]')].map(node => [node.dataset.divletId, node]));
    for (const marker of ['data-divlet-tokens', 'data-divlet-custom', 'data-divlet-compiled']) {
      const oldStyle = document.head.querySelector(`style[${marker}]`);
      const newStyle = next.head.querySelector(`style[${marker}]`);
      if (oldStyle && newStyle) { if (oldStyle.textContent !== newStyle.textContent) oldStyle.textContent = newStyle.textContent; }
      else if (newStyle) document.head.insertBefore(newStyle.cloneNode(true), sheet);
      else oldStyle?.remove();
    }
    const replacement = reconcile(current, desired, ids);
    if (replacement !== current) current.replaceWith(replacement);
    document.body.setAttribute('data-divlet-root', next.body.getAttribute('data-divlet-root') || desired.dataset.divletId);
    const nextMetadata = next.getElementById('divlet-metadata');
    const oldMetadata = document.getElementById('divlet-metadata');
    if (nextMetadata && oldMetadata) oldMetadata.textContent = nextMetadata.textContent;
    document.title = next.title;
    version = incomingVersion;
    selectedIds = selectedIds.filter(id => byId(id));
    applySelection();
    applyWork();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (version !== incomingVersion) return;
      send({ type: 'divlet:rendered' });
      report();
    }));
  }

  function applyUpdate(data) {
    try { update(data.html, data.version); }
    catch (error) { send({ type: 'divlet:error', message: error.message }); }
  }

  function startEditing(element, extra) {
    element.setAttribute('contenteditable', 'plaintext-only');
    if (element.contentEditable !== 'plaintext-only') element.setAttribute('contenteditable', 'true');
    element.setAttribute('spellcheck', 'false');
    element.focus();
    getSelection().selectAllChildren(element);
    send({ type: 'divlet:editing', active: true });
    return extra;
  }

  function beginEdit(element, override = null) {
    if (readOnly) return false;
    if (editing || element.childElementCount || !element.textContent) return false;
    const saved = [...element.childNodes].map(node => node.cloneNode(true));
    editing = { element, saved, original: element.textContent, override };
    paintBoxes();
    startEditing(element);
    return true;
  }

  /** The text node of `element` under a point (text mixed with child elements), with its model id. */
  function textAt(element, x, y) {
    const range = document.caretRangeFromPoint?.(x, y);
    let node = range?.startContainer;
    if (!node && document.caretPositionFromPoint) node = document.caretPositionFromPoint(x, y)?.offsetNode;
    if (!node || node.nodeType !== 3 || node.parentNode !== element) return null;
    const open = node.previousSibling;
    if (open?.nodeType !== 8 || !open.data.startsWith('divlet:text:')) return null;
    const probe = document.createRange();
    probe.selectNodeContents(node);
    const inside = [...probe.getClientRects()].some(r => x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3);
    return inside ? { node, id: open.data.slice('divlet:text:'.length) } : null;
  }

  /** Edit one text node of an element that mixes text and elements: it is wrapped in a span while editing. */
  function beginTextNodeEdit(found) {
    if (readOnly) return false;
    if (editing || !found.node.data) return false;
    const span = document.createElement('span');
    span.textContent = found.node.data;
    found.node.replaceWith(span);
    editing = { element: span, saved: [found.node], original: found.node.data, textId: found.id, wrapper: true };
    paintBoxes();
    startEditing(span);
    return true;
  }

  /**
   * Double-click edits what is under the pointer: the text (of an element, of one text part among
   * child elements, or of a component instance); for anything without text the board gets to
   * focus the field that matters (an image's source, a field's placeholder…).
   */
  function editAt(target, x, y) {
    if (readOnly) return;
    const element = target?.closest(OWN);
    if (!element) return;
    selectedIds = [element.dataset.divletId];
    applySelection();
    send({ type: 'divlet:node-selection', nodeIds: selectedIds });
    let started;
    if (target.dataset.divletIn) started = beginEdit(target, { instance: target.dataset.divletIn, address: target.dataset.divletAt });
    else if (element.dataset.divletRef) started = beginEdit(element, { instance: element.dataset.divletId, address: element.dataset.divletRef.split('/').pop() });
    else if (element.childElementCount) { const found = textAt(element, x, y); started = found ? beginTextNodeEdit(found) : false; }
    else started = beginEdit(element);
    if (!started && !editing) send({ type: 'divlet:edit-fallback', nodeId: element.dataset.divletId, tag: element.localName });
  }

  /** The element the board means at a point of the page: the deepest own element, else the root. */
  const elementAt = (x, y) => document.elementFromPoint(x, y)?.closest(OWN) || root();

  function endEdit(commit) {
    if (!editing) return;
    const { element, saved, original, override, textId, wrapper } = editing;
    editing = null;
    paintBoxes();
    const content = element.textContent;
    element.removeAttribute('contenteditable');
    element.removeAttribute('spellcheck');
    send({ type: 'divlet:editing', active: false });
    if (commit && content !== original && override) send({ type: 'divlet:override-text', ...override, content });
    else if (commit && content !== original) send({ type: 'divlet:text-edit', nodeId: textId ?? element.dataset.divletId, content });
    else if (wrapper) element.replaceWith(...saved);
    else element.replaceChildren(...saved);
    if (pending) {
      const data = pending;
      pending = null;
      applyUpdate(data);
    }
  }

  addEventListener('keydown', event => {
    if (editing) {
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === 'Escape') { event.preventDefault(); endEdit(false); }
      else if (event.key === 'Tab') {
        // Keep going with the keyboard: save, and let the board select the next (previous) element.
        event.preventDefault();
        const id = editing.element.dataset.divletId;
        endEdit(true);
        send({ type: 'divlet:edit-step', dir: event.shiftKey ? -1 : 1, nodeId: id ?? null });
      } else if (event.key === 'Enter' && !event.shiftKey && (editing.element.tagName !== 'P' || mod)) {
        event.preventDefault();
        const element = editing.element;
        // In a list, Enter starts the next item (Ctrl+Enter just saves), like in any list editor.
        const next = element.tagName === 'LI' && !mod && !editing.override ? element.dataset.divletId : null;
        endEdit(true);
        if (next) send({ type: 'divlet:edit-step', dir: 1, create: true, nodeId: next });
      }
      return;
    }
    if (event.key === 'Escape') { send({ type: 'divlet:escape' }); return; }
    if (mode !== 'inspect' || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    // Paste stays native so the paste event below can read the clipboard.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.code === 'KeyV' || event.key.toLowerCase() === 'v')) return;
    send({ type: 'divlet:key', key: event.key, code: event.code, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey });
    if (['Backspace', 'Delete', 'Tab', 'Enter'].includes(event.key) || event.ctrlKey || event.metaKey) event.preventDefault();
  });

  document.addEventListener('paste', event => {
    if (mode !== 'inspect' || editing) return;
    event.preventDefault();
    if (readOnly || propertiesOnly) return;
    const files = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/')).slice(0, 12);
    send({ type: 'divlet:paste', text: event.clipboardData?.getData('text/plain') ?? '', files });
  }, true);

  // Dropping a file must never navigate the preview; images are handed to the board.
  const carriesFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragover', event => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  addEventListener('drop', event => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (readOnly || propertiesOnly) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-divlet-id]');
    send({ type: 'divlet:drop', files: [...event.dataTransfer.files].filter(file => file.type.startsWith('image/')).slice(0, 12), nodeId: target?.dataset.divletId ?? null });
  });

  addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    send({ type: 'divlet:wheel', deltaY: event.deltaY, deltaMode: event.deltaMode, clientX: event.clientX, clientY: event.clientY });
  }, { passive: false });

  // A picture of this page for the board's far-zoom view: the page serializes itself into an SVG foreignObject and rasterizes it.
  // Images and CSS url() resources are inlined through CORS-enabled image loads (no fetch, so the preview CSP stays closed).
  async function capture() {
    const width = Math.ceil(innerWidth), height = Math.ceil(innerHeight);
    if (!width || !height || width > 4096 || height > 4096) return null;
    const root = document.documentElement.cloneNode(true);
    for (const node of root.querySelectorAll('script, link, #divlet-boxes, #divlet-inspector-style')) node.remove();
    const cache = new Map();
    const inline = url => {
      if (!cache.has(url)) cache.set(url, new Promise(resolve => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
          try { const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || 1; canvas.height = image.naturalHeight || 1; canvas.getContext('2d').drawImage(image, 0, 0); resolve(canvas.toDataURL('image/png')); }
          catch { resolve(null); }
        };
        image.onerror = () => resolve(null);
        image.src = url;
      }));
      return cache.get(url);
    };
    const absolute = value => { try { return new URL(value, document.baseURI).href; } catch { return null; } };
    for (const image of root.querySelectorAll('img[src]')) {
      const url = image.getAttribute('src');
      if (url.startsWith('data:')) continue;
      const data = absolute(url) ? await inline(absolute(url)) : null;
      if (data) image.setAttribute('src', data); else image.removeAttribute('src');
    }
    const urls = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g;
    for (const node of [...root.querySelectorAll('style'), ...root.querySelectorAll('[style*="url("]')]) {
      const style = node.localName === 'style';
      let text = style ? node.textContent : node.getAttribute('style');
      for (const match of [...text.matchAll(urls)].slice(0, 60)) {
        const url = match[2];
        if (url.startsWith('data:') || url.startsWith('#')) continue;
        const data = absolute(url) ? await inline(absolute(url)) : null;
        text = text.split(match[0]).join(data ? `url(${data})` : 'none');
      }
      if (style) node.textContent = text; else node.setAttribute('style', text);
    }
    const markup = new XMLSerializer().serializeToString(root);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">${markup}</foreignObject></svg>`;
    const picture = new Image();
    picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await picture.decode();
    const scale = Math.min(1, 720 / width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    return new Promise(resolve => canvas.toBlob(blob => resolve(blob ? { blob, width: canvas.width, height: canvas.height } : null), 'image/webp', 0.82));
  }

  port.addEventListener('message', event => {
    if (!event.data || typeof event.data !== 'object') return;
    const data = event.data;
    if (data.type === 'divlet:writable' && typeof data.enabled === 'boolean') {
      readOnly = !data.enabled;
      if (readOnly) endEdit(false);
    }
    if (data.type === 'divlet:inspect') {
      mode = data.enabled ? 'inspect' : 'board';
      document.documentElement.classList.toggle('divlet-inspect', mode === 'inspect');
      if (mode !== 'inspect') { setHover(null, true); endEdit(true); }
      paintBoxes();
    }
    if (data.type === 'divlet:capture') capture().then(result => { if (result) send({ type: 'divlet:snapshot', ...result }); else send({ type: 'divlet:snapshot-failed' }); }).catch(() => send({ type: 'divlet:snapshot-failed' }));
    if (data.type === 'divlet:handles-enabled') { handlesOn = data.enabled !== false; paintBoxes(); }
    if (data.type === 'divlet:space-drag' && typeof data.phase === 'string') {
      if (data.phase === 'start' && typeof data.id === 'string') beginSpaceDrag(data.id);
      else if (data.phase === 'move' && Number.isFinite(data.dx) && Number.isFinite(data.dy)) moveSpaceDrag({ dx: data.dx, dy: data.dy, x: data.x, y: data.y, shift: !!data.shift, ctrl: !!data.ctrl, alt: !!data.alt });
      else if (data.phase === 'end') endSpaceDrag(true);
      else if (data.phase === 'cancel') endSpaceDrag(false);
    }
    if (data.type === 'divlet:spacing-focus') {
      const focus = data.focus;
      spaceFocus = focus && typeof focus === 'object' && ['margin', 'padding'].includes(focus.kind) && Array.isArray(focus.sides) ? { kind: focus.kind, sides: focus.sides.filter(side => ['t', 'r', 'b', 'l'].includes(side)) } : null;
      paintBoxes();
    }
    if (data.type === 'divlet:select' && Array.isArray(data.nodeIds)) {
      selectedIds = data.nodeIds.filter(id => typeof id === 'string').slice(0, 100);
      applySelection();
      if (data.reveal && selectedIds.length) byId(selectedIds[0])?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (data.type === 'divlet:edit' && typeof data.nodeId === 'string') {
      const element = byId(data.nodeId);
      if (element && !editing) {
        selectedIds = [element.dataset.divletId];
        applySelection();
        beginEdit(element);
      }
    }
    // The board keeps the pointer (it draws, drags and zooms); it asks what is under it.
    if (data.type === 'divlet:pick' && Number.isFinite(data.x) && Number.isFinite(data.y)) {
      if (editing) endEdit(true);
      const element = elementAt(data.x, data.y);
      if (element) choose(element, !!data.additive);
    }
    if (data.type === 'divlet:hover-at') {
      if (mode === 'inspect' && !editing) setHover(Number.isFinite(data.x) && Number.isFinite(data.y) ? document.elementFromPoint(data.x, data.y)?.closest(OWN) || null : null, true);
    }
    if (data.type === 'divlet:edit-at' && Number.isFinite(data.x) && Number.isFinite(data.y) && !editing) {
      setHover(null, true);
      editAt(document.elementFromPoint(data.x, data.y)?.closest('[data-divlet-id]'), data.x, data.y);
    }
    if (data.type === 'divlet:context-at' && Number.isFinite(data.x) && Number.isFinite(data.y)) {
      if (editing) endEdit(true);
      const element = elementAt(data.x, data.y);
      if (element && !selectedIds.includes(element.dataset.divletId)) choose(element, false);
      send({ type: 'divlet:context', clientX: data.x, clientY: data.y });
    }
    if (data.type === 'divlet:hover') setHover(typeof data.nodeId === 'string' ? byId(data.nodeId) : null);
    if (data.type === 'divlet:scroll-to' && typeof data.fragment === 'string' && data.fragment.length <= 2048) scrollToFragment(data.fragment);
    if (data.type === 'divlet:flash' && Array.isArray(data.nodeIds)) flash(data.nodeIds);
    if (data.type === 'divlet:work' && Array.isArray(data.nodeIds)) { workIds = data.nodeIds.filter(id => typeof id === 'string').slice(0, 100); applyWork(); }
    if (data.type === 'divlet:update' && data.documentId === documentId && Number.isInteger(data.version) && data.version > version && typeof data.html === 'string' && data.html.length <= 8 * 1024 * 1024) {
      if (editing) pending = data;
      else applyUpdate(data);
    }
  });

  document.addEventListener('click', event => {
    if (mode !== 'inspect' || event.target.closest?.('#divlet-boxes')) return;
    const element = event.target.closest(OWN);
    event.preventDefault();
    event.stopImmediatePropagation();
    if (editing?.element.contains(event.target)) return;
    if (editing) endEdit(true);
    if (!element) return;
    choose(element, event.shiftKey || event.metaKey || event.ctrlKey);
  }, true);

  // Play: the page behaves normally. Its `<base>` points at the project files, so a link would leave for `files/…` (a 404). The
  // canonical href stays as authored. A same-page `#fragment` scrolls here the way a browser would; a link to another page is
  // reported to the board, which owns the artboards and decides what reaching a sibling frame means.
  const scrollToFragment = fragment => {
    let name = String(fragment).replace(/^#/, '');
    try { name = decodeURIComponent(name); } catch { /* an undecodable fragment is matched as written */ }
    const target = name && (document.getElementById(name) || document.getElementsByName(name)[0]);
    if (target) target.scrollIntoView();
    else if (name === '' || name.toLowerCase() === 'top') window.scrollTo(0, 0);
  };
  document.addEventListener('click', event => {
    if (mode === 'inspect' || event.defaultPrevented || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    const link = event.target.closest?.('a[href], area[href]');
    const href = link?.getAttribute('href');
    if (!href || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
    if (href[0] === '#') { event.preventDefault(); scrollToFragment(href); return; }
    // A scheme or a network-path reference is not a page of this project; leave it to the browser and its CSP.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href) || href.length > 2048) return;
    event.preventDefault();
    send({ type: 'divlet:link', href });
  });

  document.addEventListener('contextmenu', event => {
    if (mode !== 'inspect' || editing) return;
    event.preventDefault();
    const element = event.target.closest(OWN);
    if (element && !selectedIds.includes(element.dataset.divletId)) choose(element, false);
    send({ type: 'divlet:context', clientX: event.clientX, clientY: event.clientY });
  }, true);

  document.addEventListener('dblclick', event => {
    if (mode !== 'inspect') return;
    const target = event.target.closest('[data-divlet-id]');
    if (!target?.closest(OWN)) return;
    event.preventDefault();
    // Inside an instance, the text being edited is an override of that instance.
    editAt(target, event.clientX, event.clientY);
  }, true);

  document.addEventListener('mousemove', event => {
    if (mode === 'inspect' && !editing && !spaceDrag && !event.target.closest?.('#divlet-boxes')) setHover(event.target.closest?.(OWN) || null, true);
  }, true);
  document.addEventListener('mouseleave', () => setHover(null, mode === 'inspect'));
  addEventListener('scroll', () => { if (hovered && mode === 'inspect') send({ type: 'divlet:hover-node', node: null }); }, { passive: true });
  addEventListener('blur', () => endEdit(true));

  port.start();
  parent.postMessage({ type: 'divlet:connect', bridgeToken }, '*', [channel.port2]);
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener('load', report, true);
  addEventListener('resize', report);
  document.fonts?.ready.then(report);
  document.fonts?.addEventListener('loadingdone', report);
  requestAnimationFrame(() => {
    send({ type: 'divlet:rendered' });
    report();
  });
}
