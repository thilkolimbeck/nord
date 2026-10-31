/**
 * Byte-for-byte parity with the Python reference: every fixture's output, warnings and notes
 * (or error) must equal what tools/make_golden.py recorded from nordconv. The private sample's
 * fixtures (test/fixtures/presets/, gitignored) are checked against golden-local.json when present.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TEMPLATE_BYTES } from '../src/engine/index.ts';
import { compare, firstDifference, FIXTURES, golden, goldenLocal, LOCAL_FIXTURE_DIR } from './golden.ts';

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

test('the bundled template is templates/regressionTest.ns4p', () => {
  const file = readFileSync(new URL('../../templates/regressionTest.ns4p', import.meta.url));
  assert.equal(firstDifference(TEMPLATE_BYTES, file), -1);
});

test('the golden manifest covers exactly the public fixtures on disk, unchanged', () => {
  const onDisk = readdirSync(FIXTURES, { recursive: true })
    .map((p) => p.split('\\').join('/'))
    .filter((p) => p.toLowerCase().endsWith('.ns3f') && !p.startsWith(LOCAL_FIXTURE_DIR))
    .sort();
  assert.deepEqual(onDisk, Object.keys(golden.fixtures).sort());
  for (const path of onDisk) {
    assert.equal(sha256(readFileSync(new URL(encodePath(path), FIXTURES))), golden.fixtures[path]!.sha256,
      `${path} changed since the golden file was made; run npm run gen`);
  }
});

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// One test per fixture directory, so a failure points at a group without 585 lines of output.
const groups = new Map<string, string[]>();
for (const path of Object.keys(golden.fixtures)) {
  const group = path.slice(0, path.lastIndexOf('/'));
  groups.set(group, [...(groups.get(group) ?? []), path]);
}

let compared = 0;
for (const [group, paths] of groups) {
  test(`parity: ${group} (${paths.length} fixtures)`, (t) => {
    const failures: string[] = [];
    for (const path of paths) {
      const problem = compare(readFileSync(new URL(encodePath(path), FIXTURES)), golden.fixtures[path]!);
      if (problem) failures.push(`${path}: ${problem}`);
    }
    compared += paths.length;
    t.diagnostic(`${paths.length} compared, ${failures.length} failed`);
    assert.deepEqual(failures, []);
  });
}

const localPaths = Object.keys(goldenLocal?.fixtures ?? {});
const localMissing = localPaths.filter((path) => !existsSync(new URL(encodePath(path), FIXTURES)));
const localSkip = goldenLocal === null || localPaths.length === 0 || localMissing.length > 0
  ? 'needs the private sample program (test/golden/golden-local.json and test/fixtures/presets/, written by '
    + 'tools/make_golden.py when presets/ is present; gitignored, not in the public repository)'
  : false;

test('parity: private sample fixtures', { skip: localSkip }, (t) => {
  const manifest = goldenLocal;
  assert.ok(manifest !== null);
  const failures: string[] = [];
  for (const path of localPaths) {
    const input = readFileSync(new URL(encodePath(path), FIXTURES));
    const entry = manifest.fixtures[path]!;
    if (sha256(input) !== entry.sha256) failures.push(`${path} changed since the golden file was made; run npm run gen`);
    const problem = compare(input, entry, manifest);
    if (problem) failures.push(`${path}: ${problem}`);
  }
  t.diagnostic(`${localPaths.length} compared, ${failures.length} failed`);
  assert.deepEqual(failures, []);
});

test('parity: every fixture was compared', (t) => {
  t.diagnostic(`${compared} fixtures compared in total`);
  assert.equal(compared, Object.keys(golden.fixtures).length);
});
