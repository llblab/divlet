export const canonicalBundleFixture = () => ({ version: '2.21', divlet: { theme: { '--space': { variable: 'pad', unit: 'px' } }, foreign: true }, variables: { pad: { type: 'number', value: 32 }, viewWidth: { type: 'number', value: 320 } }, fileToken: 'CANONICAL-V2-PRIVATE-DO-NOT-EXPORT', children: [
  { id: 'page', type: 'frame', x: 12.5, y: 20.25, width: 1440, height: 900, padding: 24, layout: 'future-layout', fill: { type: 'future-gradient', foreign: true }, divlet: {
    tag: 'main', className: 'p-[70px]', style: { padding: '99px' }, attrs: { title: 'Dormant title' }, metadata: { keep: true },
    html: { tag: 'section', className: 'w-[600px] min-h-[120px] p-[var(--space)] flex flex-col gap-[8px]', attrs: { title: 'Canonical page' }, foreign: { children: 'Not topology' } }, viewport: { width: '$viewWidth', height: 'content' },
  }, children: [
    { id: 'body', type: 'text', content: 'Authoritative HTML', fontSize: 48, fontFamily: 'Fallback only', divlet: { style: { margin: '20px' }, html: { tag: 'p', className: 'text-[14px] leading-[1.5]' } } },
    { id: 'empty', type: 'rectangle', width: 100, height: 30, fill: '#f00', opacity: 0.2, divlet: { html: { tag: 'div', className: '' } } },
  ] },
  { id: 'canvas', type: 'frame', width: 720, height: 300, layout: 'horizontal', gap: 10, children: [
    { id: 'definition', type: 'frame', reusable: true, width: 180, height: 80, layout: 'vertical', padding: 44, divlet: { html: { tag: 'article', className: 'w-[180px] p-[12px] flex flex-col gap-[4px]' } }, children: [
      { id: 'shared-text', type: 'text', content: 'Shared', fontSize: 40, divlet: { foreign: true, html: { tag: 'p', className: 'text-[14px] leading-[1.5]' } } },
      { id: 'shared-box', type: 'rectangle', width: 40, height: 16, fill: '#f00', divlet: { html: { tag: 'div', className: 'w-[20px] h-[8px] bg-[#89a]' } } },
    ] },
    { id: 'a', type: 'ref', ref: 'definition', slot: ['definition'], descendants: { 'shared-text': { content: 'A only', divlet: { html: { tag: 'p', className: 'text-[18px] leading-[1.5]' } } } } },
    { id: 'b', type: 'ref', ref: 'definition', descendants: { 'shared-text': { content: 'B only', divlet: { html: { tag: 'p', className: '' } } } } },
  ] },
  { id: 'native-ref-root', type: 'ref', ref: 'definition', width: 200, height: 120, divlet: { html: false, viewport: { width: 999, height: 777 } } },
  { id: 'html-ref-root', type: 'ref', ref: 'definition', x: 800, divlet: { html: { tag: 'aside', className: 'w-[220px] p-[10px] flex flex-col' }, viewport: { width: 280.5, height: 140.25 } } },
] });
