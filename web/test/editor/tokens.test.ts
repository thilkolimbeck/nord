/** The editor stylesheet's fonts and tokens (docs/web-design.md): all self-hosted, nothing from other origins. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const editor = readFileSync(new URL('../../src/editor/editor.css', import.meta.url), 'utf8');

function between(css: string, start: string, end: string): string {
  const from = css.indexOf(start);
  const to = css.indexOf(end, from);
  assert.ok(from !== -1 && to !== -1, `${start} … ${end} not found`);
  return css.slice(from, to);
}

test('the token block holds the accent and follows the colour scheme', () => {
  const tokens = between(editor, '/* Tokens */', '/* Base */');
  assert.ok(/--accent: #ff6a1a;/.test(tokens), 'token block');
  assert.ok(/prefers-color-scheme: dark/.test(tokens), 'token block');
});

test('the eight font faces load files that exist in public/fonts', () => {
  const fonts = between(editor, '/* Fonts:', '/* Tokens */');
  assert.equal((fonts.match(/@font-face/g) ?? []).length, 8);
  for (const m of fonts.matchAll(/url\(\s*['"]?\/fonts\/([^'")]+)/g)) {
    assert.ok(existsSync(new URL(`../../public/fonts/${m[1]!}`, import.meta.url)), m[1]!);
  }
});

test('the editor stylesheet loads nothing from other origins', () => {
  for (const m of editor.matchAll(/url\(\s*['"]?([^'")]+)/g)) assert.ok(/^\/fonts\//.test(m[1]!), String(m[1]!));
  assert.ok(!/@import/.test(editor));
});

test('both themes define the same colour tokens, and no other rule hard-codes a colour', () => {
  const tokens = between(editor, '/* Tokens', '/* Base */');
  const darkAt = tokens.indexOf('@media (prefers-color-scheme: dark)');
  const names = (css: string): string[] =>
    [...css.matchAll(/(--[a-z0-9-]+):\s*#[0-9a-f]{3,8}\b/gi)].map((m) => m[1]!).sort();
  assert.deepEqual(names(tokens.slice(darkAt)), names(tokens.slice(0, darkAt)));
  const rest = editor.slice(editor.indexOf('/* Base */'));
  const parts = ['keyboard.css', 'status-bar.css'].map((f) =>
    readFileSync(new URL(`../../src/editor/ui/${f}`, import.meta.url), 'utf8'));
  for (const css of [rest, ...parts]) {
    assert.deepEqual(css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi) ?? [], [], 'colour outside the token block');
  }
});
