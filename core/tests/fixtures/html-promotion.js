export const htmlPromotionFiles = new Map([['assets/swatch.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><path fill="#89a" d="M0 0h40v20H0z"/></svg>']]);
export const htmlPromotionFixture = () => ({ version: '2.21', fileToken: 'PROMOTION-PRIVATE-DO-NOT-EXPORT', foreign: { keep: true }, variables: {
  width: { type: 'number', value: 320.5 }, pad: { type: 'number', value: 24 }, alpha: { type: 'number', value: 0.8 }, pose: { type: 'number', value: 12.5 },
}, children: [
  { id: 'page', type: 'frame', x: '$pose', y: 20.25, width: '$width', height: 'fit_content', layout: 'vertical', padding: '$pad', gap: 8.25, opacity: '$alpha', fill: '#e8d5a8', divlet: { metadata: { keep: true }, foreign: { keep: 'unrelated namespace' }, viewport: { width: 300, height: 222, foreign: true } }, children: [
    { id: 'title', type: 'text', content: 'Promotion source', width: 180, height: 24, fontSize: 14, fontWeight: 500, lineHeight: 1.5, fill: '#123456' },
    { id: 'box', type: 'rectangle', width: 40, height: 20, fill: '#89a', cornerRadius: 3.25 },
  ] },
  { id: 'scene', type: 'frame', width: 400, height: 200, layout: 'none', fill: { type: 'image', url: 'assets/swatch.svg', mode: 'cover' }, children: [
    { id: 'leaf', type: 'rectangle', x: -5.25, y: 12.5, width: 30.5, height: 20.25, fill: '#a98' },
    { id: 'sibling', type: 'rectangle', x: 80, y: 12.5, width: 30, height: 20, fill: '#345' },
  ] },
] });
