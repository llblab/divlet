export const polygonSource = () => ({ version: '2.21', fileToken: 'POLYGON-SOURCE-ONLY', variables: { sides: { type: 'number', value: 6 }, round: { type: 'number', value: 3 }, ink: { type: 'color', value: '#2F78FF' } }, children: [
  { id: 'poly', type: 'polygon', reusable: true, width: 32, height: 32, polygonCount: '$sides', cornerRadius: '$round', fill: '$ink', foreign: { retained: true } },
  { id: 'page', type: 'frame', x: 80, width: 300, height: 180, layout: 'none', fill: '#fff', children: [
    { id: 'rounded', type: 'ref', ref: 'poly', x: 20, y: 20 },
    { id: 'sharp', type: 'ref', ref: 'poly', x: 80, y: 20, cornerRadius: 0 },
    { id: 'wide', type: 'ref', ref: 'poly', x: 140, y: 20, width: 120, height: 48, cornerRadius: 12 },
    { id: 'clamped', type: 'ref', ref: 'poly', x: 20, y: 90, width: 64, height: 64, polygonCount: 3, cornerRadius: 16384 },
    { id: 'unfilled', type: 'ref', ref: 'poly', x: 120, y: 90, fill: [] },
  ] },
] });
