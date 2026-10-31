/**
 * Engine unit tests: damaged inputs must throw NordFormatError with the Python message (the
 * inputs and messages come from tools/make_golden.py), the post-write verification must catch
 * a tampered output, and the Python formatting helpers must match Python.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HEADER_BYTES, crc32 } from '../src/engine/cbin.ts';
import { convertBytes } from '../src/engine/convert.ts';
import { ConversionError, convert, loadTemplate, NordFormatError, TEMPLATE_BYTES, verify } from '../src/engine/index.ts';
import { fixed, pyRound, reprBytes, reprStr, signed } from '../src/engine/pyfmt.ts';
import { compare, fromBase64, golden } from './golden.ts';
import { SAMPLE, SAMPLE_SKIP } from './sample.ts';

const REQUIRED = ['bad magic', 'wrong tag (a Stage 4 program)', 'bad CRC-32', 'truncated inside the CBIN header',
  'truncated inside the NSM-era header', 'truncated body (stale CRC)', 'truncated body (resealed)'];

test('the golden cases include the required damaged inputs, all refused with NordFileError', () => {
  for (const name of REQUIRED) assert.equal(golden.cases[name]?.error?.type, 'NordFileError', name);
});

for (const [name, entry] of Object.entries(golden.cases)) {
  test(`case: ${name}`, () => {
    const input = fromBase64(entry.input!);
    assert.equal(compare(input, entry), null);
    if (entry.error) {
      assert.throws(() => convert(input, TEMPLATE_BYTES), (exc: unknown) =>
        exc instanceof NordFormatError && exc.name === 'NordFormatError' && exc.message === entry.error!.message);
    }
  });
}

test('convert attaches the file name to a thrown error, never to the message', { skip: SAMPLE_SKIP }, () => {
  const bad = Uint8Array.from(SAMPLE);
  bad[0] = 0x58;
  assert.throws(() => convert(bad, TEMPLATE_BYTES, 'My Program.ns3f'), (exc: unknown) =>
    exc instanceof NordFormatError && exc.fileName === 'My Program.ns3f'
    && exc.message === "bad magic b'XBIN', expected b'CBIN'");
});

test('an unusable template is a ConversionError, not a NordFormatError', { skip: SAMPLE_SKIP }, () => {
  assert.throws(() => convert(SAMPLE, SAMPLE), (exc: unknown) =>
    exc instanceof ConversionError && exc.message === "template unusable: file type tag is 'ns3f', expected 'ns4p'");
});

test('convert is deterministic and leaves its inputs untouched', { skip: SAMPLE_SKIP }, () => {
  const input = Uint8Array.from(SAMPLE);
  const template = Uint8Array.from(TEMPLATE_BYTES);
  const first = convert(input, template);
  const second = convert(input, template);
  assert.deepEqual(Array.from(first.output), Array.from(second.output));
  assert.deepEqual(Array.from(input), Array.from(SAMPLE));
  assert.deepEqual(Array.from(template), Array.from(TEMPLATE_BYTES));
});

function reseal(data: Uint8Array): Uint8Array {
  const out = Uint8Array.from(data);
  new DataView(out.buffer).setUint32(0x18, crc32(out.subarray(HEADER_BYTES)), true);
  return out;
}

test('verify refuses a tampered output', { skip: SAMPLE_SKIP }, () => {
  const template = loadTemplate();
  const converted = convertBytes(SAMPLE, template);
  const category = new DataView(converted.data.buffer).getUint32(0x10, true);
  verify(converted.data, template, converted.edits, category);
  const refuses = (data: Uint8Array, message: string | RegExp): void => {
    assert.throws(() => verify(data, template, converted.edits, category), (exc: unknown) =>
      exc instanceof ConversionError
      && (typeof message === 'string' ? exc.message === message : message.test(exc.message)));
  };
  refuses(converted.data.subarray(0, 100), 'output is 100 bytes, expected 868');
  const stale = Uint8Array.from(converted.data);
  stale[HEADER_BYTES + 100] = stale[HEADER_BYTES + 100]! ^ 0xff;
  refuses(stale, /^output does not parse: CRC-32 mismatch: stored 0x[0-9a-f]{8}, computed 0x[0-9a-f]{8}$/);
  // The last body byte holds no known field in this layout: flipping it is an undecoded-bit change.
  const lastBody = Uint8Array.from(converted.data);
  lastBody[lastBody.length - 1] = lastBody[lastBody.length - 1]! ^ 0x01;
  const tamperedBits = reseal(lastBody);
  try {
    verify(tamperedBits, template, converted.edits, category);
    assert.fail('verify accepted a changed byte');
  } catch (exc) {
    assert.ok(exc instanceof ConversionError);
    assert.ok(exc.message === 'undecoded template bits changed' || / reads back /.test(exc.message), exc.message);
  }
  assert.throws(() => verify(converted.data, template, converted.edits, 3), (exc: unknown) =>
    exc instanceof ConversionError && exc.message === `output header CbinHeader(format_type=1, tag='ns4p', bank=0, `
      + `location=0, category=${category}, version=313) differs from bank 0, location 0, category 3`);
});

test('Python formatting helpers match Python', () => {
  const xs = [0.25, 0.35, 2.675, 3.25, -0.25, -3.25, 0.125, 1.5, 2.5, 7.5, 0.05, 1e-7, 123456.785, 0.375];
  // Python: [f'{x:.1f}' for x in xs] and [f'{x:.2f}' for x in xs]
  assert.deepEqual(xs.map((x) => fixed(x, 1)),
    ['0.2', '0.3', '2.7', '3.2', '-0.2', '-3.2', '0.1', '1.5', '2.5', '7.5', '0.1', '0.0', '123456.8', '0.4']);
  assert.deepEqual(xs.map((x) => fixed(x, 2)),
    ['0.25', '0.35', '2.67', '3.25', '-0.25', '-3.25', '0.12', '1.50', '2.50', '7.50', '0.05', '0.00', '123456.79', '0.38']);
  // Python: [round(x) for x in ...] (banker's rounding)
  assert.deepEqual([0.5, 1.5, 2.5, -1.5, 63.5, 64.5, 2.4999999999999996, -2.5000000000000004].map(pyRound),
    [0, 2, 2, -2, 64, 64, 2, -3]);
  assert.equal(String(pyRound(-0.5)), '0');
  assert.equal(reprStr("a'b"), `"a'b"`);
  assert.equal(reprStr('a"b\'c'), `'a"b\\'c'`);
  assert.equal(reprStr('\x00\x7f\xa0\xad\xe9'), "'\\x00\\x7f\\xa0\\xad\xe9'");
  assert.equal(reprBytes(Uint8Array.from([0x27, 0x22, 9, 10, 13, 0, 0x7f, 0x80, 0x5c, 65])),
    "b'\\'\"\\t\\n\\r\\x00\\x7f\\x80\\\\A'");
  assert.equal(reprBytes(Uint8Array.from([0x27, 65])), `b"'A"`);
  assert.deepEqual([signed(0), signed(3), signed(-2)], ['+0', '+3', '-2']);
});

test('engine code imports nothing but its own modules (it runs in the browser)', () => {
  const dir = new URL('../src/engine/', import.meta.url);
  const files = readdirSync(dir, { recursive: true }).filter((p) => p.endsWith('.ts'));
  assert.ok(files.length > 10);
  for (const file of files) {
    const text = readFileSync(new URL(file.split('\\').join('/'), dir), 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      assert.ok(match[1]!.startsWith('./') || match[1]!.startsWith('../'), `${file} imports ${match[1]}`);
    }
    assert.ok(!/\b(?:process|Buffer|require|__dirname)\b/.test(text.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')),
      `${file} uses a Node global`);
  }
});
