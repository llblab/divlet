// Prior native payload decoder, retained independently of the portable implementation and shared only by Node test drivers.
import { Buffer } from 'node:buffer';
import { DivletError } from '../../lib/validation.ts';

export const nativeAssetBase64 = { decodeAssetBase64(input: string, maxBytes = 6, where = 'file') {
  const fail = (message: string): never => { throw new DivletError('INVALID_ASSET', message); };
  const padding = input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0, size = input.length / 4 * 3 - padding;
  if (size > maxBytes) fail(`${where} exceeds the ${maxBytes} decoded-byte limit.`);
  if (input.length % 4 || /[^A-Za-z0-9+/=]/.test(input) || input.slice(0, input.length - padding).includes('=')) fail(`${where} has invalid base64 data.`);
  const bytes = Buffer.from(input, 'base64');
  if (bytes.toString('base64') !== input) fail(`${where} has noncanonical base64 data.`);
  return bytes;
} };
