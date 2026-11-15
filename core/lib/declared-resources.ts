/*
 * Owns: declared-resource membership, stable identities, artifact-relative URLs and deferred text projection.
 * Excludes: URL authority, filesystem reads, mixed-graph budgets, digests and publication.
 */
import type { AssetFile } from './model.ts';
import type { CssInspector } from './resource-carriers.ts';
import { readAssetText } from './asset-data.ts';
import { assetReference, assetOutputUrl } from './asset-reference.ts';
import type { AssetReference } from './asset-reference.ts';
import { DivletError } from './validation.ts';
import { rewriteCss } from './resource-carriers.ts';
import { rewriteSvgResource } from './svg-resource.ts';

export interface DeclaredResourceAllocation {
  assertOpen(): void;
  claim(bytes: number): void;
  reserve(output: string): void;
}
export interface DeclaredResourceOutput {
  source(source: string, output: string, file: AssetFile): void;
  text(output: string, text: string): void;
}
export interface DeclaredResourceHost {
  allocation: DeclaredResourceAllocation;
  output: DeclaredResourceOutput;
  defer(task: () => Promise<void>): void;
  rewrite(url: string, source: string, output: string, kind: 'css' | 'svg'): Promise<string>;
  inspectCss?: CssInspector;
}

/** Admitted files and trusted synchronous planning ports; discard the entire plan after any failure. */
export class DeclaredResourceGraph {
  private readonly registered = new Set<string>();
  private readonly files: ReadonlyMap<string, AssetFile>;
  private readonly host: DeclaredResourceHost;
  constructor(files: ReadonlyMap<string, AssetFile>, host: DeclaredResourceHost) {
    this.files = files;
    this.host = host;
  }
  get size(): number { return this.registered.size; }
  async url(reference: AssetReference, output: unknown): Promise<string> {
    await this.add(reference.path);
    return assetOutputUrl(reference, output);
  }
  async add(key: string): Promise<void> {
    if (this.registered.has(key)) return;
    const { allocation, output } = this.host;
    allocation.assertOpen();
    const file = this.files.get(key);
    if (!file) throw new DivletError('INVALID_ASSET', `Missing declared asset: ${key}`);
    allocation.claim(file.bytes.byteLength);
    const target = `assets/${key}`, content = readAssetText(file);
    allocation.reserve(target);
    this.registered.add(key);
    const source = assetReference(key);
    output.source(source, target, file);
    if (content) this.host.defer(async () => {
      const rewrite = (url: string) => this.host.rewrite(url, source, target, content.kind);
      const rewritten = content.kind === 'css'
        ? await rewriteCss(content.text, rewrite, false, true, this.host.inspectCss)
        : await rewriteSvgResource(content.text, { url: rewrite, css: (text, inline) => rewriteCss(text, rewrite, inline, true, this.host.inspectCss) });
      if (content.ascii && /[^\x00-\x7f]/.test(rewritten)) throw new DivletError('INVALID_ASSET', 'Rewriting this asset would violate its US-ASCII encoding.');
      output.text(target, rewritten);
    });
  }
}
