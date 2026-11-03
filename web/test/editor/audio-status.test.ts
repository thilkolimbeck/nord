/** AC 9: the audio status machine (idle → starting → running; blocked; error; unsupported) and the host's use of it. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioHost, type AudioHostEnv } from '../../src/editor/audio/host.ts';
import {
  type AudioEvent, audioLed, type AudioStatus, audioStatusReducer, audioStatusText, audioStatusWord, canStart, IDLE,
} from '../../src/editor/audio/status.ts';

function run(events: AudioEvent[], from: AudioStatus = IDLE): AudioStatus {
  return events.reduce(audioStatusReducer, from);
}

test('idle → starting on a gesture → running when resumed', () => {
  const starting = run([{ type: 'gesture' }]);
  assert.deepEqual(starting, { kind: 'starting' });
  assert.deepEqual(run([{ type: 'resumed', sampleRate: 48000 }], starting), { kind: 'running', sampleRate: 48000 });
  assert.deepEqual(run([{ type: 'state', state: 'running', sampleRate: 44100 }], starting), { kind: 'running', sampleRate: 44100 });
});

test('state events before the first gesture are ignored', () => {
  assert.equal(run([{ type: 'state', state: 'suspended' }]), IDLE);
  assert.equal(run([{ type: 'state', state: 'running', sampleRate: 48000 }]), IDLE);
});

test('suspended and interrupted contexts are blocked; a gesture retries', () => {
  const running = run([{ type: 'gesture' }, { type: 'resumed', sampleRate: 48000 }]);
  assert.deepEqual(run([{ type: 'state', state: 'suspended' }], running), { kind: 'blocked', reason: 'suspended' });
  assert.deepEqual(run([{ type: 'state', state: 'interrupted' }], running), { kind: 'blocked', reason: 'interrupted' });
  // resume() settled without running (Safari without a gesture): blocked
  assert.deepEqual(run([{ type: 'gesture' }, { type: 'state', state: 'suspended' }]), { kind: 'blocked', reason: 'suspended' });
  const blocked = run([{ type: 'state', state: 'suspended' }], running);
  assert.deepEqual(run([{ type: 'gesture' }], blocked), { kind: 'starting' });
  assert.deepEqual(run([{ type: 'state', state: 'running' }], blocked), { kind: 'running', sampleRate: 0 });
});

test('failures are errors, a closed context too; a gesture retries', () => {
  const err = run([{ type: 'gesture' }, { type: 'failed', message: 'nope' }]);
  assert.deepEqual(err, { kind: 'error', message: 'nope' });
  assert.equal(run([{ type: 'gesture' }, { type: 'resumed', sampleRate: 1 }, { type: 'state', state: 'closed' }]).kind, 'error');
  assert.deepEqual(run([{ type: 'gesture' }], err), { kind: 'starting' });
});

test('unsupported is final', () => {
  const u = run([{ type: 'gesture' }, { type: 'unsupported' }]);
  assert.deepEqual(u, { kind: 'unsupported' });
  for (const e of [{ type: 'gesture' }, { type: 'resumed', sampleRate: 1 }, { type: 'failed', message: 'x' },
    { type: 'state', state: 'running' }] as AudioEvent[]) {
    assert.equal(audioStatusReducer(u, e), u);
  }
});

test('a gesture while running keeps running; repeated states return the same object', () => {
  const running = run([{ type: 'gesture' }, { type: 'resumed', sampleRate: 48000 }]);
  assert.equal(audioStatusReducer(running, { type: 'gesture' }), running);
  assert.equal(audioStatusReducer(running, { type: 'state', state: 'running', sampleRate: 48000 }), running);
  const blocked = audioStatusReducer(running, { type: 'state', state: 'suspended' });
  assert.equal(audioStatusReducer(blocked, { type: 'state', state: 'suspended' }), blocked);
});

test('texts, words, LED and the start key per state', () => {
  const cases: Array<[AudioStatus, string, 'on' | 'off' | 'alert', boolean]> = [
    [{ kind: 'idle' }, '', 'off', true],
    [{ kind: 'starting' }, '', 'off', true],
    [{ kind: 'running', sampleRate: 48000 }, '', 'on', false],
    [{ kind: 'blocked', reason: 'suspended' }, 'blocked', 'alert', true],
    [{ kind: 'blocked', reason: 'interrupted' }, 'blocked', 'alert', true],
    [{ kind: 'error', message: 'x' }, 'error', 'alert', true],
    [{ kind: 'unsupported' }, 'not supported', 'alert', false],
  ];
  for (const [s, word, led, start] of cases) {
    assert.equal(audioStatusWord(s), word, s.kind);
    assert.equal(audioLed(s), led, s.kind);
    assert.equal(canStart(s), start, s.kind);
    assert.ok(audioStatusText(s).startsWith('audio '), s.kind);
  }
  assert.equal(audioStatusText({ kind: 'running', sampleRate: 48000 }), 'audio running at 48000 Hz');
  assert.equal(audioStatusText({ kind: 'error', message: 'boom' }), 'audio error: boom');
});

/** A stand-in AudioContext with the parts the host uses. */
class FakeContext {
  state = 'suspended';
  sampleRate = 48000;
  resumes = 0;
  readonly listeners: Array<() => void> = [];
  readonly runs: boolean;
  constructor(runs: boolean) {
    this.runs = runs;
  }
  addEventListener(_type: string, fn: () => void): void { this.listeners.push(fn); }
  resume(): Promise<void> {
    this.resumes += 1;
    if (this.runs) {
      this.state = 'running';
      for (const fn of this.listeners) fn();
    }
    return Promise.resolve();
  }
}

function env(ctx: FakeContext | null, session: { type: string } | null = null): AudioHostEnv & { created: number } {
  const e = {
    created: 0,
    create: () => { e.created += 1; return ctx as unknown as AudioContext | null; },
    session: () => session,
  };
  return e;
}

test('host: no context before start; start creates it once, sets the audio session, runs', async () => {
  const ctx = new FakeContext(true);
  const session = { type: 'auto' };
  const e = env(ctx, session);
  const host = new AudioHost(e);
  const seen: string[] = [];
  host.onStatus((s) => seen.push(s.kind));
  assert.equal(host.context, null);
  assert.equal(e.created, 0);
  const result = await host.start();
  assert.equal(result, ctx as unknown);
  assert.equal(session.type, 'playback');
  assert.equal(host.status.kind, 'running');
  assert.deepEqual(seen, ['starting', 'running']);
  await host.start();
  assert.equal(e.created, 1);
});

test('host: a context that stays suspended is blocked; no Web Audio is unsupported', async () => {
  const blocked = new AudioHost(env(new FakeContext(false)));
  assert.equal(await blocked.start(), null);
  assert.deepEqual(blocked.status, { kind: 'blocked', reason: 'suspended' });
  const none = new AudioHost(env(null));
  assert.equal(await none.start(), null);
  assert.equal(none.status.kind, 'unsupported');
});
