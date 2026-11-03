/**
 * Audio status as a pure state machine (plan section 1, AC 9): idle until a user gesture, then
 * starting while the AudioContext is created and resumed, running once it plays; suspended or
 * interrupted contexts are blocked (a second gesture retries), failures are errors, and a browser
 * without Web Audio is unsupported for good. audio/host.ts feeds the events; the status bar shows
 * the texts. No Web Audio here.
 */

export type AudioStatus =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; sampleRate: number }
  | { kind: 'blocked'; reason: 'suspended' | 'interrupted' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

export type AudioEvent =
  /** A user gesture asked for audio (first key, pointer press, start audio key). */
  | { type: 'gesture' }
  /** The context runs. */
  | { type: 'resumed'; sampleRate: number }
  /** AudioContext.state after a statechange or after resume() settled. */
  | { type: 'state'; state: string; sampleRate?: number }
  | { type: 'failed'; message: string }
  | { type: 'unsupported' };

export const IDLE: AudioStatus = { kind: 'idle' };

export function audioStatusReducer(s: AudioStatus, e: AudioEvent): AudioStatus {
  if (s.kind === 'unsupported') return s;
  switch (e.type) {
    case 'unsupported':
      return { kind: 'unsupported' };
    case 'failed':
      return { kind: 'error', message: e.message };
    case 'resumed':
      return s.kind === 'running' && s.sampleRate === e.sampleRate ? s : { kind: 'running', sampleRate: e.sampleRate };
    case 'gesture':
      return s.kind === 'running' ? s : { kind: 'starting' };
    case 'state':
      // Before the first gesture there is no context whose state could matter.
      if (s.kind === 'idle') return s;
      if (e.state === 'running') {
        const rate = e.sampleRate ?? (s.kind === 'running' ? s.sampleRate : 0);
        return s.kind === 'running' && s.sampleRate === rate ? s : { kind: 'running', sampleRate: rate };
      }
      if (e.state === 'suspended') {
        return s.kind === 'blocked' && s.reason === 'suspended' ? s : { kind: 'blocked', reason: 'suspended' };
      }
      if (e.state === 'interrupted') {
        return s.kind === 'blocked' && s.reason === 'interrupted' ? s : { kind: 'blocked', reason: 'interrupted' };
      }
      if (e.state === 'closed') return { kind: 'error', message: 'the audio context was closed' };
      return s;
  }
}

/** The short word the status strip shows next to the LED; empty when the LED says it all. */
export function audioStatusWord(s: AudioStatus): string {
  switch (s.kind) {
    case 'blocked': return 'blocked';
    case 'error': return 'error';
    case 'unsupported': return 'not supported';
    default: return '';
  }
}

/** The full status sentence for screen readers and the key's description. */
export function audioStatusText(s: AudioStatus): string {
  switch (s.kind) {
    case 'idle': return 'audio off: press a key or start audio';
    case 'starting': return 'audio starting';
    case 'running': return `audio running at ${Math.round(s.sampleRate)} Hz`;
    case 'blocked':
      return s.reason === 'interrupted'
        ? 'audio blocked: the system interrupted it; press start audio to resume'
        : 'audio blocked: the browser suspended it; press start audio';
    case 'unsupported': return 'audio not supported: this browser has no Web Audio';
    case 'error': return `audio error: ${s.message}`;
  }
}

/** The LED: lit while running, off while idle or starting, outlined for blocked, error and unsupported. */
export function audioLed(s: AudioStatus): 'on' | 'off' | 'alert' {
  if (s.kind === 'running') return 'on';
  if (s.kind === 'idle' || s.kind === 'starting') return 'off';
  return 'alert';
}

/** Whether the start audio key is offered: whenever audio does not run and could. */
export function canStart(s: AudioStatus): boolean {
  return s.kind !== 'running' && s.kind !== 'unsupported';
}
