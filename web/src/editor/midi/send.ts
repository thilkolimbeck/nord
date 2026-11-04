/**
 * MIDI output to a connected Stage 4 (plan section 15.5, manual p.61–62, 68–69): the port picker's
 * ports, "send to stage 4" (control changes as the documented CC or NRPN, with the focus
 * controller first), "send notes", "send all", panic. Every message passes midi/output.ts mayEmit:
 * nothing goes out unless a port is picked and the user switched the matching sender on; MIDI input
 * is never echoed; SysEx is never sent (send refuses anything but channel-voice messages).
 *
 * Values come from the store (the stored value, never the morphed one: the Stage 4 performs its
 * own morphs from the wheel, pressure and pedal that "send notes" passes on). The CC scaling and
 * the layer addressing are the assumptions of midi/cc-map.ts (unverified on hardware, nv).
 *
 * No DOM and no Web Audio: the port is structural (MidiOutputLike), the clock and the timers are
 * injectable so tests run in Node.
 */
import type { NoteSource, PlayEvent } from '../input/events.ts';
import {
  type FxBlock, fxFocusEntries, fxLayersOf, fxSectionOf, FX_BLOCKS, FX_FOCUS_KEYS, FX_PARAMS, fxKey,
} from '../model/fx.ts';
import type { Ns4Key } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';
import {
  activeScene, type SectionId, SECTION_FIELDS, SECTION_LAYERS, SECTIONS, sceneKey, SCENES, SCENE_KEY,
} from '../model/scene.ts';
import type { Change } from '../model/store.ts';
import type { MidiAccessLike } from './access.ts';
import {
  APPENDIX_II, type CcEntry, ccMessage, entryForKey, messagesFor, resolveTarget, scaleOut,
} from './cc-map.ts';
import {
  channelNibble, DEFAULT_MIDI_OUT, mayEmit, type MidiOutApi, type MidiOutputLike, type MidiOutPort,
  type MidiOutSettings, type MidiOutStatus, type SendKind,
} from './output.ts';

/** Where a play event came from: a note source, or the on-screen controllers ('screen'). */
export type PlaySource = NoteSource | 'screen';

/** A fader drag sends at most one value per field per this many ms (the last value wins). */
export const COALESCE_MS = 20;
/** Send all spaces its messages this far apart (a DIN cable carries about 1,000 messages per second). */
export const SEND_ALL_SPACING_MS = 1;
/** Send all hands the port this many messages per timer tick, so switching off stops it within one chunk. */
export const SEND_ALL_CHUNK = 32;

/** The print-out after send all (plan 15.5; feasibility 1c). */
export function sendAllText(count: number): string {
  return `sent ${count} controllers; the stage 4 receives no split, zone, morph, arp pattern, extern or sample `
    + 'setting over midi: use the .ns4p export for those';
}

/** The panel's line about the Stage 4's MIDI menu (p.62). */
export const STAGE4_MIDI_MENU_TEXT = "the stage 4's midi menu needs ctrl receive and cc & nrpn (p.62)";

type TimerHandle = unknown;

/** The clock and timers MidiOut uses; the defaults are performance.now and setTimeout. */
export interface MidiOutTiming {
  /** ms on the clock of MIDIOutput.send's timestamp (DOMHighResTimeStamp). */
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer: (handle: TimerHandle) => void;
}

const DEFAULT_TIMING: MidiOutTiming = {
  now: () => globalThis.performance.now(),
  setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Which sender's notes a channel holds, for panic and for switching a sender off. */
type NoteSender = 'notes' | 'extern';

/** Whether data is one complete channel-voice message (status 0x80..0xEF with 7-bit data): never SysEx or realtime. */
export function isChannelMessage(data: readonly number[]): boolean {
  const status = data[0];
  if (status === undefined || !Number.isInteger(status) || status < 0x80 || status > 0xef) return false;
  const kind = status & 0xf0;
  const length = kind === 0xc0 || kind === 0xd0 ? 2 : 3;
  if (data.length !== length) return false;
  for (let i = 1; i < length; i++) {
    const b = data[i]!;
    if (!Number.isInteger(b) || b < 0 || b > 127) return false;
  }
  return true;
}

/** Note on: [0x90 | ch, note, velocity 1..127]. */
export function noteOnMessage(channel: number, note: number, velocity: number): number[] {
  return [0x90 | (channel & 0x0f), note & 0x7f, Math.min(127, Math.max(1, Math.round(velocity)))];
}

/** Note off: [0x80 | ch, note, 0]. */
export function noteOffMessage(channel: number, note: number): number[] {
  return [0x80 | (channel & 0x0f), note & 0x7f, 0];
}

/** Pitch bend: -8192..8191 as the 14-bit value 0..16383, LSB first. */
export function bendMessage(channel: number, value: number): number[] {
  const v = Math.min(16383, Math.max(0, Math.round((Number.isFinite(value) ? value : 0) + 8192)));
  return [0xe0 | (channel & 0x0f), v & 0x7f, v >> 7];
}

/** Channel pressure (aftertouch): [0xD0 | ch, value]. */
export function pressureMessage(channel: number, value: number): number[] {
  return [0xd0 | (channel & 0x0f), Math.min(127, Math.max(0, Math.round(value)))];
}

/** CC1 wheel, CC11 control pedal (p.68: "Ctrl Pedal (Expression)"). */
export const CONTROLLER_CC = { wheel: 1, pedal: 11 } as const;
const CC_SUSTAIN = 64;
const CC_ALL_NOTES_OFF = 123;

/** The tracked focus keys: the six layer focus fields (both scenes) and the section FX focus. */
function isFocusKey(k: Ns4Key): boolean {
  if (k === FX_FOCUS_KEYS.section) return true;
  return SECTIONS.some((s) => SCENES.some((sc) => sceneKey(SECTION_FIELDS[s].focus, sc) === k));
}

/** One controller value to send: its entry, the field, the 7-bit value. */
interface Item {
  readonly entry: CcEntry;
  readonly key: Ns4Key;
  readonly value: number;
}

export class MidiOut implements MidiOutApi {
  #settings: MidiOutSettings = DEFAULT_MIDI_OUT;
  #status: MidiOutStatus = { kind: 'no-access' };
  readonly #values: ValueReader;
  readonly #timing: MidiOutTiming;
  #access: MidiAccessLike | null = null;
  /** Connected outputs at the last access announcement. */
  #ports: MidiOutputLike[] = [];
  /** Names of every port seen, for the port-gone status. */
  readonly #names = new Map<string, string>();
  readonly #statusListeners = new Set<(s: MidiOutStatus) => void>();
  readonly #settingsListeners = new Set<(s: MidiOutSettings) => void>();
  readonly #performanceListeners = new Set<(e: PlayEvent, from: PlaySource) => void>();
  /** Channels (0..15) each sender started notes or sustain on since the last panic. */
  readonly #noteChannels: Record<NoteSender, Set<number>> = { notes: new Set(), extern: new Set() };
  /** Notes "send notes" holds: note → the channel nibble it went out on and how many editor sources hold it. */
  readonly #held = new Map<number, { channel: number; count: number }>();
  /** What the Stage 4's focus fields were last set to by this sender (unknown until sent). */
  readonly #sentFocus = new Map<Ns4Key, number>();
  /** Coalescing: when each field last went out, and the value waiting for its 20 ms slot. */
  readonly #lastSent = new Map<Ns4Key, number>();
  readonly #pending = new Map<Ns4Key, number>();
  readonly #timers = new Map<Ns4Key, TimerHandle>();
  #sendAll: Promise<number> | null = null;
  /**
   * The timestamp (timing clock, ms) after the last message send all queued ahead: controller
   * values sent before then are queued behind it, so they never split one of its NRPN packages.
   */
  #queuedUntil = 0;
  /** Bumped by everything that must stop a running send all (switch off, port change). */
  #generation = 0;

  /**
   * `values`: the store (sending reads stored values, never morphed ones). `timing`: the clock
   * and timers (tests pass fakes).
   */
  constructor(values: ValueReader, timing: Partial<MidiOutTiming> = {}) {
    this.#values = values;
    this.#timing = { ...DEFAULT_TIMING, ...timing };
  }

  get settings(): MidiOutSettings {
    return this.#settings;
  }

  get status(): MidiOutStatus {
    return this.#status;
  }

  /** The connected output ports (also while the picked one is gone, so the picker can offer another). */
  get ports(): readonly MidiOutPort[] {
    return this.#ports.map((p) => ({ id: p.id, name: portName(p) }));
  }

  /** Whether send all is running (the key is disabled meanwhile). */
  get sending(): boolean {
    return this.#sendAll !== null;
  }

  /** The access from MidiInput.onAccess (null: no access). Called again after every port change. */
  setAccess(access: MidiAccessLike | null): void {
    this.#access = access;
    const ports: MidiOutputLike[] = [];
    access?.outputs?.forEach((p) => {
      if (p.state !== 'connected') return;
      ports.push(p);
      this.#names.set(p.id, portName(p));
    });
    this.#ports = ports;
    this.#updateStatus();
  }

  update(patch: Partial<MidiOutSettings>): void {
    const prev = this.#settings;
    const next: MidiOutSettings = {
      portId: patch.portId === undefined ? prev.portId : patch.portId,
      channel: validChannel(patch.channel) ? patch.channel : prev.channel,
      externChannels: {
        A: validChannel(patch.externChannels?.A) ? patch.externChannels.A : prev.externChannels.A,
        B: validChannel(patch.externChannels?.B) ? patch.externChannels.B : prev.externChannels.B,
        C: validChannel(patch.externChannels?.C) ? patch.externChannels.C : prev.externChannels.C,
      },
      sendControls: patch.sendControls ?? prev.sendControls,
      sendNotes: patch.sendNotes ?? prev.sendNotes,
      extern: patch.extern ?? prev.extern,
      echoToExtern: patch.echoToExtern ?? prev.echoToExtern,
    };
    // Clean up with the old settings (old port), before the change takes effect.
    if (next.portId !== prev.portId) {
      this.#cleanup('notes');
      this.#cleanup('extern');
    } else {
      if (prev.sendNotes && !next.sendNotes) this.#cleanup('notes');
      if (prev.extern && !next.extern) this.#cleanup('extern');
    }
    const controlsStop = (prev.sendControls && !next.sendControls) || next.portId !== prev.portId;
    if (controlsStop || (!prev.sendControls && next.sendControls)) {
      // Another device, or the device may have changed meanwhile: its focus is unknown again.
      this.#generation++;
      this.#sentFocus.clear();
      this.#dropPending();
    }
    const changed = JSON.stringify(next) !== JSON.stringify(prev);
    this.#settings = next;
    if (next.portId !== prev.portId) this.#updateStatus();
    if (changed) for (const fn of [...this.#settingsListeners]) fn(next);
  }

  /**
   * A store batch: edits made in the editor (origin 'ui' and 'derived') go out as their
   * controllers while send to stage 4 is on; fields without a controller send nothing. A load or
   * init drops values still waiting for their slot.
   */
  changes(batch: readonly Change[]): void {
    if (batch.some((c) => c.origin === 'load' || c.origin === 'init')) {
      this.#dropPending();
      return;
    }
    const now: Array<{ key: Ns4Key; value: number }> = [];
    for (const c of batch) {
      if (!mayEmit(this.#settings, { kind: 'control', origin: c.origin })) continue;
      if (entryForKey(c.key) === null) continue;
      if (this.#sendAll !== null) {
        // Waits until send all is done, so its focus switches and this value cannot interleave.
        this.#pending.set(c.key, c.value);
        continue;
      }
      const t = this.#timing.now();
      const last = this.#lastSent.get(c.key);
      if (this.#timers.has(c.key) || (last !== undefined && t - last < COALESCE_MS)) {
        this.#pending.set(c.key, c.value);
        if (!this.#timers.has(c.key)) {
          const wait = Math.max(0, COALESCE_MS - (t - (last ?? t)));
          this.#timers.set(c.key, this.#timing.setTimer(() => this.#flushKey(c.key), wait));
        }
        continue;
      }
      this.#pending.delete(c.key);
      this.#lastSent.set(c.key, t);
      now.push({ key: c.key, value: c.value });
    }
    if (now.length > 0) this.#emitControls(now);
  }

  /**
   * A play event from the bus. Notes go out on the global channel while send notes is on (their
   * own source decides; MIDI input never goes back out). Sustain, bend and the wheel, pressure and
   * pedal carry no source in the play event: `from` says where they came from, and without it they
   * count as MIDI input (not sent). Panic ends every note the editor sent. Sustain, bend and the
   * three controllers are handed on to the extern output (onPerformance) with their source.
   */
  play(e: PlayEvent, from?: PlaySource): void {
    const s = this.#settings;
    const ch = channelNibble(s.channel);
    switch (e.type) {
      case 'noteOn': {
        if (e.source === 'midi') return; // MIDI input never goes back out
        const held = this.#held.get(e.note);
        if (held !== undefined) {
          held.count++; // a second editor source on a sounding note: no restrike
          return;
        }
        if (this.#send(noteOnMessage(ch, e.note, e.velocity), { kind: 'note', source: e.source }, 'notes')) {
          this.#held.set(e.note, { channel: ch, count: 1 });
        }
        return;
      }
      case 'noteOff': {
        if (e.source === 'midi') return;
        const held = this.#held.get(e.note);
        if (held === undefined) return;
        if (--held.count > 0) return;
        this.#held.delete(e.note);
        // To the channel the note on went to, even when the channel setting changed meanwhile.
        this.#send(noteOffMessage(held.channel, e.note), { kind: 'note', source: e.source });
        return;
      }
      case 'panic':
        this.panic();
        return;
      case 'sustain':
      case 'bend':
      case 'controller': {
        const source = from ?? 'midi';
        const what: SendKind = { kind: 'performance', source };
        if (e.type === 'sustain') this.#send(ccMessage(ch, CC_SUSTAIN, e.on ? 127 : 0), what, 'notes');
        else if (e.type === 'bend') this.#send(bendMessage(ch, e.value), what);
        else if (e.kind === 'pressure') this.#send(pressureMessage(ch, e.value), what);
        else this.#send(ccMessage(ch, CONTROLLER_CC[e.kind], e.value), what);
        for (const fn of [...this.#performanceListeners]) {
          try {
            fn(e, source);
          } catch (err) {
            console.error(err);
          }
        }
        return;
      }
    }
  }

  /** Sustain, bend and controller events with their source (for midi/extern.ts). */
  onPerformance(fn: (e: PlayEvent, from: PlaySource) => void): () => void {
    this.#performanceListeners.add(fn);
    return () => {
      this.#performanceListeners.delete(fn);
    };
  }

  /**
   * Send one channel message to the picked port if mayEmit allows `what` (for midi/extern.ts;
   * default: extern program data). Returns whether it went out. A note on or sustain on is
   * remembered for panic.
   */
  send(data: readonly number[], what: SendKind = { kind: 'extern', source: 'program' }): boolean {
    return this.#send(data, what, what.kind === 'extern' ? 'extern' : what.kind === 'note' ? 'notes' : undefined);
  }

  /**
   * Send every documented controller of the current program (only with send to stage 4 on), in
   * the order of plan 15.5, paced 1 ms per message; resolves with the number of controller values
   * that went out. While it runs, calls return the same promise. Switching send to stage 4 off or
   * changing the port stops it within one chunk.
   */
  sendAll(): Promise<number> {
    if (this.#sendAll !== null) return this.#sendAll;
    if (!mayEmit(this.#settings, { kind: 'sendAll' }) || this.#port() === null) return Promise.resolve(0);
    const plan = this.#plan(this.#sendAllItems(), true);
    const generation = ++this.#generation;
    this.#dropTimers();
    let resolveRun!: (n: number) => void;
    const run = new Promise<number>((resolve) => {
      resolveRun = resolve;
    });
    this.#sendAll = run;
    const base = this.#timing.now();
    let index = 0;
    let done = 0;
    const finish = (): void => {
      if (generation !== this.#generation) this.#sentFocus.clear(); // stopped half way: the focus is unknown
      this.#sendAll = null;
      resolveRun(done);
      this.#flushPending();
    };
    const step = (): void => {
      const port = this.#port();
      if (generation !== this.#generation || !mayEmit(this.#settings, { kind: 'sendAll' }) || port === null) {
        finish();
        return;
      }
      const end = Math.min(plan.length, index + SEND_ALL_CHUNK);
      for (; index < end; index++) {
        const m = plan[index]!;
        const at = base + index * SEND_ALL_SPACING_MS;
        if (!this.#write(port, m.data, at)) {
          finish();
          return;
        }
        this.#queuedUntil = at + SEND_ALL_SPACING_MS;
        if (m.completes) done++;
      }
      if (index >= plan.length) finish();
      else this.#timing.setTimer(step, SEND_ALL_CHUNK * SEND_ALL_SPACING_MS);
    };
    step();
    return run;
  }

  onStatus(fn: (s: MidiOutStatus) => void): () => void {
    this.#statusListeners.add(fn);
    return () => {
      this.#statusListeners.delete(fn);
    };
  }

  onSettings(fn: (s: MidiOutSettings) => void): () => void {
    this.#settingsListeners.add(fn);
    return () => {
      this.#settingsListeners.delete(fn);
    };
  }

  /** All notes off (CC123) and sustain off (CC64 0) on every channel the editor sent notes on since the last panic. */
  panic(): void {
    this.#cleanup('notes');
    this.#cleanup('extern');
  }

  // --- internals -------------------------------------------------------------------------------

  #port(): MidiOutputLike | null {
    const id = this.#settings.portId;
    if (id === null) return null;
    const p = this.#ports.find((x) => x.id === id);
    return p !== undefined && p.state === 'connected' ? p : null;
  }

  /** One message to the port; false when the port refused it (it is then treated as gone). */
  #write(port: MidiOutputLike, data: readonly number[], timestamp?: number): boolean {
    if (!isChannelMessage(data)) throw new Error(`refusing to send ${JSON.stringify(data)}: not a channel message`);
    try {
      if (timestamp === undefined) port.send(data);
      else port.send(data, timestamp);
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  #send(data: readonly number[], what: SendKind, sender?: NoteSender): boolean {
    if (!mayEmit(this.#settings, what)) return false;
    const port = this.#port();
    if (port === null) return false;
    if (!this.#write(port, data)) return false;
    if (sender !== undefined && startsSound(data)) this.#noteChannels[sender].add(data[0]! & 0x0f);
    return true;
  }

  /** CC123 and CC64 0 on every channel a sender started notes on; needs only the port (it ends what the user started). */
  #cleanup(sender: NoteSender): void {
    const channels = this.#noteChannels[sender];
    if (sender === 'notes') this.#held.clear();
    if (channels.size === 0) return;
    const port = this.#port();
    for (const ch of [...channels].sort((a, b) => a - b)) {
      if (port === null) break;
      this.#write(port, ccMessage(ch, CC_ALL_NOTES_OFF, 0));
      this.#write(port, ccMessage(ch, CC_SUSTAIN, 0));
    }
    channels.clear();
  }

  #updateStatus(): void {
    let next: MidiOutStatus;
    const id = this.#settings.portId;
    if (this.#access === null) next = { kind: 'no-access' };
    else if (id !== null && !this.#ports.some((p) => p.id === id)) {
      next = { kind: 'port-gone', name: this.#names.get(id) ?? 'the picked output' };
    } else if (this.#ports.length === 0) next = { kind: 'no-outputs' };
    else next = { kind: 'ready', ports: this.ports };
    if (JSON.stringify(next) === JSON.stringify(this.#status)) return;
    if (next.kind === 'port-gone' || next.kind === 'no-access') this.#sentFocus.clear();
    this.#status = next;
    for (const fn of [...this.#statusListeners]) fn(next);
  }

  #flushKey(key: Ns4Key): void {
    this.#timers.delete(key);
    const value = this.#pending.get(key);
    if (value === undefined) return;
    this.#pending.delete(key);
    if (!mayEmit(this.#settings, { kind: 'control', origin: 'ui' })) return;
    this.#lastSent.set(key, this.#timing.now());
    this.#emitControls([{ key, value }]);
  }

  /** After send all: the values edited meanwhile, in one go. */
  #flushPending(): void {
    if (this.#pending.size === 0) return;
    const items = [...this.#pending].map(([key, value]) => ({ key, value }));
    this.#pending.clear();
    if (!mayEmit(this.#settings, { kind: 'control', origin: 'ui' })) return;
    const t = this.#timing.now();
    for (const { key } of items) this.#lastSent.set(key, t);
    this.#emitControls(items);
  }

  #dropTimers(): void {
    for (const h of this.#timers.values()) this.#timing.clearTimer(h);
    this.#timers.clear();
  }

  #dropPending(): void {
    this.#dropTimers();
    this.#pending.clear();
  }

  /** Send field values now, each after the focus it needs; afterwards the Stage 4 shows the editor's focus again. */
  #emitControls(fields: ReadonlyArray<{ key: Ns4Key; value: number }>): void {
    const items: Item[] = [];
    for (const f of fields) {
      const hit = entryForKey(f.key);
      if (hit === null) continue;
      items.push({ entry: hit.entry, key: f.key, value: scaleOut(hit.entry, f.key, f.value) });
    }
    const port = this.#port();
    if (port === null) return;
    // While send all's queued messages are still ahead, queue behind them (in order, 1 ms apart).
    let at = this.#queuedUntil > this.#timing.now() ? this.#queuedUntil : undefined;
    for (const m of this.#plan(items, false)) {
      if (!this.#write(port, m.data, at)) return;
      if (at !== undefined) this.#queuedUntil = at += SEND_ALL_SPACING_MS;
    }
  }

  /**
   * The messages for a list of controller values: before each layer or effects controller the
   * focus controllers that make the Stage 4 address the field's layer or block (only when they
   * differ from what was sent last), then the value; at the end the editor's own focus for every
   * focus this moved. `completes` marks the last message of each controller value (for counting).
   */
  #plan(items: readonly Item[], includeFocusInCount: boolean): Array<{ data: number[]; completes: boolean }> {
    const ch = channelNibble(this.#settings.channel);
    const out: Array<{ data: number[]; completes: boolean }> = [];
    const moved = new Set<Ns4Key>();
    const scene = activeScene(this.#values);
    const push = (item: Item, counts: boolean): void => {
      const msgs = messagesFor(item.entry, ch, item.value);
      msgs.forEach((data, i) => out.push({ data, completes: counts && i === msgs.length - 1 }));
      if (isFocusKey(item.key)) this.#sentFocus.set(item.key, item.value);
      // A layer focus of the active scene may move the Stage 4's FX focus too (the editor assumes
      // so: M p.48, cc-in.ts focusEntries, actions.ts layerFocusEntries): CC31 is unknown from
      // here on, so the next effects value sends it again.
      if (SECTIONS.some((sec) => sceneKey(SECTION_FIELDS[sec].focus, scene) === item.key)) {
        this.#sentFocus.delete(FX_FOCUS_KEYS.section);
      }
    };
    const focus = (key: Ns4Key, value: number): void => {
      if (this.#sentFocus.get(key) === value) return;
      const hit = entryForKey(key);
      if (hit === null) return;
      moved.add(key);
      push({ entry: hit.entry, key, value: scaleOut(hit.entry, key, value) }, includeFocusInCount);
    };
    const layerFocus = (section: SectionId, layer: string): void => {
      const idx = (SECTION_LAYERS[section] as readonly string[]).indexOf(layer);
      if (idx < 0) return;
      focus(sceneKey(SECTION_FIELDS[section].focus, scene), idx);
    };
    const focusKey = (section: SectionId): Ns4Key => sceneKey(SECTION_FIELDS[section].focus, scene);
    for (const item of items) {
      const hit = entryForKey(item.key);
      if (hit !== null) {
        const t = hit.entry.target;
        if (t.kind === 'layer' && hit.at.layer !== undefined) layerFocus(t.section, hit.at.layer);
        else if (t.kind === 'organVibratoType') {
          // 2:19 sets the vibrato type of the focused organ layer's model: focus a layer with the
          // model this field belongs to (the one in focus already if it has it); none has it → not sent.
          const layers = (SECTION_LAYERS.organ as readonly string[]).filter(
            (l) => resolveTarget(hit.entry, this.#values, { layer: l }) === item.key);
          const sent = SECTION_LAYERS.organ[this.#sentFocus.get(focusKey('organ')) ?? -1];
          const shown = SECTION_LAYERS.organ[this.#values.get(focusKey('organ'))];
          const layer = layers.find((l) => l === sent) ?? layers.find((l) => l === shown) ?? layers[0];
          if (layer === undefined) continue;
          layerFocus('organ', layer);
        }
        else if (t.kind === 'fx' && hit.at.block !== undefined) {
          const block: FxBlock = hit.at.block;
          const section = fxSectionOf(block);
          // The layer focus first: it may move the FX focus, so CC31 comes after it.
          if (section !== 'organ') layerFocus(section, fxLayersOf(block)[0]!);
          const [sectionEntry] = fxFocusEntries(block);
          focus(sectionEntry![0], sectionEntry![1]);
        }
      }
      push(item, true);
      if (isFocusKey(item.key)) moved.delete(item.key);
    }
    // Back to the focus the editor shows, for every focus field this list moved: the layer focus
    // first, CC31 last (a layer focus may move the FX focus, so CC31 before it might not hold).
    for (const key of [...moved].filter((k) => k !== FX_FOCUS_KEYS.section)) {
      const shown = this.#values.get(key);
      if (this.#sentFocus.get(key) !== shown) focus(key, shown);
    }
    if (moved.has(FX_FOCUS_KEYS.section)) {
      const shown = this.#values.get(FX_FOCUS_KEYS.section);
      if (this.#sentFocus.get(FX_FOCUS_KEYS.section) !== shown) focus(FX_FOCUS_KEYS.section, shown);
    }
    return out;
  }

  /**
   * Send all's controller values, in the order of plan 15.5: the active layer scene; per section
   * the scene I and II section, layer and focus controllers and its fixed controllers (levels,
   * pans, the filter group, the rotary); per layer its controllers (the focus goes first, added by
   * #plan); per effects block its controllers (FX focus first); the global effect switches; last
   * the focus the editor shows (CC31 and the layer focus of the active scene).
   */
  #sendAllItems(): Item[] {
    const v = this.#values;
    const items: Item[] = [];
    const seen = new Set<Ns4Key>();
    const add = (entry: CcEntry, key: Ns4Key | null): void => {
      if (key === null || seen.has(key)) return;
      seen.add(key);
      items.push({ entry, key, value: scaleOut(entry, key, v.get(key)) });
    };
    const fixed = (k: Ns4Key): void => {
      const hit = entryForKey(k);
      if (hit !== null) add(hit.entry, k);
    };
    fixed(SCENE_KEY);
    for (const section of SECTIONS) {
      const fields = SECTION_FIELDS[section];
      for (const field of [fields.on, fields.mask, fields.focus]) for (const sc of SCENES) fixed(sceneKey(field, sc));
      for (const entry of APPENDIX_II) {
        if (entry.target.kind === 'key' && entry.target.key.startsWith(`${section}.`)) add(entry, entry.target.key);
      }
    }
    for (const section of SECTIONS) {
      for (const layer of SECTION_LAYERS[section]) {
        for (const entry of APPENDIX_II) {
          const t = entry.target;
          // Layer keys: #plan puts the layer's focus first. The organ vibrato type follows the organ
          // model of the layer in focus; it comes after that layer's drawbars, so the focus is that layer.
          if ((t.kind === 'layer' && t.section === section) || (t.kind === 'organVibratoType' && section === 'organ')) {
            add(entry, resolveTarget(entry, v, { layer }));
          }
        }
      }
    }
    for (const block of FX_BLOCKS) for (const param of FX_PARAMS) fixed(fxKey(block, param));
    for (const k of GLOBAL_SWITCHES) fixed(k);
    // Last: the focus the editor shows (the layer and effects controllers above moved the Stage 4's).
    items.push(focusItem(FX_FOCUS_KEYS.section, v));
    for (const section of SECTIONS) items.push(focusItem(sceneKey(SECTION_FIELDS[section].focus, activeScene(v)), v));
    return items;
  }
}

/** The three global effect switches (p.48, CC 28–30). */
const GLOBAL_SWITCHES: readonly Ns4Key[] = ['common.effectsDlyGlobal', 'common.effectsRvbGlobal', 'common.effectsCmpGlobal'];

function focusItem(k: Ns4Key, v: ValueReader): Item {
  const entry = entryForKey(k)!.entry;
  return { entry, key: k, value: scaleOut(entry, k, v.get(k)) };
}

function validChannel(c: number | undefined): c is number {
  return c !== undefined && Number.isInteger(c) && c >= 1 && c <= 16;
}

function portName(p: MidiOutputLike): string {
  return p.name !== null && p.name !== '' ? p.name : 'unnamed output';
}

/** A note on with velocity > 0, or sustain on: something panic must end. */
function startsSound(data: readonly number[]): boolean {
  const kind = data[0]! & 0xf0;
  if (kind === 0x90) return (data[2] ?? 0) > 0;
  return kind === 0xb0 && data[1] === CC_SUSTAIN && (data[2] ?? 0) >= 64;
}
