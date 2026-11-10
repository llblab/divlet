/*
 * The HTML importer plugin: a static `.html` page opened by path is converted into a Divlet project beside it (see
 * core/lib/plugins.ts for the contract). It is not `listed`: `.html` files in a folder are not offered as projects (sites and
 * generated pages are full of them); you open one deliberately, by path.
 */
import { convertHtml, decodePage, summarizeHtml } from './lib/convert.js';

export default {
  id: 'html',
  label: 'HTML page (.html)',
  extensions: ['.html', '.htm'],
  listed: false,
  claims: async () => false,
  convert: (bytes, { name, provenance }) => convertHtml(bytes.toString('utf8'), { name, provenance }),
  // A page dropped into a project folder becomes one frame, decoded exactly like a page opened by path.
  page: (bytes, { fallbackId, source }) => decodePage(bytes.toString('utf8'), { fallbackId, source, format: 'html' }),
  summarize: bytes => summarizeHtml(bytes.toString('utf8')),
};
