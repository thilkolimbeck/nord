/**
 * Module rules of the editor (plan section 1): nothing imports ui/ or main.ts; audio/ and midi/
 * never import ui/, formats/ or each other; model/ and formats/ use no DOM or Web Audio; the model
 * reads only its generated tables, two ns4 modules and the ns4 generated tables (piano names,
 * read only); outside src/editor/ only ns4/ is imported; no Node imports and no network APIs
 * anywhere; the page shell has no inline script or style (strict CSP).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const SRC = new URL('../../src/editor/', import.meta.url);
const FILES: ReadonlyArray<{ path: string; code: string; imports: string[] }> = readdirSync(SRC, { recursive: true })
  .map((p) => p.split('\\').join('/'))
  .filter((p) => p.endsWith('.ts'))
  .map((path) => {
    const text = readFileSync(new URL(path, SRC), 'utf8');
    const imports = [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    return { path, code: text.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ''), imports };
  });

/** The editor-relative path an import of `from` resolves to ('../ns4/x.ts' for the Stage 4 program code). */
function resolve(from: string, spec: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '..' && parts.length > 0 && parts.at(-1) !== '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function top(path: string): string {
  return path.includes('/') ? path.slice(0, path.indexOf('/')) : path;
}

test('the editor sources are found', () => {
  assert.ok(FILES.some((f) => f.path === 'main.ts'));
  assert.ok(FILES.filter((f) => f.path.startsWith('model/')).length >= 6);
});

test('imports are relative and never Node built-ins', () => {
  for (const f of FILES) {
    for (const spec of f.imports) {
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${f.path} imports ${spec}`);
    }
    assert.ok(!/\b(?:process|Buffer|require|__dirname)\b/.test(f.code), `${f.path} uses a Node global`);
  }
});

test('dependency rules between editor modules', () => {
  for (const f of FILES) {
    const from = top(f.path);
    for (const spec of f.imports) {
      const target = resolve(f.path, spec);
      const to = top(target);
      assert.ok(to !== 'ui' || from === 'ui' || f.path === 'main.ts', `${f.path} imports ${target}`);
      assert.notEqual(target, 'main.ts', `${f.path} imports main.ts`);
      assert.ok(!target.startsWith('../') || target.startsWith('../ns4/'), `${f.path} imports ${target}`);
      if (from === 'audio' || from === 'midi') {
        assert.ok(!['ui', 'formats', from === 'audio' ? 'midi' : 'audio'].includes(to), `${f.path} imports ${target}`);
      }
      if (from === 'model') {
        assert.ok(['model', 'generated'].includes(to)
          || ['../ns4/layout.ts', '../ns4/template.ts', '../ns4/generated/tables-ns4.ts'].includes(target),
          `${f.path} imports ${target}`);
      }
      if (from === 'generated') assert.fail(`${f.path} imports ${target}`);
    }
  }
});

test('model and formats use no DOM or Web Audio', () => {
  const browser = /\b(?:document|window|navigator|HTMLElement|Element|Node|localStorage|sessionStorage|AudioContext|AudioNode|AudioParam|OscillatorNode|requestAnimationFrame)\b/;
  for (const f of FILES.filter((x) => ['model', 'formats'].includes(top(x.path)))) {
    assert.ok(!browser.test(f.code), `${f.path} uses ${browser.exec(f.code)?.[0]}`);
  }
});

test('no network APIs in editor code', () => {
  const network = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|WebTransport|RTCPeerConnection|importScripts)\b/;
  for (const f of FILES) {
    assert.ok(!network.test(f.code), `${f.path} uses ${network.exec(f.code)?.[0]}`);
    for (const spec of f.imports) assert.ok(!/^[a-z]+:/i.test(spec), `${f.path} imports ${spec}`);
  }
});

test('the editor page has no inline script, style or handler', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  for (const [, attrs, body] of scripts) {
    assert.ok(/\bsrc="\/src\/editor\/main\.ts"/.test(attrs!), String(attrs!));
    assert.equal(body!.trim(), '');
  }
  assert.ok(!/<style\b/i.test(html), 'inline <style>');
  assert.ok(!/\sstyle\s*=/i.test(html), 'style attribute');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler');
  assert.ok(/<link rel="stylesheet" href="\/src\/editor\/editor\.css" \/>/.test(html), "stylesheet link");
});
