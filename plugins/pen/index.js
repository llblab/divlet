/*
 * The PEN importer plugin: Pencil `.pen` files (and `.divlet` files of the retired PEN-extension format) are converted into
 * Divlet projects. All PEN knowledge — the reader, its native projection, the converter — lives in this directory; the core
 * only sees this descriptor (see ../index.js for the importer contract).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { convertPen, summarizePen } from './lib/convert.js';

const FOREIGN_VERSION = /"version"\s*:\s*"/;

export default {
  id: 'pen',
  label: 'Pencil (.pen)',
  extensions: ['.pen'],

  /** A `.pen` file, or a `.divlet` that still holds a PEN source rather than a Divlet project. */
  async claims(file, read) {
    if (path.extname(file).toLowerCase() === '.pen') return true;
    if (path.extname(file).toLowerCase() !== '.divlet') return false;
    try {
      const input = JSON.parse((await read(file)).toString('utf8'));
      return typeof input?.version === 'string' && !Object.hasOwn(input, 'schemaVersion') && FOREIGN_VERSION.test(JSON.stringify(input).slice(0, 200));
    } catch { return false; }
  },

  /** A foreign source squatting on a `.divlet` name is moved to a free `<name>.pen` (never overwriting) so the project can take the name. */
  async detach(file) {
    if (path.extname(file).toLowerCase() === '.pen') return file;
    const base = path.join(path.dirname(file), path.basename(file, path.extname(file)));
    for (let n = 1; ; n++) {
      const target = `${base}${n === 1 ? '' : `-${n}`}.pen`;
      try { await fs.link(file, target); } catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      await fs.unlink(file);
      return target;
    }
  },

  convert(bytes, { name, provenance }) {
    const input = JSON.parse(bytes.toString('utf8'));
    // An authored project name (`divlet.name`) wins over the file name.
    const authored = typeof input?.divlet?.name === 'string' && input.divlet.name.trim() ? input.divlet.name.trim().slice(0, 80) : null;
    return convertPen(input, { name: authored ?? name, provenance });
  },
  summarize(bytes) { return summarizePen(JSON.parse(bytes.toString('utf8'))); },
};
