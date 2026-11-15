// Domain: Asset base64 payloads. Owns: strict canonical admission, a decoded-byte ceiling and fresh portable bytes. Excludes: MIME/Data URLs, trees, host adapters and resource activation.
import { DivletError } from './validation.ts';

export const ASSET_FILE_BYTES = 20 * 1024 * 1024;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const values = new Uint8Array(128);
for (let index = 0; index < alphabet.length; index++) values[alphabet.charCodeAt(index)] = index;
function fail(message: string): never { throw new DivletError('INVALID_ASSET', message); }

/** Validate fully before allocating the bounded output. Native hosts may wrap these privately owned bytes without copying. */
export function decodeAssetBase64(input: unknown, maxBytes = ASSET_FILE_BYTES, where = 'Asset'): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > ASSET_FILE_BYTES) fail(`Asset base64 limit must be an integer from 0 to ${ASSET_FILE_BYTES}.`);
  if (typeof input !== 'string') fail(`${where} has invalid base64 data.`);
  const padding = input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0;
  const size = input.length / 4 * 3 - padding;
  // Preserve native refusal precedence, including over-budget malformed payloads.
  if (size > maxBytes) fail(`${where} exceeds the ${maxBytes} decoded-byte limit.`);
  if (input.length % 4 || /[^A-Za-z0-9+/=]/.test(input) || input.slice(0, input.length - padding).includes('=')) fail(`${where} has invalid base64 data.`);
  if (padding && (values[input.charCodeAt(input.length - padding - 1)]! & (padding === 2 ? 15 : 3))) fail(`${where} has noncanonical base64 data.`);
  const bytes = new Uint8Array(size);
  let output = 0;
  for (let offset = 0; offset < input.length; offset += 4) {
    // '=' is zero in the private table; validated terminal padding only removes trailing output bytes.
    const bits = values[input.charCodeAt(offset)]! << 18 | values[input.charCodeAt(offset + 1)]! << 12 | values[input.charCodeAt(offset + 2)]! << 6 | values[input.charCodeAt(offset + 3)]!;
    bytes[output++] = bits >>> 16;
    if (output < size) bytes[output++] = bits >>> 8;
    if (output < size) bytes[output++] = bits;
  }
  return bytes;
}
