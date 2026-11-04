/**
 * The layer effects chain of one block (plan section 15.1, manual p.48–53):
 *
 *   input ─► Mod 1 ─► Mod 2 ─► Delay ─► Amp/EQ ─► Compressor ─► Reverb ─┬─► out ─► output
 *                                                                       └─► send ─► rotarySend
 *
 * Each unit sits in a Slot: switched off (its Enable, Layer Effects ON, or Global mode, when the
 * one global instance plays it instead) the signal passes dry, with a 20 ms crossfade; a unit's
 * nodes are built the first time it switches on. The order of the units is assumed (the order of
 * the manual's chapter). Amp/EQ "To Rotary" moves the signal from `output` to `rotarySend` (the
 * organ's rotary speaker, p.52–53); organFx has no send (the organ reaches its rotary through
 * organ.effectsLeslieEnable, p.53). Every value is read through FxContext.values, so morphs sound.
 * Approximations throughout: no Stage 4 effect is measured or copied.
 */
import { FX_ENABLE_KEY, FX_GLOBAL_KEYS, FX_UNITS, type FxBlock, type FxUnit, parseFxKey } from '../../model/fx.ts';
import type { ValueReader } from '../../model/labels.ts';
import type { Change } from '../../model/store.ts';
import { Amp } from './amp.ts';
import { Compressor } from './comp.ts';
import { Delay } from './delay.ts';
import { Mod1 } from './mod1.ts';
import { Mod2 } from './mod2.ts';
import { gainNode, glide, release, Slot, XFADE } from './nodes.ts';
import {
  ampSettings, compSettings, delaySettings, mod1Settings, mod2Settings, reverbSettings, toRotary, unitOn,
} from './params.ts';
import { Reverb } from './reverb.ts';
import type { ClockReader, FxChain, FxChainFactory, FxContext } from './types.ts';

/** Keys outside the block that every chain follows. */
const CHAIN_COMMON: ReadonlySet<string> = new Set<string>([FX_ENABLE_KEY, ...Object.values(FX_GLOBAL_KEYS),
  'common.masterClockRate']);

/** Whether a batch concerns a chain of `block` (or, with block null, any effects block). */
export function batchTouches(batch: readonly Change[], block: FxBlock | null, common: ReadonlySet<string>): boolean {
  for (const c of batch) {
    if (c.origin === 'load' || c.origin === 'init' || common.has(c.key)) return true;
    const p = parseFxKey(c.key);
    if (p !== null && (block === null || p.block === block)) return true;
  }
  return false;
}

/** The six units of one chain, in order; also used by the global units (delay, compressor, reverb). */
export interface Units {
  readonly mod1: Slot<ReturnType<typeof mod1Settings>>;
  readonly mod2: Slot<ReturnType<typeof mod2Settings>>;
  readonly delay: Slot<ReturnType<typeof delaySettings>>;
  readonly amp: Slot<ReturnType<typeof ampSettings>>;
  readonly comp: Slot<ReturnType<typeof compSettings>>;
  readonly reverb: Slot<ReturnType<typeof reverbSettings>>;
}

/** Set one unit of `units` from `block`'s fields. */
export function applyUnit(units: Partial<Units>, unit: FxUnit, on: boolean, values: ValueReader, block: FxBlock,
  clock: ClockReader | null, t: number): void {
  switch (unit) {
    case 'mod1': units.mod1?.set(on, () => mod1Settings(values, block, clock), t); break;
    case 'mod2': units.mod2?.set(on, () => mod2Settings(values, block), t); break;
    case 'delay': units.delay?.set(on, () => delaySettings(values, block, clock), t); break;
    case 'amp': units.amp?.set(on, () => ampSettings(values, block), t); break;
    case 'comp': units.comp?.set(on, () => compSettings(values, block), t); break;
    case 'reverb': units.reverb?.set(on, () => reverbSettings(values, block), t); break;
  }
}

export class LayerFxChain implements FxChain {
  readonly block: FxBlock;
  readonly input: GainNode;
  readonly output: GainNode;
  readonly rotarySend: GainNode | null;
  readonly #ctx: BaseAudioContext;
  readonly #values: ValueReader;
  readonly #clock: ClockReader | null;
  readonly units: Units;
  #mod1: Mod1 | null = null;
  #disposed = false;

  constructor(c: FxContext) {
    this.block = c.block;
    this.#ctx = c.ctx;
    this.#values = c.values;
    this.#clock = c.clock;
    const ctx = c.ctx;
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.rotarySend = c.block === 'organFx' ? null : gainNode(ctx, 0);
    this.units = {
      mod1: new Slot(ctx, () => (this.#mod1 = new Mod1(ctx, c.clock))),
      mod2: new Slot(ctx, () => new Mod2(ctx)),
      delay: new Slot(ctx, () => new Delay(ctx), true),
      amp: new Slot(ctx, () => new Amp(ctx)),
      comp: new Slot(ctx, () => new Compressor(ctx)),
      reverb: new Slot(ctx, () => new Reverb(ctx), true),
    };
    let prev: AudioNode = this.input;
    for (const slot of this.#slots()) {
      prev.connect(slot.input);
      prev = slot.output;
    }
    prev.connect(this.output);
    if (this.rotarySend !== null) prev.connect(this.rotarySend);
    this.#reread(ctx.currentTime);
  }

  #slots(): Array<Slot<unknown>> {
    return FX_UNITS.map((u) => this.units[u] as Slot<unknown>);
  }

  /** Whether the chain's signal goes to the rotary now (Amp/EQ To Rotary). */
  get sendingToRotary(): boolean {
    return this.rotarySend !== null && toRotary(this.#values, this.block);
  }

  #reread(t: number): void {
    for (const unit of FX_UNITS) {
      applyUnit(this.units, unit, unitOn(this.#values, this.block, unit), this.#values, this.block, this.#clock, t);
    }
    if (this.rotarySend !== null) {
      const send = toRotary(this.#values, this.block);
      glide(this.output.gain, send ? 0 : 1, t, XFADE);
      glide(this.rotarySend.gain, send ? 1 : 0, t, XFADE);
    }
  }

  applyChanges(batch: readonly Change[]): void {
    if (this.#disposed || !batchTouches(batch, this.block, CHAIN_COMMON)) return;
    const t = this.#ctx.currentTime;
    if (batch.some((c) => c.origin === 'load')) {
      this.#mod1?.programLoaded();
      this.silence();
    }
    this.#reread(t);
  }

  controller(kind: string, value: number): void {
    if (this.#disposed) return;
    this.units.mod1.controller(kind, value, this.#ctx.currentTime);
  }

  silence(): void {
    if (this.#disposed) return;
    const t = this.#ctx.currentTime;
    for (const slot of this.#slots()) slot.silence(t);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const slot of this.#slots()) slot.dispose();
    release([this.input, this.output, this.rotarySend]);
  }
}

export const fxChainFactory: FxChainFactory = (c) => new LayerFxChain(c);
