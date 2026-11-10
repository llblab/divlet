import { sourceTailwindFixture } from './source-tailwind.js';

export function sourceVariableFixture() {
  const source = sourceTailwindFixture();
  Object.assign(source.variables, Object.fromEntries(Object.entries({ viewportWidth: 420, viewportHeight: 240, pad: 12, padX: 18, gap: 8, alpha: 0.7, radius: 6, fontSize: 16, leading: 1.5, posX: -11.25, posY: 20.5, smallWidth: 40, ignoredPosition: 32 }).map(([name, value]) => [name, { type: 'number', value }])));
  source.divlet.theme['--pad_used'] = { variable: 'pad', unit: 'px' };
  source.children.push(
    { id: 'variable-tree', type: 'frame', x: '$canvasX', width: '$viewportWidth', height: '$viewportHeight', layout: 'vertical', padding: ['$pad', '$padX', '$pad', '$padX'], gap: '$gap', opacity: '$alpha', cornerRadius: '$alpha', fill: '#cde', children: [
      { id: 'variable-text', type: 'text', x: '$ignoredPosition', content: 'Bound, not frozen', width: 'fill_container', height: 40, fontSize: '$fontSize', lineHeight: '$leading', fill: '#123' },
      { id: 'variable-box', type: 'frame', width: 'fill_container', height: 32, layout: 'none', padding: ['$pad', '$padX'], gap: '$gap', cornerRadius: '$radius', fill: '#9ab' },
    ] },
    { id: 'variable-abs', type: 'frame', width: 320, height: 160, layout: 'none', children: [
      { id: 'variable-offset', type: 'rectangle', x: '$posX', y: '$posY', width: '$smallWidth', height: 24, opacity: '$alpha', fill: '#bca' },
    ] },
  );
  return source;
}
