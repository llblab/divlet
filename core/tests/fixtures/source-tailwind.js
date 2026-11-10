export const sourceTailwindFixture = () => ({
  version: '2.21', divlet: { schemaVersion: 1, theme: { '--spacing': { variable: 'spacing', unit: 'px' } } }, fileToken: 'SOURCE-ONLY-TAILWIND-SECRET',
  variables: { canvasX: { type: 'number', value: 34 }, spacing: { type: 'number', value: 99 } }, foreign: { keep: true },
  children: [
    { id: 'card / opaque', type: 'frame', x: '$canvasX', y: 50, width: 320.5, height: 168.25, layout: 'vertical', padding: 24, gap: 12.5, clip: true, alignItems: 'center', justifyContent: 'space_between', fill: '#e8d5a8', cornerRadius: 8.5, opacity: 0.75 },
    { id: 'scene', type: 'frame', width: 620, height: 340, layout: 'none', children: [
      { id: 'label', type: 'text', x: -12.25, y: 20.5, width: 180, height: 52, content: 'Native to Tailwind\nБез округления', fontSize: 16, fontWeight: 500, lineHeight: 1.5, textAlign: 'left', fill: '#123456', opacity: 0.9, divlet: { tag: 'p', attrs: { title: 'Retained title', 'aria-label': 'Native label' }, metadata: { keep: 'local' } } },
      { id: 'box-a', type: 'rectangle', x: 220, y: 30, width: 40, height: 40, fill: '#4b7' },
      { id: 'box-b', type: 'rectangle', x: 220, y: 30, width: 40, height: 40, fill: '#4b7' },
    ] },
    { id: 'flow', type: 'frame', width: 640, height: 240, layout: 'horizontal', padding: 10, gap: 13, children: [
      { id: 'wide', type: 'frame', width: 'fill_container', height: 'fill_container', layout: 'vertical', gap: 9, padding: [3, 5], fill: '#9ab' },
      { id: 'fixed', type: 'rectangle', width: 24, height: 40, fill: '#345' },
    ] },
    { id: 'intrinsic', type: 'frame', width: 320, height: 'fit_content', layout: 'vertical', padding: 8, fill: '#abc' },
    { id: 'four', type: 'frame', width: 200, height: 96, layout: 'horizontal', padding: [1.25, 2.5, 3.75, 4], gap: 0, fill: '#1238' },
    { id: 'stack', type: 'frame', width: 240, height: 180, layout: 'horizontal', padding: 16, gap: 8, children: [
      { id: 'tile-a', type: 'rectangle', width: 48, height: 32, fill: '#abc' },
      { id: 'tile-b', type: 'rectangle', width: 48, height: 32, fill: '#def' },
    ] },
    { id: 'intrinsic-tree', type: 'frame', width: 320, height: 'fit_content', layout: 'vertical', padding: 8, children: [
      { id: 'intrinsic-item', type: 'text', content: 'Intrinsic subtree', width: 160, fontSize: 14 },
    ] },
    { id: 'nested', type: 'frame', width: 640, height: 320, layout: 'vertical', padding: 10, children: [
      { id: 'group', type: 'frame', width: 'fill_container', height: 'fit_content', layout: 'horizontal', padding: 12, gap: 6, children: [
        { id: 'group-box', type: 'rectangle', width: 24, height: 16, fill: '#abc' },
        { id: 'group-text', type: 'text', content: 'Nested', width: 80, height: 24, fontSize: 14, lineHeight: 1.4, fill: '#123' },
      ] },
      { id: 'unselected', type: 'rectangle', width: 40, height: 20, fill: '#999' },
    ] },
  ],
});
