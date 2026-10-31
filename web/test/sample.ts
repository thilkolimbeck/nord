/**
 * The private sample program pair, for the tests that use it. It is gitignored (presets/ and its
 * copy in test/fixtures/presets/), so a public checkout has neither file: those tests then skip
 * with SAMPLE_SKIP as the reason instead of failing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

/** The first file (sorted by name) with this extension in a folder, or null. */
function firstFile(folder: URL, extension: string): URL | null {
  if (!existsSync(folder)) return null;
  const name = readdirSync(folder).filter((p) => p.toLowerCase().endsWith(extension)).sort()[0];
  return name === undefined ? null : new URL(encodeURIComponent(name), folder);
}

const ns3 = firstFile(new URL('./fixtures/presets/', import.meta.url), '.ns3f');
const ns4 = firstFile(new URL('../../presets/stage4/', import.meta.url), '.ns4p');

/** node:test's skip option: false when the pair is present, else the reason shown for each skipped test. */
export const SAMPLE_SKIP: false | string = ns3 && ns4 ? false
  : 'needs the private sample program pair (presets/, copied by tools/make_golden.py; gitignored, not in the public repository)';

/** The Stage 3 sample, or empty bytes when it is absent (the tests that read it skip then). */
export const SAMPLE: Uint8Array = ns3 ? readFileSync(ns3) : new Uint8Array(0);
/** The Stage 4 sample, or empty bytes when it is absent. */
export const STAGE4: Uint8Array = ns4 ? readFileSync(ns4) : new Uint8Array(0);
