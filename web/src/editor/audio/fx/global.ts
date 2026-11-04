/**
 * Delay, compressor and reverb in Global mode (plan section 15.1, manual p.48, 52): one instance
 * each on the sum of every section, in front of the master, in the order delay ─► compressor ─►
 * reverb, with the settings of the FX focus block (model/fx.ts fxFocusBlock). A unit plays here
 * while Layer Effects ON, its global switch and the focus block's Enable are on; every chain
 * bypasses that unit meanwhile (params.ts unitOn). Units not in Global mode pass the sum through.
 * Approximations, as the layer units.
 */
import { FX_ENABLE_KEY, FX_FOCUS_KEYS, FX_GLOBAL_KEYS, fxEnabled, fxFocusBlock, fxGlobalOn, type GlobalUnit } from '../../model/fx.ts';
import type { ValueReader } from '../../model/labels.ts';
import type { Change } from '../../model/store.ts';
import { applyUnit, batchTouches, type Units } from './chain.ts';
import { Compressor } from './comp.ts';
import { Delay } from './delay.ts';
import { gainNode, release, Slot } from './nodes.ts';
import { unitSwitch } from './params.ts';
import { Reverb } from './reverb.ts';
import type { ClockReader, GlobalFx, GlobalFxContext, GlobalFxFactory } from './types.ts';

const GLOBAL_UNITS: readonly GlobalUnit[] = ['delay', 'comp', 'reverb'];
const GLOBAL_COMMON: ReadonlySet<string> = new Set<string>([FX_ENABLE_KEY, ...Object.values(FX_GLOBAL_KEYS),
  ...Object.values(FX_FOCUS_KEYS), 'common.masterClockRate']);

/** Whether a unit plays in the global instance: Layer Effects ON, Global mode, and the focus block's Enable. */
export function globalUnitOn(values: ValueReader, unit: GlobalUnit): boolean {
  return fxEnabled(values) && fxGlobalOn(values, unit) && unitSwitch(values, fxFocusBlock(values), unit);
}

export class GlobalUnits implements GlobalFx {
  readonly input: GainNode;
  readonly units: Pick<Units, GlobalUnit>;
  readonly #ctx: BaseAudioContext;
  readonly #values: ValueReader;
  readonly #clock: ClockReader | null;
  readonly #last: AudioNode;
  #disposed = false;

  constructor(c: GlobalFxContext) {
    const ctx = c.ctx;
    this.#ctx = ctx;
    this.#values = c.values;
    this.#clock = c.clock;
    this.input = gainNode(ctx);
    this.units = {
      delay: new Slot(ctx, () => new Delay(ctx), true),
      comp: new Slot(ctx, () => new Compressor(ctx)),
      reverb: new Slot(ctx, () => new Reverb(ctx), true),
    };
    let prev: AudioNode = this.input;
    for (const u of GLOBAL_UNITS) {
      prev.connect(this.units[u].input);
      prev = this.units[u].output;
    }
    this.#last = prev;
    prev.connect(c.out);
    this.#reread(ctx.currentTime);
  }

  #reread(t: number): void {
    const block = fxFocusBlock(this.#values);
    for (const u of GLOBAL_UNITS) {
      applyUnit(this.units, u, globalUnitOn(this.#values, u), this.#values, block, this.#clock, t);
    }
  }

  applyChanges(batch: readonly Change[]): void {
    if (this.#disposed || !batchTouches(batch, null, GLOBAL_COMMON)) return;
    if (batch.some((c) => c.origin === 'load')) this.silence();
    this.#reread(this.#ctx.currentTime);
  }

  controller(): void {
    // No global unit follows a performance controller (Mod 1 PED is a layer unit).
  }

  silence(): void {
    if (this.#disposed) return;
    const t = this.#ctx.currentTime;
    for (const u of GLOBAL_UNITS) this.units[u].silence(t);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const u of GLOBAL_UNITS) this.units[u].dispose();
    release([this.input, this.#last]);
  }
}

export const globalFxFactory: GlobalFxFactory = (c) => new GlobalUnits(c);
