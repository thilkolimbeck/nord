/** The editor repeats the converter's fonts and tokens (web/src/styles.css stays untouched); they must not drift. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const converter = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../../src/editor/editor.css', import.meta.url), 'utf8');

function between(css: string, start: string, end: string): string {
  const from = css.indexOf(start);
  const to = css.indexOf(end, from);
  assert.ok(from !== -1 && to !== -1, `${start} … ${end} not found`);
  return css.slice(from, to);
}

test('the token block equals the converter\'s', () => {
  const tokens = between(converter, '/* Tokens */', '/* Base */');
  assert.ok(/--accent: #ff6a1a;/.test(tokens), "token block");
  assert.ok(/prefers-color-scheme: dark/.test(tokens), "token block");
  assert.equal(between(editor, '/* Tokens */', '/* Base */'), tokens);
});

test('the font faces equal the converter\'s', () => {
  const fonts = between(converter, '/* Fonts:', '/* Tokens */');
  assert.equal((fonts.match(/@font-face/g) ?? []).length, 8);
  assert.equal(between(editor, '/* Fonts:', '/* Tokens */'), fonts);
});

test('the editor stylesheet loads nothing from other origins', () => {
  for (const m of editor.matchAll(/url\(\s*['"]?([^'")]+)/g)) assert.ok(/^\/fonts\//.test(m[1]!), String(m[1]!));
  assert.ok(!/@import/.test(editor));
});
