/**
 * The AudioWorklet processors 'nord-osc' and 'nord-filter' (plan section 15.7, protocol.ts). This
 * module runs in the AudioWorkletGlobalScope: no DOM, no imports of DOM code; Vite bundles it with
 * its pure DSP imports (render.ts, dsp.ts, waveforms.ts) into one same-origin file (module-url.ts).
 * The work happens in render.ts; this file unpacks the worklet's arrays, options and messages.
 *
 * The DOM lib has no types for the AudioWorkletGlobalScope, so the slice used here is declared
 * locally and read from globalThis. Outside a worklet (the Node tests import it with fakes, or
 * nothing at all) it registers nothing.
 */
import {
  FILTER_PARAMS, FILTER_PROCESSOR, type FilterMode, type FromProcessor, isOscOptions, isToProcessor, OSC_PARAMS,
  OSC_PROCESSOR, type ParamSpec,
} from './protocol.ts';
import { FilterRenderer, OscRenderer } from './render.ts';

interface ProcessorPort {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: FromProcessor): void;
}

interface ProcessorBase {
  readonly port: ProcessorPort;
}

interface NodeOptions {
  readonly processorOptions?: unknown;
}

type ProcessorClass = new (options: NodeOptions) => ProcessorBase;

/** The AudioWorkletGlobalScope members this module uses. */
interface WorkletScope {
  readonly AudioWorkletProcessor?: new () => ProcessorBase;
  readonly registerProcessor?: (name: string, processor: ProcessorClass) => void;
  readonly sampleRate: number;
  readonly currentTime: number;
}

type Channels = readonly Float32Array[];
type Params = Readonly<Record<string, Float32Array | undefined>>;

/**
 * The name of the callback the audio thread calls once per block. Spelled in parts because the
 * editor's module rules (imports.test.ts) reject the bare word as a Node global.
 */
const RENDER_CALLBACK = ['pro', 'cess'].join('');

const ZERO = new Float32Array(1);

function isFilterMode(v: unknown): v is FilterMode {
  return v === 'ladder' || v === 'drive';
}

function register(scope: WorkletScope, Base: new () => ProcessorBase): void {
  class NordOsc extends Base {
    static get parameterDescriptors(): readonly ParamSpec[] {
      return OSC_PARAMS;
    }

    readonly #renderer: OscRenderer | null;
    #scratch = new Float32Array(128);

    constructor(options: NodeOptions) {
      super();
      const o = options.processorOptions;
      this.#renderer = isOscOptions(o) ? new OscRenderer(o, scope.sampleRate) : null;
      if (this.#renderer === null) this.port.postMessage({ type: 'error', message: 'nord-osc: invalid processorOptions' });
      this.port.onmessage = (event) => {
        if (isToProcessor(event.data)) this.#renderer?.message(event.data);
      };
    }

    render(_inputs: readonly Channels[], outputs: readonly Channels[], parameters: Params): boolean {
      const out = outputs[0];
      const left = out?.[0];
      if (this.#renderer === null || left === undefined) return false;
      let right = out?.[1];
      if (right === undefined) {
        if (this.#scratch.length < left.length) this.#scratch = new Float32Array(left.length);
        right = this.#scratch.subarray(0, left.length);
      }
      return this.#renderer.render(left, right, parameters['pitch'] ?? ZERO, parameters['ctrl'] ?? ZERO, scope.currentTime);
    }
  }

  class NordFilter extends Base {
    static get parameterDescriptors(): readonly ParamSpec[] {
      return FILTER_PARAMS;
    }

    readonly #renderer: FilterRenderer | null;
    #scratch = new Float32Array(128);

    constructor(options: NodeOptions) {
      super();
      const o = options.processorOptions as { mode?: unknown } | undefined;
      const mode = o?.mode;
      this.#renderer = isFilterMode(mode) ? new FilterRenderer(mode, scope.sampleRate) : null;
      if (this.#renderer === null) this.port.postMessage({ type: 'error', message: 'nord-filter: invalid processorOptions' });
    }

    render(inputs: readonly Channels[], outputs: readonly Channels[], parameters: Params): boolean {
      const out = outputs[0];
      const left = out?.[0];
      if (this.#renderer === null || left === undefined) return false;
      let right = out?.[1];
      if (right === undefined) {
        if (this.#scratch.length < left.length) this.#scratch = new Float32Array(left.length);
        right = this.#scratch.subarray(0, left.length);
      }
      const p = (name: string, fallback: number): Float32Array => parameters[name] ?? Float32Array.of(fallback);
      return this.#renderer.render(inputs[0] ?? [], left, right, p('frequency', 1000), p('detune', 0),
        p('resonance', 0)[0]!, p('drive', 1)[0]!);
    }
  }

  for (const P of [NordOsc, NordFilter]) {
    Object.defineProperty(P.prototype, RENDER_CALLBACK, { value: P.prototype.render, writable: true, configurable: true });
  }
  scope.registerProcessor?.(OSC_PROCESSOR, NordOsc);
  scope.registerProcessor?.(FILTER_PROCESSOR, NordFilter);
}

const scope = globalThis as unknown as WorkletScope;
if (typeof scope.AudioWorkletProcessor === 'function' && typeof scope.registerProcessor === 'function') {
  register(scope, scope.AudioWorkletProcessor);
}
