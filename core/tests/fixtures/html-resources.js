const svg = color => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48"><rect width="96" height="48" fill="${color}"/></svg>`;
export const htmlResourceFiles = new Map([
  ['images/active.svg', svg('#2364cc').replace('</svg>', '<defs><pattern id="unused"><image href="nested.svg" width="1" height="1"/></pattern></defs></svg>')],
  ['images/nested.svg', svg('#ef7d32')], ['images/dormant.svg', svg('#777777')], ['images/flat.svg', svg('#22aa88')], ['images/style.svg', svg('#dd6699')],
  ['pages/info.html', '<!doctype html><link rel="stylesheet" href="../style/copy.css"><h1 id="intro">Portable details</h1><img src="../images/active.svg">'],
  ['style/copy.css', '@import "nested.css"; h1{color:rgb(21,60,63)}'], ['style/nested.css', '.unused{background:url("../images/nested.svg")}'],
]);
export const htmlResourceFixture = () => ({ version: '2.21', fileToken: 'HTML-COPY-SOURCE-ONLY', divlet: { schemaVersion: { opaque: true }, css: '.literal-card{color:#153c3f;background-image:url("images/style.svg")}', foreign: { path: 'images/not-a-carrier.svg' } }, variables: { ink: { type: 'color', value: '#153c3f' }, width: { type: 'number', value: 390 } }, children: [
  { id: 'page', name: 'Literal resources', type: 'frame', x: 12.5, y: 20.25, width: 1000, height: 800, layout: 'future-layout', fill: { type: 'image', url: 'images/dormant.svg' }, divlet: {
    className: 'rounded', attrs: { src: 'images/flat.svg' }, style: { 'background-image': 'url(images/dormant.svg)' }, metadata: { path: 'images/metadata.svg' },
    viewport: { width: '$width', height: 'content' }, html: { tag: 'section', className: 'literal-card w-full max-w-[360px] p-[16px] flex flex-col gap-[8px]', attrs: { title: 'Portable card' }, style: { 'background-image': 'u\\72l("images/style.svg?copy=1#shape")' }, foreign: { src: 'images/not-a-carrier.svg' } },
  }, children: [
    { id: 'picture', type: 'rectangle', fill: { type: 'image', url: 'images/dormant.svg' }, divlet: { html: { tag: 'img', className: 'w-[96px] h-[48px]', attrs: { src: 'images/active.svg?copy=2#shape', srcset: 'images/active.svg 1x, images/nested.svg 2x', alt: 'Portable blue swatch' } } } },
    { id: 'label', type: 'text', content: 'Literal HTML resources', fontSize: 60, divlet: { html: { tag: 'h1', className: 'text-[18px] leading-[24px]', style: { 'letter-spacing': 'calc(1px + 0px)' } } } },
    { id: 'details', type: 'text', content: 'Details', divlet: { html: { tag: 'a', className: 'text-[14px] underline', attrs: { href: 'pages/info.html?q=2#intro' } } } },
  ] },
] });
