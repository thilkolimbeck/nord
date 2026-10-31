/**
 * Python formatting and rounding, so that messages and computed values match
 * the Python reference exactly.
 */

const hex2 = (c: number): string => c.toString(16).padStart(2, '0');

/** Latin-1 code points Python's str.isprintable() rejects above ASCII: C1 controls, NBSP and soft hyphen. */
function latin1Printable(c: number): boolean {
  return c > 0xa0 && c !== 0xad;
}

function quoteFor(text: string): string {
  return text.includes("'") && !text.includes('"') ? '"' : "'";
}

/** Python repr() of a str (as produced by the latin-1 decoder, so code points stay below 0x100). */
export function reprStr(s: string): string {
  const quote = quoteFor(s);
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === quote || ch === '\\') out += `\\${ch}`;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 || c === 0x7f) out += `\\x${hex2(c)}`;
    else if (c < 0x7f || c > 0xff || latin1Printable(c)) out += ch;
    else out += `\\x${hex2(c)}`;
  }
  return out + quote;
}

/** Python repr() of a bytes object. */
export function reprBytes(bytes: Uint8Array): string {
  const text = String.fromCharCode(...bytes);
  const quote = quoteFor(text);
  let out = `b${quote}`;
  for (const c of bytes) {
    const ch = String.fromCharCode(c);
    if (ch === quote || ch === '\\') out += `\\${ch}`;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 || c >= 0x7f) out += `\\x${hex2(c)}`;
    else out += ch;
  }
  return out + quote;
}

/** Python f'{n:+d}'. */
export function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

/** Python f'{n:0{width}x}' (lowercase) for a non-negative integer. */
export function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

/** Python f'{n:0{width}X}' (uppercase) for a non-negative integer. */
export function hexUpper(n: number, width: number): string {
  return hex(n, width).toUpperCase();
}

/**
 * Python f'{x:.{digits}f}'. Both Python and Number#toFixed round the exact binary value; they
 * differ only on an exact tie such as 0.25 (Python: half to even, giving 0.2; toFixed: half away
 * from zero, giving 0.3), so a tie is detected on the exact decimal expansion and settled here.
 */
export function fixed(x: number, digits: number): string {
  const rounded = x.toFixed(digits);
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return rounded;
  const exact = Math.abs(x).toFixed(100); // every double in this range has at most 100 decimals here
  const point = exact.indexOf('.');
  if (!/^50*$/.test(exact.slice(point + 1 + digits))) return rounded;
  const kept = exact.slice(0, digits ? point + 1 + digits : point);
  const last = Number(kept[kept.length - 1]);
  return last % 2 === 0 ? (x < 0 ? '-' : '') + kept : rounded;
}

/** Python round(x) for a float: the nearest integer, ties to even (JS Math.round rounds ties up). */
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python repr() of a list of int tuples, e.g. "[(4, 17), (22, 14)]". */
export function reprPairs(pairs: ReadonlyArray<readonly number[]>): string {
  return `[${pairs.map((p) => `(${p.join(', ')})`).join(', ')}]`;
}
