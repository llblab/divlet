export const largeSource = () => ({ version: '2.21', children: [
  { id: 'unit', type: 'frame', reusable: true, layout: 'vertical', width: 2, height: 2, children: [{ id: 'label', type: 'text', width: 2, height: 1, content: 'x', fontSize: 1 }] },
  { id: 'page', type: 'frame', layout: 'vertical', width: 320, height: 800, clip: true, children: Array.from({ length: 1500 }, (_, i) => ({ id: `i${i}`, type: 'ref', ref: 'unit' })) },
] });
