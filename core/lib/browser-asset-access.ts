// Domain: Browser asset-byte capability. Owns: the unchanged unsupported-host refusal, not validation or resource activation.
export function requireAssetBytes(): never {
  throw Object.assign(new Error('Embedded assets need the local divlet host: this browser build does not decode project asset bytes.'), { code: 'ASSETS_UNAVAILABLE' });
}
