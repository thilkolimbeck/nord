/**
 * The AudioContext, created only from a user gesture (AC 9). start() must be called inside the
 * gesture's event handler: it creates the context (or resumes a suspended one) synchronously,
 * then reports the outcome through the pure status machine in status.ts. On iOS the audio
 * session is set to 'playback' first where the browser offers it, so the ringer switch does not
 * mute the synth.
 */
import { type AudioEvent, type AudioStatus, audioStatusReducer, IDLE } from './status.ts';

interface AudioSessionLike {
  type: string;
}

export interface AudioHostEnv {
  /** Creates the context; null when the browser has no Web Audio. */
  create(): AudioContext | null;
  /** navigator.audioSession where it exists (Safari 16.4+). */
  session(): AudioSessionLike | null;
}

function browserEnv(): AudioHostEnv {
  return {
    create(): AudioContext | null {
      const Ctor = globalThis.AudioContext as (typeof AudioContext) | undefined;
      return typeof Ctor === 'function' ? new Ctor({ latencyHint: 'interactive' }) : null;
    },
    session(): AudioSessionLike | null {
      const nav = globalThis.navigator as (Navigator & { audioSession?: AudioSessionLike }) | undefined;
      return nav?.audioSession ?? null;
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AudioHost {
  readonly #env: AudioHostEnv;
  readonly #listeners = new Set<(s: AudioStatus) => void>();
  #status: AudioStatus = IDLE;
  #ctx: AudioContext | null = null;

  constructor(env: AudioHostEnv = browserEnv()) {
    this.#env = env;
  }

  get status(): AudioStatus {
    return this.#status;
  }

  /** The context once a gesture created it (it may still be suspended). */
  get context(): AudioContext | null {
    return this.#ctx;
  }

  get running(): boolean {
    return this.#status.kind === 'running';
  }

  /** Call only inside a user-gesture handler. Resolves with the context once it runs, else null. */
  start(): Promise<AudioContext | null> {
    if (this.#status.kind === 'unsupported') return Promise.resolve(null);
    if (this.#ctx !== null && this.#ctx.state === 'running') {
      this.#dispatch({ type: 'resumed', sampleRate: this.#ctx.sampleRate });
      return Promise.resolve(this.#ctx);
    }
    this.#dispatch({ type: 'gesture' });
    let ctx = this.#ctx;
    if (ctx === null) {
      try {
        const session = this.#env.session();
        if (session !== null) session.type = 'playback';
      } catch {
        // An audio session the browser refuses to change is not fatal.
      }
      try {
        ctx = this.#env.create();
      } catch (err) {
        this.#dispatch({ type: 'failed', message: message(err) });
        return Promise.resolve(null);
      }
      if (ctx === null) {
        this.#dispatch({ type: 'unsupported' });
        return Promise.resolve(null);
      }
      this.#ctx = ctx;
      const c = ctx;
      c.addEventListener('statechange', () => {
        this.#dispatch({ type: 'state', state: c.state, sampleRate: c.sampleRate });
      });
    }
    const c = ctx;
    // resume() is called synchronously inside the gesture; Safari unlocks audio only then.
    return c.resume().then(
      () => {
        this.#dispatch(c.state === 'running'
          ? { type: 'resumed', sampleRate: c.sampleRate }
          : { type: 'state', state: c.state, sampleRate: c.sampleRate });
        return c.state === 'running' ? c : null;
      },
      (err: unknown) => {
        this.#dispatch({ type: 'failed', message: message(err) });
        return null;
      },
    );
  }

  onStatus(fn: (s: AudioStatus) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  #dispatch(e: AudioEvent): void {
    const next = audioStatusReducer(this.#status, e);
    if (next === this.#status) return;
    this.#status = next;
    for (const fn of [...this.#listeners]) fn(next);
  }
}
