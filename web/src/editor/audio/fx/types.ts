/**
 * The layer effects contract (plan section 15.1): every section engine sends each layer's signal
 * (the organ: both layers' sum) through an FxChain for its block before the section output, and
 * the global units (delay, compressor, reverb in Global mode, manual p.48, 52) sit on the sum of
 * every section in front of the master:
 *
 *   synth layer:  voices ─► xfade ─► level bus ─► gate ─► pan ─► FxChain(synth{L}Fx) ─┬─► out
 *   piano layer:  voices ─► timbre ─► level ─────────────────► FxChain(piano{L}Fx) ──┤  (or, Amp/EQ "To
 *   organ:        layers (level) ─► organ bus ─► FxChain(organFx) ─┬─► direct ──────┤   Rotary": the
 *                                                                  └─► rotary ──────┘   rotary input)
 *   out = GlobalFx.input ─► (global delay, compressor, reverb) ─► MasterBus.input ─► destination
 *
 * The engines build their chains through fxChainFor() (below) from SectionContext.fx; without
 * hooks (the tests, or before audio/fx exists) the layer connects straight on, exactly as before.
 * passThroughChain and passThroughGlobal stand in for audio/fx in main until it exists.
 * audio/fx/** builds the real chains (builder B1); this file is shared and frozen.
 */
import type { FxBlock } from '../../model/fx.ts';
import type { ValueReader } from '../../model/labels.ts';
import type { ControllerKind } from '../../model/morph.ts';
import type { Change } from '../../model/store.ts';

export type { FxBlock, FxParam, FxUnit, GlobalUnit } from '../../model/fx.ts';

/** The master clock as the effects read it: tempo, and the audio time of a beat (for phase-locked LFOs). */
export interface ClockReader {
  /** Beats per minute, 30..240. */
  bpm(): number;
  /** The audio time of a beat of the master clock's grid (any beat; the grid repeats every 60 / bpm s). */
  anchor(): number;
}

/** What a chain is built from. */
export interface FxContext {
  readonly ctx: BaseAudioContext;
  /**
   * The program values as the engines read them: in the editor the morphed values
   * (model/morph.ts MorphedValues), so morphed amounts, rates and mixes sound without extra code.
   */
  readonly values: ValueReader;
  /** The block whose fields this chain plays. */
  readonly block: FxBlock;
  /** Tempo for Mst Clk rates and delay times; null: read common.masterClockRate from `values`, free phase. */
  readonly clock: ClockReader | null;
}

/** One block's effects for one layer (organFx: both organ layers). */
export interface FxChain {
  readonly block: FxBlock;
  /** The section connects the layer's signal here (stereo). */
  readonly input: AudioNode;
  /** The processed signal for the section output; silent while Amp/EQ "To Rotary" sends it to the rotary instead. */
  readonly output: AudioNode;
  /**
   * The processed signal while Amp/EQ is "To Rotary" (p.52–53), silent otherwise; the engine
   * connects it to the rotary speaker's input when one exists. null for organFx (the organ reaches
   * the rotary through organ.effectsLeslieEnable, p.53).
   */
  readonly rotarySend: AudioNode | null;
  /**
   * Follow a batch: the block's own fields, its morph changes (origin 'morph'), common.fxEnable,
   * the three global switches (a global unit is bypassed in every chain) and
   * common.masterClockRate. A 'load' or 'init' batch re-reads everything. Other keys are ignored.
   */
  applyChanges(batch: readonly Change[]): void;
  /** A performance controller moved (0..127): the Mod 1 PED variations follow the control pedal (p.49). */
  controller(kind: ControllerKind, value: number): void;
  /** Panic and program load: delay and reverb tails stop at once (≈ 10 ms fade). */
  silence(): void;
  /** Disconnect and stop every node. The chain is unusable afterwards. */
  dispose(): void;
}

export type FxChainFactory = (c: FxContext) => FxChain;

/** What the global units are built from: they sit between every section and the master. */
export interface GlobalFxContext {
  readonly ctx: BaseAudioContext;
  readonly values: ValueReader;
  /** Where the global units send the sum: the MasterBus input. */
  readonly out: AudioNode;
  readonly clock: ClockReader | null;
}

/**
 * Delay, compressor and reverb in Global mode (p.48, 52): one instance each, on the sum of every
 * section (after the rotary and the layer levels), with the settings of the FX focus block
 * (model/fx.ts fxFocusBlock). Units not in Global mode pass the sum through.
 */
export interface GlobalFx {
  /** SectionContext.out for every engine. */
  readonly input: AudioNode;
  applyChanges(batch: readonly Change[]): void;
  controller(kind: ControllerKind, value: number): void;
  silence(): void;
  dispose(): void;
}

export type GlobalFxFactory = (c: GlobalFxContext) => GlobalFx;

/** What main hands every engine (SectionContext.fx): the chain factory and the shared rotary. */
export interface FxHooks {
  readonly chain: FxChainFactory;
  /** The rotary speaker's input (the organ engine's), for "To Rotary"; null while there is none. */
  readonly rotary: () => AudioNode | null;
  readonly clock: ClockReader | null;
}

/** A chain that changes nothing: one GainNode as input and output. */
export const passThroughChain: FxChainFactory = (c) => {
  const node = c.ctx.createGain();
  return {
    block: c.block,
    input: node,
    output: node,
    rotarySend: null,
    applyChanges: () => undefined,
    controller: () => undefined,
    silence: () => undefined,
    dispose: () => node.disconnect(),
  };
};

/** Global units that change nothing: the sum goes straight to `out`. */
export const passThroughGlobal: GlobalFxFactory = (c) => {
  const node = c.ctx.createGain();
  node.connect(c.out);
  return {
    input: node,
    applyChanges: () => undefined,
    controller: () => undefined,
    silence: () => undefined,
    dispose: () => node.disconnect(),
  };
};

/** The section context fields fxChainFor needs (audio/section.ts SectionContext has them). */
export interface FxHost {
  readonly ctx: BaseAudioContext;
  readonly values: ValueReader;
  readonly fx?: FxHooks;
}

/** A chain that is not there: nothing to forward, nothing to dispose (an engine without hooks). */
export function inertChain(block: FxBlock, node: AudioNode): FxChain {
  return {
    block, input: node, output: node, rotarySend: null,
    applyChanges: () => undefined, controller: () => undefined, silence: () => undefined, dispose: () => undefined,
  };
}

/**
 * Put a block's chain between `from` and `to` (one node or several, e.g. the organ's direct path
 * and rotary send), and its rotary send on the shared rotary when both exist. Without hooks
 * `from` connects straight to `to` and the chain is inert, so an engine built without hooks has
 * exactly the graph it had before section 15. The engine keeps the chain to forward batches,
 * controllers, panic (silence) and dispose.
 */
export function fxChainFor(host: FxHost, block: FxBlock, from: AudioNode, to: AudioNode | readonly AudioNode[]): FxChain {
  const targets: readonly AudioNode[] = Array.isArray(to) ? to : [to as AudioNode];
  if (host.fx === undefined) {
    for (const t of targets) from.connect(t);
    return inertChain(block, from);
  }
  const chain = host.fx.chain({ ctx: host.ctx, values: host.values, block, clock: host.fx.clock });
  from.connect(chain.input);
  for (const t of targets) chain.output.connect(t);
  const rotary = host.fx.rotary();
  if (chain.rotarySend !== null && rotary !== null) chain.rotarySend.connect(rotary);
  return chain;
}
