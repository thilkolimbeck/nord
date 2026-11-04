/**
 * The program, organ and piano regions without the DOM (plan section 13.6, B4): which key a panel
 * control shows for the focused layer and the active scene, the approximation marker, drawbar
 * captions per organ model, the piano model list, the scene and section keys, and the model
 * actions behind them (setSectionEnabled, setLayerEnabled per section, setPianoModel,
 * setPianoType, setSplitPoint).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  setLayerEnabled, setOscBank, setPianoModel, setPianoType, setSectionEnabled, setSplitPoint, splitPointOn,
} from '../../src/editor/model/actions.ts';
import { splitBoundaries } from '../../src/editor/audio/router.ts';
import { descriptorOf, DESCRIPTORS, formatValue } from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { NS4_KEYS, type Ns4Key } from '../../src/editor/model/keys.ts';
import { modelsOfType, PIANO_MODELS, pianoModel, PIANO_TYPES } from '../../src/editor/model/pianos.ts';
import { keysOf, PANEL } from '../../src/editor/model/sections.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import {
  boundKey, controlPattern, descriptionText, displayParamLine, displayStateLine, isApprox, keyForScene,
  keyForSectionLayer, sectionLayerOf, shownDeps, shownValue, valueView, writeControl,
} from '../../src/editor/ui/control-model.ts';
import {
  drawbarLabels, MODEL_GROUPS, modelChoice, modelText, morphCountText, ORGAN_MODELS, organModel, sceneKeys, sectionKeys,
  unknownModelText, variationUsed, vibratoTypeKey,
} from '../../src/editor/ui/region-model.ts';

const store = (): ParamStore => new ParamStore(initProgram());

test('organ and piano layer keys map to the other layer; other keys stay', () => {
  assert.equal(keyForSectionLayer('organA.model', 'B'), 'organB.model');
  assert.equal(keyForSectionLayer('organBDrawbars.org_Preset_kDb4', 'A'), 'organADrawbars.org_Preset_kDb4');
  assert.equal(keyForSectionLayer('organAVibPerc.org_Preset_kB3PercEnable', 'B'), 'organBVibPerc.org_Preset_kB3PercEnable');
  assert.equal(keyForSectionLayer('organ.layerLevelOrgA', 'B'), 'organ.layerLevelOrgB');
  assert.equal(keyForSectionLayer('pianoB.eq', 'A'), 'pianoA.eq');
  assert.equal(keyForSectionLayer('piano.layerLevelPnoB', 'A'), 'piano.layerLevelPnoA');
  assert.equal(keyForSectionLayer('organ.vibratoTypeB3', 'B'), 'organ.vibratoTypeB3');
  assert.equal(keyForSectionLayer('pianoAFx.rvbEnable', 'B'), 'pianoAFx.rvbEnable', 'effects blocks are not layer controls');
  assert.deepEqual(sectionLayerOf('piano.layerLevelPnoB'), { section: 'piano', layer: 'B' });
  assert.deepEqual(sectionLayerOf('organBDrawbars.org_Preset_kDb1'), { section: 'organ', layer: 'B' });
  assert.equal(sectionLayerOf('synthA.mode'), null);
  // Every organ and piano layer group maps one to one onto the other layer.
  for (const id of ['organ-a', 'piano-a'] as const) {
    const g = PANEL.flatMap((r) => r.groups).find((x) => x.id === id)!;
    const other = PANEL.flatMap((r) => r.groups).find((x) => x.id === id.replace('-a', '-b'))!;
    assert.deepEqual(keysOf(g, null).map((k) => keyForSectionLayer(k, 'B')), keysOf(other, null), id);
  }
});

test('control patterns are free of layer and scene', () => {
  assert.equal(controlPattern('synthBSound.fltFreq'), 'synth{L}Sound.fltFreq');
  assert.equal(controlPattern('organB.model'), 'organ{L}.model');
  assert.equal(controlPattern('piano.layerLevelPnoA'), 'piano.layerLevelPno{L}');
  assert.equal(controlPattern('common.sectionEnableOrg_II'), 'common.sectionEnableOrg');
  assert.equal(controlPattern('synth.layerFocusSyn_I'), 'synth.layerFocusSyn');
  assert.equal(controlPattern('common.transposeValue'), 'common.transposeValue');
  assert.equal(keyForScene('piano.layerEnablePno_I', 'II'), 'piano.layerEnablePno_II');
  assert.equal(keyForScene('pianoA.eq', 'II'), 'pianoA.eq');
});

test('panels bind to the focused layer of the active scene, and follow a scene switch', () => {
  const s = store();
  assert.equal(boundKey('organ', 'organA.model', s), 'organA.model');
  assert.equal(boundKey('synth', 'common.sectionEnableSyn_I', s), 'common.sectionEnableSyn_I');
  // Scene I focuses organ B; scene II keeps focus A.
  s.set('organ.layerFocusOrg_I', 1);
  assert.equal(boundKey('organ', 'organA.model', s), 'organB.model');
  assert.equal(boundKey('organ', 'organ.layerLevelOrgA', s), 'organ.layerLevelOrgB');
  s.set('common.layerScene', 1);
  assert.equal(boundKey('organ', 'organB.model', s), 'organA.model');
  assert.equal(boundKey('organ', 'common.sectionEnableOrg_I', s), 'common.sectionEnableOrg_II');
  assert.equal(boundKey('piano', 'piano.layerEnablePno_I', s), 'piano.layerEnablePno_II');
  s.set('synth.layerFocusSyn_II', 2);
  assert.equal(boundKey('synth', 'synthASound.fltFreq', s), 'synthCSound.fltFreq');
  assert.equal(boundKey('synth', 'synth.layerFocusSyn_I', s), 'synth.layerFocusSyn_II');
  s.set('common.layerScene', 0);
  assert.equal(boundKey('synth', 'synthCSound.fltFreq', s), 'synthASound.fltFreq');
  assert.equal(boundKey('synth', 'common.sectionEnableSyn_II', s), 'common.sectionEnableSyn_I');
  // Every field a panel shows in scene II exists and is described.
  s.set('common.layerScene', 1);
  for (const r of PANEL.filter((x) => ['organ', 'piano', 'synth'].includes(x.id))) {
    for (const g of r.groups) {
      for (const k of keysOf(g, 'A')) assert.ok(DESCRIPTORS.has(boundKey(r.id as 'organ', k, s)), k);
    }
  }
});

test('sound-affecting organ and piano controls carry the approximation marker', () => {
  const s = store();
  for (const key of ['organB.model', 'organADrawbars.org_Preset_kDb2', 'organ.effectsLeslieSpeed', 'organ.vibratoTypeVox',
    'pianoA.bank', 'pianoB.nameHash', 'pianoA.eq', 'pianoA.kbdTouch', 'pianoB.acoustic'] as const) {
    assert.ok(isApprox(descriptorOf(key)), key);
  }
  for (const key of ['organ.layerLevelOrgA', 'organA.octaveShift', 'organA.kbZone', 'common.sectionEnablePno_I',
    'piano.layerFocusPno_I', 'pianoA.sustainEnable', 'pianoA.entry', 'organA.presetEnable', 'organ.leslieStopPreset',
    'synthASound.fltFreq', 'common.transposeValue'] as const) {
    assert.ok(!isApprox(descriptorOf(key)), key);
  }
  const model = descriptorOf('organA.model');
  assert.deepEqual(valueView(model, 1, s), { text: 'VOX', nv: false, coarse: false, stored: false, approx: true, suffixes: ['≈'] });
  assert.ok(/approximation: an additive model/.test(descriptionText(model, 1, s)));
  const eq = descriptorOf('pianoB.eq');
  assert.deepEqual(valueView(eq, 2, s).suffixes, ['nv', '≈']);
  assert.ok(/approximation: synthesized in the browser, no Nord samples/.test(descriptionText(eq, 2, s)));
  assert.equal(displayParamLine(model, 1, s), 'organ a · model · VOX ≈ · B3–B3 BASS');
  assert.equal(displayParamLine(descriptorOf('piano.layerLevelPnoB'), 127, s), 'piano b · level · 0.0 dB · volume off–0.0 dB');
  assert.equal(displayParamLine(descriptorOf('organ.layerEnableOrg_II'), 3, s), 'organ · layers on · scene ii · A+B · none–A+B');
  assert.equal(displayStateLine(model, 1, s, 1), 'approximation · edited 1');
});

test('drawbar captions follow the organ model', () => {
  assert.deepEqual(ORGAN_MODELS.map((_, i) => organModel(i)), ['B3', 'VOX', 'FARF', 'PIPE1', 'PIPE2', 'B3 BASS']);
  assert.equal(organModel(9), 'B3');
  const short = (m: Parameters<typeof drawbarLabels>[0]): string[] => drawbarLabels(m).map((l) => l.short);
  const b3 = ["16'", "5⅓'", "8'", "4'", "2⅔'", "2'", "1⅗'", "1⅓'", "1'"];
  assert.deepEqual(short('B3'), b3);
  assert.deepEqual(short('PIPE1'), b3);
  assert.deepEqual(short('PIPE2'), b3);
  assert.deepEqual(short('B3 BASS'), ["16'", "8'", '–', '–', '–', '–', '–', '–', '–']);
  assert.deepEqual(drawbarLabels('B3 BASS').map((l) => l.used), [true, true, false, false, false, false, false, false, false]);
  assert.deepEqual(short('VOX'), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', '–', 'mix']);
  assert.deepEqual(short('FARF'), ['b 16', 's 16', 'f 8', 'o 8', 't 8', 's 8', 'f 4', 's 4', "2⅔'"]);
  for (const m of ORGAN_MODELS) {
    assert.equal(drawbarLabels(m).length, 9, m);
    for (const l of drawbarLabels(m)) assert.ok(l.name.length > l.short.length, `${m} ${l.short}`);
    assert.equal(new Set(drawbarLabels(m).map((l) => l.name)).size, 9, `${m}: nine distinct accessible names`);
  }
  assert.equal(drawbarLabels('B3 BASS')[2]!.name, 'drawbar 3, not used by this model');
  assert.equal(drawbarLabels('VOX')[7]!.name, 'drawbar 8, not used by this model');
  assert.equal(vibratoTypeKey('B3'), 'organ.vibratoTypeB3');
  assert.equal(vibratoTypeKey('B3 BASS'), 'organ.vibratoTypeB3');
  assert.equal(vibratoTypeKey('VOX'), 'organ.vibratoTypeVox');
  assert.equal(vibratoTypeKey('FARF'), 'organ.vibratoTypeFarfisa');
  assert.equal(vibratoTypeKey('PIPE1'), null);
});

test('the piano model select lists the 295 models by type, each marked approximation', () => {
  assert.deepEqual(MODEL_GROUPS.map((g) => g.type), PIANO_TYPES);
  const all = MODEL_GROUPS.flatMap((g) => g.options);
  assert.equal(all.length, 295);
  assert.equal(new Set(all.map((o) => o.value)).size, 295);
  assert.equal(new Set(all.map((o) => o.text)).size, 295, 'shared names are told apart');
  for (const g of MODEL_GROUPS) {
    assert.equal(g.options.length, modelsOfType(g.type).length, g.type);
    for (const o of g.options) {
      assert.ok(o.text.endsWith(' · approximation'), o.text);
      assert.equal(pianoModel(o.value)!.type, g.type);
    }
  }
  assert.deepEqual(MODEL_GROUPS.map((g) => g.options.length), [105, 75, 70, 15, 22, 8]);
  const first = modelsOfType('electric')[0]!;
  const hash = descriptorOf('pianoA.nameHash');
  assert.deepEqual(formatValue(hash, first.hash, store()), { text: first.label, marker: null }, 'a known hash shows its name');
  assert.deepEqual(formatValue(hash, 0, store()), { text: '0x00000000', marker: 'raw' });
  assert.equal(unknownModelText(0, 'grand'), 'no model · plays the grand default ≈');
  assert.equal(unknownModelText(0xabc, 'clav'), 'unknown model 0x00000abc · plays the clav default ≈');
});

test('scene and section keys of the program region read the active scene', () => {
  const s = store();
  assert.deepEqual(sceneKeys(s).map((k) => [k.label, k.active]), [['I', true], ['II', false]]);
  assert.deepEqual(sectionKeys(s).map((k) => [k.label, k.on]), [['organ', false], ['piano', false], ['synth', true]]);
  s.set('common.layerScene', 1);
  assert.deepEqual(sceneKeys(s).map((k) => k.active), [false, true]);
  // The init program's scene II keeps the layout defaults: piano on (plan section 13.4).
  assert.deepEqual(sectionKeys(s).map((k) => [k.label, k.on]), [['organ', false], ['piano', true], ['synth', false]]);
});

test('setSectionEnabled acts on the active scene and switches on the focused layer of an empty section', () => {
  const s = store();
  s.set('organ.layerFocusOrg_I', 1);
  const seen: string[] = [];
  s.onChange((batch) => seen.push(...batch.map((c) => `${c.key}=${c.value}:${c.origin}`)));
  setSectionEnabled(s, 'organ', true);
  assert.deepEqual(seen, ['common.sectionEnableOrg_I=1:ui', 'organ.layerEnableOrg_I=2:derived']);
  setSectionEnabled(s, 'organ', false);
  assert.equal(s.get('organ.layerEnableOrg_I'), 2, 'switching off keeps the layers');
  s.set('common.layerScene', 1);
  setSectionEnabled(s, 'synth', true);
  assert.equal(s.get('common.sectionEnableSyn_II'), 1);
  assert.equal(s.get('synth.layerEnableSyn_II'), 1, 'focus A of scene II');
  setSectionEnabled(s, 'piano', true);
  assert.equal(s.get('piano.layerEnablePno_II'), 1, 'the piano mask was already set: unchanged');
  setSectionEnabled(s, 'organ', true, 'I');
  assert.equal(s.get('common.sectionEnableOrg_I'), 1, 'an explicit scene');
});

test('setLayerEnabled: the synth form and the section form, in the active scene', () => {
  const s = store();
  setLayerEnabled(s, 'C', true);
  assert.equal(s.get('synth.layerEnableSyn_I'), 0b101);
  setLayerEnabled(s, 'piano', 'B', true);
  assert.equal(s.get('piano.layerEnablePno_I'), 0b10);
  s.set('common.layerScene', 1);
  setLayerEnabled(s, 'organ', 'A', false);
  assert.equal(s.get('organ.layerEnableOrg_II'), 0);
  setLayerEnabled(s, 'B', true);
  assert.equal(s.get('synth.layerEnableSyn_II'), 0b11, 'scene II synth default A, plus B');
});

test('setPianoModel writes the type and slot; setPianoType picks the first model of the new type', () => {
  const s = store();
  const clav = modelsOfType('clav')[0]!;
  s.set('pianoA.entry', 5);
  const seen: string[] = [];
  s.onChange((batch) => seen.push(...batch.map((c) => `${c.key}:${c.origin}`)));
  setPianoModel(s, 'A', clav.hash);
  assert.deepEqual([s.get('pianoA.nameHash'), s.get('pianoA.bank'), s.get('pianoA.entry')], [clav.hash, 3, 0]);
  assert.deepEqual(seen, ['pianoA.nameHash:ui', 'pianoA.bank:derived', 'pianoA.entry:derived']);

  const electric = modelsOfType('electric');
  setPianoType(s, 'A', 2);
  assert.deepEqual([s.get('pianoA.bank'), s.get('pianoA.nameHash')], [2, electric[0]!.hash]);
  setPianoModel(s, 'A', electric[3]!.hash);
  setPianoType(s, 'A', 2);
  assert.equal(s.get('pianoA.nameHash'), electric[3]!.hash, 'same type: the model stays');

  setPianoType(s, 'B', 4);
  assert.equal(pianoModel(s.get('pianoB.nameHash'))!.type, 'digital', 'hash 0 gets the first digital model');
  setPianoModel(s, 'B', 0xdead);
  assert.deepEqual([s.get('pianoB.nameHash'), s.get('pianoB.bank')], [0xdead, 4], 'an unknown hash is written alone');
  assert.equal(PIANO_MODELS.length, 295);
});

test('a split point key also sets split on while any point is on', () => {
  const s = store();
  assert.deepEqual([s.get('common.splitEnabled'), s.get('common.splitEnabledMid')], [0, 1]);
  setSplitPoint(s, 'Low', true);
  assert.deepEqual([s.get('common.splitEnabled'), s.get('common.splitEnabledLow'), s.get('common.splitEnabledMid')], [1, 1, 0],
    'split was off, so only the chosen point plays');
  setSplitPoint(s, 'Mid', true);
  assert.deepEqual([s.get('common.splitEnabledLow'), s.get('common.splitEnabledMid')], [1, 1], 'split on: points add up');
  setSplitPoint(s, 'Low', false);
  assert.equal(s.get('common.splitEnabled'), 1, 'mid is still on');
  setSplitPoint(s, 'Mid', false);
  assert.equal(s.get('common.splitEnabled'), 0);
  setSplitPoint(s, 'High', false);
  assert.equal(s.get('common.splitEnabled'), 0, 'switching a point off never turns split on');
});

test('split point keys show what plays: from the init program one click on mid splits at C4', () => {
  const s = store();
  const mid = descriptorOf('common.splitEnabledMid');
  assert.deepEqual(shownDeps(mid), ['common.splitEnabled']);
  assert.deepEqual(shownDeps(descriptorOf('common.splitPosMid')), []);
  assert.equal(s.get('common.splitEnabledMid'), 1, 'stored on');
  assert.equal(shownValue(mid, s), 0, 'but split is off, so the key shows off');
  assert.equal(splitBoundaries(s).length, 0);
  // A key click writes the opposite of what it shows.
  writeControl(s, mid, shownValue(mid, s) === mid.max ? mid.min : mid.max);
  assert.equal(s.get('common.splitEnabled'), 1);
  assert.equal(shownValue(mid, s), 1);
  assert.deepEqual(splitBoundaries(s).map((b) => [b.point, b.note]), [['Mid', 60]]);
  writeControl(s, mid, shownValue(mid, s) === mid.max ? mid.min : mid.max);
  assert.deepEqual([s.get('common.splitEnabled'), shownValue(mid, s)], [0, 0], 'the second click switches split off');

  // A loaded file with points on and split off: every key shows off, as nothing splits.
  s.setMany([['common.splitEnabledLow', 1], ['common.splitEnabledMid', 1], ['common.splitEnabled', 0]], 'load');
  for (const p of ['Low', 'Mid', 'High'] as const) {
    assert.equal(shownValue(descriptorOf(`common.splitEnabled${p}`), s), 0, p);
    assert.equal(splitPointOn(s, p), false, p);
  }
  assert.equal(shownValue(descriptorOf('common.transposeValue'), s), s.get('common.transposeValue'), 'other keys show the stored value');
});

test('writeControl routes multi-field writes to the actions and the rest to a plain write', () => {
  const same = (key: Ns4Key, value: number, action: (s: ParamStore) => void): void => {
    const a = store();
    writeControl(a, descriptorOf(key), value);
    const b = store();
    action(b);
    for (const k of NS4_KEYS) assert.equal(a.get(k), b.get(k), `${key} = ${value}: ${k}`);
  };
  // Section switches of both scenes act on the key's own scene, even while the other is active.
  same('common.sectionEnableOrg_I', 1, (s) => setSectionEnabled(s, 'organ', true, 'I'));
  same('common.sectionEnableOrg_II', 1, (s) => setSectionEnabled(s, 'organ', true, 'II'));
  same('common.sectionEnablePno_II', 0, (s) => setSectionEnabled(s, 'piano', false, 'II'));
  same('common.sectionEnableSyn_I', 0, (s) => setSectionEnabled(s, 'synth', false, 'I'));
  const s = store();
  writeControl(s, descriptorOf('common.sectionEnableOrg_II'), 1);
  assert.equal(s.get('common.layerScene'), 0, 'the active scene stays I');
  assert.notEqual(s.get('organ.layerEnableOrg_II'), 0, 'the scene II organ gets its focused layer');
  assert.equal(s.get('organ.layerEnableOrg_I'), 0, 'scene I is untouched');
  // Every split point key.
  for (const p of ['Low', 'Mid', 'High'] as const) {
    same(`common.splitEnabled${p}`, 1, (x) => setSplitPoint(x, p, true));
    same(`common.splitEnabled${p}`, 0, (x) => setSplitPoint(x, p, false));
  }
  const t = store();
  writeControl(t, descriptorOf('common.splitEnabledHigh'), 1);
  assert.equal(t.get('common.splitEnabled'), 1, 'a split point write keeps split in step');
  // Piano type: the model and slot follow.
  same('pianoB.bank', 2, (x) => setPianoType(x, 'B', 2));
  const u = store();
  writeControl(u, descriptorOf('pianoA.bank'), 3);
  assert.equal(pianoModel(u.get('pianoA.nameHash'))?.type, 'clav');
  // Osc bank of every synth layer.
  for (const l of ['A', 'B', 'C'] as const) for (const v of [0, 1, 2]) same(`synth${l}Sound.oscBank`, v, (x) => setOscBank(x, l, v));
  // Everything else: one plain write.
  const w = store();
  const seen: Ns4Key[] = [];
  w.onChange((batch) => seen.push(...batch.map((c) => c.key)));
  writeControl(w, descriptorOf('common.transposeValue'), 3);
  writeControl(w, descriptorOf('pianoA.variation'), 2);
  assert.deepEqual(seen, ['common.transposeValue', 'pianoA.variation']);
});

test('the piano variation shows only for a clav layer; the model select names what plays', () => {
  assert.deepEqual(PIANO_TYPES.map((_, i) => variationUsed(i)), [false, false, false, true, false, false]);
  const grand = modelsOfType('grand')[0]!;
  const electric = modelsOfType('electric')[0]!;
  const bank = (t: (typeof PIANO_TYPES)[number]): number => PIANO_TYPES.indexOf(t);
  assert.deepEqual(modelChoice(electric.hash, bank('electric')), { playsModel: true, text: modelText(electric) });
  const mismatch = modelChoice(grand.hash, bank('electric'));
  assert.equal(mismatch.playsModel, false, 'a grand model on an electric bank does not sound');
  assert.ok(mismatch.text.startsWith(grand.label), mismatch.text);
  assert.ok(mismatch.text.endsWith('plays the electric default ≈'), mismatch.text);
  assert.deepEqual(modelChoice(0xdead, bank('clav')), { playsModel: false, text: unknownModelText(0xdead, 'clav') });
});

test('morph readout text', () => {
  assert.equal(morphCountText(0), 'none set');
  assert.equal(morphCountText(3), '3 set, shown as dots on the controls, not played');
});

test('the program region shows every program field: controls, or read-only values', () => {
  const program = PANEL.find((r) => r.id === 'program')!;
  const keys = program.groups.flatMap((g) => keysOf(g, null));
  assert.equal(keys.length, 37);
  for (const k of keys) assert.ok(descriptorOf(k as Ns4Key).label.length > 0, k);
});
