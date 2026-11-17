// Node-owned preview content and a closure-free DOM probe shared by literal/declared actual-board witnesses.
import { fontDataUrl } from '../../../core/tests/fixtures/font.js';
export const image = color => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"><rect width="7" height="9" fill="${color}"/></svg>`).toString('base64')}`;
export const css = (padding, advance) => `@font-face{font-family:ProjectedBoard;src:url("${fontDataUrl(advance)}")}main{padding:${padding}px}#font{display:inline-block;font:100px/1 ProjectedBoard}`;
export const projectedSource = () => ({ schemaVersion: 1, name: 'Literal projection proof', frames: [{
  id: 'index', name: 'Literal frame', version: 1, rootId: 'root', artboard: { x: 0, y: 0, width: 600, height: 400 }, css: css(17, 600),
  nodes: {
    root: { id: 'root', type: 'element', tag: 'main', children: ['font', 'image', 'svg', 'input'] },
    font: { id: 'font', type: 'element', tag: 'span', attrs: { id: 'font' }, children: ['label'] },
    label: { id: 'label', type: 'text', content: 'AA' },
    image: { id: 'image', type: 'element', tag: 'img', attrs: { src: image('#123456') }, children: [] },
    svg: { id: 'svg', type: 'element', tag: 'svg', attrs: { width: '7', height: '9' }, children: ['defs', 'use'] },
    defs: { id: 'defs', type: 'element', tag: 'defs', children: ['rect'] },
    rect: { id: 'rect', type: 'element', tag: 'rect', attrs: { id: 'local-mark', width: '7', height: '9' }, children: [] },
    use: { id: 'use', type: 'element', tag: 'use', attrs: { href: '#local-mark' }, children: [] },
    input: { id: 'input', type: 'element', tag: 'input', attrs: { value: 'authored' }, children: [] },
  },
}] });
// Serialized by Playwright; no imports/outer-scope dependencies may enter this function.
export async function resourceEndpoints(main, clean = false) {
  const image = document.querySelector(clean ? 'img' : '[data-divlet-id="image"]'); await image.decode();
  const fonts = await document.fonts.load('100px ProjectedBoard', 'AA'); await document.fonts.ready;
  const use = document.querySelector(clean ? 'svg use' : '[data-divlet-id="use"]').getBBox();
  const canvas = document.createElement('canvas'); canvas.width = 7; canvas.height = 9;
  const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
  let isolated = false; try { void parent.document.body; } catch (error) { isolated = error.name === 'SecurityError'; }
  return { image: [image.naturalWidth, image.naturalHeight], use: [use.width, use.height], fonts: fonts.length, fontWidth: document.getElementById('font').getBoundingClientRect().width, padding: getComputedStyle(main).paddingTop, pixel: [...ctx.getImageData(3, 4, 1, 1).data], isolated, referrer: document.referrer };
}
