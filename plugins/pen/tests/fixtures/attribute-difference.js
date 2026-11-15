// PEN extension attribute objects replace the lower source object; native component overrides must preserve that result.
export function attributeDifferenceSource({ nested = false, name = 'toString' } = {}) {
  const component = { id: 'component', type: 'frame', name: 'Component', reusable: true, width: 100, height: 100, divlet: { tag: 'svg', attrs: nested ? {} : { [name]: 'definition' } } };
  const page = { id: 'page', type: 'frame', name: 'Page', x: 300, width: 200, height: 150, children: [] };
  const children = [component];
  if (nested) {
    children.push({ id: 'card', type: 'frame', name: 'Card', reusable: true, x: 150, width: 100, height: 100, children: [
      { id: 'inner', type: 'ref', ref: 'component', divlet: { tag: 'svg', attrs: { [name]: 'nested' } } },
    ] });
    page.children.push({ id: 'outer', type: 'ref', ref: 'card', descendants: { inner: { divlet: { tag: 'svg', attrs: {}, className: 'outer' } } } });
  } else page.children.push({ id: 'instance', type: 'ref', ref: 'component', divlet: { tag: 'svg', attrs: {} } });
  children.push(page);
  return { version: '2.21', divlet: { css: `[${name.toLowerCase()}]{opacity:.25}` }, children };
}
