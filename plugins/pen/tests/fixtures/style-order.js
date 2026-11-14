// Authored PEN extension styles are atomic source objects; their CSS member order is rendering data.
export function styleOrderSource({ nested = false, reordered = true, sameValues = false } = {}) {
  const style = { 'padding-left': '20px', padding: '10px' };
  const padding = sameValues ? '10px' : '12px', left = sameValues ? '20px' : '24px';
  const next = reordered ? { padding, 'padding-left': left } : { 'padding-left': left, padding };
  const styled = { id: 'styled', type: 'frame', name: 'Styled', reusable: true, width: 100, height: 60, layout: 'vertical', divlet: { style: nested ? {} : style }, children: [{ id: 'paint', type: 'rectangle', width: 10, height: 10, fill: '#ff0000' }] };
  const page = { id: 'page', type: 'frame', name: 'Page', x: 300, width: 200, height: 120, children: [] };
  const children = [styled];
  if (nested) {
    children.push({ id: 'card', type: 'frame', name: 'Card', reusable: true, x: 150, width: 120, height: 80, children: [{ id: 'inner', type: 'ref', ref: 'styled', divlet: { style } }] });
    page.children.push({ id: 'outer', type: 'ref', ref: 'card', descendants: { inner: { divlet: { style: next } } } });
  } else page.children.push({ id: 'one', type: 'ref', ref: 'styled', divlet: { style: next } });
  children.push(page);
  return { version: '2.21', children };
}
