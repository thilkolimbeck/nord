/**
 * Which part of the layer effects each effects field drives, and when it is heard (plan section
 * 15.1), as audio/bindings.ts does for the synth:
 *
 * - live: the chain (or the global instance) follows at once (10 ms smoothing; type changes
 *   crossfade in 20 ms; a new delay time in normal mode jumps behind a 15 ms dip);
 * - none: the field changes no sound (focus and group switches: the store and the panel's job).
 *
 * Block fields are listed once with the block token `{B}` (organFx, pianoAFx … synthCFx). Morph
 * amounts have no binding of their own: the chains read the morphed values (model/morph.ts), so a
 * morph moves its parent field's binding. Every live and unverified field of the effects region
 * has a binding (fx-bindings.test.ts).
 */
import { DESCRIPTORS } from '../../model/descriptors.ts';
import {
  FX_BLOCKS, FX_ENABLE_KEY, FX_FOCUS_KEYS, FX_GLOBAL_KEYS, FX_GROUP_KEYS, type FxParam, type FxUnit, fxKey, parseFxKey,
} from '../../model/fx.ts';
import type { Ns4Key } from '../../model/keys.ts';

export type FxApply = 'live' | 'none';

export interface FxBinding {
  /** The unit it belongs to, or 'section' for the effects-wide switches. */
  readonly unit: FxUnit | 'section';
  readonly apply: FxApply;
  /** Every chain of its block ('block'), every chain and the global units ('all'), the global units only ('global'). */
  readonly scope: 'block' | 'all' | 'global';
  /** The audio parameter(s) it ends up on, for the reader. */
  readonly target: string;
}

/** The stand-in for the block in a pattern: '{B}.dlyMix'. */
export const FX_BLOCK_TOKEN = '{B}';

const b = (unit: FxBinding['unit'], target: string, scope: FxBinding['scope'] = 'block', apply: FxApply = 'live'): FxBinding =>
  ({ unit, apply, scope, target });

const BLOCK_BINDINGS: Readonly<Record<FxParam, FxBinding>> = {
  // Mod 1 (p.49)
  fx1Enable: b('mod1', 'Mod 1 slot: dry/wet crossfade GainNodes'),
  fx1Type: b('mod1', 'Mod 1 type: crossfade between A-Pan, Trem, RM, A-Wah, Wah, Pump subgraphs'),
  fx1RateClkDiv: b('mod1', 'LFO OscillatorNode.frequency; RM sine frequency; A-Wah follower depth; Wah PED position'),
  fx1ClkEnable: b('mod1', 'LFO OscillatorNode.frequency from a master clock division'),
  fx1Amt: b('mod1', 'depth GainNodes (pan, tremolo, pump) or dry/wet GainNodes (RM, wahs)'),
  // Mod 2 (p.50)
  fx2Enable: b('mod2', 'Mod 2 slot: dry/wet crossfade GainNodes'),
  fx2Type: b('mod2', 'Mod 2 type: crossfade between Phaser, Flanger, Chorus, Vibe, Ensemble, Spin subgraphs'),
  fx2Rate: b('mod2', 'LFO OscillatorNode.frequency (Spin: gliding, τ 0.7 s)'),
  fx2Amt: b('mod2', 'phaser feedback, sweep depth GainNodes, chorus third voice, Spin depth'),
  // Delay (p.50–51)
  dlyEnable: b('delay', 'delay slot: dry/wet crossfade GainNodes; off cuts the tail'),
  dlyRateClkDiv: b('delay', 'DelayNode.delayTime (normal: dip and jump; analog: glide)'),
  dlyClkEnable: b('delay', 'DelayNode.delayTime from a master clock division'),
  dlyMix: b('delay', 'equal-power dry/wet GainNodes'),
  dlyFbkAmt: b('delay', 'feedback GainNode.gain'),
  dlyMode: b('delay', 'loop WaveShaperNode curve; how delayTime moves'),
  dlyFbkPingPong: b('delay', 'input and loop routing GainNodes (L↔R)'),
  dlyFbkFilt: b('delay', 'loop BiquadFilterNode type and frequency'),
  dlyFbFxType: b('delay', 'loop effect: crossfade between none, Ensemble, Vibe, Chorus, Flam, Space'),
  // Amp sim / EQ (p.51–52)
  ampEnable: b('amp', 'amp slot: dry/wet crossfade GainNodes; with To Rotary the output/send GainNodes'),
  ampTypeNew: b('amp', 'model EQ BiquadFilterNodes, drive pre-gain, LP/HP filter types; To Rotary: output → rotary send'),
  ampDrive: b('amp', 'drive pre and post GainNodes, WaveShaperNode curve in or out'),
  ampBass: b('amp', 'low shelf BiquadFilterNode.gain'),
  ampMid: b('amp', 'mid peaking BiquadFilterNode.gain; LP/HP filter Q'),
  ampMidFreq: b('amp', 'mid peaking and LP/HP filter BiquadFilterNode.frequency'),
  ampTreble: b('amp', 'high shelf BiquadFilterNode.gain'),
  // Compressor (p.52)
  cmpEnable: b('comp', 'compressor slot: dry/wet crossfade GainNodes'),
  cmpAmt: b('comp', 'DynamicsCompressorNode threshold and ratio, make-up GainNode'),
  cmpResponse: b('comp', 'DynamicsCompressorNode.release'),
  // Reverb (p.52–53)
  rvbEnable: b('reverb', 'reverb slot: dry/wet crossfade GainNodes; off cuts the tail'),
  rvbType: b('reverb', 'ConvolverNode impulse response (a fresh convolver, crossfaded); chorale delay depth'),
  rvbAmt: b('reverb', 'equal-power dry/wet GainNodes'),
  rvbColor: b('reverb', 'colour BiquadFilterNodes on the wet path'),
};

export const FX_BINDINGS: Readonly<Record<string, FxBinding>> = {
  ...Object.fromEntries(Object.entries(BLOCK_BINDINGS).map(([p, x]) => [`${FX_BLOCK_TOKEN}.${p}`, x])),
  [FX_ENABLE_KEY]: b('section', 'every slot of every chain and the global units: bypassed while off (p.48)', 'all'),
  [FX_GLOBAL_KEYS.delay]: b('delay', 'delay slot of every chain bypassed; the global delay on (p.48)', 'all'),
  [FX_GLOBAL_KEYS.comp]: b('comp', 'compressor slot of every chain bypassed; the global compressor on (p.48)', 'all'),
  [FX_GLOBAL_KEYS.reverb]: b('reverb', 'reverb slot of every chain bypassed; the global reverb on (p.48, 52)', 'all'),
  [FX_FOCUS_KEYS.section]: b('section', 'the block whose settings the global units play (FX focus, p.48)', 'global'),
  [FX_FOCUS_KEYS.piano]: b('section', 'the block whose settings the global units play (FX focus, p.48)', 'global'),
  [FX_FOCUS_KEYS.synth]: b('section', 'the block whose settings the global units play (FX focus, p.48)', 'global'),
  [FX_GROUP_KEYS.piano]: b('section', 'none: the store keeps the grouped blocks equal (model/actions.ts)', 'block', 'none'),
  [FX_GROUP_KEYS.synth]: b('section', 'none: the store keeps the grouped blocks equal (model/actions.ts)', 'block', 'none'),
};

/** The pattern of an effects key: 'synthBFx.dlyMix' → '{B}.dlyMix'; other keys unchanged. */
export function fxPatternOf(key: Ns4Key): string {
  const p = parseFxKey(key);
  return p === null || key.includes('.morph') ? key : `${FX_BLOCK_TOKEN}.${p.param}`;
}

/** The keys a pattern stands for (a block pattern: one per block). */
export function expandFxPattern(pattern: string): Ns4Key[] {
  if (!pattern.startsWith(`${FX_BLOCK_TOKEN}.`)) return [pattern as Ns4Key];
  const param = pattern.slice(FX_BLOCK_TOKEN.length + 1) as FxParam;
  return FX_BLOCKS.map((block) => fxKey(block, param));
}

/** The binding of an effects field, or null (morph amounts, other regions). */
export function fxBindingOf(key: Ns4Key): FxBinding | null {
  const pattern = fxPatternOf(key);
  return Object.hasOwn(FX_BINDINGS, pattern) ? FX_BINDINGS[pattern]! : null;
}

/** The fields of the effects region that sound in the editor: status live or unverified. */
export function fxSoundingKeys(): Ns4Key[] {
  return [...DESCRIPTORS.values()]
    .filter((d) => d.region === 'effects' && (d.status === 'live' || d.status === 'unverified'))
    .map((d) => d.key);
}
