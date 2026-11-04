/**
 * Plan section 15.1, shared hook plumbing (frozen with the interfaces): every section engine puts
 * one effects chain per block between a layer's output and the section output, forwards batches,
 * controllers, panic and dispose to it, and wires "To Rotary" sends to the organ's rotary; without
 * hooks the graph is the one of section 13. Also the extern tee (15.6) and the note source the
 * router now passes along.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSynthFactory, SynthEngine } from '../../src/editor/audio/engine.ts';
import {
  type FxChain, type FxChainFactory, type FxContext, type FxHooks, passThroughChain, passThroughGlobal,
} from '../../src/editor/audio/fx/types.ts';
import { OrganEngine } from '../../src/editor/audio/organ/engine.ts';
import { PianoEngine } from '../../src/editor/audio/piano/engine.ts';
import { Router } from '../../src/editor/audio/router.ts';
import type { SectionContext, SectionEngine, SectionEvent } from '../../src/editor/audio/section.ts';
import { teeSection } from '../../src/editor/audio/tee.ts';
import type { FxBlock } from '../../src/editor/model/fx.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { SynthLayer } from '../../src/editor/model/keys.ts';
import type { Change } from '../../src/editor/model/store.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import {
  asContext, asNode, FakeContext, FakeGain, type FakeNode, FakeStereoPanner, installAudioGlobals,
} from './fake-audio.ts';

installAudioGlobals();

interface Recorded {
  readonly block: FxBlock;
  readonly input: FakeGain;
  readonly output: FakeGain;
  readonly send: FakeGain | null;
  readonly batches: Array<readonly Change[]>;
  readonly controllers: Array<[string, number]>;
  silenced: number;
  disposed: boolean;
}

/** A chain factory that records what the engines do with their chains. */
function recorder(ctx: FakeContext, withSend: boolean): { factory: FxChainFactory; chains: Recorded[] } {
  const chains: Recorded[] = [];
  const factory = (c: FxContext): FxChain => {
    const r: Recorded = {
      block: c.block, input: new FakeGain(ctx), output: new FakeGain(ctx),
      send: withSend && c.block !== 'organFx' ? new FakeGain(ctx) : null,
      batches: [], controllers: [], silenced: 0, disposed: false,
    };
    chains.push(r);
    return {
      block: c.block, input: asNode(r.input), output: asNode(r.output), rotarySend: r.send === null ? null : asNode(r.send),
      applyChanges: (b) => void r.batches.push(b),
      controller: (kind, value) => void r.controllers.push([kind, value]),
      silence: () => void r.silenced++,
      dispose: () => void (r.disposed = true),
    };
  };
  return { factory, chains };
}

/** The shared fake, also keeping the StereoPannerNodes it made. */
class PannerContext extends FakeContext {
  readonly panners: FakeStereoPanner[] = [];
  override createStereoPanner(): FakeStereoPanner {
    const p = super.createStereoPanner();
    this.panners.push(p);
    return p;
  }
}

function rig(withSend = true) {
  const ctx = new PannerContext();
  const out = new FakeGain(ctx);
  const rotaryIn = new FakeGain(ctx);
  const store = new ParamStore(initProgram());
  const { factory, chains } = recorder(ctx, withSend);
  const fx: FxHooks = { chain: factory, rotary: () => asNode(rotaryIn), clock: null };
  const c: SectionContext = { ctx: asContext(ctx), values: store, out: asNode(out), fx };
  return { ctx, out, rotaryIn, store, chains, c };
}

const byBlock = (chains: readonly Recorded[], block: FxBlock): Recorded => {
  const r = chains.find((x) => x.block === block);
  assert.ok(r, block);
  return r;
};

test('the synth builds one chain per layer between its pan and the section output', () => {
  const { ctx, out, rotaryIn, chains, c } = rig();
  const synth = makeSynthFactory()(c) as SynthEngine;
  assert.deepEqual(chains.map((r) => r.block), ['synthAFx', 'synthBFx', 'synthCFx']);
  for (const r of chains) {
    assert.ok(r.output.outputs.has(out), `${r.block} output → out`);
    assert.ok(r.send!.outputs.has(rotaryIn), `${r.block} rotary send → rotary`);
  }
  const pans = (ctx as PannerContext).panners;
  assert.equal(pans.length, 3);
  pans.forEach((p, i) => assert.ok(p.outputs.has(chains[i]!.input), `layer ${'ABC'[i]} pan → its chain`));
  assert.ok(pans.every((p) => !p.outputs.has(out)), 'no pan bypasses its chain');
  synth.dispose();
  assert.ok(chains.every((r) => r.disposed));
});

test('the piano builds one chain per layer, the organ one shared chain before direct and rotary', () => {
  const { out, chains, c } = rig();
  const piano = new PianoEngine(c);
  const organ = new OrganEngine(c);
  assert.deepEqual(chains.map((r) => r.block), ['pianoAFx', 'pianoBFx', 'organFx']);
  for (const b of ['pianoAFx', 'pianoBFx'] as const) assert.ok(byBlock(chains, b).output.outputs.has(out));
  const organFx = byBlock(chains, 'organFx');
  assert.equal(organFx.send, null, 'organFx has no To Rotary send: the organ has its own rotary switch');
  assert.equal(organFx.output.outputs.size, 2, 'organ chain → direct and rotary send');
  assert.ok((organ.rotaryInput as unknown as FakeNode) !== undefined);
  piano.dispose();
  organ.dispose();
  assert.ok(chains.every((r) => r.disposed));
});

test('engines forward batches (before their own reload), controllers and panic to their chains', () => {
  const { store, chains, c } = rig();
  const synth = makeSynthFactory()(c);
  const piano = new PianoEngine(c);
  const organ = new OrganEngine(c);
  const engines: SectionEngine[] = [synth, piano, organ];
  store.onChange((batch) => engines.forEach((e) => e.applyChanges(batch)));
  store.set('synthAFx.dlyMix', 100);
  store.load(initProgram(), 'load');
  for (const r of chains) {
    assert.equal(r.batches.length, 2, r.block);
    assert.equal(r.batches[0]![0]!.key, 'synthAFx.dlyMix');
    assert.equal(r.batches[1]![0]!.origin, 'load');
  }
  for (const e of engines) e.handle({ type: 'controller', kind: 'pedal', value: 100 });
  for (const r of chains) assert.deepEqual(r.controllers, [['pedal', 100]], r.block);
  const before = chains.map((r) => r.silenced);
  for (const e of engines) e.panic();
  chains.forEach((r, i) => assert.ok(r.silenced > before[i]!, `${r.block} silenced on panic`));
});

test('without hooks a layer connects straight to the output (the graph of section 13)', () => {
  const ctx = new PannerContext();
  const out = new FakeGain(ctx);
  const store = new ParamStore(initProgram());
  const synth = new SynthEngine(asContext(ctx), store, undefined, asNode(out));
  assert.equal(ctx.panners.length, 3);
  assert.ok(ctx.panners.every((p) => p.outputs.has(out)), 'pan → out, no chain between');
  // Effects keys reach an engine without hooks harmlessly.
  synth.applyChanges([{ key: 'synthAFx.rvbAmt', value: 99, previous: 0, origin: 'ui' }]);
  synth.dispose();
});

test('pass-through chain and global units change nothing', () => {
  const ctx = new FakeContext();
  const out = new FakeGain(ctx);
  const store = new ParamStore(initProgram());
  const chain = passThroughChain({ ctx: asContext(ctx), values: store, block: 'synthAFx', clock: null });
  assert.equal(chain.input, chain.output);
  assert.equal(chain.rotarySend, null);
  const global = passThroughGlobal({ ctx: asContext(ctx), values: store, out: asNode(out), clock: null });
  assert.ok((global.input as unknown as FakeNode).outputs.has(out));
  global.dispose();
  assert.equal((global.input as unknown as FakeNode).outputs.size, 0);
});

test('teeSection hands the sink every event after the engine; a throwing sink cannot stop the sound', () => {
  const seen: string[] = [];
  const engine: SectionEngine<'synth'> = {
    section: 'synth', activeCount: 3,
    handle: (e) => void seen.push(`engine ${e.type}`), applyChanges: () => void seen.push('engine batch'),
    panic: () => void seen.push('engine panic'), reload: () => void seen.push('engine reload'),
    dispose: () => void seen.push('engine dispose'),
  };
  const sink = {
    handle: (e: SectionEvent<SynthLayer>) => {
      seen.push(`sink ${e.type}`);
      if (e.type === 'bend') throw new Error('sink failure');
    },
    applyChanges: () => void seen.push('sink batch'),
    panic: () => void seen.push('sink panic'),
  };
  const tee = teeSection(engine, sink);
  const error = console.error;
  console.error = () => undefined;
  try {
    tee.handle({ type: 'noteOn', key: 60, note: 60, velocity: 90, layers: [{ layer: 'A', gain: 1 }] });
    tee.handle({ type: 'bend', value: 10 });
    tee.applyChanges([]);
    tee.reload();
    tee.panic();
  } finally {
    console.error = error;
  }
  assert.deepEqual(seen, ['engine noteOn', 'sink noteOn', 'engine bend', 'sink bend', 'engine batch', 'sink batch',
    'engine reload', 'sink panic', 'engine panic', 'sink panic']);
  assert.equal(tee.activeCount, 3);
  assert.equal(tee.section, 'synth');
});

test('the router passes the note source on to the engines', () => {
  const store = new ParamStore(initProgram());
  const events: Array<SectionEvent<SynthLayer>> = [];
  const synth: SectionEngine<'synth'> = {
    section: 'synth', activeCount: 0, handle: (e) => void events.push(e), applyChanges: () => undefined,
    panic: () => undefined, reload: () => undefined, dispose: () => undefined,
  };
  const router = new Router(store, { synth });
  router.handle({ type: 'noteOn', note: 60, velocity: 100, source: 'pointer' });
  const on = events[0];
  assert.ok(on !== undefined && on.type === 'noteOn');
  assert.equal(on.source, 'pointer');
});
