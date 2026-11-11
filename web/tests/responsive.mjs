import assert from 'node:assert/strict';
import { legacyProject } from '../../core/tests/fixtures/legacy-project.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openRuntime } from '../../core/lib/runtime.js';
import { decodeHtml } from '../../core/lib/codec.ts';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = await import('playwright'); }
catch {
  if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw new Error('Install dev dependencies and run npx playwright install chromium.');
  playwright = require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright'));
}

const css = `
.shell{width:min(calc(100% - 32px),960px);margin-inline:auto;padding-block:24px;color:#24342c;background:white}
.shell h1{font:600 24px/1.2 system-ui;margin:0 0 16px}
.copy{font:16px/20px monospace;margin:0 0 16px}
.css-grid{display:grid;grid-template-columns:repeat(1,minmax(0,1fr));gap:16px;margin-bottom:16px}
.cell{min-width:0;height:40px;background:#ddd}
.fluid{width:clamp(120px,50vw,420px);max-width:100%;height:20px;background:#cba}
.wide-only{display:none}
.query-host{container-type:inline-size;width:100%}
.cq-child{height:20px;background-color:rgb(255,0,0)}
@media(min-width:768px){.css-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.wide-only{display:block}}
@media(min-width:1100px){.css-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@container(min-width:700px){.cq-child{background-color:rgb(0,128,0)}}
`;
const copy = 'A single authored document should reflow naturally at intermediate widths as well as named breakpoints. Changing the artboard viewport must preserve content, metadata and the declarative sizing rules.';
const model = decodeHtml(`<style>${css}</style><main id="shell" class="shell"><h1>One responsive document</h1><p id="copy" class="copy">${copy}</p><section id="css-grid" class="css-grid"><div class="cell">A</div><div class="cell">B</div><div class="cell">C</div></section><section id="tw-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"><div class="cell">A</div><div class="cell">B</div><div class="cell">C</div></section><div id="fluid" class="fluid"></div><p id="wide-only" class="wide-only">Visible from 768px</p><div class="query-host"><div id="cq-child" class="cq-child"></div></div></main>`, { fallbackId: 'responsive' });
model.artboard = { x: 60, y: 50, width: 390, height: 1600 };
model.metadata = { intent: 'Same document across a width sweep', expectedWidths: [390, 600, 768, 1200] };
model.nodes.shell.metadata = { intent: 'Fluid width with a 960px maximum' };

const cwd = await mkdtemp(path.join(os.tmpdir(), 'divlet-responsive-'));
await legacyProject(path.join(cwd, 'project.divlet'));
const runtime = await openRuntime({ cwd, watch: false, createDemo: false });
const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PI_DIVLET_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PI_DIVLET_CHROMIUM_EXECUTABLE;
let browser;

try {
  await runtime.create({ document: model });
  browser = await playwright.chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(runtime.info().url);
  const iframe = page.locator('iframe[data-document-id="responsive"]');
  await iframe.waitFor();
  const frame = iframe.contentFrame();
  await frame.locator('[data-divlet-id="shell"]').waitFor();
  await frame.locator('[data-divlet-id="shell"]').evaluate(node => { window.__responsiveRoot = node; });
  const originalFrame = await iframe.getAttribute('src');
  const records = [];
  for (const width of [390, 600, 768, 1200]) {
    const before = runtime.read({ view: 'document', documentId: 'responsive' });
    let version = before.version;
    if (before.artboard.width !== width) {
      const result = await runtime.patch({ documentId: 'responsive', expectedVersion: version, patch: { artboard: { width } } });
      version = result.version;
    }
    await page.waitForFunction(expected => Number(document.querySelector('.artboard[data-artboard-id="responsive"]')?.dataset.renderedVersion) === expected, version);
    const values = await frame.locator('[data-divlet-id="shell"]').evaluate(root => {
      const find = id => document.querySelector(`[data-divlet-id="${id}"]`);
      const columns = id => getComputedStyle(find(id)).gridTemplateColumns.split(/\s+/).length;
      return {
        width: innerWidth,
        shell: root.getBoundingClientRect().width,
        fluid: find('fluid').getBoundingClientRect().width,
        cssColumns: columns('css-grid'),
        tailwindColumns: columns('tw-grid'),
        textHeight: find('copy').getBoundingClientRect().height,
        wideVisible: getComputedStyle(find('wide-only')).display !== 'none',
        containerColor: getComputedStyle(find('cq-child')).backgroundColor,
        sameRoot: root === window.__responsiveRoot,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.equal(values.width, width);
    assert.ok(Math.abs(values.shell - Math.min(width - 32, 960)) < 1, `fluid shell at ${width}: ${values.shell}`);
    assert.ok(Math.abs(values.fluid - Math.min(420, Math.max(120, width * 0.5))) < 1, `clamp width at ${width}`);
    const columns = width >= 1100 ? 3 : width >= 768 ? 2 : 1;
    assert.equal(values.cssColumns, columns, `plain CSS grid at ${width}`);
    assert.equal(values.tailwindColumns, width >= 1024 ? 3 : width >= 768 ? 2 : 1, `Tailwind grid at ${width}`);
    assert.equal(values.wideVisible, width >= 768);
    assert.equal(values.containerColor, Math.min(width - 32, 960) >= 700 ? 'rgb(0, 128, 0)' : 'rgb(255, 0, 0)');
    assert.equal(values.sameRoot, true);
    assert.equal(values.horizontalOverflow, false);
    assert.equal(await iframe.getAttribute('src'), originalFrame);
    const accepted = runtime.read({ view: 'document', documentId: 'responsive' });
    assert.deepEqual(accepted.nodes, model.nodes);
    assert.deepEqual(accepted.metadata, model.metadata);
    records.push(values);
  }
  assert.ok(records[0].textHeight > records.at(-1).textHeight, 'text must reflow, not retain a fixed text-box height');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', documentId: 'responsive', widths: records, checks: ['same authored document', 'fixed iframe viewport', 'fluid min/max/clamp/percentage sizes', 'plain CSS media queries', 'Tailwind breakpoint variants', 'container queries', 'text reflow', 'responsive visibility', 'no horizontal overflow', 'retained DOM/iframe identity', 'metadata retained'] }, null, 2));
} finally {
  await browser?.close();
  await runtime.close();
  await rm(cwd, { recursive: true, force: true });
}
