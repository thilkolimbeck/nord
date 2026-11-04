/**
 * The Stage 4 program code in src/ns4/: the bundled donor, the neutral template, the strict
 * reader's messages for damaged files, the verify step every export passes, the message
 * formatting helpers, and the rule that the code runs in the browser (no Node, no DOM imports).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { writeBits } from '../src/ns4/bits.ts';
import { buildCbin, crc32, HEADER_BYTES } from '../src/ns4/cbin.ts';
import { ConversionError, loadTemplate, NordFormatError, Ns4Program, TEMPLATE_BYTES, verify } from '../src/ns4/index.ts';
import { NS4_LAYOUT } from '../src/ns4/layout.ts';
import { fixed, reprBytes, reprStr } from '../src/ns4/pyfmt.ts';
import { CATEGORY_NONE, SWITCHES_OFF, UNDECODED_VALUES } from '../src/ns4/template.ts';

test('the bundled donor is templates/regressionTest.ns4p, byte for byte', () => {
  const file = readFileSync(new URL('../../templates/regressionTest.ns4p', import.meta.url));
  assert.deepEqual(Array.from(TEMPLATE_BYTES), Array.from(file));
});

test('the neutral template: every field at its default, scene I off, bank 0, location 0, category none', () => {
  const neutral = loadTemplate();
  const donor = Ns4Program.fromBytes(TEMPLATE_BYTES);
  assert.deepEqual({ ...neutral.header }, { ...donor.header, bank: 0, location: 0, category: CATEGORY_NONE });
  assert.ok(SWITCHES_OFF.length >= 4, SWITCHES_OFF.join(' '));
  for (const [key, f] of NS4_LAYOUT.fields) {
    assert.equal(neutral.value(key), SWITCHES_OFF.includes(key) ? 0 : f.default, key);
  }
  // Undecoded bits stay the donor's, except the constants Nord Sound Manager writes.
  const expected = donor.body;
  const blocks = new Map(NS4_LAYOUT.blocks.map((b) => [b.key, b]));
  for (const [block, bit, width, value] of UNDECODED_VALUES) {
    writeBits(expected, (blocks.get(block)!.offset + 1) * 8 + bit, width, value);
  }
  const back = Ns4Program.fromBytes(neutral.toBytes()).body;
  for (const f of NS4_LAYOUT.fields.values()) {
    writeBits(back, f.bodyBit, f.width, 0);
    writeBits(expected, f.bodyBit, f.width, 0);
  }
  assert.deepEqual(Array.from(back), Array.from(expected));
});

test('the reader refuses damaged files with a message that says why', () => {
  const src = Ns4Program.fromBytes(TEMPLATE_BYTES);
  const refuses = (data: Uint8Array, message: string | RegExp): void => {
    assert.throws(() => Ns4Program.fromBytes(data), (exc: unknown) =>
      exc instanceof NordFormatError
      && (typeof message === 'string' ? exc.message === message : message.test(exc.message)));
  };
  refuses(TEMPLATE_BYTES.subarray(0, 10), 'file is 10 bytes, too short for a CBIN header');
  refuses(TEMPLATE_BYTES.subarray(0, 30), 'file is 30 bytes, too short for the 44-byte NSM-era header');
  const magic = Uint8Array.from(TEMPLATE_BYTES);
  magic[0] = 0x58;
  refuses(magic, "bad magic b'XBIN', expected b'CBIN'");
  const tag = Uint8Array.from(TEMPLATE_BYTES);
  tag.set([0x6e, 0x73, 0x33, 0x66], 8);
  refuses(tag, "file type tag is 'ns3f', expected 'ns4p'");
  const crc = Uint8Array.from(TEMPLATE_BYTES);
  crc[crc.length - 1] = crc[crc.length - 1]! ^ 0x01;
  refuses(crc, /^CRC-32 mismatch: stored 0x[0-9a-f]{8}, computed 0x[0-9a-f]{8}$/);
  const formatType = Uint8Array.from(TEMPLATE_BYTES);
  formatType[4] = 2;
  refuses(formatType, 'unsupported CBIN formatType 2 (Nord Sound Manager reads 0 and 1)');
  refuses(buildCbin({ ...src.header, formatType: 0 }, src.body), 'Stage 4 programs use CBIN formatType 1, got 0');
  refuses(buildCbin(src.header, src.body.subarray(0, 800)), 'Nord Stage 4 body is 800 bytes, expected 824');
  const newer = src.body;
  new DataView(newer.buffer).setUint32(0, 314, false);
  refuses(buildCbin({ ...src.header, version: 314 }, newer),
    'format version 3.14 is outside the 3.07-3.13 range of the Nord Stage 4 layout');
  const chain = src.body;
  chain[4] = chain[4]! - 1;
  refuses(buildCbin(src.header, chain), /^block chain \[\(4, 43\), \(48, 0\), .* does not match the Nord Stage 4 layout \[\(4, 44\), \(49, 17\), /);
});

/** A file with a fresh CRC-32 over its body. */
function reseal(data: Uint8Array): Uint8Array {
  const out = Uint8Array.from(data);
  new DataView(out.buffer).setUint32(0x18, crc32(out.subarray(HEADER_BYTES)), true);
  return out;
}

test('verify accepts a patched file and refuses a tampered one', () => {
  const template = loadTemplate();
  const edits = new Map<string, number>([['synthASound.fltFreq', 74], ['synth.layerEnableSyn_I', 0b011],
    ['synthBSound.oscTuneCoarse', -12], ['common.sectionEnableSyn_I', 1]]);
  const category = 5;
  const out = new Ns4Program({ ...template.header, category }, template.body);
  for (const [key, value] of edits) out.set(key, value);
  const data = out.toBytes();
  verify(data, template, edits, category);
  const refuses = (bytes: Uint8Array, message: string | RegExp, cat = category): void => {
    assert.throws(() => verify(bytes, template, edits, cat), (exc: unknown) =>
      exc instanceof ConversionError
      && (typeof message === 'string' ? exc.message === message : message.test(exc.message)));
  };
  refuses(data.subarray(0, 100), 'output is 100 bytes, expected 868');
  const stale = Uint8Array.from(data);
  stale[HEADER_BYTES + 100] = stale[HEADER_BYTES + 100]! ^ 0xff;
  refuses(stale, /^output does not parse: CRC-32 mismatch: stored 0x[0-9a-f]{8}, computed 0x[0-9a-f]{8}$/);
  // The last body byte holds no known field: flipping it is an undecoded-bit change.
  const lastBody = Uint8Array.from(data);
  lastBody[lastBody.length - 1] = lastBody[lastBody.length - 1]! ^ 0x01;
  refuses(reseal(lastBody), 'undecoded template bits changed');
  const missed = new Ns4Program({ ...template.header, category }, template.body);
  missed.set('synthASound.fltFreq', 74);
  refuses(missed.toBytes(), /^[\w.]+ reads back -?\d+, expected -?\d+$/);
  refuses(data, `output header CbinHeader(format_type=1, tag='ns4p', bank=0, location=0, category=${category}, `
    + `version=313) differs from bank 0, location 0, category 3`, 3);
});

test('message formatting helpers', () => {
  const xs = [0.25, 0.35, 2.675, 3.25, -0.25, -3.25, 0.125, 1.5, 2.5, 7.5, 0.05, 1e-7, 123456.785, 0.375];
  // Python: [f'{x:.1f}' for x in xs] and [f'{x:.2f}' for x in xs]
  assert.deepEqual(xs.map((x) => fixed(x, 1)),
    ['0.2', '0.3', '2.7', '3.2', '-0.2', '-3.2', '0.1', '1.5', '2.5', '7.5', '0.1', '0.0', '123456.8', '0.4']);
  assert.deepEqual(xs.map((x) => fixed(x, 2)),
    ['0.25', '0.35', '2.67', '3.25', '-0.25', '-3.25', '0.12', '1.50', '2.50', '7.50', '0.05', '0.00', '123456.79', '0.38']);
  assert.equal(reprStr("a'b"), `"a'b"`);
  assert.equal(reprStr('a"b\'c'), `'a"b\\'c'`);
  assert.equal(reprStr('\x00\x7f\xa0\xad\xe9'), "'\\x00\\x7f\\xa0\\xad\xe9'");
  assert.equal(reprBytes(Uint8Array.from([0x27, 0x22, 9, 10, 13, 0, 0x7f, 0x80, 0x5c, 65])),
    "b'\\'\"\\t\\n\\r\\x00\\x7f\\x80\\\\A'");
  assert.equal(reprBytes(Uint8Array.from([0x27, 65])), `b"'A"`);
});

test('src/ns4 imports nothing but its own modules (it runs in the browser)', () => {
  const dir = new URL('../src/ns4/', import.meta.url);
  const files = readdirSync(dir, { recursive: true }).filter((p) => p.endsWith('.ts'));
  assert.ok(files.length > 8);
  for (const file of files) {
    const text = readFileSync(new URL(file.split('\\').join('/'), dir), 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      assert.ok(match[1]!.startsWith('./'), `${file} imports ${match[1]}`);
    }
    const code = text.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/\b(?:process|Buffer|require|__dirname)\b/.test(code), `${file} uses a Node global`);
    assert.ok(!/\b(?:document|window|navigator|localStorage|AudioContext|fetch)\b/.test(code), `${file} uses a browser API`);
  }
});
