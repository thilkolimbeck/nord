/**
 * Which audio parameter each synth field drives, and when a change is heard (plan section 4.1):
 *
 * - live: the layer or the sounding voices follow at once (10 ms smoothing on AudioParams);
 * - next-stage: envelope times; a sounding voice uses the new value from its next stage on (a
 *   release time is read at key-up), every new note at once;
 * - next-note: read when the next note starts (voicing, unison, glide, velocity curves);
 * - none: the field changes no sound (the panel's layer focus).
 *
 * Every live and unverified synth field has a binding (bindings.test.ts); engine.ts has a handler
 * for every effect, which the type checker enforces through a Record over Effect.
 */
import { DESCRIPTORS } from '../model/descriptors.ts';
import { patternOf, type Ns4Key } from '../model/keys.ts';
import type { VoiceUpdate } from './voice.ts';

export type Effect =
  | 'layers' | 'focus' | 'layerBus' | 'lfo' | 'vibrato' | 'bend'
  | VoiceUpdate
  | 'envTimes' | 'ampVelocity' | 'voicing' | 'glide' | 'unison' | 'vibDelay';

export type Apply = 'live' | 'next-stage' | 'next-note' | 'none';

export interface Binding {
  readonly effect: Effect;
  readonly apply: Apply;
  /** What sounds: the synth section, one layer's shared nodes, or each voice of the layer. */
  readonly scope: 'section' | 'layer' | 'voice';
  /** The audio parameter(s) it ends up on, for the reader. */
  readonly target: string;
}

const b = (effect: Effect, apply: Apply, scope: Binding['scope'], target: string): Binding => ({ effect, apply, scope, target });

const ENV = (which: string): Binding => b('envTimes', 'next-stage', 'voice', `${which} envelope automation`);

export const BINDINGS: Readonly<Record<string, Binding>> = {
  // Section and layers
  'common.sectionEnableSyn_I': b('layers', 'next-note', 'section', 'which layers start voices'),
  'synth.layerEnableSyn_I': b('layers', 'next-note', 'section', 'which layers start voices'),
  'synth.layerFocusSyn_I': b('focus', 'none', 'section', 'none: selects the layer the panel edits'),
  'synth.layerLevelSyn{L}': b('layerBus', 'live', 'layer', 'layer bus GainNode.gain'),
  'synth.layerPanSyn{L}': b('layerBus', 'live', 'layer', 'layer StereoPannerNode.pan'),

  // Oscillator
  'synth{L}.mode': b('source', 'live', 'voice', 'oscillator graph (samples: silent)'),
  'synth{L}Sound.oscBank': b('source', 'live', 'voice', 'oscillator graph (wave: silent)'),
  'synth{L}Sound.oscCat': b('source', 'live', 'voice', 'oscillator graph'),
  'synth{L}Sound.oscWave': b('source', 'live', 'voice', 'oscillator graph'),
  'synth{L}Sound.oscCtrl': b('ctrl', 'live', 'voice', 'osc ctrl ConstantSourceNode.offset; static waves rebuilt'),
  'synth{L}Sound.oscTuneCoarse': b('pitch', 'live', 'voice', 'pitch ConstantSourceNode.offset → OscillatorNode.detune'),
  'synth{L}Sound.oscTuneFine': b('pitch', 'live', 'voice', 'pitch ConstantSourceNode.offset → OscillatorNode.detune'),

  // Osc envelope
  'synth{L}Sound.oscEnvAtk': ENV('osc'),
  'synth{L}Sound.oscEnvDcy': ENV('osc'),
  'synth{L}Sound.oscEnvRls': ENV('osc'),
  'synth{L}Sound.oscEnvDst': b('oscEnvDepth', 'live', 'voice', 'osc env GainNode.gain to pitch or osc ctrl'),
  'synth{L}Sound.oscEnvAmt': b('oscEnvDepth', 'live', 'voice', 'osc env GainNode.gain to pitch or osc ctrl'),
  'synth{L}Sound.oscEnvVel': b('oscEnvDepth', 'live', 'voice', 'osc env GainNode.gain (velocity depth)'),

  // Filter
  'synth{L}Sound.fltEnable': b('filterChain', 'live', 'voice', 'filter chain in or out'),
  'synth{L}Sound.fltType': b('filterChain', 'live', 'voice', 'BiquadFilterNode type and count'),
  'synth{L}Sound.fltDrive': b('filterChain', 'live', 'voice', 'WaveShaperNode curve'),
  'synth{L}Sound.fltFreq': b('filterParams', 'live', 'voice', 'BiquadFilterNode.frequency'),
  'synth{L}Sound.fltRes': b('filterParams', 'live', 'voice', 'BiquadFilterNode.Q (LP+HP: highpass frequency)'),
  'synth{L}Sound.fltKbdTrk': b('filterParams', 'live', 'voice', 'cutoff ConstantSourceNode.offset → detune'),
  'synth{L}Sound.fltEnvAmt': b('filterEnvDepth', 'live', 'voice', 'filter env GainNode.gain → detune'),
  'synth{L}Sound.fltEnvVel': b('filterEnvDepth', 'live', 'voice', 'filter env GainNode.gain (velocity depth)'),
  'synth{L}Sound.fltEnvAtk': ENV('filter'),
  'synth{L}Sound.fltEnvDcy': ENV('filter'),
  'synth{L}Sound.fltEnvRls': ENV('filter'),

  // Amp envelope
  'synth{L}Sound.ampEnvAtk': ENV('amp'),
  'synth{L}Sound.ampEnvDcy': ENV('amp'),
  'synth{L}Sound.ampEnvRls': ENV('amp'),
  'synth{L}Sound.ampEnvVel': b('ampVelocity', 'next-note', 'voice', 'VCA envelope peak'),

  // LFO and vibrato
  'synth{L}Sound.lfoWave': b('lfo', 'live', 'layer', 'LFO source'),
  'synth{L}Sound.lfoDst': b('lfo', 'live', 'layer', 'LFO depth GainNodes (pitch, filter, osc ctrl)'),
  'synth{L}Sound.lfoRateClkDiv': b('lfo', 'live', 'layer', 'LFO frequency'),
  'synth{L}Sound.lfoAmt': b('lfo', 'live', 'layer', 'LFO depth GainNodes'),
  'synth{L}.vibMode': b('vibrato', 'live', 'layer', 'vibrato depth GainNode.gain'),
  'synth{L}Sound.vibRate': b('vibrato', 'live', 'layer', 'vibrato OscillatorNode.frequency'),
  'synth{L}Sound.vibAmt': b('vibrato', 'live', 'layer', 'vibrato depth GainNode.gain'),
  'synth{L}.vibDly': b('vibDelay', 'next-note', 'voice', 'per-voice vibrato GainNode ramp'),

  // Voice
  'synth{L}.voiceMode': b('voicing', 'next-note', 'section', 'voice allocator mode'),
  'synth{L}.voicePrio': b('voicing', 'next-note', 'section', 'voice allocator priority'),
  'synth{L}.glideRate': b('glide', 'next-note', 'voice', 'pitch ramp at the next mono or legato note'),
  'synth{L}.oscUnison': b('unison', 'next-note', 'voice', 'oscillator copies'),

  // Keyboard
  'synth{L}.octaveShift': b('pitch', 'live', 'voice', 'pitch ConstantSourceNode.offset'),
  'synth{L}.pStickEnable': b('bend', 'live', 'layer', 'bend ConstantSourceNode.offset'),
  'synth{L}.pitchStickRange': b('bend', 'live', 'layer', 'bend ConstantSourceNode.offset'),
  'synth{L}.sustainEnable': b('voicing', 'next-note', 'section', 'voice allocator sustain'),
};

/** The binding of a field, or null for fields that do not sound in the MVP. */
export function bindingOf(key: Ns4Key): Binding | null {
  const pattern = patternOf(key);
  return Object.hasOwn(BINDINGS, pattern) ? BINDINGS[pattern]! : null;
}

/** The synth fields that sound in the MVP: status live or unverified, in the synth region. */
export function soundingKeys(): Ns4Key[] {
  return [...DESCRIPTORS.values()]
    .filter((d) => d.region === 'synth' && (d.status === 'live' || d.status === 'unverified'))
    .map((d) => d.key);
}
