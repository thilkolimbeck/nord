/**
 * Which part of the browser piano each piano field drives, and when a change is heard (plan
 * section 13.3, "Voices and changes"):
 *
 * - live: the layer follows at once (10 ms smoothing): level, timbre, string resonance send, pitch stick;
 * - next-note: read when the next note starts (type, model, variation, touch, dyn comp, unison,
 *   octave shift, sustain switch); a sounding voice keeps what it started with;
 * - key-up: read when the damper falls (Soft Release, part of piano{X}.acoustic);
 * - next-pedal: read at the next sustain pedal event (pedal noise);
 * - none: no sound (the panel's layer focus, and the router-owned keys, which matter only to the
 *   router at the next note-on: section and layer switches, keyboard zones).
 *
 * Binding tables list `_I` scene keys only; bindingOf resolves an `_II` key to its `_I` twin.
 * piano{X}.entry has no binding (stored). Every live and unverified field of the piano region has
 * a binding (piano-bindings.test.ts); engine.ts has a handler for every effect (a Record over Effect).
 */
import { DESCRIPTORS } from '../../model/descriptors.ts';
import { isNs4Key, LAYER_TOKEN, type Ns4Key } from '../../model/keys.ts';
import { parseSceneKey, type PianoLayer, sceneTwin } from '../../model/scene.ts';
import { PIANO_LAYERS, pianoKey } from './mapping.ts';

export type Effect =
  | 'router' | 'focus' | 'level' | 'timbre' | 'type' | 'resonance' | 'sustain' | 'bend' | 'nextNote' | 'pedalNoise';

export type Apply = 'live' | 'next-note' | 'key-up' | 'next-pedal' | 'none';

export interface Binding {
  readonly effect: Effect;
  readonly apply: Apply;
  /** What sounds: the piano section (router), one layer's shared nodes, or each new voice of the layer. */
  readonly scope: 'section' | 'layer' | 'voice';
  /** The audio parameter(s) it ends up on, for the reader. */
  readonly target: string;
}

const b = (effect: Effect, apply: Apply, scope: Binding['scope'], target: string): Binding => ({ effect, apply, scope, target });
const NEXT = (target: string): Binding => b('nextNote', 'next-note', 'voice', target);
const ROUTER = b('router', 'none', 'section', 'none: the router reads it at the next note-on');

export const BINDINGS: Readonly<Record<string, Binding>> = {
  // Section and layers (router-owned) and the panel focus
  'common.sectionEnablePno_I': ROUTER,
  'piano.layerEnablePno_I': ROUTER,
  'piano.layerFocusPno_I': b('focus', 'none', 'section', 'none: selects the layer the panel edits'),
  'piano{L}.kbZone': ROUTER,

  // Layer
  'piano.layerLevelPno{L}': b('level', 'live', 'layer', 'layer level GainNode.gain'),
  'piano{L}.eq': b('timbre', 'live', 'layer', 'layer timbre BiquadFilterNodes'),
  'piano{L}.bank': b('type', 'next-note', 'voice', 'recipe family of new voices; the timbre set follows at once'),
  'piano{L}.nameHash': NEXT('recipe family of new voices'),
  'piano{L}.variation': NEXT('Clav pickup filters of new voices'),
  'piano{L}.acoustic': b('resonance', 'live', 'layer', 'string resonance send GainNode.gain; soft release read at key-up'),
  'piano{L}.pedalNoise': b('pedalNoise', 'next-pedal', 'layer', 'noise burst at the next sustain event'),
  'piano{L}.kbdTouch': NEXT('touch curve of new voices'),
  'piano{L}.dynComp': NEXT('level of new voices'),
  'piano{L}.unison': NEXT('oscillator copies of new voices'),

  // Keyboard
  'piano{L}.octaveShift': NEXT('oscillator frequencies of new voices'),
  'piano{L}.pStickEnable': b('bend', 'live', 'layer', 'bend ConstantSourceNode.offset → OscillatorNode.detune'),
  'piano{L}.sustainEnable': b('sustain', 'next-note', 'layer', 'sustain of new voices; string resonance send'),
};

// Piano layer keys: blocks pianoA and pianoB, and the per-layer fields of the piano section
// (piano.layerLevelPnoA and its morphs). pianoAFx (effects) is not matched.
const LAYER_RE = /^(piano)([AB])(\.)|^(piano\.layerLevelPno)([AB])(?=\.|$)/;

/** The piano layer a key belongs to, or null for keys outside the two piano layers. */
export function pianoLayerOf(key: Ns4Key): PianoLayer | null {
  const m = LAYER_RE.exec(key);
  if (m === null) return null;
  return (m[2] ?? m[5]) as PianoLayer;
}

/** The layer-free pattern of a piano key: 'pianoB.eq' → 'piano{L}.eq'; other keys as they are. */
export function pianoPatternOf(key: Ns4Key): string {
  const m = LAYER_RE.exec(key);
  if (m === null) return key;
  const rest = key.slice(m[0].length);
  return m[1] !== undefined ? `${m[1]}${LAYER_TOKEN}${m[3]!}${rest}` : `${m[4]!}${LAYER_TOKEN}${rest}`;
}

/** The keys a binding pattern names: one per piano layer with the token, else the key itself. */
export function expandPianoPattern(pattern: string): Ns4Key[] {
  if (pattern.includes(LAYER_TOKEN)) return PIANO_LAYERS.map((l) => pianoKey(l, pattern));
  if (!isNs4Key(pattern)) throw new Error(`${pattern} is not a Stage 4 field`);
  return [pattern];
}

/** The binding of a field, or null for fields the piano does not play. Scene II keys resolve to their scene I twin. */
export function bindingOf(key: Ns4Key): Binding | null {
  const scene = parseSceneKey(key);
  const k = scene !== null && scene.scene === 'II' ? sceneTwin(key) ?? key : key;
  const pattern = pianoPatternOf(k);
  return Object.hasOwn(BINDINGS, pattern) ? BINDINGS[pattern]! : null;
}

/** The piano fields that sound: status live or unverified, in the piano region. */
export function soundingKeys(): Ns4Key[] {
  return [...DESCRIPTORS.values()]
    .filter((d) => d.region === 'piano' && (d.status === 'live' || d.status === 'unverified'))
    .map((d) => d.key);
}
