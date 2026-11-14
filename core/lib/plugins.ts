/* Owns: the legacy public plugin facade and bundled importer composition. Provider-free policy lives in plugin-registry.ts. */
import pen from '../../plugins/pen/index.js';
import { seedImporters } from './plugin-registry.ts';
import type { Importer } from './plugin-registry.ts';

seedImporters([pen as unknown as Importer]);

export type {
  SourceBytes, ReadSource, ConversionStats, ConvertResult, PageResult, ImportSummary,
  Importer, Exporter, ExportedBytes, ExportFile,
} from './plugin-registry.ts';
export {
  registerExporter, exporterList, exportAs, registerImporter, importerList, pageExtensions,
  importExtensions, importerFor,
} from './plugin-registry.ts';
