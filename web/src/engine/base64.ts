/** A dependency-free base64 decoder (standard alphabet, padding optional). */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Map(Array.from(ALPHABET, (ch, i) => [ch, i]));

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let count = 0;
  let pos = 0;
  for (const ch of clean) {
    const v = LOOKUP.get(ch);
    if (v === undefined) throw new Error(`invalid base64 character ${JSON.stringify(ch)}`);
    bits = (bits << 6) | v;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[pos++] = (bits >> count) & 0xff;
    }
  }
  return out.subarray(0, pos);
}
