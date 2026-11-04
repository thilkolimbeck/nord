/**
 * The AudioWorklet voice engine (plan section 15.7): loads the processor module once per context
 * and offers a source provider (band-limited Sync, Shape, Shape Sine, Multi, Super; M p.29–30) and
 * a filter provider (the LP M ladder, M p.31, and the drive stage, M p.32). Until the module has
 * loaded, where AudioWorklet is missing, after addModule failed and after a processor reported an
 * error, both providers decline and the native voice plays (with its coarse markers). A voice
 * started before the module loaded keeps its native graph until its source or filter is rebuilt.
 *
 * Per voice: one 'nord-osc' node (unison copies inside) for a worklet category, and one
 * 'nord-filter' node only for LP M or an active drive; Pure, Sub, Misc, FM and the plain filter
 * types stay native. The voice's pitch, osc ctrl and cutoff sources connect to the nodes'
 * parameters as they do to the native detune parameters.
 */
import { driveGain, type FilterSpec, resonanceQ } from '../mapping.ts';
import type { OscGraph } from '../oscillators.ts';
import type { FilterProvider, FilterRequest, FilterStage, SourceProvider, SourceRequest } from '../sources.ts';
import { buildBiquads } from '../voice.ts';
import {
  FILTER_NODE_OPTIONS, FILTER_PROCESSOR, type FilterOptions, type FromProcessor, OSC_NODE_OPTIONS, OSC_PROCESSOR,
  type OscOptions, supportsAudioWorklet, type ToProcessor, type WorkletHost, workletKind,
} from './protocol.ts';

export interface WorkletVoices {
  readonly sources: SourceProvider;
  readonly filters: FilterProvider;
  /**
   * True once the module is loaded and no processor has failed: the coarse markers go
   * (mapping.ts coarsePatterns). It turns false again after a processor error.
   */
  readonly ready: boolean;
  /** Load the processor module (same-origin URL); resolves false when unsupported or refused. */
  load(moduleUrl: string): Promise<boolean>;
  /** Called whenever `ready` changes (the module loaded, a processor failed); returns the unsubscribe function. */
  onReadyChange(fn: (ready: boolean) => void): () => void;
}

/** Time constant of live filter changes (as the native voice). */
const SMOOTH = 0.01;

const Q_MIN = resonanceQ(0);
const Q_MAX = resonanceQ(127);

/**
 * The ladder's resonance 0..1 from the voice's filter spec: the res knob's position, read back from
 * the Q curve the native biquads use (mapping.ts resonanceQ), so both engines share one knob scale.
 * Unverified: the ladder self-oscillates from 0.9 (dsp.ts LADDER_FEEDBACK).
 */
export function ladderResonance(q: number): number {
  const r = Math.log(q / Q_MIN) / Math.log(Q_MAX / Q_MIN);
  return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
}

/** The parameter values of a filter node for a spec. */
export function filterParams(spec: FilterSpec): { frequency: number; resonance: number; drive: number } {
  return { frequency: spec.freq, resonance: ladderResonance(spec.q), drive: driveGain(spec.drive) };
}

function unlink(from: AudioNode, to: AudioParam): void {
  try {
    from.disconnect(to);
  } catch {
    // Not connected (any more).
  }
}

function param(node: AudioWorkletNode, name: string): AudioParam | null {
  return node.parameters.get(name) ?? null;
}

export function createWorkletVoices(ctx: BaseAudioContext): WorkletVoices {
  let loaded = false;
  let broken = false;
  let loading: Promise<boolean> | null = null;
  let seed = 0x9e3779b9;
  const listeners = new Set<(ready: boolean) => void>();

  const usable = (): boolean => loaded && !broken;

  const notify = (): void => {
    const ready = usable();
    for (const fn of [...listeners]) fn(ready);
  };

  const fail = (why: string): void => {
    if (broken) return;
    const was = usable();
    broken = true;
    console.warn(`nord: the AudioWorklet engine stopped (${why}); new voices use the native engine`);
    if (was) notify();
  };

  const watch = (node: AudioWorkletNode): void => {
    node.onprocessorerror = () => fail('a processor failed');
    node.port.onmessage = (event: MessageEvent) => {
      const m = event.data as FromProcessor | undefined;
      if (m?.type === 'error') fail(m.message);
    };
  };

  const post = (node: AudioWorkletNode, message: ToProcessor): void => {
    node.port.postMessage(message);
  };

  const create = (name: string, options: AudioWorkletNodeOptions): AudioWorkletNode | null => {
    try {
      const node = new AudioWorkletNode(ctx, name, options);
      watch(node);
      return node;
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const sources: SourceProvider = {
    id: 'worklet',
    covers: () => false,
    build(req: SourceRequest): OscGraph | null {
      if (!usable() || !('bank' in req.spec)) return null;
      const kind = workletKind(req.spec);
      if (kind === null) return null;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const processorOptions: OscOptions = {
        kind, wave: Math.min(127, Math.max(0, Math.round(req.spec.wave))),
        copies: Math.min(4, Math.max(1, Math.round(req.unison.copies))),
        spreadCents: Math.max(0, req.unison.spreadCents), seed,
      };
      const node = create(OSC_PROCESSOR, {
        numberOfInputs: OSC_NODE_OPTIONS.numberOfInputs, numberOfOutputs: OSC_NODE_OPTIONS.numberOfOutputs,
        outputChannelCount: [...OSC_NODE_OPTIONS.outputChannelCount], processorOptions,
      });
      const pitch = node === null ? null : param(node, 'pitch');
      const ctrl = node === null ? null : param(node, 'ctrl');
      if (node === null || pitch === null || ctrl === null) return null;
      req.inputs.pitch.connect(pitch);
      req.inputs.ctrl.connect(ctrl);
      // The graph's clock: a silent source pulled through the pitch parameter (it adds 0), started
      // and stopped with the voice; its onended is the graph's.
      const clock = ctx.createConstantSource();
      clock.offset.value = 0;
      clock.connect(pitch);
      const output = ctx.createGain();
      node.connect(output);
      let gone = false;
      return {
        output,
        start: (t) => clock.start(t),
        stop(t: number): void {
          clock.stop(t);
          post(node, { type: 'end', at: t });
        },
        onEnded(fn: () => void): void {
          clock.onended = () => {
            clock.onended = null;
            fn();
          };
        },
        // Osc ctrl and pitch reach the processor per sample through the parameters.
        setCtrl: () => undefined,
        retune: () => undefined,
        disconnect(): void {
          if (gone) return;
          gone = true;
          unlink(req.inputs.pitch, pitch);
          unlink(req.inputs.ctrl, ctrl);
          clock.disconnect();
          node.disconnect();
          output.disconnect();
          post(node, { type: 'end', at: 0 });
        },
      };
    },
  };

  const filters: FilterProvider = {
    id: 'worklet',
    build(req: FilterRequest): FilterStage | null {
      const spec = req.spec;
      if (!usable() || !spec.enabled) return null;
      const ladder = spec.type === 'lpm';
      if (!ladder && spec.drive <= 0) return null;
      const values = filterParams(spec);
      const processorOptions: FilterOptions = { mode: ladder ? 'ladder' : 'drive' };
      const node = create(FILTER_PROCESSOR, {
        numberOfInputs: FILTER_NODE_OPTIONS.numberOfInputs, numberOfOutputs: FILTER_NODE_OPTIONS.numberOfOutputs,
        outputChannelCount: [...FILTER_NODE_OPTIONS.outputChannelCount], processorOptions,
        parameterData: values,
      });
      if (node === null) return null;
      const frequency = param(node, 'frequency');
      const detune = param(node, 'detune');
      const resonance = param(node, 'resonance');
      const drive = param(node, 'drive');
      if (frequency === null || detune === null || resonance === null || drive === null) return null;
      if (ladder) req.cutoff.connect(detune);
      // Drive alone: the native biquads of the other types follow the worklet's drive stage.
      const net = ladder ? null : buildBiquads(ctx, spec, req.cutoff);
      const output = net === null ? node : net.attach(node);
      return {
        input: node,
        output,
        update(next: FilterSpec, t: number): void {
          const v = filterParams(next);
          frequency.setTargetAtTime(v.frequency, t, SMOOTH);
          resonance.setValueAtTime(v.resonance, t);
          drive.setValueAtTime(v.drive, t);
          net?.update(next, t);
        },
        disconnect(): void {
          if (ladder) unlink(req.cutoff, detune);
          node.disconnect();
          net?.disconnect();
        },
      };
    },
  };

  return {
    sources,
    filters,
    get ready(): boolean {
      return usable();
    },
    load(moduleUrl: string): Promise<boolean> {
      if (loading !== null) return loading;
      const host = ctx as unknown as WorkletHost;
      if (!supportsAudioWorklet(host) || host.audioWorklet === undefined) {
        loading = Promise.resolve(false);
        return loading;
      }
      loading = host.audioWorklet.addModule(moduleUrl).then(() => {
        loaded = true;
        if (usable()) notify();
        return true;
      }, (err: unknown) => {
        console.warn('nord: the AudioWorklet module did not load; the native engine plays', err);
        return false;
      });
      return loading;
    },
    onReadyChange(fn: (ready: boolean) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
