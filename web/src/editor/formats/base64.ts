/**
 * Base64 for the app preset's embedded source program (plan section 5.1): an encoder, and a
 * strict decoder that refuses anything but canonical standard-alphabet base64 with padding. The
 * decoding itself is the engine's dependency-free decoder (web/src/ns4/base64.ts), used read only.
 */
import { decodeBase64 } from '../../ns4/base64.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CANONICAL = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Standard base64 with padding. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63]! : '=';
    out += i + 2 < bytes.length ? ALPHABET[n & 63]! : '=';
  }
  return out;
}

/** Decode canonical base64; Error('not base64') for anything else (wrong length, characters or padding). */
export function decodeBase64Strict(text: string): Uint8Array {
  if (!CANONICAL.test(text)) throw new Error('not base64');
  return decodeBase64(text);
}
