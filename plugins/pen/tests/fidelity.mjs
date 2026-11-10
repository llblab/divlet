// Pixel fidelity of the PEN converter: every root frame of a .pen is rendered twice in a real browser, once from the
// native PEN projection and once from the converted Divlet frame (HTML + Tailwind), and the screenshots must be identical.
//   node plugins/pen/tests/fidelity.mjs [file.pen ...]      (default: examples/pen/field-notes.pen)
//   PI_DIVLET_FIDELITY_LIMIT=10 node ...                    (compare only the first N frames of each file)
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { convertPen } from '../lib/convert.js';
import { sourceFrame } from '../lib/projection.js';
import { readProject as readSource } from '../lib/source.js';
import { readProject } from '../../../core/lib/project.ts';
import { prepareFrame } from '../../../core/lib/render.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const files = process.argv.slice(2).length ? process.argv.slice(2) : [path.join(root, 'examples/pen/field-notes.pen')];
const limit = Number(process.env.PI_DIVLET_FIDELITY_LIMIT) || Infinity;

const browser = await chromium.launch({ headless: true, executablePath: process.env.PI_DIVLET_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const report = [];
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const shot = async (html, { width, height }) => {
    await page.setViewportSize({ width: Math.min(4000, Math.max(1, Math.ceil(width))), height: Math.min(4000, Math.max(1, Math.ceil(height))) });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);
    return page.screenshot({ type: 'png' });
  };
  const compare = async (a, b) => page.evaluate(async ([x, y]) => {
    const load = src => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
    const [i, j] = await Promise.all([load(x), load(y)]);
    if (i.width !== j.width || i.height !== j.height) return { size: false, different: -1, total: 0 };
    const read = image => { const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); return context.getImageData(0, 0, image.width, image.height).data; };
    const p = read(i), q = read(j);
    let different = 0, flat = true;
    for (let n = 4; n < p.length && flat; n += 4) if (p[n] !== p[0] || p[n + 1] !== p[1] || p[n + 2] !== p[2]) flat = false;
    for (let n = 0; n < p.length; n += 4) if (Math.abs(p[n] - q[n]) > 2 || Math.abs(p[n + 1] - q[n + 1]) > 2 || Math.abs(p[n + 2] - q[n + 2]) > 2 || Math.abs(p[n + 3] - q[n + 3]) > 2) different++;
    return { size: true, different, total: p.length / 4, flat };
  }, [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`]);

  for (const file of files) {
    const source = JSON.parse(await fs.readFile(file, 'utf8'));
    const roots = readSource(source).source.children.slice(0, limit);
    const { text } = convertPen(source, { name: path.basename(file, '.pen') });
    const { settings, frames } = readProject(JSON.parse(text));
    const lookup = new Map(frames.map(frame => [frame.id, frame]));
    for (const [index, node] of roots.entries()) {
      const native = await prepareFrame(sourceFrame(source, node.id).document, { settings: { ...settings, tokens: {}, css: '' } });
      const converted = frames[index];
      const output = await prepareFrame(converted, { lookup: id => lookup.get(id), settings });
      const size = { width: converted.artboard?.width ?? 1280, height: converted.artboard?.height ?? 800 };
      const result = await compare(await shot(native.html, size), await shot(output.html, size));
      report.push({ file: path.basename(file), frame: converted.name || converted.id, ...result });
    }
  }
} finally { await browser.close(); }

// A flat (single-colour) screenshot would make an identical match meaningless, so it counts as a failure too.
const bad = report.filter(item => !item.size || item.different > 0 || item.flat);
console.log(JSON.stringify({ status: bad.length ? 'failed' : 'passed', frames: report.length, differing: bad }, null, 1));
assert.equal(bad.length, 0, 'converted frames render pixel-identically to the native projection');
