/**
 * MIDI control in (plan section 15.4): incoming CC and NRPN messages of manual Appendix II
 * (p.68–69) move the editor's fields (midi/cc-map.ts), store origin 'midi', while the user has
 * switched "midi control in" on. Controllers the play bus owns (wheel, pedal, sustain, panic) stay
 * there. Pure: no Web MIDI, no DOM; main feeds it from MidiInput.onMessage.
 *
 * Per controller message on the chosen channel (every channel, or the Stage 4's global channel,
 * p.61–62): CC99, CC98, CC6 and CC38 go to the NRPN decoder, and a complete NRPN (p.68) looks up
 * its entry; any other controller looks up its plain CC entry. Entries the editor does not map
 * (target 'none') and the play bus's controllers are ignored. `resolveTarget` gives the field (the
 * focused layer of its section in the active scene, the FX focus block, the organ vibrato type by
 * model: assumed, nv) and `scaleIn` the value (the manual gives no scaling: nv). One message is one
 * store batch. While a synth Group is on (M p.32, 34, 35) or a section's effects are in group mode
 * (p.48), the write reaches every layer or block of the group, as the panel's edits do.
 *
 * Every write carries origin 'midi', the copies to grouped layers included, so the MIDI output
 * never sends back what came in (midi/output.ts mayEmit). Off, the class does nothing, and the
 * NRPN decoder forgets any half-received package.
 */
import { activeGroupOf, layerFocusEntries } from '../model/actions.ts';
import { clampValue, descriptorOf } from '../model/descriptors.ts';
import { fxBlocksOf, fxGroupOn, fxKey, fxSectionOf, parseFxKey } from '../model/fx.ts';
import { LAYERS, layerKey, layerOf, type Ns4Key, patternOf } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';
import { focusedLayer, parseSceneKey, SECTION_FIELDS, type SectionId } from '../model/scene.ts';
import type { Entry, ParamStore } from '../model/store.ts';
import { type CcEntry, ccEntry, NrpnDecoder, nrpnEntry, PLAY_BUS_CCS, resolveTarget, scaleIn } from './cc-map.ts';
import type { MidiEvent } from './parser.ts';

export interface ControlInSettings {
  /** "midi control in": off by default. */
  readonly enabled: boolean;
  /** Which channel's controllers count: every channel, or one (1..16, the Stage 4's global channel). */
  readonly channel: number | 'all';
}

export const DEFAULT_CONTROL_IN: ControlInSettings = { enabled: false, channel: 'all' };

/** CC120 (all sound off) and CC123 (all notes off): the play bus panics; the decoder forgets too. */
const PANIC_CCS: readonly number[] = [120, 123];

function validChannel(c: unknown): c is ControlInSettings['channel'] {
  return c === 'all' || (typeof c === 'number' && Number.isInteger(c) && c >= 1 && c <= 16);
}

/**
 * The store entries of one controller write: the field itself, and while its synth Group or its
 * section's effects group is on, the same value on the other layers or blocks of that group.
 * Every entry is a plain [key, value]; the caller writes them with origin 'midi'.
 */
export function controlInEntries(values: ValueReader, key: Ns4Key, value: number): Entry[] {
  const focus = focusEntries(values, key, value);
  if (focus !== null) return focus;
  const out: Entry[] = [[key, value]];
  const layer = layerOf(key);
  if (layer !== null && activeGroupOf(values, key) !== null) {
    const p = patternOf(key);
    for (const l of LAYERS) if (l !== layer) out.push([layerKey(l, p), value]);
    return out;
  }
  const fx = parseFxKey(key);
  if (fx !== null) {
    const section = fxSectionOf(fx.block);
    if (fxGroupOn(values, section)) {
      for (const b of fxBlocksOf(section)) if (b !== fx.block) out.push([fxKey(b, fx.param), value]);
    }
  }
  return out;
}

/**
 * A layer focus controller (CC 82/83, 109/112, 115/119): the focus, and in the active scene the
 * FX focus on that layer's block, as the panel's layer keys move it (model/actions.ts
 * layerFocusEntries, M p.48). The tags are dropped: every entry is written with origin 'midi',
 * so the MIDI output never sends the follow-up FX focus back. Null for every other key.
 */
function focusEntries(values: ValueReader, key: Ns4Key, value: number): Entry[] | null {
  const p = parseSceneKey(key);
  if (p === null) return null;
  const section = (Object.keys(SECTION_FIELDS) as SectionId[]).find((s) => SECTION_FIELDS[s].focus === p.field);
  if (section === undefined) return null;
  // The layer the value names once the store has clamped it to the field's range (out of the layers' range → A).
  const layer = focusedLayer({ get: (k) => (k === key ? clampValue(descriptorOf(key), value) : values.get(k)) },
    section, p.scene);
  return layerFocusEntries(values, section, layer, p.scene).map(([k, v]): Entry => [k, v]);
}

export class MidiControlIn {
  readonly #store: ParamStore;
  readonly #nrpn = new NrpnDecoder();
  readonly #editListeners = new Set<(key: Ns4Key) => void>();
  #settings: ControlInSettings = DEFAULT_CONTROL_IN;

  constructor(store: ParamStore) {
    this.#store = store;
  }

  get settings(): ControlInSettings {
    return this.#settings;
  }

  /** Change the settings; an invalid channel is ignored. Switching off or changing the channel drops half-received NRPNs. */
  update(patch: Partial<ControlInSettings>): void {
    const next: ControlInSettings = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : this.#settings.enabled,
      channel: patch.channel !== undefined && validChannel(patch.channel) ? patch.channel : this.#settings.channel,
    };
    if (!next.enabled || next.channel !== this.#settings.channel) this.#nrpn.reset();
    this.#settings = next;
  }

  /** One parsed message from any input; edits the store when enabled and the message maps to a field. */
  handle(e: MidiEvent): void {
    if (!this.#settings.enabled || e.type !== 'cc') return;
    const ch = this.#settings.channel;
    if (ch !== 'all' && e.channel !== ch - 1) return;
    if (PANIC_CCS.includes(e.controller)) {
      this.#nrpn.reset();
      return;
    }
    if (NrpnDecoder.isRpnSelect(e.controller)) this.#nrpn.feed(e.channel, e.controller, e.value);
    if (NrpnDecoder.isTransport(e.controller)) {
      const n = this.#nrpn.feed(e.channel, e.controller, e.value);
      if (n !== null) this.#apply(nrpnEntry(n.msb, n.lsb), n.value);
      return;
    }
    if (PLAY_BUS_CCS.includes(e.controller)) return;
    this.#apply(ccEntry(e.controller), e.value);
  }

  /** Called with each field a controller moved (the display shows it as the last touched parameter). */
  onEdit(fn: (key: Ns4Key) => void): () => void {
    this.#editListeners.add(fn);
    return () => {
      this.#editListeners.delete(fn);
    };
  }

  #apply(entry: CcEntry | null, raw: number): void {
    if (entry === null || entry.target.kind === 'none') return;
    const key = resolveTarget(entry, this.#store);
    if (key === null) return;
    const value = scaleIn(entry, key, raw);
    this.#store.setMany(controlInEntries(this.#store, key, value), 'midi');
    const errors: unknown[] = [];
    for (const fn of [...this.#editListeners]) {
      try {
        fn(key);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) throw errors[0];
  }
}
