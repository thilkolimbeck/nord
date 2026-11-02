/**
 * UI logic tests: the state machine in src/state.ts (file picks, convert, clear, the notes
 * toggle, the save name) and the view model the strip and the print-out are drawn from.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convert, NordFormatError, Ns3Program, TEMPLATE_BYTES } from '../src/engine/index.ts';
import { type FileLike, initialModel, MULTIPLE_FILES, READ_FAILED, saveFileName, Session, view } from '../src/state.ts';
import { SAMPLE, SAMPLE_SKIP, STAGE4 } from './sample.ts';

// The sample's bytes are loaded under a neutral file name: the name only sets the program name.
const NAME = 'My Program';

function fileOf(name: string, data: Uint8Array): FileLike {
  return { name, arrayBuffer: async () => Uint8Array.from(data).buffer };
}

/** A file whose read waits until `release` is called. */
function slowFile(name: string, data: Uint8Array): { file: FileLike; release: () => void } {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { file: { name, arrayBuffer: async () => { await gate; return Uint8Array.from(data).buffer; } }, release };
}

function failingFile(name: string): FileLike {
  return { name, arrayBuffer: () => Promise.reject(new Error('NotReadableError')) };
}

test('idle view', () => {
  const v = view(initialModel);
  assert.equal(v.kind, 'idle');
  assert.equal(v.name, '');
  assert.equal(v.versionLine, 'ns3f → ns4p 3.13');
  assert.equal(v.stateLine, 'insert program');
  assert.deepEqual(v.meters, { warn: 0, notes: 0, error: 0 });
  assert.deepEqual(v.counts, { warn: '0', notes: '0', error: '0' });
  assert.deepEqual(v.keys, {
    convert: { disabled: true, lit: false },
    save: { disabled: true, lit: false },
    clear: { disabled: true },
    notes: { disabled: true, lit: false },
  });
  assert.deepEqual(v.printout, {
    warnings: '0 warnings', notes: '0 notes on switched-off parts', notesDisabled: true, lines: ['nothing printed yet'],
  });
  assert.equal(saveFileName(initialModel.state), null);
});

test('one valid file is ready to convert', { skip: SAMPLE_SKIP }, async () => {
  const session = new Session();
  assert.equal(await session.load([fileOf(`${NAME}.ns3f`, SAMPLE)]), true);
  const { state } = session.model;
  assert.equal(state.kind, 'ready');
  const v = view(session.model);
  assert.equal(v.name, NAME);
  const version = (Ns3Program.fromBytes(SAMPLE).formatVersion / 100).toFixed(2);
  assert.equal(v.versionLine, `ns3f ${version} → ns4p 3.13`);
  assert.equal(v.stateLine, 'ready · press convert');
  assert.deepEqual(v.keys.convert, { disabled: false, lit: true });
  assert.deepEqual(v.keys.save, { disabled: true, lit: false });
  assert.equal(v.keys.clear.disabled, false);
  assert.deepEqual(v.printout.lines, []);
});

test('converting the sample gives the engine output and its warnings and notes', { skip: SAMPLE_SKIP }, async () => {
  const session = new Session();
  await session.load([fileOf(`${NAME}.ns3f`, SAMPLE)]);
  session.convert();
  const { state } = session.model;
  assert.equal(state.kind, 'converted');
  if (state.kind !== 'converted') return;
  const reference = convert(SAMPLE, TEMPLATE_BYTES);
  assert.deepEqual(Array.from(state.output), Array.from(reference.output));
  assert.deepEqual(state.warnings, reference.warnings);
  assert.deepEqual(state.notes, reference.notes);
  assert.equal(state.warnings.length, 7);
  assert.equal(state.notes.length, 1);

  const v = view(session.model);
  assert.equal(v.stateLine, 'panel a+b → layers a+b · ok');
  assert.deepEqual(v.meters, { warn: 6, notes: 1, error: 0 }); // six segments at most
  assert.deepEqual(v.counts, { warn: '7', notes: '1', error: '0' });
  assert.deepEqual(v.keys.convert, { disabled: true, lit: false });
  assert.deepEqual(v.keys.save, { disabled: false, lit: true });
  assert.deepEqual(v.keys.notes, { disabled: false, lit: false });
  assert.equal(v.printout.warnings, '7 warnings');
  assert.equal(v.printout.notes, '1 note on switched-off parts');
  assert.deepEqual(v.printout.lines, reference.warnings);
  assert.equal(saveFileName(state), `${NAME}.ns4p`);

  // a second convert of the same program reuses the cached template and gives the same bytes
  await session.load([fileOf(`${NAME}.ns3f`, SAMPLE)]);
  session.convert();
  const again = session.model.state;
  assert.equal(again.kind, 'converted');
  if (again.kind === 'converted') assert.deepEqual(Array.from(again.output), Array.from(reference.output));
});

test('the notes toggle prints warnings and notes, and toggles back', { skip: SAMPLE_SKIP }, async () => {
  const session = new Session();
  await session.load([fileOf(`${NAME}.ns3f`, SAMPLE)]);
  session.toggleNotes(); // not converted yet: no effect
  assert.equal(session.model.showNotes, false);
  session.convert();
  const reference = convert(SAMPLE, TEMPLATE_BYTES);
  session.toggleNotes();
  let v = view(session.model);
  assert.equal(v.notesShown, true);
  assert.deepEqual(v.keys.notes, { disabled: false, lit: true });
  assert.deepEqual(v.printout.lines, [...reference.warnings, ...reference.notes]);
  session.toggleNotes();
  v = view(session.model);
  assert.equal(v.notesShown, false);
  assert.deepEqual(v.printout.lines, reference.warnings);
});

test('two files are refused with "one file at a time" and nothing is converted', { skip: SAMPLE_SKIP }, async () => {
  const session = new Session();
  await session.load([fileOf(`${NAME}.ns3f`, SAMPLE), fileOf('other.ns3f', SAMPLE)]);
  const { state } = session.model;
  assert.deepEqual(state, { kind: 'error', name: '', version: '', message: MULTIPLE_FILES });
  session.convert();
  assert.equal(session.model.state.kind, 'error');
  const v = view(session.model);
  assert.equal(v.stateLine, 'error · one file at a time');
  assert.deepEqual(v.printout.lines, ['one file at a time']);
  assert.deepEqual(v.meters, { warn: 0, notes: 0, error: 6 });
  assert.equal(v.counts.error, '1');
  assert.equal(v.keys.convert.disabled, true);
  assert.equal(saveFileName(session.model.state), null);
});

test('an invalid file (an .ns4p) is an error with the engine message verbatim in the print-out', { skip: SAMPLE_SKIP }, async () => {
  let expected = '';
  try {
    Ns3Program.fromBytes(STAGE4);
  } catch (exc) {
    assert.ok(exc instanceof NordFormatError);
    expected = exc.message;
  }
  assert.ok(expected.length > 0);
  const session = new Session();
  await session.load([fileOf(`${NAME}.ns4p`, STAGE4)]);
  assert.deepEqual(session.model.state, { kind: 'error', name: NAME, version: '', message: expected });
  const v = view(session.model);
  assert.equal(v.stateLine, `error · ${expected}`);
  assert.deepEqual(v.printout.lines, [expected]);
  assert.equal(v.keys.clear.disabled, false);
});

test('a file that cannot be read is an error, not an unhandled rejection', async () => {
  const session = new Session();
  assert.equal(await session.load([failingFile('Gone.ns3f')]), true);
  assert.deepEqual(session.model.state, { kind: 'error', name: 'Gone', version: '', message: READ_FAILED });
  const v = view(session.model);
  assert.equal(v.stateLine, 'error · could not read the file');
  assert.deepEqual(v.printout.lines, ['could not read the file']);
});

test('a load that finishes after a clear is ignored', { skip: SAMPLE_SKIP }, async () => {
  const session = new Session();
  const slow = slowFile(`${NAME}.ns3f`, SAMPLE);
  const pending = session.load([slow.file]);
  session.clear();
  slow.release();
  assert.equal(await pending, false);
  assert.equal(session.model, initialModel);
});

test('a load that finishes after a newer pick is ignored', { skip: SAMPLE_SKIP }, async () => {
  const session = new Session();
  const slow = slowFile(`${NAME}.ns3f`, SAMPLE);
  const first = session.load([slow.file]);
  assert.equal(await session.load([fileOf(`${NAME}.ns4p`, STAGE4)]), true);
  slow.release();
  assert.equal(await first, false);
  assert.equal(session.model.state.kind, 'error');
});

test('clear returns to idle and resets the notes toggle', { skip: SAMPLE_SKIP }, async () => {
  const session = new Session();
  await session.load([fileOf(`${NAME}.ns3f`, SAMPLE)]);
  session.convert();
  session.toggleNotes();
  session.clear();
  assert.equal(session.model, initialModel);
  assert.equal(view(session.model).stateLine, 'insert program');
});

test('an empty file list changes nothing', async () => {
  const session = new Session();
  assert.equal(await session.load([]), false);
  assert.equal(session.model, initialModel);
});
