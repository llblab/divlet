export function fixture(width = 390) {
  return { version: '2.21', fileToken: 'DO-NOT-EMIT', variables: { ink: { type: 'color', value: '#123456' }, line: { type: 'number', value: 1.5 }, family: { type: 'string', value: 'Inter' } }, divlet: { schemaVersion: 1, theme: { '--color-brand': '$ink' } }, children: [
    { id: 'definition', type: 'frame', reusable: true, width: 100, height: 32, children: [{ id: 'label', type: 'text', content: 'Default', fontSize: 16, lineHeight: '$line', fontFamily: '$family' }] },
    { id: '7 / screen', type: 'frame', name: 'PEN preview', x: 9000, y: 1200, width, height: 480, layout: 'vertical', padding: 16, gap: 12, children: [
      { id: 'row', type: 'frame', width: 'fill_container', height: 32, gap: 12, children: [
        { id: 'fixed', type: 'rectangle', width: 64, height: 32, fill: '#cccccc' },
        { id: 'grow', type: 'text', width: 'fill_container(150)', content: 'Growing title', fill: '$ink', fontSize: 16 },
      ] },
      { id: 'instance', type: 'ref', ref: 'definition', divlet: { tag: 'button', attrs: { type: 'button', 'aria-label': 'Native button' }, className: 'bg-brand text-white' }, descendants: { label: { content: 'Changed' } } },
      { id: 'icon', type: 'icon', name: 'Check', library: 'lucide', icon: 'check', width: 24, height: 24, fill: '$ink' },
      { id: 'alias', type: 'icon', name: 'Trash', library: 'lucide', icon: 'trash-2', width: 24, height: 24, fill: '$ink' },
      { id: 'vector', type: 'path', width: 50, height: 50, viewBox: [0, 0, 10, 10], geometry: 'M0 0H10V10H0Z', fill: '#00aa00' },
      { id: 'photo', type: 'frame', width: 80, height: 40, fill: [{ type: 'image', url: 'assets/photo.svg', mode: 'cover' }, '#ff000080'] },
      { id: 'free', type: 'frame', width: 120, height: 40, layout: 'none', children: [{ id: 'badge', type: 'rectangle', x: -6, y: 8, width: 20, height: 16, fill: '#aa0000' }] },
    ] },
  ] };
}
